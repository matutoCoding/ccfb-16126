/**
 * 可复用 WebGL 视口：轨道控制 / 截面裁剪 / 透明分层 / 壁厚热力 / 悬停探针 / 截图。
 * 纯 DOM + 渲染器，不绑定具体页面。
 */
import {
  CameraState, ClipPlane, GLRenderer, LayerTag, PixelLayerInfo, RenderLayerConfig,
} from './GLRenderer';
import { Vec3 } from '../core/math';
import { SceneItem } from './scene';

export interface ViewportOptions {
  layerConfig: RenderLayerConfig;
  heatMode: boolean;
  minWall: number;
  clip: ClipPlane;
  onHover?: (info: PixelLayerInfo[] | null, screenX: number, screenY: number) => void;
}

const TAG_ALPHA: Record<LayerTag, keyof RenderLayerConfig> = {
  shell: 'shell', tube: 'tube', vent: 'vent', device: 'device',
  impression: 'impression', marker: 'device',
};

/**
 * 全局唯一 WebGL 上下文：canvas 与 GLRenderer 在页面切换间持久复用，
 * 只重新挂载 DOM 节点，绝不反复创建/销毁上下文（规避 SwiftShader 多上下文崩溃）。
 */
let sharedCanvas: HTMLCanvasElement | null = null;
let sharedRenderer: GLRenderer | null = null;

function getSharedRenderer(): { canvas: HTMLCanvasElement; renderer: GLRenderer } {
  if (!sharedCanvas || !sharedRenderer) {
    sharedCanvas = document.createElement('canvas');
    sharedCanvas.style.width = '100%';
    sharedCanvas.style.height = '100%';
    sharedCanvas.style.display = 'block';
    sharedCanvas.style.cursor = 'grab';
    sharedRenderer = new GLRenderer(sharedCanvas);
  }
  return { canvas: sharedCanvas, renderer: sharedRenderer };
}

/** 全局视口注册表 */
const activeViewports = new Set<Viewport>();
export function disposeAllViewports(): void {
  for (const vp of [...activeViewports]) vp.dispose();
  activeViewports.clear();
}

/** 创建视口（复用共享上下文） */
export function createViewportDeferred(
  container: HTMLElement, target: Vec3, fitRadius: number, options: ViewportOptions,
  cb: (vp: Viewport) => void,
): void {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const vp = new Viewport(container, target, fitRadius, options);
    cb(vp);
  }));
}

export class Viewport {
  canvas: HTMLCanvasElement;
  renderer: GLRenderer;
  camera: CameraState;
  items: SceneItem[] = [];
  options: ViewportOptions;
  private raf = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private disposed = false;
  private resizeObs: ResizeObserver;

  constructor(container: HTMLElement, target: Vec3, fitRadius: number, options: ViewportOptions) {
    const shared = getSharedRenderer();
    this.canvas = shared.canvas;
    this.renderer = shared.renderer;
    container.appendChild(this.canvas); // 重新挂载，上下文不重建
    this.camera = {
      target,
      distance: Math.max(20, fitRadius * 2.4),
      yaw: 0.6,
      pitch: 0.35,
      fovyDeg: 40,
    };
    this.options = options;
    this.bindControls();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.loop();
    activeViewports.add(this);
  }

  setItems(items: SceneItem[]): void {
    this.items = items;
    this.dirty = true;
  }

  setOptions(patch: Partial<ViewportOptions>): void {
    this.options = { ...this.options, ...patch };
    this.dirty = true;
  }

  frame(target: Vec3, fitRadius: number): void {
    this.camera.target = target;
    this.camera.distance = Math.max(20, fitRadius * 2.4);
    this.dirty = true;
  }

  /** 外部直接改了相机参数后调用，请求下一帧重算 */
  invalidate(): void {
    this.dirty = true;
  }

  private resize(): void {
    // 限制 DPR 与总像素，控制 depth peeling 多层浮点纹理的显存占用（软件渲染友好）
    const dpr = Math.min(1, window.devicePixelRatio || 1);
    const w = Math.max(64, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(64, Math.floor(this.canvas.clientHeight * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    this.renderer.resize(w, h);
  }

  private probeQueued = false;
  private probeX = 0;
  private probeY = 0;
  private probeSX = 0;
  private probeSY = 0;

  private bindControls(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX; this.lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
      c.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      if (this.dragging) {
        const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
        this.lastX = e.clientX; this.lastY = e.clientY;
        this.camera.yaw += dx * 0.01;
        this.camera.pitch = Math.max(-1.45, Math.min(1.45, this.camera.pitch + dy * 0.01));
        this.dirty = true;
      } else {
        // 节流：每帧最多一次探针回读，避免高频 readPixels 拖垮软件渲染
        this.probeX = e.clientX - rect.left;
        this.probeY = e.clientY - rect.top;
        this.probeSX = e.clientX;
        this.probeSY = e.clientY;
        if (!this.probeQueued) {
          this.probeQueued = true;
          requestAnimationFrame(() => {
            this.probeQueued = false;
            this.probe(this.probeX, this.probeY, this.probeSX, this.probeSY);
          });
        }
      }
    });
    c.addEventListener('pointerup', (e) => {
      this.dragging = false;
      c.releasePointerCapture(e.pointerId);
      c.style.cursor = 'grab';
    });
    c.addEventListener('pointerleave', () => this.options.onHover?.(null, 0, 0));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.distance = Math.max(5, Math.min(200, this.camera.distance * (1 + Math.sign(e.deltaY) * 0.08)));
      this.dirty = true;
    }, { passive: false });
  }

  private probe(cssX: number, cssY: number, screenX: number, screenY: number): void {
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const x = Math.floor(cssX * dpr);
    const y = Math.floor((this.canvas.clientHeight - cssY) * dpr);
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    const info = this.renderer.readbackLayers(x, y);
    this.options.onHover?.(info.length ? info : null, screenX, screenY);
  }

  /** 供外部做射线拾取（标记点拖动等） */
  pickRay(cssX: number, cssY: number) {
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    return this.renderer.pixelRay(
      this.camera,
      Math.floor(cssX * dpr),
      Math.floor((this.canvas.clientHeight - cssY) * dpr),
    );
  }

  private dirty = true;

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.items.length === 0) return;
    if (!this.dirty) return; // 相机与数据未变时跳过重算，避免每帧全量回读
    this.dirty = false;
    this.draw();
  };

  private draw(): void {
    const cfg = this.options.layerConfig;
    const renderItems = this.items
      .filter((it) => {
        const key = TAG_ALPHA[it.tag];
        return cfg[key].visible;
      })
      .map((it) => {
        const key = TAG_ALPHA[it.tag];
        const style = cfg[key];
        return {
          mesh: it.mesh,
          model: it.model,
          tag: it.tag,
          color: style.color,
          alpha: it.alpha * style.opacity,
        };
      });
    this.renderer.render(
      renderItems,
      this.camera,
      this.options.clip,
      this.options.heatMode,
      this.options.minWall,
    );
  }

  snapshot(): string {
    this.draw(); // 强制出一帧最新画面
    return this.renderer.snapshot();
  }

  /** 解除挂载并停止本视口循环；共享 GL 上下文保留供下一页面复用 */
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    activeViewports.delete(this);
    this.canvas.remove();
  }

  /** CPU 参考合成（测试用，与画面同源同结果） */
  referenceImage(): ImageData {
    this.dirty = true;
    this.draw();
    return this.renderer.referenceImage();
  }

  get canvasImage(): ImageData {
    const gl = this.renderer.gl;
    const img = new ImageData(this.canvas.width, this.canvas.height);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
    return flipY(img);
  }
}

export function flipY(img: ImageData): ImageData {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(data.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    out.set(data.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  }
  return new ImageData(out, width, height);
}

export function defaultLayerConfig(): RenderLayerConfig {
  return {
    shell: { visible: true, opacity: 0.34, color: [0.91, 0.71, 0.56] },
    tube: { visible: true, opacity: 0.65, color: [0.2, 0.6, 0.95] },
    vent: { visible: true, opacity: 0.65, color: [0.3, 0.9, 0.55] },
    device: { visible: true, opacity: 0.8, color: [0.9, 0.4, 0.35] },
    impression: { visible: false, opacity: 0.16, color: [0.85, 0.78, 0.68] },
  };
}

export type { Vec3 };

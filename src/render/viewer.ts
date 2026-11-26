// 统一 3D 视图：管理场景条目、标记点、悬停拾取、截图
import { createCanvas, GpuMesh } from './glCore';
import { OrbitCamera, attachOrbit } from './camera';
import { DepthPeelingRenderer, RenderItem } from './depthPeeling';
import { Mesh, emptyMesh } from '../core/mesh';
import { Vec3, v3, m4, Mat4, pixelRay } from '../core/math';
import { RayMeshIntersector } from '../core/raycast';

export interface ViewerEntry {
  id: string;
  label: string;
  mesh: Mesh;
  color: Vec3;
  alpha: number;
  visible: boolean;
  pickable: boolean;
}

interface GpuEntry extends ViewerEntry {
  gpu: GpuMesh | null;
  intersector: RayMeshIntersector | null;
}

export class Viewer {
  gl: WebGL2RenderingContext;
  camera: OrbitCamera;
  renderer: DepthPeelingRenderer;
  private entries = new Map<string, GpuEntry>();
  private detach: () => void;
  transparent = true;
  onHover?: (info: HoverInfo | null) => void;
  private raf = 0;
  private needsRedraw = true;

  constructor(public canvas: HTMLCanvasElement) {
    this.gl = createCanvas(canvas);
    this.camera = new OrbitCamera();
    this.renderer = new DepthPeelingRenderer(this.gl, this.camera);
    this.detach = attachOrbit(canvas, this.camera);
    const redraw = () => { this.needsRedraw = true; };
    canvas.addEventListener('pointermove', () => this.scheduleHover());
    canvas.addEventListener('pointermove', redraw);
    canvas.addEventListener('wheel', redraw);
    const ro = new ResizeObserver(() => this.invalidate());
    ro.observe(canvas);
    this.loop();
  }

  private loop = (): void => {
    if (this.needsRedraw && !this.auditLock) {
      this.needsRedraw = false;
      this.draw();
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  // 审计期间加锁，阻止 RAF 用全屏尺寸重绘覆盖离屏自检结果
  auditLock = false;

  // 审计后强制按 canvas 物理尺寸重建渲染目标
  restoreSize(): void {
    this.renderer.resetTargets();
  }

  invalidate(): void {
    this.needsRedraw = true;
  }

  setEntry(e: ViewerEntry): void {
    const existing = this.entries.get(e.id);
    const gpu = existing && existing.mesh === e.mesh ? existing.gpu : this.upload(e.mesh);
    const intersector = existing && existing.mesh === e.mesh
      ? existing.intersector
      : (e.mesh.indices.length ? new RayMeshIntersector(e.mesh, 48) : null);
    this.entries.set(e.id, { ...e, gpu, intersector });
    this.invalidate();
  }

  removeEntry(id: string): void {
    this.entries.delete(id);
    this.invalidate();
  }

  clear(): void {
    this.entries.clear();
    this.invalidate();
  }

  entryIds(): string[] {
    return [...this.entries.keys()];
  }

  getEntry(id: string): ViewerEntry | undefined {
    return this.entries.get(id);
  }

  private upload(mesh: Mesh): GpuMesh | null {
    if (!mesh.indices.length) return null;
    return new GpuMesh(this.gl, mesh.positions, mesh.normals, mesh.indices);
  }

  private buildRenderItems(): RenderItem[] {
    const items: RenderItem[] = [];
    for (const e of this.entries.values()) {
      if (!e.gpu) continue;
      items.push({ mesh: e.gpu, color: e.color, alpha: e.alpha, visible: e.visible, id: e.id });
    }
    return items;
  }

  private draw(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(64, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(64, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const items = this.buildRenderItems();
    if (!items.length) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0.12, 0.13, 0.16, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    this.renderer.render(items, w, h, this.transparent);
  }

  // 供透视自检使用：当前可见条目的 RenderItem（含 GpuMesh）与对应 Mesh
  auditItems(): { renderItems: RenderItem[]; sceneObjects: import('../core/referenceRenderer').SceneObject[] } {
    const renderItems: RenderItem[] = [];
    const sceneObjects: import('../core/referenceRenderer').SceneObject[] = [];
    for (const e of this.entries.values()) {
      if (!e.gpu || !e.visible) continue;
      renderItems.push({ mesh: e.gpu, color: e.color, alpha: e.alpha, visible: true, id: e.id });
      sceneObjects.push({ mesh: e.mesh, color: e.color, alpha: e.alpha });
    }
    return { renderItems, sceneObjects };
  }

  // 悬停：CPU 射线拾取 + 各层深度
  private hoverTimer = 0;
  private scheduleHover(): void {
    clearTimeout(this.hoverTimer);
    this.hoverTimer = window.setTimeout(() => this.doHover(), 80);
  }

  private doHover(): void {
    if (!this.onHover) return;
    const rect = this.canvas.getBoundingClientRect();
    const ev = this.lastEvent;
    if (!ev) return;
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const ndcX = (px / rect.width) * 2 - 1;
    const ndcY = 1 - (py / rect.height) * 2;
    const inv = m4.invert(this.camera.viewProj(rect.width / rect.height));
    const { origin, dir } = pixelRay(inv, ndcX, ndcY);
    const hits: { id: string; label: string; t: number; point: Vec3 }[] = [];
    for (const e of this.entries.values()) {
      if (!e.visible || !e.pickable || !e.intersector) continue;
      for (const h of e.intersector.intersectAll(origin, dir)) {
        hits.push({ id: e.id, label: e.label, t: h.t, point: h.point });
      }
    }
    hits.sort((a, b) => a.t - b.t);
    const depths = this.renderer.pixelDepths(
      Math.floor(px * (this.canvas.width / rect.width)),
      Math.floor(py * (this.canvas.height / rect.height)),
      this.canvas.width,
      this.canvas.height,
    );
    this.onHover(hits.length ? { hits, layerDepths: depths, origin, dir } : { hits: [], layerDepths: depths, origin, dir });
  }

  private lastEvent: PointerEvent | null = null;
  attachHoverTracking(): void {
    this.canvas.addEventListener('pointermove', (e) => { this.lastEvent = e; });
  }

  fitView(): void {
    const meshes: Mesh[] = [];
    for (const e of this.entries.values()) if (e.visible && e.mesh.indices.length) meshes.push(e.mesh);
    if (meshes.length) this.camera.fit(meshes);
    this.invalidate();
  }

  // 透视自检：回读当前画面
  readFrame(): { rgba: Uint8Array; width: number; height: number } {
    const rgba = this.renderer.readColor(this.canvas.width, this.canvas.height);
    // readPixels 左下原点，翻转成左上
    const w = this.canvas.width, h = this.canvas.height;
    const flipped = new Uint8Array(rgba.length);
    const row = w * 4;
    for (let y = 0; y < h; y++) flipped.set(rgba.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return { rgba: flipped, width: w, height: h };
  }

  readLayerDepths(): Float32Array[] {
    return this.renderer.readLayerDepths(this.canvas.width, this.canvas.height);
  }

  screenshot(): Blob {
    const url = this.canvas.toDataURL('image/png');
    const bin = atob(url.split(',')[1]);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: 'image/png' });
  }

  dispose(): void {
    this.detach();
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }
}

export interface HoverInfo {
  hits: { id: string; label: string; t: number; point: Vec3 }[];
  layerDepths: number[];
  origin: Vec3;
  dir: Vec3;
}

export function markerMesh(center: Vec3, radius: number, color: Vec3): Mesh {
  // 低精度球体
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const seg = 12, rings = 8;
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const theta = (s / seg) * Math.PI * 2;
      const n: Vec3 = [Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi)];
      positions.push(center[0] + n[0] * radius, center[1] + n[1] * radius, center[2] + n[2] * radius);
      normals.push(...n);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s;
      const b = a + seg + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    name: `marker-${color.join(',')}`,
  };
}

export function lineTubeMesh(a: Vec3, b: Vec3, radius: number): Mesh {
  // 细圆柱管（声管/通气孔可视化）
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const axis = v3.normalize(v3.sub(b, a));
  const ref: Vec3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u = v3.normalize(v3.cross(axis, ref));
  const w = v3.normalize(v3.cross(axis, u));
  const seg = 10;
  for (const end of [a, b]) {
    for (let s = 0; s <= seg; s++) {
      const t = (s / seg) * Math.PI * 2;
      const n = v3.normalize(v3.add(v3.scale(u, Math.cos(t)), v3.scale(w, Math.sin(t))));
      positions.push(end[0] + n[0] * radius, end[1] + n[1] * radius, end[2] + n[2] * radius);
      normals.push(...n);
    }
  }
  for (let s = 0; s < seg; s++) {
    indices.push(s, seg + 1 + s, s + 1, seg + 1 + s, seg + 2 + s, s + 1);
  }
  const mesh: Mesh = {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
  };
  mesh.normals = normals.length ? mesh.normals : emptyMesh().normals;
  return mesh;
}

export function polylineToTubeMesh(points: Vec3[], radius: number): Mesh {
  const parts: Mesh[] = [];
  for (let i = 0; i < points.length - 1; i++) parts.push(lineTubeMesh(points[i], points[i + 1], radius));
  // 合并
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const m of parts) {
    positions.push(...m.positions);
    normals.push(...m.normals);
    for (const ix of m.indices) indices.push(ix + offset);
    offset += m.positions.length / 3;
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
  };
}

export type { Mat4 };

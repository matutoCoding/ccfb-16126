import type {
  DefectMark,
  Landmarks,
  LayerStyle,
  MeshData,
  PlacedComponent,
  Vec3,
} from '../types';
import { Renderer, type SceneMesh } from '../core/render/Renderer';
import { OrbitControls } from '../core/render/OrbitControls';
import { boxMesh, cylinderMesh, mergeMeshes, tubeAlongPath } from '../core/math/mesh';
import { raySphereHit } from '../core/math/raycast';
import { h } from './dom';
import type { LayerId } from '../types';

export interface ViewportScene {
  impression?: MeshData | null;
  shell?: MeshData | null;
  shellSections?: { center: Vec3 }[];
  components?: PlacedComponent[];
  soundTubePath?: Vec3[];
  ventPath?: Vec3[];
  soundTubeDiameter?: number;
  ventDiameter?: number;
  landmarks?: Landmarks | null;
  defects?: DefectMark[];
  stuckPoints?: Vec3[];
  draggableLandmarks?: boolean;
  onLandmarkDrag?: (kind: 'aperture' | 'firstBend' | 'secondBend', pos: Vec3) => void;
  onHover?: (info: HoverInfo | null) => void;
  showCenterline?: boolean;
}

export interface HoverInfo {
  pixel: { x: number; y: number };
  layers: { index: number; layerId: number; depthMm: number }[];
  shellSegments: { thickness: number; depthEnter: number }[];
  minWall: number;
}

const COMP_LAYER: Record<string, LayerId> = {
  receiver: 'receiver',
  battery: 'battery',
  faceplate: 'faceplate',
  amplifier: 'amplifier',
};

function componentMesh(c: PlacedComponent): MeshData {
  if (c.size.radius !== undefined && c.size.length !== undefined) {
    return cylinderMesh(c.center, c.axis, c.size.radius, c.size.length);
  }
  return boxMesh(c.center, c.axis, {
    width: c.size.width ?? 2,
    height: c.size.height ?? 2,
    depth: c.size.depth ?? 2,
  });
}

function sphereMesh(center: Vec3, radius: number): MeshData {
  return cylinderMesh(center, [0, 0, 1], radius, radius * 2, 18);
}

function lineTube(a: Vec3, b: Vec3, radius: number): MeshData {
  return tubeAlongPath([a, b], radius, 8);
}

/** 可复用 WebGL 视口：负责场景组装、相机、标志点拖拽、悬停分析 */
export class Viewport {
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  readonly renderer: Renderer;
  readonly controls: OrbitControls;
  private scene: ViewportScene = {};
  private styles: LayerStyle[];
  private markerMeshes: { id: string; kind: 'aperture' | 'firstBend' | 'secondBend' | 'defect' | 'stuck'; pos: Vec3; radius: number }[] = [];
  private raf = 0;
  private resizeObs: ResizeObserver;
  private draggingMarker: string | null = null;
  wallMin = 0.8;
  thinRed = true;

  constructor(styles: LayerStyle[]) {
    this.styles = styles;
    this.container = h('div', { class: 'viewport' });
    this.canvas = h('canvas', { class: 'gl-canvas' }) as HTMLCanvasElement;
    this.container.append(this.canvas);
    this.renderer = new Renderer(this.canvas);
    this.controls = new OrbitControls(this.canvas, this.renderer, () => this.draw());
    this.controls.apply();
    this.resizeObs = new ResizeObserver(() => this.fit());
    this.resizeObs.observe(this.container);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    requestAnimationFrame(() => this.fit());
  }

  setStyles(styles: LayerStyle[]): void {
    this.styles = styles;
    this.renderer.setLayerStyles(styles.filter((s) => s.id !== 'shell' || true));
    this.draw();
  }

  setScene(scene: ViewportScene): void {
    this.scene = scene;
    this.rebuild();
  }

  setWallMin(v: number): void {
    this.wallMin = v;
    this.renderer.wallMin = v;
    this.draw();
  }

  setThinRed(on: boolean): void {
    this.thinRed = on;
    this.renderer.thinRedEnabled = on;
    this.draw();
  }

  /** 自检专用：直接装入分层网格，跳过 ViewportScene 组装，避免被异步重建覆盖 */
  setRawLayerMeshes(meshes: { layerId: LayerId; mesh: MeshData; color: Vec3; alpha: number }[]): void {
    const sceneMeshes: SceneMesh[] = meshes.map((m, i) => ({
      id: `raw_${i}`,
      layerId: m.layerId,
      mesh: m.mesh,
      color: m.color,
      alpha: m.alpha,
      visible: true,
    }));
    this.renderer.setLayerStyles(this.styles);
    this.renderer.setScene(sceneMeshes);
    this.draw();
  }

  resetView(): void {
    this.controls.resetView();
  }

  private fit(): void {
    const rect = this.container.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setSize(rect.width * dpr, rect.height * dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.draw();
  }

  private styleOf(id: LayerId): LayerStyle {
    return this.styles.find((s) => s.id === id) ?? {
      id,
      label: id,
      visible: true,
      alpha: 0.5,
      color: [0.8, 0.8, 0.8],
    };
  }

  private rebuild(): void {
    const meshes: SceneMesh[] = [];
    this.markerMeshes = [];
    const s = this.scene;

    if (s.impression && s.impression.indices.length > 0) {
      meshes.push({
        id: 'impression',
        layerId: 'impression',
        mesh: s.impression,
        color: [0.72, 0.66, 0.55],
        alpha: 0.35,
        visible: true,
      });
    }
    if (s.shell && s.shell.indices.length > 0) {
      const st = this.styleOf('shell');
      meshes.push({ id: 'shell', layerId: 'shell', mesh: s.shell, color: st.color, alpha: st.alpha, visible: st.visible });
    }
    if (s.components) {
      for (const c of s.components) {
        const layer = COMP_LAYER[c.kind];
        const st = this.styleOf(layer);
        if (!st.visible) continue;
        meshes.push({
          id: `comp_${c.id}`,
          layerId: layer,
          mesh: componentMesh(c),
          color: st.color,
          alpha: st.alpha,
          visible: true,
        });
      }
    }
    if (s.soundTubePath && s.soundTubePath.length > 1) {
      const st = this.styleOf('tube');
      if (st.visible) {
        meshes.push({
          id: 'soundtube',
          layerId: 'tube',
          mesh: tubeAlongPath(s.soundTubePath, (s.soundTubeDiameter ?? 1.2) / 2),
          color: st.color,
          alpha: st.alpha,
          visible: true,
        });
      }
    }
    if (s.ventPath && s.ventPath.length > 1) {
      const st = this.styleOf('vent');
      if (st.visible) {
        meshes.push({
          id: 'vent',
          layerId: 'vent',
          mesh: tubeAlongPath(s.ventPath, (s.ventDiameter ?? 2) / 2),
          color: st.color,
          alpha: st.alpha,
          visible: true,
        });
      }
    }
    if (s.showCenterline && s.landmarks) {
      const cl = s.landmarks.centerline;
      for (let i = 0; i < cl.length - 1; i++) {
        meshes.push({
          id: `cl_${i}`,
          layerId: 'marker',
          mesh: lineTube(cl[i], cl[i + 1], 0.12),
          color: [0.4, 0.85, 1],
          alpha: 2,
          visible: true,
        });
      }
    }
    if (s.landmarks) {
      const lm = s.landmarks;
      this.markerMeshes.push(
        { id: 'lm_aperture', kind: 'aperture', pos: lm.aperture, radius: 0.8 },
        { id: 'lm_firstBend', kind: 'firstBend', pos: lm.firstBend, radius: 0.8 },
        { id: 'lm_secondBend', kind: 'secondBend', pos: lm.secondBend, radius: 0.8 },
      );
    }
    for (const d of s.defects ?? []) {
      this.markerMeshes.push({
        id: `def_${d.id}`,
        kind: 'defect',
        pos: d.position,
        radius: Math.max(0.7, d.radius * 0.45),
      });
    }
    for (let i = 0; i < (s.stuckPoints ?? []).length; i++) {
      this.markerMeshes.push({ id: `stuck_${i}`, kind: 'stuck', pos: s.stuckPoints![i], radius: 0.9 });
    }
    for (const m of this.markerMeshes) {
      const color: Vec3 =
        m.kind === 'aperture' ? [0.3, 0.9, 1]
        : m.kind === 'firstBend' ? [1, 0.8, 0.2]
        : m.kind === 'secondBend' ? [1, 0.45, 0.2]
        : m.kind === 'stuck' ? [1, 0.1, 0.1]
        : [1, 0.3, 0.8];
      meshes.push({
        id: `marker_${m.id}`,
        layerId: 'marker',
        mesh: sphereMesh(m.pos, m.radius),
        color,
        alpha: this.draggingMarker === m.id ? 2 : 1,
        visible: true,
      });
    }
    this.renderer.setLayerStyles(this.styles);
    this.renderer.wallMin = this.wallMin;
    this.renderer.thinRedEnabled = this.thinRed;
    this.renderer.setScene(meshes);
    this.draw();
  }

  draw(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      try {
        this.renderer.render();
      } catch (err) {
        console.error('渲染失败', err);
      }
    });
  }

  flush(): void {
    this.renderer.render();
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.scene.draggableLandmarks || e.button !== 0) return;
    const hit = this.pickMarker(e.clientX, e.clientY);
    if (hit) {
      this.draggingMarker = hit;
      this.canvas.setPointerCapture(e.pointerId);
      this.rebuild();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.draggingMarker) {
      // 标志点沿中心线吸附：取射线与中心线最近点
      const ray = this.renderer.screenToRay(e.clientX, e.clientY);
      const cl = this.scene.landmarks?.centerline ?? [];
      let best = cl[0];
      let bestD = Infinity;
      for (const p of cl) {
        const t = raySphereHit(ray.origin, ray.dir, p, 0.01);
        if (t >= 0 && t < bestD) {
          bestD = t;
          best = p;
        }
      }
      if (bestD < Infinity) {
        const marker = this.markerMeshes.find((m) => m.id === this.draggingMarker);
        if (marker && marker.kind !== 'defect' && marker.kind !== 'stuck') {
          this.scene.onLandmarkDrag?.(marker.kind, best);
        }
      }
      return;
    }
    // 悬停分析
    if (this.scene.onHover && this.scene.shell) {
      const info = this.renderer.inspectPixel(e.clientX, e.clientY);
      if (info && info.layers.length > 0) {
        this.scene.onHover({
          pixel: { x: e.clientX, y: e.clientY },
          layers: info.layers,
          shellSegments: info.shellSegments,
          minWall: info.minWall,
        });
      } else {
        this.scene.onHover(null);
      }
    }
  };

  private onPointerUp = (): void => {
    if (this.draggingMarker) {
      this.draggingMarker = null;
      this.rebuild();
    }
  };

  private pickMarker(clientX: number, clientY: number): string | null {
    const ray = this.renderer.screenToRay(clientX, clientY);
    let best: string | null = null;
    let bestT = Infinity;
    for (const m of this.markerMeshes) {
      if (m.kind === 'defect' || m.kind === 'stuck') continue;
      const t = raySphereHit(ray.origin, ray.dir, m.pos, m.radius * 1.4);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = m.id;
      }
    }
    return best;
  }

  snapshot(): string {
    this.flush();
    return this.renderer.snapshot();
  }

  get peelData() {
    return this.renderer.readPeelTargets();
  }

  get compositePixels(): Uint8Array {
    return this.renderer.readCompositePixels();
  }

  get glSize() {
    return this.renderer.size;
  }

  get camera() {
    return this.renderer.getCamera();
  }

  screenRay(x: number, y: number) {
    return this.renderer.screenToRay(x, y);
  }

  dispose(): void {
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.dispose();
    this.container.remove();
  }
}

export { mergeMeshes };

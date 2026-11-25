import type { ShellDesign, ShellParams } from '../../types';
import { buildShell, clipMeshAtStation, defaultTrimStation, wallMinFor, type ShellBuildResult } from '../../core/geometry/shellBuilder';
import { store } from '../../core/state/store';
import { Viewport } from '../Viewport';
import { badge, button, clear, fmt, h, labelRow, numberInput, selectInput, slider, toast } from '../dom';
import { MOLD_TYPE_LABEL } from '../../types';

export class ShellPage {
  readonly el: HTMLElement;
  private viewportHost: HTMLElement;
  private sideEl: HTMLElement;
  private viewport: Viewport | null = null;
  private built: ShellBuildResult | null = null;
  private design: ShellDesign | null = null;
  private clipT = 1;

  constructor() {
    this.el = h('div', { class: 'page page-shell' },
      h('div', { class: 'page-head' },
        h('h2', {}, '外壳设计'),
        h('div', { class: 'spacer' }),
      ),
      h('div', { class: 'scan-layout' },
        (this.viewportHost = h('div', { class: 'viewport-host panel' })),
        (this.sideEl = h('div', { class: 'scan-side panel' })),
      ),
    );
  }

  render(): void {
    this.ensureViewport();
    this.ensureDesign();
    this.renderSide();
    this.rebuildShell();
  }

  private ensureViewport(): void {
    if (this.viewport) return;
    this.viewport = new Viewport(store.state.layerStyles);
    this.viewportHost.append(this.viewport.container);
  }

  private ensureDesign(): void {
    const scan = store.currentScan;
    const ec = store.currentCase;
    if (!scan || !ec) {
      this.design = null;
      return;
    }
    let design = store.currentDesign;
    if (!design || design.scanId !== scan.id) {
      const existing = store.state.designs.find((d) => d.scanId === scan.id);
      if (existing) {
        design = existing;
        store.update((s) => (s.selectedDesignId = existing.id));
      } else {
        const params: ShellParams = {
          material: 'hard',
          wallThickness: 1.0,
          trimStation: defaultTrimStation(ec.moldType),
          edgeFillet: 0.35,
          ventDiameter: 2.0,
          soundTubeDiameter: 1.2,
        };
        design = {
          id: store.newId('design'),
          caseId: ec.id,
          side: ec.side,
          label: `${MOLD_TYPE_LABEL[ec.moldType]}-${new Date(scan.createdAt).toLocaleDateString('zh-CN')}`,
          scanId: scan.id,
          params,
          shellMesh: null,
          layout: { components: [], soundTubePath: [], ventPath: [], collisions: [] },
          note: '',
          createdAt: Date.now(),
        };
        void store.saveDesign(design);
      }
    }
    this.design = design;
  }

  private renderSide(): void {
    clear(this.sideEl);
    const scan = store.currentScan;
    const ec = store.currentCase;
    if (!scan || !ec || !this.design) {
      this.sideEl.append(h('div', { class: 'empty-hint' }, '请先在耳印扫描页生成或导入印模。'));
      return;
    }
    const d = this.design;
    const p = d.params;
    const settings = store.state.settings;
    const wallMin = wallMinFor(p.material, settings);
    const history = store.state.designs.filter((x) => x.caseId === ec.id);

    const update = (patch: Partial<ShellParams>): void => {
      Object.assign(p, patch);
      d.shellMesh = null;
      void store.saveDesign(d);
      this.rebuildShell();
    };

    this.sideEl.append(
      h('div', { class: 'section-title' }, h('h4', {}, '设计参数')),
      labelRow('当前壳型', h('div', { class: 'history-select' },
        selectInput(d.id, history.map((x) => ({ value: x.id, label: x.label })), (v) => {
          store.update((s) => (s.selectedDesignId = v));
          this.design = store.currentDesign;
          this.renderSide();
          this.rebuildShell();
        }),
        button('另存为新壳型（复诊）', () => this.forkDesign(), 'primary'),
      )),
      labelRow('壳体材料', selectInput(p.material, [
        { value: 'hard', label: `硬壳（壁厚下限 ${settings.wallMinHard}mm）` },
        { value: 'softSilicone', label: `软硅胶（壁厚下限 ${settings.wallMinSoftSilicone}mm）` },
      ], (v) => update({ material: v as ShellParams['material'] }))),
      labelRow(`壁厚 mm（下限 ${fmt(wallMin)}）`, numberInput(p.wallThickness, 0.05, 0.4, 3, (v) => update({ wallThickness: v })),
        p.wallThickness < wallMin ? '低于材料下限！' : undefined),
      labelRow(`截短保留比例 ${fmt(p.trimStation, 2)}`, slider(p.trimStation, 0.3, 1, 0.01, (v) => update({ trimStation: v })),
        '沿耳道中心线截掉多余长度'),
      labelRow('截面边缘倒圆 mm', numberInput(p.edgeFillet, 0.05, 0.1, 1.2, (v) => update({ edgeFillet: v }))),
      labelRow(`通气孔直径 ${fmt(p.ventDiameter)}mm（${settings.ventMin}~${settings.ventMax}）`,
        slider(p.ventDiameter, settings.ventMin, settings.ventMax, 0.1, (v) => update({ ventDiameter: v }))),
      labelRow('声管直径 mm', numberInput(p.soundTubeDiameter, 0.1, 0.6, 3, (v) => update({ soundTubeDiameter: v }))),
      h('hr'),
      this.buildInfoPanel(wallMin),
      h('hr'),
      this.clipPanel(),
      h('hr'),
      h('div', { class: 'section-title' }, h('h4', {}, `本耳例历次壳型（${history.length}，复诊新旧壳挂接）`)),
      ...history.map((x) => h('div', { class: `scan-record ${x.id === d.id ? 'active' : ''}` },
        h('div', {}, h('strong', {}, x.label), badge(x.params.material === 'hard' ? '硬壳' : '软胶')),
        h('div', { class: 'ear-case-meta' }, `壁厚 ${fmt(x.params.wallThickness)} · 通气孔 ${fmt(x.params.ventDiameter)}mm`),
      )),
    );
  }

  private buildInfoPanel(wallMin: number): HTMLElement {
    const box = h('div', { class: 'build-info' });
    if (!this.built) {
      box.append(h('div', { class: 'empty-hint small' }, '尚未构建壳体'));
      return box;
    }
    const b = this.built;
    box.append(
      h('div', { class: 'stat-row' }, h('span', {}, '保留耳道长度'), h('strong', {}, `${fmt(b.trimLength)} mm`)),
      h('div', { class: 'stat-row' }, h('span', {}, '最小壁厚'),
        h('strong', { class: b.minWall < wallMin ? 'stat-bad' : 'stat-ok' }, `${fmt(b.minWall)} mm`)),
      h('div', { class: 'stat-row' }, h('span', {}, '截面数'), h('strong', {}, String(b.sections.length))),
      ...b.warnings.map((w) => h('div', { class: 'warn-line' }, '⚠ ', w)),
      button('进入内部排布 →', () => store.goto('layout'), 'primary'),
    );
    return box;
  }

  private clipPanel(): HTMLElement {
    const box = h('div', {});
    box.append(
      h('div', { class: 'section-title' }, h('h4', {}, '截面剖切（切口封口着色）')),
      labelRow(`剖切位置 ${fmt(this.clipT * 100, 0)}%`, slider(this.clipT, 0.05, 1, 0.01, (v) => {
        this.clipT = v;
        this.renderSide();
        this.refreshViewport();
      })),
      button('取消剖切', () => {
        this.clipT = 1;
        this.renderSide();
        this.refreshViewport();
      }),
    );
    return box;
  }

  private rebuildShell(): void {
    const scan = store.currentScan;
    const d = this.design;
    if (!scan || !d || !this.viewport) return;
    const wallMin = wallMinFor(d.params.material, store.state.settings);
    const built = buildShell(scan.mesh, scan.landmarks, d.params, d.params.trimStation, wallMin);
    this.built = built;
    d.shellMesh = built.shellMesh;
    d.layout.ventPath = built.ventPath;
    void store.saveDesign(d);
    this.viewport.setWallMin(wallMin);
    this.refreshViewport();
    if (this.sideEl.isConnected) this.renderSide();
  }

  private refreshViewport(): void {
    if (!this.viewport || !this.built || !this.design) return;
    const scan = store.currentScan!;
    let shell = this.built.shellMesh;
    if (this.clipT < 0.999) {
      const sections = this.built.sections;
      const idx = Math.min(sections.length - 1, Math.max(1, Math.floor(this.clipT * (sections.length - 1))));
      const s = sections[idx];
      const tangent: Vec3Tuple = normalize3(sub3(sections[Math.min(idx + 1, sections.length - 1)].center, sections[Math.max(0, idx - 1)].center));
      shell = clipMeshAtStation(shell, s.center, tangent);
    }
    this.viewport.setScene({
      impression: scan.mesh,
      shell,
      landmarks: scan.landmarks,
      ventPath: this.built.ventPath,
      ventDiameter: this.design.params.ventDiameter,
      showCenterline: false,
    });
  }

  private forkDesign(): void {
    const base = this.design;
    const ec = store.currentCase;
    if (!base || !ec) return;
    const copy: ShellDesign = {
      ...structuredClone(base),
      id: store.newId('design'),
      label: `${MOLD_TYPE_LABEL[ec.moldType]}-复诊 ${new Date().toLocaleDateString('zh-CN')}`,
      shellMesh: null,
      createdAt: Date.now(),
    };
    void store.saveDesign(copy).then(() => {
      store.update((s) => (s.selectedDesignId = copy.id));
      this.design = store.currentDesign;
      this.renderSide();
      this.rebuildShell();
      toast('已基于旧壳创建新壳型，两者挂在同一耳例下', 'ok');
    });
  }

  dispose(): void {
    this.viewport?.dispose();
    this.viewport = null;
  }
}

type Vec3Tuple = [number, number, number];
function normalize3(a: Vec3Tuple): Vec3Tuple {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function sub3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

import type { PlacedComponent, ShellDesign, Vec3 } from '../../types';
import { checkCollisions, checkInsertionPath, tubeLength, type InsertionCheckResult } from '../../core/geometry/collision';
import { buildShell, defaultLayout, wallMinFor } from '../../core/geometry/shellBuilder';
import { store } from '../../core/state/store';
import { Viewport } from '../Viewport';
import { badge, button, clear, fmt, h, labelRow, numberInput, slider, toast } from '../dom';

export class LayoutPage {
  readonly el: HTMLElement;
  private viewportHost: HTMLElement;
  private sideEl: HTMLElement;
  private viewport: Viewport | null = null;
  private design: ShellDesign | null = null;
  private insertion: InsertionCheckResult | null = null;
  private sections: { center: Vec3; innerRadius: number; outerRadius: number; station: number; u: Vec3; v: Vec3 }[] = [];

  constructor() {
    this.el = h('div', { class: 'page page-layout' },
      h('div', { class: 'page-head' },
        h('h2', {}, '内部排布'),
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
    this.design = store.currentDesign;
    this.prepareLayout();
    this.renderSide();
    this.refreshViewport();
  }

  private ensureViewport(): void {
    if (this.viewport) return;
    this.viewport = new Viewport(store.state.layerStyles);
    this.viewportHost.append(this.viewport.container);
  }

  /** 重新计算壳体截面与默认排布 */
  private prepareLayout(): void {
    const scan = store.currentScan;
    const d = this.design;
    if (!scan || !d) return;
    const wallMin = wallMinFor(d.params.material, store.state.settings);
    const built = buildShell(scan.mesh, scan.landmarks, d.params, d.params.trimStation, wallMin);
    this.sections = built.sections;
    if (d.layout.components.length === 0) {
      d.layout = defaultLayout(built.sections, d.params);
    }
    d.layout.ventPath = built.ventPath;
    this.runChecks();
    d.shellMesh = built.shellMesh;
    void store.saveDesign(d);
  }

  private runChecks(): void {
    if (!this.design) return;
    this.design.layout.collisions = checkCollisions(this.design.layout, this.sections);
    const radii = this.sections.map((s) => s.outerRadius);
    const scan = store.currentScan;
    this.insertion = checkInsertionPath(
      this.sections,
      radii,
      scan?.landmarks.secondBend ?? this.sections[Math.floor(this.sections.length * 0.6)].center,
    );
  }

  private renderSide(): void {
    clear(this.sideEl);
    const d = this.design;
    if (!d) {
      this.sideEl.append(h('div', { class: 'empty-hint' }, '请先在外壳设计页生成壳型。'));
      return;
    }
    this.sideEl.append(
      h('div', { class: 'section-title' }, h('h4', {}, '器件清单（真实尺寸 mm）')),
      ...d.layout.components.map((c) => this.componentCard(c)),
      h('hr'),
      h('div', { class: 'section-title' }, h('h4', {}, '管路')),
      h('div', { class: 'stat-row' }, h('span', {}, '声管长度'), h('strong', {}, `${fmt(tubeLength(d.layout.soundTubePath))} mm`)),
      h('div', { class: 'stat-row' }, h('span', {}, '通气孔直径'), h('strong', {}, `${fmt(d.params.ventDiameter)} mm`)),
      labelRow('通气孔直径调整（联动外壳设计）', slider(d.params.ventDiameter, store.state.settings.ventMin, store.state.settings.ventMax, 0.1, (v) => {
        d.params.ventDiameter = v;
        void store.saveDesign(d);
        this.renderSide();
        this.refreshViewport();
      })),
      h('hr'),
      this.collisionPanel(),
      h('hr'),
      this.insertionPanel(),
    );
  }

  private componentCard(c: PlacedComponent): HTMLElement {
    const sizeText = c.size.radius !== undefined
      ? `Ø${fmt((c.size.radius ?? 0) * 2)} × 长${fmt(c.size.length ?? 0)}`
      : `${fmt(c.size.width ?? 0)}×${fmt(c.size.height ?? 0)}×${fmt(c.size.depth ?? 0)}`;
    const sectionCount = this.sections.length;
    const stationIdx = (() => {
      let best = 0;
      let bd = Infinity;
      this.sections.forEach((s, i) => {
        const dd = Math.hypot(s.center[0] - c.center[0], s.center[1] - c.center[1], s.center[2] - c.center[2]);
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      });
      return best;
    })();
    return h('div', { class: 'component-card' },
      h('div', { class: 'component-head' }, h('strong', {}, c.label), badge(sizeText)),
      labelRow(`沿耳道位置（站点 ${stationIdx}/${sectionCount - 1}）`,
        slider(stationIdx, 0, sectionCount - 1, 1, (v) => this.moveComponent(c.id, Math.round(v), undefined))),
      labelRow('横向偏移 mm', numberInput(this.lateralOf(c), 0.1, -6, 6, (v) => this.moveComponent(c.id, undefined, v))),
    );
  }

  private lateralOf(c: PlacedComponent): number {
    let best = this.sections[0];
    let bd = Infinity;
    for (const s of this.sections) {
      const dd = Math.hypot(s.center[0] - c.center[0], s.center[1] - c.center[1], s.center[2] - c.center[2]);
      if (dd < bd) {
        bd = dd;
        best = s;
      }
    }
    const dx = c.center[0] - best.center[0];
    const dy = c.center[1] - best.center[1];
    const dz = c.center[2] - best.center[2];
    return Math.hypot(dx, dy, dz) * (dx * best.u[0] + dy * best.u[1] + dz * best.u[2] >= 0 ? 1 : -1);
  }

  private moveComponent(id: string, station?: number, lateral?: number): void {
    const d = this.design;
    if (!d) return;
    const c = d.layout.components.find((x) => x.id === id);
    if (!c) return;
    const cur = (() => {
      let best = 0;
      let bd = Infinity;
      this.sections.forEach((s, i) => {
        const dd = Math.hypot(s.center[0] - c.center[0], s.center[1] - c.center[1], s.center[2] - c.center[2]);
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      });
      return best;
    })();
    const targetStation = station ?? cur;
    const targetLateral = lateral ?? this.lateralOf(c);
    const s = this.sections[Math.min(targetStation, this.sections.length - 1)];
    c.center = [
      s.center[0] + s.u[0] * targetLateral,
      s.center[1] + s.u[1] * targetLateral,
      s.center[2] + s.u[2] * targetLateral,
    ];
    c.axis = normalize3(sub3(
      this.sections[Math.min(targetStation + 1, this.sections.length - 1)].center,
      this.sections[Math.max(0, targetStation - 1)].center,
    ));
    this.runChecks();
    void store.saveDesign(d);
    this.renderSide();
    this.refreshViewport();
  }

  private collisionPanel(): HTMLElement {
    const cols = this.design?.layout.collisions ?? [];
    const box = h('div', {},
      h('div', { class: 'section-title' },
        h('h4', {}, `干涉检查（${cols.length}）`),
        h('div', { class: 'spacer' }),
        button('重新检查', () => {
          this.runChecks();
          this.renderSide();
        }),
      ),
    );
    if (cols.length === 0) {
      box.append(h('div', { class: 'ok-line' }, '✓ 器件、声管、通气孔之间未发现干涉'));
      return box;
    }
    for (const col of cols) {
      box.append(h('div', { class: `warn-line ${col.severity === 'error' ? 'stat-bad' : ''}` },
        col.severity === 'error' ? '✗ ' : '⚠ ', col.message));
    }
    return box;
  }

  private insertionPanel(): HTMLElement {
    const ins = this.insertion;
    const box = h('div', {});
    box.append(h('div', { class: 'section-title' }, h('h4', {}, '第二弯通过性（耳道式/深耳道式重点）')));
    if (!ins) return box;
    if (ins.pass) {
      box.append(h('div', { class: 'ok-line' },
        `✓ 可顺利通过第二弯，最小间隙 ${fmt(ins.minClearance)}mm，壳长 ${fmt(ins.totalLength)}mm`));
    } else {
      box.append(
        h('div', { class: 'warn-line stat-bad' }, `✗ 发现 ${ins.stuckPoints.length} 个卡点`),
        ...ins.stuckPoints.map((p) => h('div', { class: 'warn-line' }, `· 站点 ${fmt(p.station)}mm：${p.message}`)),
        h('div', { class: 'stat-row' }, h('span', {}, '建议截短至'), h('strong', { class: 'stat-bad' }, `${fmt(ins.suggestedTrimLength)} mm`)),
        button('应用建议截短长度', () => this.applyTrim(ins.suggestedTrimLength), 'primary'),
      );
    }
    return box;
  }

  private applyTrim(length: number): void {
    const d = this.design;
    if (!d || this.sections.length === 0) return;
    const total = this.sections[this.sections.length - 1].station;
    d.params.trimStation = Math.max(0.3, Math.min(1, length / total));
    d.shellMesh = null;
    void store.saveDesign(d).then(() => {
      this.prepareLayout();
      this.renderSide();
      this.refreshViewport();
      toast('已按建议截短并重新检查', 'ok');
    });
  }

  private refreshViewport(): void {
    if (!this.viewport || !this.design) return;
    const scan = store.currentScan;
    this.viewport.setScene({
      shell: this.design.shellMesh,
      components: this.design.layout.components,
      soundTubePath: this.design.layout.soundTubePath,
      ventPath: this.design.layout.ventPath,
      soundTubeDiameter: this.design.params.soundTubeDiameter,
      ventDiameter: this.design.params.ventDiameter,
      landmarks: scan?.landmarks ?? null,
      stuckPoints: this.insertion?.pass ? [] : this.insertion?.stuckPoints.map((p) => p.position) ?? [],
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

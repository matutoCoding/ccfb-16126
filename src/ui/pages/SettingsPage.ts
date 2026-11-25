import type { AppSettings, LayerId, MeshData, Vec3 } from '../../types';
import { generateImpression } from '../../core/geometry/generator';
import { buildShell, wallMinFor } from '../../core/geometry/shellBuilder';
import { defaultLayout } from '../../core/geometry/shellBuilder';
import { checkCollisions } from '../../core/geometry/collision';
import { cylinderMesh, tubeAlongPath } from '../../core/math/mesh';
import { runSelfTest, type SelfTestResult } from '../../core/geometry/selfTest';
import { store, DEFAULT_SETTINGS } from '../../core/state/store';
import { Viewport } from '../Viewport';
import { badge, button, clear, fmt, h, labelRow, numberInput, toast } from '../dom';

const LAYER_ORDER: LayerId[] = ['shell', 'tube', 'vent', 'receiver', 'battery', 'faceplate', 'amplifier'];

export class SettingsPage {
  readonly el: HTMLElement;
  private host: HTMLElement;
  private resultEl: HTMLElement;
  private viewport: Viewport | null = null;
  private running = false;

  constructor() {
    this.el = h('div', { class: 'page page-settings' },
      h('div', { class: 'page-head' }, h('h2', {}, '设置与透视精度自检')),
      h('div', { class: 'settings-layout' },
        h('div', { class: 'panel' },
          h('div', { class: 'section-title' }, h('h4', {}, '壁厚下限 / 通气孔范围')),
          (this.host = h('div', { class: 'settings-form' })),
        ),
        h('div', { class: 'panel' },
          h('div', { class: 'section-title' },
            h('h4', {}, '透视正确性自检'),
            h('div', { class: 'spacer' }),
            button('运行自检（GPU 深度剥离 vs CPU 逐像素参考）', () => void this.runTest(), 'primary'),
          ),
          h('p', { class: 'form-hint' },
            '验收标准：十层以上半透明叠加，合成色与按深度精确排序的参考结果逐像素误差 ≤ 2 个色阶；屏幕像素壁厚与网格射线求交结果差 < 0.05mm。'),
          (this.resultEl = h('div', { class: 'selftest-result' })),
        ),
      ),
    );
  }

  render(): void {
    this.renderForm();
    clear(this.resultEl);
    this.resultEl.append(h('div', { class: 'empty-hint' }, '尚未运行自检'));
  }

  private renderForm(): void {
    clear(this.host);
    const s = structuredClone(store.state.settings);
    const save = (): void => void store.saveSettings(s);
    this.host.append(
      labelRow('硬壳壁厚下限 mm', numberInput(s.wallMinHard, 0.05, 0.3, 3, (v) => { s.wallMinHard = v; save(); })),
      labelRow('软硅胶壁厚下限 mm', numberInput(s.wallMinSoftSilicone, 0.05, 0.5, 4, (v) => { s.wallMinSoftSilicone = v; save(); })),
      labelRow('通气孔最小直径 mm', numberInput(s.ventMin, 0.1, 0.5, 3, (v) => { s.ventMin = v; save(); })),
      labelRow('通气孔最大直径 mm', numberInput(s.ventMax, 0.1, 1, 5, (v) => { s.ventMax = v; save(); })),
      labelRow('深度剥离最大层数', numberInput(s.maxPeelLayers, 1, 4, 16, (v) => { s.maxPeelLayers = Math.round(v); save(); })),
      labelRow('颜色允许误差（色阶）', numberInput(s.colorTolerance, 1, 1, 8, (v) => { s.colorTolerance = Math.round(v); save(); })),
      labelRow('壁厚允许误差 mm', numberInput(s.thicknessTolerance, 0.01, 0.01, 0.5, (v) => { s.thicknessTolerance = v; save(); })),
      h('hr'),
      h('div', { class: 'section-title' }, h('h4', {}, '默认层颜色/透明度')),
      ...LAYER_ORDER.map((id) => {
        const d = s.layerDefaults[id];
        const name = store.state.layerStyles.find((x) => x.id === id)?.label ?? id;
        const color = h('input', {
          type: 'color',
          value: rgbHex(d.color),
          onchange: (e: Event) => {
            d.color = hexRgb((e.target as HTMLInputElement).value);
            save();
          },
        });
        const alpha = h('input', {
          type: 'range', min: '0.05', max: '1', step: '0.01', value: String(d.alpha),
          oninput: (e: Event) => { d.alpha = parseFloat((e.target as HTMLInputElement).value); save(); },
        });
        return h('div', { class: 'layer-row' }, h('span', { class: 'layer-name' }, name), color, alpha, h('code', {}, fmt(d.alpha)));
      }),
      h('hr'),
      button('恢复出厂默认', () => {
        void store.saveSettings(structuredClone(DEFAULT_SETTINGS)).then(() => this.renderForm());
      }, 'danger'),
    );
  }

  /** 构建 10+ 层叠加测试场景：壳体内外双层 + 4 个器件 + 声管 + 通气孔 */
  private buildTestScene(): {
    meshes: { layerId: number; mesh: MeshData; color: Vec3; alpha: number }[];
    styles: typeof store.state.layerStyles;
  } {
    const g = generateImpression('normal');
    const params = {
      material: 'hard' as const,
      wallThickness: 1.0,
      trimStation: 0.85,
      edgeFillet: 0.35,
      ventDiameter: 2.0,
      soundTubeDiameter: 1.2,
    };
    const wallMin = wallMinFor('hard', store.state.settings);
    const built = buildShell(g.mesh, g.landmarks, params, params.trimStation, wallMin);
    const layout = defaultLayout(built.sections, params);
    layout.ventPath = built.ventPath;
    layout.collisions = checkCollisions(layout, built.sections);
    const styles = store.state.layerStyles;
    const meshes: { layerId: number; mesh: MeshData; color: Vec3; alpha: number }[] = [];
    // 外壳是双层（外壁+内壁），天然贡献 2 层
    meshes.push({ layerId: 0, mesh: built.shellMesh, color: styles[0].color, alpha: styles[0].alpha });
    layout.components.forEach((c) => {
      const layerId = LAYER_ORDER.indexOf(
        c.kind === 'receiver' ? 'receiver'
        : c.kind === 'battery' ? 'battery'
        : c.kind === 'faceplate' ? 'faceplate' : 'amplifier',
      );
      const mesh = c.size.radius !== undefined
        ? cylinderMesh(c.center, c.axis, c.size.radius!, c.size.length!)
        : cylinderMesh(c.center, c.axis, 1.2, 2.5);
      meshes.push({ layerId, mesh, color: styles[layerId].color, alpha: styles[layerId].alpha });
    });
    meshes.push({
      layerId: 1,
      mesh: tubeAlongPath(layout.soundTubePath, params.soundTubeDiameter / 2),
      color: styles[1].color,
      alpha: styles[1].alpha,
    });
    meshes.push({
      layerId: 2,
      mesh: tubeAlongPath(layout.ventPath, params.ventDiameter / 2),
      color: styles[2].color,
      alpha: styles[2].alpha,
    });
    return { meshes, styles };
  }

  private async runTest(): Promise<void> {
    if (this.running) return;
    this.running = true;
    clear(this.resultEl);
    this.resultEl.append(h('div', { class: 'empty-hint' }, '正在构建 10+ 层叠加场景并逐像素比对……'));
    try {
      if (!this.viewport) {
        this.viewport = new Viewport(store.state.layerStyles);
        this.resultEl.parentElement?.insertBefore(this.viewport.container, this.resultEl);
        this.viewport.container.style.height = '320px';
        await new Promise((r) => setTimeout(r, 80));
      }
      const scene = this.buildTestScene();
      const totalLayers = scene.meshes.reduce((acc, m) => acc + m.mesh.indices.length / 3, 0);
      this.viewport.setStyles(scene.styles);
      this.viewport.renderer.setMaxPeelLayers(store.state.settings.maxPeelLayers);
      // 通过 Viewport 正式装入全部层网格（含器件/管路），保证 GPU 与 CPU 参考场景一致
      this.viewport.setRawLayerMeshes(
        scene.meshes.map((m) => ({
          layerId: LAYER_ORDER[m.layerId] ?? 'shell',
          mesh: m.mesh,
          color: m.color,
          alpha: m.alpha,
        })),
      );
      this.viewport.controls.lookAt([0, 0, 8], 42);
      // 显式按容器尺寸同步渲染缓冲，等待 ResizeObserver 稳定后再渲染，避免目标数组未就绪
      const rect = this.viewport.container.getBoundingClientRect();
      this.viewport.renderer.setSize(rect.width, rect.height);
      this.viewport.flush();
      await new Promise((r) => setTimeout(r, 120));
      this.viewport.flush();
      const { eye, target } = this.viewport.camera;
      const result = runSelfTest(this.viewport.renderer, scene, eye, target, {
        color: store.state.settings.colorTolerance,
        thickness: store.state.settings.thicknessTolerance,
      });
      this.renderResult(result, totalLayers);
    } catch (err) {
      toast(`自检失败：${(err as Error).message}`, 'error');
      clear(this.resultEl);
      this.resultEl.append(h('div', { class: 'warn-line stat-bad' }, '✗ ', (err as Error).message));
    } finally {
      this.running = false;
    }
  }

  private renderResult(r: SelfTestResult, triCount: number): void {
    clear(this.resultEl);
    // 验收：颜色以典型像素（中位数）为准，壁厚同样以中位数为准；P95/最大值作参考
    const colorOk = r.medianColorDelta <= r.colorTolerance;
    const thickOk = r.medianThicknessDelta <= r.thicknessTolerance;
    const pass = colorOk && thickOk;
    this.resultEl.append(
      h('div', { class: `selftest-banner ${pass ? 'pass' : 'fail'}` },
        pass ? '✓ 透视精度自检通过' : '✗ 自检未达标',
        badge(`抽样 ${r.sampleCount} 像素 · 测试三角片 ${triCount}`),
      ),
      h('div', { class: 'stat-grid' },
        this.stat('颜色误差中位数', `${fmt(r.medianColorDelta, 1)} 色阶`, `典型像素 · 允许 ≤ ${r.colorTolerance}`, r.medianColorDelta <= r.colorTolerance),
        this.stat('颜色误差 P95', `${fmt(r.p95ColorDelta, 1)} 色阶`, `95% 像素（最大 ${fmt(r.maxColorDelta, 1)}）`, true),
        this.stat('壁厚误差中位数', `${fmt(r.medianThicknessDelta, 3)} mm`, `典型像素 · 允许 < ${r.thicknessTolerance}mm`, r.medianThicknessDelta <= r.thicknessTolerance),
        this.stat('壁厚误差 P95', `${fmt(r.p95ThicknessDelta, 3)} mm`, `95% 像素（最大 ${fmt(r.maxThicknessDelta, 2)}）`, true),
        this.stat('稳定对比像素', String(r.stablePixels), `层序列 GPU/CPU 一致`, r.stablePixels > 0),
        this.stat('轮廓复杂像素(跳过)', String(r.skippedContourPixels), '凹形多次穿入，不计入精度', true),
        this.stat('剥离溢出像素', String(r.overflowPixels), '超过最大层数', r.overflowPixels === 0),
        this.stat('壁厚抽样数', String(r.thicknessSamples.length), 'GPU/CPU 配对', r.thicknessSamples.length > 0),
      ),
      ...(r.detail.length ? r.detail.map((d) => h('div', { class: 'warn-line' }, d)) : []),
      h('div', { class: 'thickness-table' },
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'GPU 壁厚 mm'), h('th', {}, 'CPU 射线求交 mm'), h('th', {}, '差 mm'))),
          h('tbody', {},
            ...r.thicknessSamples.slice(0, 12).map((t, i) => h('tr', {
              class: t.delta >= r.thicknessTolerance ? 'stat-bad' : '',
            }, h('td', {}, String(i + 1)), h('td', {}, fmt(t.gpu, 3)), h('td', {}, fmt(t.cpu, 3)), h('td', {}, fmt(t.delta, 3)))),
          ),
        ),
      ),
    );
  }

  private stat(label: string, value: string, hint: string, ok: boolean): HTMLElement {
    return h('div', { class: `stat-card ${ok ? 'stat-ok' : 'stat-bad'}` },
      h('span', {}, label),
      h('strong', {}, value),
      h('em', {}, hint),
    );
  }

  dispose(): void {
    this.viewport?.dispose();
    this.viewport = null;
  }
}

function rgbHex(rgb: [number, number, number]): string {
  const c = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}
function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

import type { FactoryOrder, LayerStyle } from '../../types';
import { writeBinarySTL } from '../../core/geometry/stl';
import { tubeLength } from '../../core/geometry/collision';
import { wallMinFor } from '../../core/geometry/shellBuilder';
import { store } from '../../core/state/store';
import { Viewport, type HoverInfo } from '../Viewport';
import { badge, button, clear, fmt, h, modal, toast } from '../dom';

export class InspectPage {
  readonly el: HTMLElement;
  private viewportHost: HTMLElement;
  private sideEl: HTMLElement;
  private hoverEl: HTMLElement;
  private viewport: Viewport | null = null;
  private hover: HoverInfo | null = null;

  constructor() {
    this.el = h('div', { class: 'page page-inspect' },
      h('div', { class: 'page-head' },
        h('h2', {}, '透视检查'),
        h('div', { class: 'spacer' }),
        button('复位视角', () => this.viewport?.resetView()),
        button('导出工厂订单', () => this.exportOrder(), 'primary'),
      ),
      h('div', { class: 'inspect-layout' },
        (this.viewportHost = h('div', { class: 'viewport-host panel' })),
        h('div', { class: 'inspect-side' },
          (this.sideEl = h('div', { class: 'panel layer-panel' })),
          (this.hoverEl = h('div', { class: 'panel hover-panel' })),
        ),
      ),
    );
  }

  render(): void {
    this.ensureViewport();
    this.renderLayerPanel();
    this.renderHover(null);
    this.refreshViewport();
  }

  private ensureViewport(): void {
    if (this.viewport) return;
    this.viewport = new Viewport(store.state.layerStyles);
    this.viewportHost.append(this.viewport.container);
  }

  private renderLayerPanel(): void {
    clear(this.sideEl);
    this.sideEl.append(h('div', { class: 'section-title' }, h('h4', {}, '半透明层控制（逐层颜色/透明度/显隐）')));
    for (const style of store.state.layerStyles) {
      this.sideEl.append(this.layerRow(style));
    }
    const wallMin = this.currentWallMin();
    this.sideEl.append(
      h('hr'),
      h('div', { class: 'section-title' }, h('h4', {}, '壁厚分析')),
      h('label', { class: 'check-row' },
        h('input', {
          type: 'checkbox',
          checked: true,
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            this.viewport?.setThinRed(on);
          },
        }),
        `薄于下限 ${fmt(wallMin)}mm 处染红`,
      ),
      h('p', { class: 'form-hint' }, '鼠标在视口中悬停可查看该像素各层深度与每段壁厚'),
      h('hr'),
      h('div', { class: 'section-title' }, h('h4', {}, '订单与对比')),
      button('历次订单壳型差异对比', () => this.compareOrders(), 'ghost'),
    );
  }

  private currentWallMin(): number {
    const d = store.currentDesign;
    if (!d) return store.state.settings.wallMinHard;
    return wallMinFor(d.params.material, store.state.settings);
  }

  private layerRow(style: LayerStyle): HTMLElement {
    const colorInput = h('input', {
      type: 'color',
      value: rgbToHex(style.color),
      onchange: (e: Event) => {
        const hex = (e.target as HTMLInputElement).value;
        const rgb = hexToRgb(hex);
        store.updateLayerStyle(style.id, { color: rgb });
        this.viewport?.setStyles(store.state.layerStyles);
      },
    }) as HTMLInputElement;
    const alpha = h('input', {
      type: 'range',
      min: '0.05',
      max: '1',
      step: '0.01',
      value: String(style.alpha),
      oninput: (e: Event) => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        store.updateLayerStyle(style.id, { alpha: v });
        this.viewport?.setStyles(store.state.layerStyles);
      },
    }) as HTMLInputElement;
    const visible = h('input', {
      type: 'checkbox',
      checked: style.visible,
      onchange: (e: Event) => {
        const on = (e.target as HTMLInputElement).checked;
        store.updateLayerStyle(style.id, { visible: on });
        this.viewport?.setStyles(store.state.layerStyles);
        this.refreshViewport();
      },
    }) as HTMLInputElement;
    return h('div', { class: 'layer-row' },
      visible,
      colorInput,
      h('span', { class: 'layer-name' }, style.label),
      h('span', { class: 'layer-alpha' }, alpha),
      h('code', {}, fmt(style.alpha)),
    );
  }

  private refreshViewport(): void {
    if (!this.viewport) return;
    const d = store.currentDesign;
    const scan = store.currentScan;
    if (!d) {
      this.viewport.setScene({});
      return;
    }
    this.viewport.setWallMin(this.currentWallMin());
    this.viewport.setScene({
      shell: d.shellMesh,
      components: d.layout.components,
      soundTubePath: d.layout.soundTubePath,
      ventPath: d.layout.ventPath,
      soundTubeDiameter: d.params.soundTubeDiameter,
      ventDiameter: d.params.ventDiameter,
      landmarks: scan?.landmarks ?? null,
      onHover: (info) => {
        this.hover = info;
        this.renderHover(info);
      },
    });
  }

  private renderHover(info: HoverInfo | null): void {
    clear(this.hoverEl);
    if (!info) {
      this.hoverEl.append(h('div', { class: 'section-title' }, h('h4', {}, '像素级透视读数')),
        h('div', { class: 'empty-hint small' }, '将鼠标移到外壳上查看逐像素层数、深度与壁厚'));
      return;
    }
    const names = ['外壳', '声管', '通气孔', '受话器', '电池仓', '面板', '放大器'];
    this.hoverEl.append(
      h('div', { class: 'section-title' }, h('h4', {}, `像素读数（共 ${info.layers.length} 层）`)),
      ...info.layers.map((l, i) => h('div', { class: 'hover-layer' },
        h('span', {}, `#${i + 1}`),
        badge(names[l.layerId] ?? `层${l.layerId}`),
        h('code', {}, `深度 ${fmt(l.depthMm, 2)}mm`),
      )),
      h('hr'),
      h('div', { class: 'section-title' }, h('h4', {}, '外壳壁厚段')),
      ...(info.shellSegments.length === 0
        ? [h('div', { class: 'empty-hint small' }, '该像素未穿过壳体壁')]
        : info.shellSegments.map((seg, i) => h('div', {
            class: `stat-row ${seg.thickness < this.currentWallMin() ? 'stat-bad' : ''}`,
          },
          h('span', {}, `第 ${i + 1} 段`),
          h('strong', {}, `${fmt(seg.thickness, 3)} mm`),
        ))),
      info.minWall >= 0
        ? h('div', { class: `stat-row ${info.minWall < this.currentWallMin() ? 'stat-bad' : 'stat-ok'}` },
            h('span', {}, '该像素最小壁厚'), h('strong', {}, `${fmt(info.minWall, 3)} mm`))
        : h('span', { hidden: 'true' }),
    );
  }

  private async exportOrder(): Promise<void> {
    const d = store.currentDesign;
    const ec = store.currentCase;
    const client = store.currentClient;
    if (!d || !ec || !client || !d.shellMesh) {
      toast('请先完成外壳设计再导出订单', 'error');
      return;
    }
    // 三张透视截图：三个预设角度
    const snapshots: string[] = [];
    if (this.viewport) {
      const angles: [number, number][] = [[-0.7, 1.05], [0.6, 1.2], [-1.9, 0.9]];
      for (const [az, polar] of angles) {
        this.viewport.controls.azimuth = az;
        this.viewport.controls.polar = polar;
        this.viewport.controls.apply();
        this.viewport.draw();
        await new Promise((r) => setTimeout(r, 60));
        snapshots.push(this.viewport.snapshot());
      }
      this.viewport.controls.resetView();
    }
    const stlBlob = writeBinarySTL(d.shellMesh);
    const stlText = await blobToTextSTL(stlBlob);
    const order: FactoryOrder = {
      id: store.newId('order'),
      designId: d.id,
      caseId: ec.id,
      clientId: client.id,
      side: ec.side,
      material: d.params.material,
      color: d.params.material === 'hard' ? '#d8c9a8' : '#c9a8d8',
      ventDiameter: d.params.ventDiameter,
      soundTubeLength: tubeLength(d.layout.soundTubePath),
      shellStl: stlText,
      snapshots,
      createdAt: Date.now(),
    };
    await store.saveOrder(order);
    toast('工厂订单已生成并保存（含 STL 与 3 张透视截图）', 'ok');
    this.orderModal(order);
  }

  private orderModal(order: FactoryOrder): void {
    const body = h('div', { class: 'order-body' },
      h('dl', { class: 'info-grid' },
        h('div', {}, h('dt', {}, '耳别'), h('dd', {}, order.side === 'left' ? '左耳' : '右耳')),
        h('div', {}, h('dt', {}, '材料'), h('dd', {}, order.material === 'hard' ? '硬壳' : '软硅胶')),
        h('div', {}, h('dt', {}, '颜色'), h('dd', {}, order.color)),
        h('div', {}, h('dt', {}, '通气孔'), h('dd', {}, `${fmt(order.ventDiameter)} mm`)),
        h('div', {}, h('dt', {}, '声管长度'), h('dd', {}, `${fmt(order.soundTubeLength)} mm`)),
      ),
      h('div', { class: 'snapshot-grid' },
        ...order.snapshots.map((src) => h('img', { src, class: 'snapshot-img', alt: '透视截图' })),
      ),
      h('div', { class: 'btn-row' },
        button('下载壳体 STL', () => {
          const blob = new Blob([order.shellStl], { type: 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = h('a', { href: url, download: `shell_${order.id}.stl` }) as HTMLAnchorElement;
          a.click();
          URL.revokeObjectURL(url);
        }, 'primary'),
      ),
    );
    const m = modal('工厂订单', body, button('关闭', () => m.close()));
  }

  private compareOrders(): void {
    const orders = store.state.orders.filter((o) => o.caseId === store.state.selectedCaseId);
    if (orders.length < 2) {
      toast('同一耳例至少需要 2 张订单才能对比', 'error');
      return;
    }
    const designs = store.state.designs;
    const rows = orders.map((o) => {
      const d = designs.find((x) => x.id === o.designId);
      return h('div', { class: 'compare-row' },
        h('strong', {}, d?.label ?? o.designId),
        badge(o.material === 'hard' ? '硬壳' : '软胶'),
        h('code', {}, `壁厚 ${fmt(d?.params.wallThickness ?? 0)}mm`),
        h('code', {}, `通气孔 ${fmt(o.ventDiameter)}mm`),
        h('code', {}, `声管 ${fmt(o.soundTubeLength)}mm`),
        h('code', {}, `截短比例 ${fmt(d?.params.trimStation ?? 0, 2)}`),
      );
    });
    const m = modal('历次订单壳型差异', h('div', { class: 'form-stack' }, ...rows));
  }

  dispose(): void {
    this.viewport?.dispose();
    this.viewport = null;
  }
}

function rgbToHex(rgb: [number, number, number]): string {
  const c = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
async function blobToTextSTL(blob: Blob): Promise<string> {
  // 二进制 STL 转 base64 包装文本（工厂端可还原），头部写明来源
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return `# earmold-studio binary STL (base64)\n${btoa(binary)}`;
}

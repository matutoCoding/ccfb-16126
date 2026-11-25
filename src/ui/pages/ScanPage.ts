import type { DefectMark, Landmarks, ScanRecord, Vec3 } from '../../types';
import { detectDefects, detectLandmarks } from '../../core/geometry/landmarks';
import { generateImpression, IMPRESSION_KIND_LABEL, type ImpressionKind } from '../../core/geometry/generator';
import { parseSTL } from '../../core/geometry/stl';
import { store } from '../../core/state/store';
import { Viewport } from '../Viewport';
import { badge, button, clear, fmtDate, h, labelRow, toast } from '../dom';

const KINDS: ImpressionKind[] = ['normal', 'narrow', 'sharpBend', 'bubbleDefect'];

export class ScanPage {
  readonly el: HTMLElement;
  private viewportHost: HTMLElement;
  private sideEl: HTMLElement;
  private viewport: Viewport | null = null;
  private scan: ScanRecord | null = null;

  constructor() {
    this.el = h('div', { class: 'page page-scan' },
      h('div', { class: 'page-head' },
        h('h2', {}, '耳印模扫描'),
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
    this.renderSide();
    this.refreshViewport();
  }

  private ensureViewport(): void {
    if (this.viewport) return;
    this.viewport = new Viewport(store.state.layerStyles);
    this.viewportHost.append(this.viewport.container);
  }

  private currentCaseScans(): ScanRecord[] {
    const caseId = store.state.selectedCaseId;
    if (!caseId) return [];
    return store.state.scans
      .filter((s) => s.caseId === caseId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private renderSide(): void {
    clear(this.sideEl);
    const ec = store.currentCase;
    if (!ec) {
      this.sideEl.append(h('div', { class: 'empty-hint' }, '请先在客户档案中选择耳例。'));
      return;
    }
    const scans = this.currentCaseScans();
    this.scan = store.currentScan ?? scans[0] ?? null;

    this.sideEl.append(
      h('div', { class: 'section-title' }, h('h4', {}, '测试印模（程序生成）')),
      h('div', { class: 'gen-grid' },
        ...KINDS.map((kind) => button(IMPRESSION_KIND_LABEL[kind], () => this.generate(kind), 'primary')),
      ),
      h('div', { class: 'section-title' }, h('h4', {}, '导入 STL 扫描')),
      this.stlInput(),
      h('hr'),
      h('div', { class: 'section-title' }, h('h4', {}, `本耳例扫描记录（${scans.length}）`)),
      ...(scans.length === 0
        ? [h('div', { class: 'empty-hint small' }, '暂无扫描')]
        : scans.map((s) => h('div', {
            class: `scan-record ${this.scan?.id === s.id ? 'active' : ''}`,
            onclick: () => {
              store.update((st) => {
                st.selectedScanId = s.id;
              });
              this.scan = s;
              this.renderSide();
              this.refreshViewport();
            },
          },
            h('div', {}, h('strong', {}, s.label), badge(s.source === 'stl' ? 'STL' : '生成')),
            h('div', { class: 'ear-case-meta' }, fmtDate(s.createdAt)),
          ))),
      h('hr'),
      this.landmarkPanel(),
      this.defectPanel(),
    );
  }

  private stlInput(): HTMLElement {
    const input = h('input', {
      type: 'file',
      accept: '.stl',
      onchange: async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        try {
          const buf = await file.arrayBuffer();
          const mesh = parseSTL(buf);
          if (mesh.indices.length === 0) throw new Error('STL 中没有三角形');
          const landmarks = detectLandmarks(mesh);
          const defects = detectDefects(mesh, landmarks);
          const ec = store.currentCase!;
          const scan: ScanRecord = {
            id: store.newId('scan'),
            caseId: ec.id,
            side: ec.side,
            label: file.name.replace(/\.stl$/i, ''),
            mesh,
            landmarks,
            defects,
            source: 'stl',
            createdAt: Date.now(),
          };
          await store.saveScan(scan);
          this.renderSide();
          this.refreshViewport();
          toast(`STL 已导入：${mesh.indices.length / 3} 个三角片，自动标志点与缺陷已标记`, 'ok');
        } catch (err) {
          toast(`STL 解析失败：${(err as Error).message}`, 'error');
        }
      },
    }) as HTMLInputElement;
    return h('div', { class: 'stl-drop' }, input, h('p', { class: 'form-hint' }, '支持二进制/ASCII STL，单位按毫米处理'));
  }

  private generate(kind: ImpressionKind): void {
    const ec = store.currentCase;
    if (!ec) return toast('请先选择耳例', 'error');
    const g = generateImpression(kind);
    const scan: ScanRecord = {
      id: store.newId('scan'),
      caseId: ec.id,
      side: ec.side,
      label: `测试印模-${IMPRESSION_KIND_LABEL[kind]}`,
      mesh: g.mesh,
      landmarks: g.landmarks,
      defects: g.defects,
      source: 'generated',
      createdAt: Date.now(),
    };
    void store.saveScan(scan).then(() => {
      this.scan = scan;
      this.renderSide();
      this.refreshViewport();
      toast(`已生成${IMPRESSION_KIND_LABEL[kind]}测试印模`, 'ok');
    });
  }

  private landmarkPanel(): HTMLElement {
    const box = h('div', { class: 'landmark-panel' });
    if (!this.scan) {
      box.append(h('div', { class: 'empty-hint small' }, '生成或导入印模后显示标志点'));
      return box;
    }
    const lm = this.scan.landmarks;
    const rows: [keyof Landmarks, string, Vec3][] = [
      ['aperture', '耳道口', lm.aperture],
      ['firstBend', '第一弯', lm.firstBend],
      ['secondBend', '第二弯', lm.secondBend],
    ];
    box.append(
      h('div', { class: 'section-title' },
        h('h4', {}, '解剖标志点（可在视口中拖拽球体贴中心线）'),
        h('div', { class: 'spacer' }),
        button('重新自动检测', () => this.redetect(), 'ghost'),
      ),
      ...rows.map(([key, label, p]) => h('div', { class: 'lm-row' },
        h('span', {}, label),
        h('code', {}, `(${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)})`),
      )),
      h('p', { class: 'form-hint' }, '中心线站点数：' + lm.centerline.length),
    );
    void rows;
    return box;
  }

  private defectPanel(): HTMLElement {
    const box = h('div', { class: 'defect-panel' });
    if (!this.scan) return box;
    box.append(h('div', { class: 'section-title' }, h('h4', {}, `缺陷标记（${this.scan.defects.length}）`)));
    if (this.scan.defects.length === 0) {
      box.append(h('div', { class: 'empty-hint small' }, '未检测到气泡或缺损'));
      return box;
    }
    for (const d of this.scan.defects) {
      box.append(h('div', { class: `defect-row defect-${d.kind}` },
        badge(d.kind === 'bubble' ? '气泡' : '缺损'),
        h('div', {},
          h('div', {}, d.note),
          h('code', {}, `r=${d.radius.toFixed(2)}mm @ (${d.position.map((x) => x.toFixed(1)).join(', ')})`),
        ),
      ));
    }
    return box;
  }

  private redetect(): void {
    if (!this.scan) return;
    const landmarks = detectLandmarks(this.scan.mesh);
    const defects = detectDefects(this.scan.mesh, landmarks);
    const updated: ScanRecord = { ...this.scan, landmarks, defects };
    void store.saveScan(updated).then(() => {
      this.scan = updated;
      this.renderSide();
      this.refreshViewport();
      toast('标志点与缺陷已重新检测', 'ok');
    });
  }

  private refreshViewport(): void {
    if (!this.viewport) return;
    const scan = this.scan ?? store.currentScan;
    if (!scan) {
      this.viewport.setScene({ showCenterline: false });
      return;
    }
    this.viewport.setScene({
      impression: scan.mesh,
      landmarks: scan.landmarks,
      defects: scan.defects,
      showCenterline: true,
      draggableLandmarks: true,
      onLandmarkDrag: (kind, pos) => this.dragLandmark(kind, pos),
    });
  }

  private dragLandmark(kind: 'aperture' | 'firstBend' | 'secondBend', pos: Vec3): void {
    if (!this.scan) return;
    const landmarks: Landmarks = structuredClone(this.scan.landmarks);
    landmarks[kind] = pos;
    const updated: ScanRecord = { ...this.scan, landmarks };
    this.scan = updated;
    void store.saveScan(updated);
    this.refreshViewport();
    // 数值面板延迟刷新（避免拖拽中频繁重建侧栏）
    clearTimeout(this._dragTimer);
    this._dragTimer = window.setTimeout(() => this.renderSide(), 200);
  }
  private _dragTimer = 0;

  dispose(): void {
    this.viewport?.dispose();
    this.viewport = null;
  }
}

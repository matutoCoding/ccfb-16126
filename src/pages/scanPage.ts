// 耳印扫描页：生成测试印模 / 导入 STL，自动定位耳道口、第一弯、第二弯，标记缺陷
import { h, clear, toast, field } from '../ui/dom';
import { createViewerHost, ViewerHost } from '../ui/viewerHost';
import { store } from '../state/store';
import { generateImpression, ImpressionKind, KIND_LABEL, ALL_KINDS } from '../core/impression';
import { markerMesh, ViewerEntry } from '../render/viewer';
import { parseSTL } from '../core/mesh';
import { Centerline, detectBends, Landmark } from '../core/centerline';
import { polylineToTubeMesh } from '../render/viewer';
import { Vec3, v3 } from '../core/math';

const KIND_COLOR: Record<ImpressionKind, Vec3> = {
  normal: [0.62, 0.78, 0.95],
  narrow: [0.95, 0.82, 0.5],
  sharpBend: [0.8, 0.65, 0.95],
  bubbleDefect: [0.95, 0.6, 0.55],
};

export function scanPage(root: HTMLElement): void {
  const host = createViewerHost();
  const col = h('div', { class: 'page-col scroll' });
  let current: { kind: ImpressionKind | 'imported'; label: string } | null = null;

  const showImpression = (kind: ImpressionKind): void => {
    const imp = generateImpression(kind, 96);
    store.setImpression(imp);
    current = { kind, label: KIND_LABEL[kind] };
    populateViewer(host, imp);
    renderInfo();
    toast(`已生成${KIND_LABEL[kind]}`);
  };

  const renderInfo = (): void => {
    clear(col);
    const imp = store.state.impression;
    col.append(
      h('div', { class: 'card' },
        h('h3', {}, '测试耳印模生成'),
        h('div', { class: 'muted', style: { marginBottom: '8px' } }, '程序化生成 4 副典型印模，无需外部文件'),
        ...ALL_KINDS.map((k) =>
          h('button', {
            class: 'btn ghost',
            style: { width: '100%', marginBottom: '6px', textAlign: 'left' },
            onclick: () => showImpression(k),
          }, KIND_LABEL[k])),
      ),
      h('div', { class: 'card' },
        h('h3', {}, '导入 STL 耳印模'),
        h('input', {
          type: 'file', accept: '.stl',
          onchange: async (e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            try {
              const buf = await file.arrayBuffer();
              const mesh = parseSTL(buf);
              toast(`STL 已导入：${mesh.indices.length / 3} 个三角面`);
              // 导入网格暂以独立条目展示，中心线用包围盒主轴近似
              const v = host.ensure();
              v.clear();
              v.setEntry({ id: 'imported', label: file.name, mesh, color: [0.7, 0.8, 0.9], alpha: 1, visible: true, pickable: true });
              v.fitView();
              current = { kind: 'imported', label: file.name };
            } catch (err) {
              toast('STL 解析失败：' + (err as Error).message);
            }
          },
        }),
      ),
    );

    if (imp && current) {
      const lm = imp.landmarks;
      col.append(
        h('div', { class: 'card' },
          h('h3', {}, '自动标记点'),
          metric('类型', current.label),
          metric('中心线总长', `${imp.centerline.totalLen.toFixed(2)} mm`),
          metric('耳道口', `s=${lm.aperture.toFixed(2)} mm`),
          metric('第一弯', `s=${lm.firstBend.toFixed(2)} mm`),
          metric('第二弯', `s=${lm.secondBend.toFixed(2)} mm`),
          metric('三角面数', String(imp.mesh.indices.length / 3)),
          h('div', { class: 'muted', style: { marginTop: '8px' } }, '标记球可在 3D 视图中查看；红色为气泡/缺损'),
        ),
      );
      if (imp.defects.length) {
        col.append(
          h('div', { class: 'card' },
            h('h3', {}, `缺陷标注（${imp.defects.length} 处）`),
            ...imp.defects.map((d, i) =>
              h('div', { class: 'metric' },
                h('span', { class: 'k' }, `${d.type === 'bubble' ? '气泡坑' : '取模缺损'} #${i + 1}`),
                h('span', { class: 'v' }, `r=${d.radius.toFixed(2)}mm`),
              )),
            h('div', { class: 'muted' }, '印模未取到/含气泡的区域已在表面标红，设计外壳时需避让或补取'),
          ),
        );
      }
      col.append(
        h('div', { class: 'card' },
          h('h3', {}, '操作'),
          h('button', { class: 'btn', style: { width: '100%' }, onclick: () => { window.location.hash = 'shell'; } }, '前往外壳设计 →'),
        ),
      );
    }
  };

  renderInfo();
  // 若已有印模（从其他页返回），恢复显示
  if (store.state.impression) populateViewer(host, store.state.impression);

  clear(root);
  root.append(h('div', { class: 'page' }, col, host.wrap));
}

function metric(k: string, v: string): HTMLElement {
  return h('div', { class: 'metric' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
}

function populateViewer(host: ViewerHost, imp: ReturnType<typeof generateImpression>): void {
  const v = host.ensure();
  v.clear();
  const color = KIND_COLOR[imp.kind];
  const entries: ViewerEntry[] = [
    { id: 'impression', label: '耳印模', mesh: imp.mesh, color, alpha: 0.9, visible: true, pickable: true },
  ];
  // 中心线
  const clPts = imp.centerline.sampleStations(40).map((st) => st.point);
  entries.push({
    id: 'centerline', label: '中心线',
    mesh: polylineToTubeMesh(clPts, 0.12), color: [0.2, 0.9, 0.9], alpha: 1, visible: true, pickable: false,
  });
  // 三个标记点
  const marks: [string, Vec3, Vec3][] = [
    ['aperture', imp.landmarkPoints.aperture, [1, 1, 1]],
    ['firstBend', imp.landmarkPoints.firstBend, [1, 0.85, 0.2]],
    ['secondBend', imp.landmarkPoints.secondBend, [1, 0.4, 0.2]],
  ];
  for (const [id, pt, c] of marks) {
    entries.push({ id: `mark-${id}`, label: id, mesh: markerMesh(pt, 0.45, c), color: c, alpha: 1, visible: true, pickable: false });
  }
  // 缺陷标红
  imp.defects.forEach((d, i) => {
    entries.push({
      id: `defect-${i}`, label: '缺陷',
      mesh: markerMesh(d.center, d.radius * 0.9, [1, 0.1, 0.1]),
      color: [1, 0.1, 0.1], alpha: 0.85, visible: true, pickable: false,
    });
  });
  for (const e of entries) v.setEntry(e);
  v.transparent = false;
  v.fitView();
}

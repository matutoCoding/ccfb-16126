// 外壳设计页：壁厚偏移、材料壁厚下限、沿耳道截短、边缘倒圆、通气孔/声管，实时重建
import { h, clear, toast, field, slider, fmt } from '../ui/dom';
import { createViewerHost, ViewerHost } from '../ui/viewerHost';
import { store } from '../state/store';
import {
  designShell, defaultParams, ShellDesignParams, ShellMaterial, MATERIAL_LABEL, WALL_LIMIT, findThinSpots,
} from '../core/shell';
import { markerMesh, polylineToTubeMesh, ViewerEntry } from '../render/viewer';
import { exportBinarySTL, downloadBlob } from '../core/mesh';
import { Vec3 } from '../core/math';

let rebuildTimer = 0;

export function shellPage(root: HTMLElement): void {
  const host = createViewerHost();
  const col = h('div', { class: 'page-col wide scroll' });
  const imp = store.state.impression;

  if (!imp) {
    clear(root);
    root.append(h('div', { class: 'page' }, col, h('div', { class: 'viewer-wrap' },
      h('div', { class: 'empty-hint' }, '请先在「耳印扫描」页生成或导入耳印模'))));
    return;
  }

  let params: ShellDesignParams = store.state.shellParams
    ? { ...store.state.shellParams, ventPath: [...store.state.shellParams.ventPath], soundPath: [...store.state.shellParams.soundPath] }
    : defaultParams(imp);

  const build = (showToast = false): void => {
    const res = designShell(imp.field, imp, params, 96);
    store.setShell(params, res);
    const v = host.ensure();
    v.clear();
    v.transparent = false;
    v.setEntry({ id: 'shell', label: '外壳', mesh: res.mesh, color: [0.72, 0.8, 0.88], alpha: 1, visible: true, pickable: true });
    // 声管、通气孔路径可视化
    if (params.soundPath.length >= 2) {
      v.setEntry({ id: 'sound', label: '声管', mesh: polylineToTubeMesh(params.soundPath, params.soundTubeDiameter / 2), color: [0.2, 0.95, 0.5], alpha: 0.9, visible: true, pickable: false });
    }
    if (params.ventPath.length >= 2) {
      v.setEntry({ id: 'vent', label: '通气孔', mesh: polylineToTubeMesh(params.ventPath, params.ventDiameter / 2), color: [0.95, 0.7, 0.2], alpha: 0.9, visible: true, pickable: false });
    }
    v.fitView();
    if (showToast) toast(`外壳已重建：${res.mesh.indices.length / 3} 三角面`);
    renderThin(res);
  };

  const scheduleBuild = (): void => {
    clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(() => build(), 180);
  };

  const thinCard = h('div', { class: 'card' });
  const renderThin = (res: ReturnType<typeof designShell>): void => {
    const spots = findThinSpots(res.field, imp, params, 120);
    clear(thinCard);
    const limit = WALL_LIMIT[params.material];
    thinCard.append(
      h('h3', {}, '壁厚下限校验'),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '当前材料壁厚下限'), h('span', { class: 'v' }, `${limit.toFixed(1)} mm`)),
      spots.length === 0
        ? h('div', { style: { padding: '8px 0' } }, h('span', { class: 'tag ok' }, '✓ 全部点位满足下限'))
        : h('div', {},
            h('div', { style: { padding: '8px 0' } }, h('span', { class: 'tag bad' }, `✗ ${spots.length} 处薄于下限`)),
            ...spots.slice(0, 12).map((s) => {
              host.ensure().setEntry({
                id: `thin-${Math.round(s.point[0] * 10)}-${Math.round(s.point[2] * 10)}`,
                label: '薄片', mesh: markerMesh(s.point, 0.28, [1, 0.15, 0.1] as Vec3),
                color: [1, 0.15, 0.1], alpha: 1, visible: true, pickable: false,
              });
              return h('div', { class: 'metric' }, h('span', { class: 'k' }, '壁厚'), h('span', { class: 'v fail' }, `${fmt(s.thickness)} mm`));
            }),
          ),
    );
  };

  const controls = h('div', {},
    h('div', { class: 'card' },
      h('h3', {}, '材料与壁厚'),
      field('壳体材料', h('select', {
        onchange: (e: Event) => {
          params.material = (e.target as HTMLSelectElement).value as ShellMaterial;
          // 切换材料时若低于下限自动抬到下限
          if (params.wallThickness < WALL_LIMIT[params.material]) params.wallThickness = WALL_LIMIT[params.material];
          scheduleBuild(); renderControls();
        },
      }, ...(['hard', 'soft'] as ShellMaterial[]).map((m) =>
        h('option', { value: m, selected: params.material === m }, `${MATERIAL_LABEL[m]}（下限 ${WALL_LIMIT[m]}mm）`)))),
      rangeField('名义壁厚 (mm)', params.wallThickness, 0.5, 3, 0.05, (val) => { params.wallThickness = val; scheduleBuild(); renderControls(); }),
      rangeField('边缘倒圆半径 (mm)', params.edgeRadius, 0.1, 1.5, 0.05, (val) => { params.edgeRadius = val; scheduleBuild(); renderControls(); }),
    ),
    h('div', { class: 'card' },
      h('h3', {}, '沿耳道截短'),
      rangeField('截短位置 s (mm)', params.trimS, imp.landmarks.firstBend + 1, imp.centerline.totalLen - 1, 0.25, (val) => { params.trimS = val; scheduleBuild(); renderControls(); }),
      rangeField('面板位置 s (mm)', params.faceplateS, 0.5, 4, 0.1, (val) => { params.faceplateS = val; scheduleBuild(); renderControls(); }),
      h('div', { class: 'muted' }, `第一弯 s=${fmt(imp.landmarks.firstBend)} · 第二弯 s=${fmt(imp.landmarks.secondBend)}`),
    ),
    h('div', { class: 'card' },
      h('h3', {}, '管路'),
      rangeField('通气孔直径 (mm)', params.ventDiameter, 1, 3, 0.1, (val) => { params.ventDiameter = val; scheduleBuild(); renderControls(); }),
      rangeField('声管外径 (mm)', params.soundTubeDiameter, 0.6, 2.5, 0.1, (val) => { params.soundTubeDiameter = val; scheduleBuild(); renderControls(); }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost', onclick: () => { params.ventPath = []; scheduleBuild(); renderControls(); } }, '移除通气孔'),
        h('button', { class: 'btn ghost', onclick: () => { params.soundPath = []; scheduleBuild(); renderControls(); } }, '移除声管'),
      ),
    ),
    h('div', { class: 'card' },
      h('h3', {}, '输出'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => build(true) }, '立即重建'),
        h('button', {
          class: 'btn ghost', onclick: () => {
            const res = store.state.shellResult;
            if (res) { downloadBlob(exportBinarySTL(res.mesh), `shell-${params.material}.stl`); toast('壳体 STL 已导出'); }
          },
        }, '导出 STL'),
      ),
    ),
    thinCard,
  );

  function renderControls(): void {
    clear(col);
    col.append(controls);
    // 重建后 thinCard 已被 renderThin 填充，重新挂回
    if (!col.contains(thinCard)) col.append(thinCard);
  }
  renderControls();
  build();

  clear(root);
  root.append(h('div', { class: 'page' }, col, host.wrap));
}

function rangeField(label: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void): HTMLElement {
  const val = h('span', { class: 'v mono' }, fmt(value));
  return h('div', { class: 'field' },
    h('label', {}, label),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      slider(min, max, step, value, (v) => { onInput(v); val.textContent = fmt(v); }),
      val,
    ),
  );
}

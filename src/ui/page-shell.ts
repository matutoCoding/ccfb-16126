/** 页面 3：外壳设计 —— 壁厚偏置 / 沿耳道截短 / 截面倒圆 / 材料下限校验 */
import { app } from '../state';
import { h, clear, toast, fmt } from './dom';
import { MIN_WALL, ShellMaterial, MATERIAL_LABEL, ShellStyle, SHELL_STYLE_LABEL } from '../core/types';
import { Viewport, defaultLayerConfig, createViewportDeferred } from '../render/Viewport';
import { buildScene, centerOfBounds, boundsRadius } from '../render/scene';
import { createDefaultDesign, buildShellWithStyle } from '../design-service';
import { boundaryEdges, signedVolume } from '../core/geometry';
import { radialWallThickness } from '../core/analysis';

export function renderShellPage(root: HTMLElement): void {
  clear(root);
  root.append(h('h2', {}, '外壳设计（偏置壁厚 · 截短 · 倒圆）'));
  const c = app.currentCustomer;
  const im = app.currentImpression;
  if (!c || !im) { root.append(h('div', { class: 'card muted' }, '请先选择客户并在「耳印扫描」准备印模。')); return; }
  const ear = c.ears[app.currentSide];

  const viewHost = h('div', { class: 'viewport-wrap' });
  const panel = h('div', { class: 'card', style: 'width:330px;flex:0 0 330px;overflow:auto' });
  root.append(h('div', { style: 'display:flex;gap:16px;height:calc(100% - 40px);min-height:0' }, viewHost, panel));

  let viewport: Viewport | null = null;
  let design = app.currentDesign;
  let shell = app.currentShell;

  const ensureDesign = (): boolean => {
    if (design && shell) return true;
    const d = createDefaultDesign(c.id, im, ear.shellStyle, ear.material);
    design = d;
    shell = buildShellWithStyle(im, d, ear.shellStyle);
    app.saveDesign(d, shell);
    return true;
  };

  const rebuild = () => {
    if (!design) return;
    shell = buildShellWithStyle(im, design, ear.shellStyle);
    if (design) app.shellCache.set(design.id, shell);
    if (viewport) {
      viewport.setItems(buildScene(shell, design, im, false));
      const center = centerOfBounds(im.centerline);
      viewport.frame(center, boundsRadius(im.centerline, center) + 3);
    }
    drawStats();
  };

  const statBox = h('div', {});
  const drawStats = () => {
    clear(statBox);
    if (!shell || !design) return;
    const edges = boundaryEdges(shell.mesh);
    const vol = signedVolume(shell.mesh);
    const minWallLimit = design.material === 'silicone'
      ? app.settings.siliconeMinWall
      : app.settings.hardMinWall;
    const samples = radialWallThickness(shell.mesh, shell.frames, shell.stationRange, 16);
    const min = Math.min(...samples.map((s) => s.thicknessMm));
    const avg = samples.reduce((a, s) => a + s.thicknessMm, 0) / Math.max(1, samples.length);
    const tooThin = samples.filter((s) => s.thicknessMm < minWallLimit).length;
    statBox.append(
      h('h3', {}, '壳体质量'),
      h('div', { class: 'badge ' + (edges.length === 0 ? 'ok' : 'bad'), style: 'margin:4px 6px 4px 0' },
        edges.length === 0 ? '水密闭合 ✓（射线壁厚有效）' : `存在 ${edges.length} 条开口边`),
      h('div', { class: 'muted', style: 'margin:6px 0' }, `封闭体积：${fmt(Math.abs(vol), 1)} mm³ · 三角面：${shell.mesh.indices.length / 3}`),
      h('table', { class: 'data' },
        h('tbody', {},
          h('tr', {}, h('td', {}, '壁厚下限（' + MATERIAL_LABEL[design.material] + '）'), h('td', { class: 'mono' }, `${minWallLimit} mm`)),
          h('tr', {}, h('td', {}, '实测最小壁厚'), h('td', { class: 'mono ' + (min < minWallLimit ? 'badge bad' : '') }, `${fmt(min, 3)} mm`)),
          h('tr', {}, h('td', {}, '平均壁厚'), h('td', { class: 'mono' }, `${fmt(avg, 3)} mm`)),
          h('tr', {}, h('td', {}, '低于下限采样点'), h('td', { class: 'mono' }, `${tooThin} / ${samples.length}`)),
          h('tr', {}, h('td', {}, '截掉长度'), h('td', { class: 'mono' }, `${fmt(shell.trimLengthMm, 2)} mm`)),
        ),
      ),
    );
  };

  const drawPanel = () => {
    clear(panel);
    ensureDesign();
    const d = design!;
    const limit = d.material === 'silicone' ? app.settings.siliconeMinWall : app.settings.hardMinWall;

    const wallInput = h('input', { type: 'range', min: String(Math.max(0.3, limit - 0.2)), max: '2.5', step: '0.05', value: String(d.wallThickness) }) as HTMLInputElement;
    const wallVal = h('span', { class: 'mono' }, `${fmt(d.wallThickness, 2)} mm`);
    const trimInput = h('input', { type: 'range', min: '0.45', max: '0.98', step: '0.01', value: String(d.trimPosition) }) as HTMLInputElement;
    const trimVal = h('span', { class: 'mono' }, `${Math.round(d.trimPosition * 100)}%`);
    const edgeInput = h('input', { type: 'range', min: '0.1', max: '1.2', step: '0.05', value: String(d.edgeRadius) }) as HTMLInputElement;
    const edgeVal = h('span', { class: 'mono' }, `${fmt(d.edgeRadius, 2)} mm`);
    const ventInput = h('input', { type: 'range', min: '1', max: '3', step: '0.1', value: String(d.vent?.diameterMm ?? 1.6) }) as HTMLInputElement;
    const ventVal = h('span', { class: 'mono' }, `${fmt(d.vent?.diameterMm ?? 1.6, 1)} mm`);
    const colorInput = h('input', { type: 'color', value: d.color }) as HTMLInputElement;
    const matSel = h('select', {}, ...(Object.keys(MIN_WALL) as ShellMaterial[]).map((m) =>
      h('option', { value: m, ...(d.material === m ? { selected: true } : {}) }, MATERIAL_LABEL[m]))) as HTMLSelectElement;
    const styleSel = h('select', {}, ...(Object.keys(SHELL_STYLE_LABEL) as ShellStyle[]).map((m) =>
      h('option', { value: m, ...(ear.shellStyle === m ? { selected: true } : {}) }, SHELL_STYLE_LABEL[m]))) as HTMLSelectElement;

    const apply = async (newVersion = false) => {
      if (!design) return;
      if (newVersion) {
        design = { ...design, id: `design-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, version: design.version + 1, createdAt: Date.now() };
      }
      await app.saveDesign(design, shell ?? undefined);
      rebuild();
    };

    panel.append(
      h('h3', {}, '机型 / 材料'),
      h('label', { class: 'field' }, h('span', {}, '机型（改机型影响耳甲保留量）'), styleSel),
      h('label', { class: 'field' }, h('span', {}, '壳体材料（硬壳/软硅胶下限不同）'), matSel),
      h('div', { class: 'muted', style: 'margin-bottom:8px' },
        `当前下限：硬壳 ${app.settings.hardMinWall}mm / 软硅胶 ${app.settings.siliconeMinWall}mm`),

      h('h3', {}, '壁厚（沿印模面向内偏置）'),
      h('div', { class: 'slider-row' }, wallInput, wallVal),
      h('div', { class: 'muted' }, `低于材料下限 ${limit}mm 的区域将在透视检查染红`),

      h('h3', {}, '沿耳道方向截短'),
      h('div', { class: 'slider-row' }, trimInput, trimVal),

      h('h3', {}, '截面边缘自动倒圆'),
      h('div', { class: 'slider-row' }, edgeInput, edgeVal),

      h('h3', {}, '通气孔直径（1–3 mm）'),
      h('div', { class: 'slider-row' }, ventInput, ventVal),

      h('h3', {}, '壳体颜色（订单用）'),
      colorInput,

      h('div', { style: 'display:flex;gap:8px;margin:14px 0' },
        h('button', { class: 'btn', onclick: () => apply(false) }, '保存修改'),
        h('button', { class: 'btn ghost', onclick: () => apply(true) }, '存为新版本'),
      ),
      statBox,
    );

    wallInput.oninput = () => { d.wallThickness = Number(wallInput.value); wallVal.textContent = `${fmt(d.wallThickness, 2)} mm`; rebuild(); };
    trimInput.oninput = () => { d.trimPosition = Number(trimInput.value); trimVal.textContent = `${Math.round(d.trimPosition * 100)}%`; rebuild(); };
    edgeInput.oninput = () => { d.edgeRadius = Number(edgeInput.value); edgeVal.textContent = `${fmt(d.edgeRadius, 2)} mm`; rebuild(); };
    ventInput.oninput = () => {
      const v = Number(ventInput.value);
      ventVal.textContent = `${fmt(v, 1)} mm`;
      if (d.vent) d.vent.diameterMm = v;
      rebuild();
    };
    colorInput.oninput = () => { d.color = colorInput.value; rebuild(); };
    matSel.onchange = () => {
      d.material = matSel.value as ShellMaterial;
      const newLimit = d.material === 'silicone' ? app.settings.siliconeMinWall : app.settings.hardMinWall;
      if (d.wallThickness < newLimit) d.wallThickness = newLimit + 0.1;
      drawPanel(); rebuild();
    };
    styleSel.onchange = async () => {
      ear.shellStyle = styleSel.value as ShellStyle;
      await app.saveCustomer(c);
      rebuild();
      toast('机型已变更，壳体耳甲保留量已重建');
    };
  };

  createViewportDeferred(viewHost, [0, 0, 0], 30, {
    layerConfig: defaultLayerConfig(),
    heatMode: false,
    minWall: app.settings.hardMinWall,
    clip: { point: [0, 0, 0], normal: [1, 0, 0], enabled: false },
  }, (vp) => {
    viewport = vp;
    ensureDesign();
    drawPanel();
    rebuild();
  });
}

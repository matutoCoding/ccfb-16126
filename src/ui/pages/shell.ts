import { getCurrentDesign, persistDesign, rebuildDesign } from '../../state';
import { WALL_LIMITS } from '../../geom/shell';
import { writeBinarySTL } from '../../geom/stl';
import { createSphereMesh } from '../../geom/mesh';
import { mat4Compose } from '../../math/vec';
import { WebGLRenderer, type SceneObject } from '../../render/Renderer';
import { PointerOrbitControls } from '../../render/camera';
import type { MaterialType, MoldType } from '../../types';
import { h, downloadBlob, fmt } from '../dom';
import { sliderField, selectField } from '../controls';
import type { UiContext } from '../context';
import { buildSceneObjects } from '../sceneFactory';
import { openOrderCreator } from '../orders';

export function renderShellPage(ctx: UiContext) {
  const scan = ctx.state.scans.find(s => s.id === ctx.state.currentScanId) ?? ctx.state.scans[0];
  const maybeDesign = scan ? getCurrentDesign(ctx.state) : undefined;
  if (!scan || !maybeDesign) {
    return h('div', { class: 'card card-bd helper-box', text: '请先在耳印扫描页选择或导入耳印。' });
  }
  const design = maybeDesign;

  const element = h('div', { class: 'page-grid grid-3' });
  const controlsCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', { text: '外壳参数' })));
  const controlsBody = h('div', { class: 'card-bd stack' });
  controlsCard.append(controlsBody);

  const canvas = h('canvas') as HTMLCanvasElement;
  const wrap = h('div', { class: 'canvas-wrap' }, canvas, h('div', { class: 'canvas-hint', text: '外壳按耳印面内偏生成；红色为低于材料壁厚下限的像素区域' }));
  const viewer = h('div', { class: 'card viewer-card' },
    h('div', { class: 'viewer-toolbar' },
      h('strong', { class: 'grow', text: scan.name }),
      h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: true }), '壁厚热图'),
      h('button', { class: 'btn sm', text: '导出壳体 STL' }),
      h('button', { class: 'btn primary sm', text: '工厂订单', onClick: () => openOrderCreator(ctx) })
    ),
    wrap
  );
  const heatCheckbox = viewer.querySelector('input[type=checkbox]') as HTMLInputElement;
  const exportBtn = viewer.querySelectorAll('button')[0] as HTMLButtonElement;
  exportBtn.addEventListener('click', () => downloadBlob(writeBinarySTL(design.shellMesh, 'ear-shell'), 'ear-shell.stl'));

  const resultCard = h('div', { class: 'card right-panel' }, h('div', { class: 'card-hd' }, h('h3', { text: '可制造性 / 过弯' })));
  const resultBody = h('div', { class: 'card-bd stack' });
  resultCard.append(resultBody);
  element.append(controlsCard, viewer, resultCard);

  let renderer: WebGLRenderer | null = null;
  let orbit: PointerOrbitControls | null = null;
  let ro: ResizeObserver | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const stuckSphere = createSphereMesh(1.4, 16, 20);

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void persistDesign(design), 350);
  }

  function rebuild() {
    rebuildDesign(design, scan);
    scheduleSave();
    draw();
    renderResults();
  }

  function draw() {
    if (!renderer) return;
    const objects: SceneObject[] = buildSceneObjects(scan, design, { includeImpression: true, includeMarkers: false, includeDefects: false, includeInternals: false });
    const shell = objects.find(o => o.id === 'shell');
    if (shell && heatCheckbox.checked) {
      renderer.computeShellLayers(shell, WALL_LIMITS[design.params.material].min);
    }
    if (design.insertion?.stuckPosition) {
      objects.push({
        id: 'stuck-marker', mesh: stuckSphere,
        model: mat4Compose(design.insertion.stuckPosition, 0, [1, 1, 1]),
        color: '#ef4444', opacity: 0.9, unlit: true, heat: false
      });
    }
    renderer.renderNormal(objects, { heatTexture: renderer.heat, useHeat: heatCheckbox.checked, background: '#0b1829' });
  }

  try {
    renderer = new WebGLRenderer(canvas);
    renderer.camera.target = [0, -1.5, -4];
    renderer.camera.distance = 94;
    renderer.camera.update();
    orbit = new PointerOrbitControls(canvas, renderer.camera, draw);
    ro = new ResizeObserver(() => { renderer?.resize(); draw(); });
    ro.observe(wrap);
    requestAnimationFrame(() => { renderer?.resize(); draw(); });
    heatCheckbox.addEventListener('change', draw);
  } catch (err) {
    wrap.append(h('div', { class: 'probe-tip show', style: 'display:block', text: `WebGL2 不可用：${(err as Error).message}` }));
  }

  const wall = sliderField({
    label: '名义壁厚', min: 0.5, max: 4, step: 0.05, value: design.params.nominalWall, unit: ' mm',
    onInput: v => { design.params.nominalWall = v; rebuild(); }
  });
  const trim = sliderField({
    label: '沿耳道截短', min: 0, max: 12, step: 0.1, value: design.params.trimMmFromTip, unit: ' mm',
    onInput: v => { design.params.trimMmFromTip = v; rebuild(); }
  });
  const edge = sliderField({
    label: '截面边缘倒圆', min: 0, max: 1.4, step: 0.05, value: design.params.edgeRadius, unit: ' mm',
    onInput: v => { design.params.edgeRadius = v; rebuild(); }
  });
  const vent = sliderField({
    label: '通气孔直径', min: 1, max: 3, step: 0.1, value: design.params.ventDiameter, unit: ' mm',
    onInput: v => { design.params.ventDiameter = v; scheduleSave(); }
  });

  controlsBody.append(
    selectField('外壳/耳模类型', design.params.moldType, [
      ['full-concha', '全耳甲腔'], ['half-concha', '半耳甲腔'], ['canal', '耳道式'], ['deep-canal', '深耳道式']
    ], v => { design.params.moldType = v as MoldType; rebuild(); }),
    selectField('材料与壁厚下限', design.params.material, [
      ['hard-acrylic', `硬壳丙烯酸 · 下限 ${WALL_LIMITS['hard-acrylic'].min} mm`],
      ['soft-silicone', `软硅胶 · 下限 ${WALL_LIMITS['soft-silicone'].min} mm`]
    ], v => {
      design.params.material = v as MaterialType;
      design.params.nominalWall = WALL_LIMITS[design.params.material].recommended;
      wall.input.value = String(design.params.nominalWall);
      wall.output.textContent = `${design.params.nominalWall.toFixed(2)} mm`;
      rebuild();
    }),
    wall.field,
    h('div', { class: `issue ${design.actualWallMm && design.actualWallMm < WALL_LIMITS[design.params.material].min ? 'error' : 'warning'}` },
      h('div', { class: 'dot' }),
      h('div', { class: 'small', id: 'wall-help', text: `当前材料下限 ${WALL_LIMITS[design.params.material].min.toFixed(1)} mm；窄耳道会限制最大可加工壁厚。` })
    ),
    trim.field, edge.field, vent.field,
    h('button', { class: 'btn', text: '重新按耳印偏移生成', onClick: () => { rebuild(); ctx.toast('壳体已重新生成', 'ok'); } }),
    h('div', { class: 'helper-box', text: '截短会改变远端封口环；切口使用多圈环带和圆角过渡，不是空心开口。' })
  );

  function renderResults() {
    resultBody.innerHTML = '';
    const limit = WALL_LIMITS[design.params.material].min;
    const thin = (design.actualWallMm ?? design.params.nominalWall) < limit;
    const ins = design.insertion!;
    resultBody.append(
      h('div', { class: 'kpi-grid', style: 'grid-template-columns:1fr 1fr' },
        h('div', { class: 'kpi' }, h('span', { text: '实际最小壁厚' }), h('b', { class: thin ? 'metric-bad' : 'metric-good', text: `${fmt(design.actualWallMm ?? design.params.nominalWall, 2)} mm` })),
        h('div', { class: 'kpi' }, h('span', { text: '壁厚下限' }), h('b', { style: 'font-size:18px', text: `${limit.toFixed(1)} mm` })),
        h('div', { class: 'kpi' }, h('span', { text: '三角面' }), h('b', { style: 'font-size:18px', text: fmt(design.shellMesh.indices.length / 3, 0) })),
        h('div', { class: 'kpi' }, h('span', { text: '过弯最小间隙' }), h('b', { class: (ins?.minClearance ?? 1) >= 0.05 ? 'metric-good' : 'metric-bad', style: 'font-size:18px', text: `${fmt(ins?.minClearance ?? 0, 2)} mm` }))
      ),
      ...(design.collisions.some(c => c.message.includes('外壳内壁')) ? [h('div', { class: 'issue warning' }, h('div', { class: 'dot' }), h('div', { class: 'small', text: '内部器件可能顶壳，请到“内部排布”处理。' }))] : []),
      h('div', { class: `issue ${ins?.pass ? 'warning' : 'error'}` },
        h('div', { class: 'dot' }),
        h('div', {},
          h('strong', { text: ins?.pass ? '第二弯走向检查通过' : '插入路径存在卡点' }),
          h('div', { class: 'small muted', style: 'margin-top:4px', text: ins?.pass
            ? `采样 ${ins.samples.length} 段，未发现低于 0.05 mm 的卡死位置。`
            : `卡点 ${ins.stuckPosition ? ins.stuckPosition.map(v => fmt(v, 1)).join(', ') : ''}；建议从当前未截短端累计截短 ${fmt(ins.suggestedTrimMm, 1)} mm。` }),
          !ins?.pass ? h('button', { class: 'btn warn sm', style: 'margin-top:8px', text: `采用建议截短 ${fmt(ins.suggestedTrimMm, 1)} mm`, onClick: () => {
            design.params.trimMmFromTip = ins.suggestedTrimMm;
            trim.input.value = String(design.params.trimMmFromTip);
            trim.output.textContent = `${design.params.trimMmFromTip.toFixed(1)} mm`;
            rebuild();
          } }) : null
        )
      ),
      h('div', { class: 'card', style: 'box-shadow:none;background:rgba(255,255,255,.025)' },
        h('div', { class: 'card-hd', style: 'border:0;padding-bottom:4px' }, h('strong', { class: 'small', text: '插入路径间隙曲线' })),
        h('div', { class: 'card-bd' }, clearanceSVG(design))
      )
    );
    const help = controlsBody.querySelector('#wall-help');
    if (help) help.textContent = thin ? `实际壁厚低于下限 ${limit.toFixed(1)} mm，透视页将逐像素染红。` : `满足 ${WALL_LIMITS[design.params.material].label}下限，窄耳道几何约束已计入。`;
  }
  renderResults();

  return {
    element,
    cleanup: () => {
      clearTimeout(saveTimer);
      ro?.disconnect(); orbit?.dispose();
      renderer?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}

function clearanceSVG(design: NonNullable<ReturnType<typeof getCurrentDesign>>): string | HTMLElement {
  const samples = design.insertion?.samples ?? [];
  if (!samples.length) return h('div', { class: 'helper-box', text: '全/半耳甲式不执行深耳道过弯曲线。' });
  const W = 320, H = 130, L = 30, R = 8, T = 12, B = 22;
  const iw = W - L - R, ih = H - T - B;
  const min = Math.min(-0.5, ...samples.map(s => s.clearance));
  const max = Math.max(1.2, ...samples.map(s => s.clearance));
  const x = (i: number) => L + iw * i / (samples.length - 1);
  const y = (v: number) => T + ih * ((max - v) / (max - min));
  const path = samples.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.clearance).toFixed(1)}`).join(' ');
  const zeroY = y(0.05);
  return h('div', { html: `<svg viewBox="0 0 ${W} ${H}" class="compare-svg" style="height:150px">
    <line x1="${L}" x2="${W-R}" y1="${zeroY}" y2="${zeroY}" stroke="#ef4444" stroke-dasharray="4 4"/>
    <path d="${path}" fill="none" stroke="#38bdf8" stroke-width="2.5"/>
    <text x="${L}" y="${H-6}" fill="#91a7bf" font-size="10">第一弯</text>
    <text x="${W-R}" y="${H-6}" text-anchor="end" fill="#91a7bf" font-size="10">远端</text>
  </svg>` });
}

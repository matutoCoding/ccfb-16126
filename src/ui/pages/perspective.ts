import { getCurrentDesign, persistDesign } from '../../state';
import { WALL_LIMITS } from '../../geom/shell';
import { rayMeshIntersections, pairWallSegments } from '../../geom/raycast';
import { WebGLRenderer, type SceneObject } from '../../render/Renderer';
import { PointerOrbitControls } from '../../render/camera';
import type { LayerStyle } from '../../types';
import { h, fmt } from '../dom';
import type { UiContext } from '../context';
import { buildSceneObjects, sectionClipPlane } from '../sceneFactory';
import { screenRayHelper } from '../pick-helpers';
import { openOrderCreator } from '../orders';

export function renderPerspectivePage(ctx: UiContext) {
  const scan = ctx.state.scans.find(s => s.id === ctx.state.currentScanId) ?? ctx.state.scans[0];
  const maybeDesign = scan ? getCurrentDesign(ctx.state) : undefined;
  if (!scan || !maybeDesign) return h('div', { class: 'card card-bd helper-box', text: '请先选择耳印并生成设计。' });
  const design = maybeDesign;

  const element = h('div', { class: 'page-grid perspective-grid' });
  const stageCard = h('div', { class: 'card viewer-card' });
  const toolbar = h('div', { class: 'viewer-toolbar' },
    h('strong', { class: 'grow', text: '精确排序透视台' }),
    h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: ctx.state.settings.heatmapEnabled }), '薄壁染红'),
    h('button', { class: 'btn sm', text: '保存截图' }),
    h('button', { class: 'btn primary sm', text: '工厂订单', onClick: () => openOrderCreator(ctx) })
  );
  const heatCheck = toolbar.querySelector('input[type=checkbox]') as HTMLInputElement;
  const shotBtn = toolbar.querySelectorAll('button')[0] as HTMLButtonElement;
  const canvas = h('canvas') as HTMLCanvasElement;
  const probe = h('div', { class: 'probe-tip' });
  const wrap = h('div', { class: 'canvas-wrap' },
    canvas, probe,
    h('div', { class: 'legend' },
      h('div', {}, h('i', { style: 'background:#7dd3fc' }), '外壳前后壁'),
      h('div', {}, h('i', { style: 'background:#22c55e' }), '声管'),
      h('div', {}, h('i', { style: 'background:#fb923c' }), '通气孔'),
      h('div', {}, h('i', { style: 'background:#f472b6' }), '切口封层')
    ),
    h('div', { class: 'canvas-hint', text: '任意角度旋转；32 趟深度剥离保证逐片段排序，悬停查看每层深度/壁厚' })
  );
  stageCard.append(toolbar, wrap);

  const side = h('div', { class: 'stack right-panel' });
  const layerCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', { text: '图层透明度 / 颜色' })));
  const layerBody = h('div', { class: 'card-bd stack' });
  layerCard.append(layerBody);
  const sectionCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', { text: '中心线截面' })));
  const sectionBody = h('div', { class: 'card-bd stack' });
  sectionCard.append(sectionBody);
  const verifyCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', { text: '正确性' })));
  const verifyBody = h('div', { class: 'card-bd stack' },
    h('div', { class: 'helper-box', text: '深度剥离按像素收集第 1…N 个最近表面并前向后混合；壁厚来自 RGBA32F 线性眼距离，不使用 8-bit 深度缓冲猜值。' }),
    h('button', { class: 'btn', text: '打开像素/壁厚验收', onClick: () => ctx.navigate('settings') })
  );
  verifyCard.append(verifyBody);
  side.append(layerCard, sectionCard, verifyCard);
  element.append(stageCard, side);

  let renderer: WebGLRenderer | null = null;
  let orbit: PointerOrbitControls | null = null;
  let ro: ResizeObserver | null = null;
  let raf = 0;

  function layerRow(style: LayerStyle) {
    const color = h('input', { type: 'color', value: style.color }) as HTMLInputElement;
    color.addEventListener('input', () => { style.color = color.value; schedule(); refresh(); });
    const check = h('input', { type: 'checkbox', checked: style.visible }) as HTMLInputElement;
    check.addEventListener('change', () => { style.visible = check.checked; schedule(); refresh(); });
    const range = h('input', { type: 'range', min: '0.05', max: '1', step: '0.01', value: String(style.opacity) }) as HTMLInputElement;
    const val = h('span', { class: 'val', text: `${Math.round(style.opacity * 100)}%` });
    range.addEventListener('input', () => { style.opacity = Number(range.value); val.textContent = `${range.value}%`; refresh(); });
    range.addEventListener('change', () => void persistDesign(design));
    return h('div', { class: 'layer-row' },
      check, color,
      h('div', { class: 'name', text: style.name }),
      h('span', { class: 'val', text: '' }),
      range, val
    );
  }

  function renderLayerPanel() {
    layerBody.innerHTML = '';
    const ids = ['shell', 'receiver', 'battery', 'amplifier', 'faceplate', 'sound', 'vent', 'sectionCap', 'impression'];
    for (const id of ids) {
      const s = design.layerStyles[id];
      if (s) layerBody.append(layerRow(s));
    }
  }

  function renderSectionPanel() {
    sectionBody.innerHTML = '';
    const enabled = h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: design.params.sectionEnabled }), '启用截面切开外壳');
    (enabled.querySelector('input') as HTMLInputElement).addEventListener('change', e => {
      design.params.sectionEnabled = (e.target as HTMLInputElement).checked;
      refresh(); void persistDesign(design);
    });
    const out = h('output', { text: `t=${design.params.sectionT.toFixed(2)}` });
    const slider = h('input', { type: 'range', min: '0.12', max: '0.94', step: '0.01', value: String(design.params.sectionT) }) as HTMLInputElement;
    slider.addEventListener('input', () => { design.params.sectionT = Number(slider.value); out.textContent = `t=${slider.value}`; refresh(); });
    slider.addEventListener('change', () => void persistDesign(design));
    sectionBody.append(
      enabled,
      h('div', { class: 'field' }, h('label', {}, h('span', { text: '沿耳道中心线位置' }), out), slider),
      h('div', { class: 'helper-box', text: '切开后显示环形封口面和圆角边；内部器件/管路不做破坏性裁切，便于看清路径。' })
    );
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function schedule() { clearTimeout(saveTimer); saveTimer = setTimeout(() => void persistDesign(design), 300); }

  function refresh() {
    if (!renderer) return;
    const objects: SceneObject[] = buildSceneObjects(scan, design, { includeImpression: true, includeMarkers: false, includeDefects: true });
    const shell = objects.find(o => o.id === 'shell');
    if (shell) renderer.computeShellLayers(shell, WALL_LIMITS[design.params.material].min);
    const clip = design.params.sectionEnabled ? sectionClipPlane(scan, design) : null;
    renderer.renderTransparent(objects, {
      clipPlane: clip,
      heatTexture: renderer.heat,
      useHeat: heatCheck.checked,
      background: '#08111f'
    });
  }

  try {
    renderer = new WebGLRenderer(canvas);
    renderer.maxPeelLayers = ctx.state.settings.maxPeelLayers;
    renderer.camera.target = [0, -1.8, -4];
    renderer.camera.distance = 96;
    renderer.camera.update();
    orbit = new PointerOrbitControls(canvas, renderer.camera, () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(refresh);
    });
    ro = new ResizeObserver(() => { renderer?.resize(ctx.state.settings.rendererScale); refresh(); });
    ro.observe(wrap);
    requestAnimationFrame(() => { renderer?.resize(ctx.state.settings.rendererScale); refresh(); });
  } catch (err) {
    wrap.append(h('div', { class: 'probe-tip show', style: 'display:block', text: `WebGL2 透视台初始化失败：${(err as Error).message}` }));
  }

  heatCheck.addEventListener('change', refresh);
  shotBtn.addEventListener('click', () => {
    refresh();
    const a = h('a', { href: renderer?.dataURL(), download: `perspective-${design.id}.png` }) as HTMLAnchorElement;
    a.click();
    ctx.toast('透视截图已保存', 'ok');
  });

  let probeRaf = 0;
  let lastPointer: PointerEvent | null = null;
  const updateProbe = () => {
    probeRaf = 0;
    const e = lastPointer;
    if (!e || !renderer || e.buttons !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const bx = (e.clientX - rect.left) * canvas.width / rect.width;
    const by = (e.clientY - rect.top) * canvas.height / rect.height;
    const gpuDepths = renderer.readShellLayerDepthsAtPixel(Math.floor(bx), Math.floor(by));
    const screenRay0 = screenRayHelper(renderer.camera.viewProj, bx, by, canvas.width, canvas.height);
    const ray = { origin: renderer.camera.position, dir: screenRay0.dir };
    const cpuHits = rayMeshIntersections(ray, design.shellMesh);
    const cpuSegments = pairWallSegments(cpuHits.map(h => h.distance));
    const gpuSegments = pairWallSegments(gpuDepths);
    const firstDelta = gpuSegments[0] && cpuSegments[0] ? Math.abs(gpuSegments[0].thickness - cpuSegments[0].thickness) : null;
    probe.classList.add('show');
    const left = Math.min(rect.width - 270, e.clientX - rect.left + 16);
    const top = Math.min(rect.height - 210, e.clientY - rect.top + 14);
    probe.style.left = `${Math.max(8, left)}px`;
    probe.style.top = `${Math.max(8, top)}px`;
    probe.innerHTML = `
      <strong>像素探针</strong>
      <div class="tiny muted">GPU 层数 ${gpuDepths.length} · CPU 网格交点 ${cpuHits.length}</div>
      <table>
        ${gpuDepths.map((d, i) => `<tr><td>层 ${i + 1} 深度</td><td>${fmt(d, 3)} mm</td></tr>`).join('')}
        ${gpuSegments.map((s, i) => `<tr><td>壁段 ${i + 1} 厚度</td><td style="color:${s.thickness < WALL_LIMITS[design.params.material].min ? '#fca5a5' : '#86efac'}">${fmt(s.thickness, 3)} mm</td></tr>`).join('')}
        ${firstDelta !== null ? `<tr><td>对射线求交误差</td><td style="color:${firstDelta < 0.05 ? '#86efac' : '#fca5a5'}">${firstDelta.toFixed(4)} mm</td></tr>` : '<tr><td colspan="2" class="muted">当前像素没有闭合壁段</td></tr>'}
      </table>`;
  };
  canvas.addEventListener('pointermove', e => {
    lastPointer = e;
    if (!probeRaf) probeRaf = requestAnimationFrame(updateProbe);
  });
  canvas.addEventListener('pointerleave', () => {
    probe.classList.remove('show');
    lastPointer = null;
  });

  renderLayerPanel();
  renderSectionPanel();
  return {
    element,
    cleanup: () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(probeRaf);
      clearTimeout(saveTimer);
      ro?.disconnect(); orbit?.dispose();
      renderer?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}

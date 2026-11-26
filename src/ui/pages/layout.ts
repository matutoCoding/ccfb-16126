import { getCurrentDesign, persistDesign } from '../../state';
import { checkCollisions } from '../../geom/layout';
import { RadiusSampler } from '../../geom/shell';
import { rayMeshIntersections } from '../../geom/raycast';
import { WebGLRenderer } from '../../render/Renderer';
import { PointerOrbitControls } from '../../render/camera';
import { h, fmt } from '../dom';
import { sliderField } from '../controls';
import type { UiContext } from '../context';
import { buildSceneObjects } from '../sceneFactory';
import { screenRayHelper } from '../pick-helpers';

export function renderLayoutPage(ctx: UiContext) {
  const scan = ctx.state.scans.find(s => s.id === ctx.state.currentScanId) ?? ctx.state.scans[0];
  const maybeDesign = scan ? getCurrentDesign(ctx.state) : undefined;
  if (!scan || !maybeDesign) return h('div', { class: 'card card-bd helper-box', text: '请先选择耳印和设计。' });
  const design = maybeDesign;

  const element = h('div', { class: 'page-grid grid-3' });
  const controlCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', { text: '器件 / 路径' })));
  const controlBody = h('div', { class: 'card-bd stack' });
  controlCard.append(controlBody);

  const canvas = h('canvas') as HTMLCanvasElement;
  const wrap = h('div', { class: 'canvas-wrap' }, canvas, h('div', { class: 'canvas-hint', text: '可旋转查看；开启“点击加点”后，在壳体上点击会向内部 2.5 mm 处添加路径点' }));
  const viewer = h('div', { class: 'card viewer-card' },
    h('div', { class: 'viewer-toolbar' },
      h('strong', { class: 'grow', text: '内部排布三维视图' }),
      h('button', { class: 'btn sm', text: '重置碰撞' }),
      h('button', { class: 'btn primary sm', text: '透视检查 →', onClick: () => ctx.navigate('perspective', scan.id) })
    ), wrap);

  const issueCard = h('div', { class: 'card right-panel' }, h('div', { class: 'card-hd' }, h('h3', { text: '碰撞与净距' })));
  const issueBody = h('div', { class: 'card-bd stack' });
  issueCard.append(issueBody);
  element.append(controlCard, viewer, issueCard);

  let renderer: WebGLRenderer | null = null;
  let orbit: PointerOrbitControls | null = null;
  let ro: ResizeObserver | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let selectedCompId = design.components[0]?.id;
  let selectedPathId = design.paths[1]?.id ?? design.paths[0]?.id;
  let selectedPoint = 0;
  let clickToAdd = false;
  let downXY: [number, number] | null = null;

  function recompute() {
    design.collisions = checkCollisions(design.components, design.paths, new RadiusSampler(scan));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void persistDesign(design), 300);
  }

  function draw() {
    if (!renderer) return;
    const objects = buildSceneObjects(scan, design, { includeImpression: true, includeMarkers: false, includeDefects: false });
    renderer.renderNormal(objects, { background: '#0b1829' });
  }

  try {
    renderer = new WebGLRenderer(canvas);
    renderer.camera.target = [0, -1.5, -3];
    renderer.camera.distance = 92;
    renderer.camera.update();
    orbit = new PointerOrbitControls(canvas, renderer.camera, draw);
    ro = new ResizeObserver(() => { renderer?.resize(); draw(); });
    ro.observe(wrap);
    requestAnimationFrame(() => { renderer?.resize(); draw(); });

    canvas.addEventListener('pointerdown', e => { downXY = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', e => {
      if (!clickToAdd || !downXY || !renderer) return;
      if (Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 6) return;
      const path = design.paths.find(p => p.id === selectedPathId);
      if (!path) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * canvas.width / rect.width;
      const y = (e.clientY - rect.top) * canvas.height / rect.height;
      const ray = screenRayHelper(renderer.camera.viewProj, x, y, canvas.width, canvas.height);
      const hits = rayMeshIntersections(ray, design.shellMesh);
      const hit = hits[0];
      if (hit) {
        path.points.push([
          hit.point[0] - ray.dir[0] * 2.5,
          hit.point[1] - ray.dir[1] * 2.5,
          hit.point[2] - ray.dir[2] * 2.5
        ]);
        selectedPoint = path.points.length - 1;
        recompute(); renderControls(); renderIssues(); draw();
        ctx.toast('已添加内部路径点', 'ok');
      }
    });
  } catch (err) {
    wrap.append(h('div', { class: 'probe-tip show', style: 'display:block', text: `WebGL2 不可用：${(err as Error).message}` }));
  }

  function renderControls() {
    controlBody.innerHTML = '';
    controlBody.append(
      h('strong', { class: 'small', text: '真实尺寸器件' }),
      ...design.components.map(comp => h('div', { class: `list-item ${selectedCompId === comp.id ? 'active' : ''}` },
        h('div', { class: 'row between' },
          h('label', { class: 'row', style: 'gap:7px;cursor:pointer' },
            h('input', { type: 'checkbox', checked: comp.enabled, onChange: () => { comp.enabled = !comp.enabled; recompute(); draw(); } }),
            h('strong', { text: comp.name })
          ),
          h('button', { class: 'btn sm ghost', text: '定位', onClick: () => { if (renderer) { renderer.camera.target = [...comp.position] as [number, number, number]; renderer.camera.update(); draw(); } } })
        ),
        selectedCompId === comp.id ? componentEditor(comp) : h('button', { class: 'btn sm', style: 'margin-top:8px', text: '编辑位置/旋转', onClick: () => { selectedCompId = comp.id; renderControls(); } })
      )),
      h('hr', { class: 'hr' }),
      h('strong', { class: 'small', text: '声管与通气孔路径' }),
      h('div', { class: 'field' }, h('label', { text: '编辑路径' }),
        h('select', { class: 'input', onChange: (e: Event) => { selectedPathId = (e.target as HTMLSelectElement).value; selectedPoint = 0; renderControls(); } },
          ...design.paths.map(p => h('option', { value: p.id, selected: p.id === selectedPathId, text: p.name })))
      )
    );

    const path = design.paths.find(p => p.id === selectedPathId);
    if (path) {
      const diameter = sliderField({
        label: path.kind === 'vent' ? '通气孔直径（硬约束 1–3 mm）' : '声管直径',
        min: path.kind === 'vent' ? 1 : 1, max: path.kind === 'vent' ? 3 : 3.2, step: 0.1,
        value: path.diameter, unit: ' mm',
        onInput: v => { path.diameter = v; recompute(); renderIssues(); }
      });
      const pointSelect = h('select', { class: 'input', onChange: (e: Event) => { selectedPoint = Number((e.target as HTMLSelectElement).value); renderControls(); } },
        ...path.points.map((p, i) => h('option', { value: String(i), selected: i === selectedPoint, text: `路径点 ${i + 1}: ${p.map(v => fmt(v, 1)).join(', ')}` })));
      const point = path.points[selectedPoint] ?? path.points[0];
      const axes = (['X', 'Y', 'Z'] as const).map((axis, ai) => sliderField({
        label: `${axis} 坐标`, min: -24, max: 24, step: 0.1, value: point?.[ai] ?? 0, unit: ' mm',
        onInput: v => { if (point) point[ai] = v; recompute(); draw(); renderIssues(); }
      }).field);
      controlBody.append(
        h('div', { class: 'card', style: 'background:rgba(255,255,255,.03);box-shadow:none' }, h('div', { class: 'card-bd stack' },
          diameter.field,
          h('div', { class: 'field' }, h('label', { text: '路径点' }), pointSelect),
          ...axes,
          h('div', { class: 'row' },
            h('button', { class: `btn sm ${clickToAdd ? 'warn' : ''}`, text: clickToAdd ? '● 点击加点已开启' : '点击壳体加点', onClick: () => { clickToAdd = !clickToAdd; renderControls(); } }),
            h('button', { class: 'btn sm danger', text: '删除当前点', disabled: path.points.length <= 2, onClick: () => { path.points.splice(selectedPoint, 1); selectedPoint = 0; recompute(); renderControls(); draw(); } }),
            h('button', { class: 'btn sm ghost', text: '重置示例路径', onClick: () => {
              if (path.kind === 'vent') path.points = [[-1.2, 1.2, 18.5], [-0.5, 0.2, 11], [1.2, -1.2, 3], [1.0, -2.8, -8], [-1.4, -3.8, -17]];
              else path.points = [[3.5, -2.6, 4.2], [3.8, -3.2, -2], [-0.5, -4.2, -10], [-2.2, -3.2, -18]];
              recompute(); renderControls(); draw();
            } })
          )
        ))
      );
    }
  }

  function componentEditor(comp: (typeof design.components)[number]) {
    const wrap = h('div', { class: 'stack', style: 'margin-top:10px' });
    const sizeText = h('div', { class: 'tiny muted', text: `真实尺寸 ${comp.size.map(v => fmt(v, 1)).join(' × ')} mm` });
    wrap.append(sizeText);
    (['X', 'Y', 'Z'] as const).forEach((axis, i) => {
      const s = sliderField({
        label: `位置 ${axis}`, min: -18, max: 22, step: 0.1, value: comp.position[i], unit: ' mm',
        onInput: v => { comp.position[i] = v; recompute(); draw(); renderIssues(); }
      });
      wrap.append(s.field);
    });
    const rot = sliderField({
      label: 'Z 轴旋转', min: -90, max: 90, step: 1, value: comp.rotationZ * 180 / Math.PI, unit: '°',
      onInput: v => { comp.rotationZ = v * Math.PI / 180; recompute(); draw(); renderIssues(); }
    });
    wrap.append(rot.field);
    return wrap;
  }

  function renderIssues() {
    issueBody.innerHTML = '';
    const errors = design.collisions.filter(c => c.severity === 'error');
    const warnings = design.collisions.filter(c => c.severity === 'warning');
    issueBody.append(
      h('div', { class: 'kpi-grid', style: 'grid-template-columns:1fr 1fr' },
        h('div', { class: 'kpi' }, h('span', { text: '硬干涉' }), h('b', { class: errors.length ? 'metric-bad' : 'metric-good', text: String(errors.length) })),
        h('div', { class: 'kpi' }, h('span', { text: '贴近警告' }), h('b', { style: warnings.length ? 'color:var(--warn)' : '', text: String(warnings.length) }))
      ),
      ...(!design.collisions.length ? [h('div', { class: 'pill ok', style: 'justify-content:center;padding:10px', text: '未发现器件、管路或外壳碰撞' })] : []),
      ...design.collisions.map(issue => h('div', { class: `issue ${issue.severity}` },
        h('div', { class: 'dot' }),
        h('div', {},
          h('strong', { class: 'small', text: issue.message }),
          h('div', { class: 'tiny mono muted', style: 'margin:4px 0', text: `位置 ${issue.position.map(v => fmt(v, 1)).join(', ')}` }),
          h('button', { class: 'btn sm ghost', text: '定位到碰撞点', onClick: () => {
            if (renderer) { renderer.camera.target = issue.position; renderer.camera.distance = 42; renderer.camera.update(); draw(); }
          } })
        )
      )),
      h('div', { class: 'helper-box', text: '碰撞使用 OBB 分离轴和路径采样点到盒体最近距离；通气孔直径变化会立即改变碰撞半径。' })
    );
  }

  renderControls();
  renderIssues();
  return {
    element,
    cleanup: () => {
      clearTimeout(saveTimer);
      ro?.disconnect(); orbit?.dispose();
      renderer?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}

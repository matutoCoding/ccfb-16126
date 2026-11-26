import type { ScanRecord } from '../../types';
import { db, uid } from '../../db';
import { parseSTL, writeBinarySTL } from '../../geom/stl';
import { analyzeImpression } from '../../geom/analysis';
import { rayMeshIntersections } from '../../geom/raycast';
import { screenRayHelper } from '../pick-helpers';
import { WebGLRenderer } from '../../render/Renderer';
import { PointerOrbitControls } from '../../render/camera';
import { VARIANT_META } from '../../geom/procedural';
import { h, downloadBlob, fmt } from '../dom';
import type { UiContext } from '../context';
import { buildSceneObjects } from '../sceneFactory';

export function renderScanPage(ctx: UiContext): { element: HTMLElement; cleanup: () => void } {
  const scan = ctx.state.scans.find(s => s.id === ctx.state.currentScanId) ?? ctx.state.scans[0];
  if (scan) ctx.state.currentScanId = scan.id;
  const element = h('div', { class: 'page-grid grid-2' });
  if (!scan) {
    element.append(h('div', { class: 'card card-bd helper-box', text: '没有耳印数据，请导入 STL。' }));
    return { element, cleanup: () => {} };
  }

  const listCard = h('div', { class: 'card' },
    h('div', { class: 'card-hd' }, h('div', {}, h('h3', { text: '耳印扫描库' }), h('p', { text: '四副程序生成测试耳模 + STL 导入' }))),
    h('div', { class: 'card-bd stack' },
      h('label', { class: 'btn primary', text: '导入 STL 耳印', style: 'cursor:pointer' },
        h('input', { type: 'file', accept: '.stl', style: 'display:none', onChange: async (e: Event) => {
          const input = e.currentTarget as HTMLInputElement;
          const file = input.files?.[0];
          if (!file) return;
          try {
            const buffer = await file.arrayBuffer();
            const mesh = parseSTL(buffer);
            const analysis = analyzeImpression(mesh);
            const record: ScanRecord = {
              id: uid('scan'), name: file.name.replace(/\.stl$/i, ''), variant: 'imported',
              createdAt: Date.now(), mesh, stl: buffer, ...analysis
            };
            await db.scans.save(record);
            ctx.state.scans.push(record);
            ctx.state.currentScanId = record.id;
            ctx.toast(`STL 导入成功：${Math.round(mesh.indices.length / 3)} 个三角面`, 'ok');
            ctx.rerender();
          } catch (err) {
            console.error(err);
            ctx.toast(`STL 导入失败：${(err as Error).message}`, 'bad');
          }
        } })
      ),
      h('div', { class: 'list', style: 'max-height:calc(100vh - 270px)' }, ...ctx.state.scans.map(s =>
        h('button', { class: `list-item ${s.id === scan.id ? 'active' : ''}`, onClick: () => ctx.navigate('scan', s.id) },
          h('strong', { text: s.name }),
          h('span', { text: `${VARIANT_META[s.variant]?.label ?? s.variant} · ${fmt(s.mesh.indices.length / 3, 0)} 面 · ${s.landmarks.length} 标记 · ${s.defects.length} 缺陷` })
        )
      ))
    )
  );

  const canvas = h('canvas', { 'aria-label': '耳印三维视图' }) as HTMLCanvasElement;
  const wrap = h('div', { class: 'canvas-wrap' },
    canvas,
    h('div', { class: 'legend' },
      h('div', {}, h('i', { style: 'background:#22c55e' }), '耳道口'),
      h('div', {}, h('i', { style: 'background:#f59e0b' }), '第一弯'),
      h('div', {}, h('i', { style: 'background:#ef4444' }), '第二弯'),
      h('div', {}, h('i', { style: 'background:#a78bfa' }), '未取到')
    ),
    h('div', { class: 'canvas-hint', text: '左键旋转 · 右键/Shift 平移 · 滚轮缩放 · 直接拖动彩色弯道球' })
  );
  const viewerCard = h('div', { class: 'card viewer-card' },
    h('div', { class: 'viewer-toolbar' },
      h('strong', { class: 'grow', text: scan.name }),
      h('span', { class: 'pill', text: VARIANT_META[scan.variant]?.description ?? '导入模型' }),
      h('button', { class: 'btn sm', text: '导出 STL', onClick: () => downloadBlob(writeBinarySTL(scan.mesh, scan.name), `${scan.name}.stl`) }),
      h('button', { class: 'btn primary sm', text: '用于外壳设计 →', onClick: () => ctx.navigate('shell', scan.id) })
    ),
    wrap
  );

  const sideCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', { text: '自动标记与缺损' })));
  const sideBody = h('div', { class: 'card-bd stack' });
  sideCard.append(sideBody);
  element.append(listCard, h('div', { class: 'page-grid', style: 'grid-template-columns:minmax(0,1fr) 330px;gap:16px' }, viewerCard, sideCard));

  let renderer: WebGLRenderer | null = null;
  let controls: PointerOrbitControls | null = null;
  let resizeObs: ResizeObserver | null = null;
  let dragLandmark: string | null = null;
  const cleanupFns: Array<() => void> = [];

  function draw() {
    if (!renderer) return;
    const objects = buildSceneObjects(scan, undefined, { includeImpression: true, includeMarkers: true, includeDefects: true });
    renderer.renderNormal(objects, { background: '#0b1829' });
  }

  try {
    renderer = new WebGLRenderer(canvas);
    renderer.camera.target = [0, -1.5, -4];
    renderer.camera.distance = 96;
    renderer.camera.update();
    controls = new PointerOrbitControls(canvas, renderer.camera, draw);
    resizeObs = new ResizeObserver(() => { renderer?.resize(); draw(); });
    resizeObs.observe(wrap);
    requestAnimationFrame(() => { renderer?.resize(); draw(); });

    const projectedMarker = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      for (const lm of scan.landmarks) {
        const p = renderer!.project(lm.position);
        const px = p.x / canvas.width * rect.width;
        const py = p.y / canvas.height * rect.height;
        if (Math.hypot(mx - px, my - py) < 18) return lm.id;
      }
      return null;
    };

    const pointerDown = (e: PointerEvent) => {
      dragLandmark = projectedMarker(e);
      if (dragLandmark && controls) controls.enabled = false;
    };
    const pointerMove = (e: PointerEvent) => {
      if (!dragLandmark || !renderer) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * canvas.width / rect.width;
      const y = (e.clientY - rect.top) * canvas.height / rect.height;
      const ray = screenRayHelper(renderer.camera.viewProj, x, y, canvas.width, canvas.height);
      const hits = rayMeshIntersections(ray, scan.mesh);
      if (hits[0]) {
        const lm = scan.landmarks.find(l => l.id === dragLandmark);
        if (lm) {
          lm.position = hits[0].point;
          let best = 0, bd = Infinity;
          scan.centerline.forEach((p, i) => {
            const d = (p[0] - lm.position[0]) ** 2 + (p[1] - lm.position[1]) ** 2 + (p[2] - lm.position[2]) ** 2;
            if (d < bd) { bd = d; best = i; }
          });
          lm.t = best / (scan.centerline.length - 1);
          draw();
          renderSide();
        }
      }
    };
    const pointerUp = async () => {
      if (dragLandmark) {
        dragLandmark = null;
        if (controls) controls.enabled = true;
        await db.scans.save(scan);
        ctx.toast('标记点位置已保存', 'ok');
      }
    };
    canvas.addEventListener('pointerdown', pointerDown, true);
    canvas.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    cleanupFns.push(() => canvas.removeEventListener('pointerdown', pointerDown, true));
    cleanupFns.push(() => canvas.removeEventListener('pointermove', pointerMove));
    cleanupFns.push(() => window.removeEventListener('pointerup', pointerUp));
  } catch (err) {
    console.error(err);
    wrap.append(h('div', { class: 'probe-tip show', style: 'display:block', text: `WebGL2 初始化失败：${(err as Error).message}` }));
  }

  function renderSide() {
    sideBody.innerHTML = '';
    sideBody.append(
      h('div', { class: 'helper-box', text: '系统沿耳印长轴切片，用质心轨迹生成中心线，并按曲率峰值寻找第一、第二弯。所有标记均可在左侧视图中手动拖动修正。' }),
      h('div', { class: 'stack' }, ...scan.landmarks.map(lm => h('div', { class: 'list-item' },
        h('div', { class: 'row between' }, h('strong', { text: lm.name }), h('span', { class: 'pill ok', text: '可拖动' })),
        h('div', { class: 'tiny mono muted', style: 'margin-top:6px', text: `X ${fmt(lm.position[0], 2)}  Y ${fmt(lm.position[1], 2)}  Z ${fmt(lm.position[2], 2)}` })
      ))),
      h('button', { class: 'btn', text: '重新自动识别中心线/弯道', onClick: async () => {
        const a = analyzeImpression(scan.mesh);
        scan.centerline = a.centerline; scan.landmarks = a.landmarks; scan.defects = a.defects;
        await db.scans.save(scan);
        renderSide(); draw(); ctx.toast('已重新分析并保存', 'ok');
      } }),
      h('hr', { class: 'hr' }),
      h('strong', { text: `气泡坑 / 缺损标记（${scan.defects.length}）` }),
      ...scan.defects.map(d => h('div', { class: `issue ${d.type === 'missing' ? 'warning' : 'error'}` },
        h('div', { class: 'dot' }),
        h('div', {}, h('strong', { text: d.type === 'missing' ? '未取到/开放区' : '气泡凹坑' }), h('div', { class: 'small muted', style: 'margin-top:3px', text: d.note }), h('div', { class: 'tiny mono', style: 'margin-top:4px', text: `${fmt(d.center[0])}, ${fmt(d.center[1])}, ${fmt(d.center[2])} · R ${fmt(d.radius)}` }))
      )),
      ...(!scan.defects.length ? [h('div', { class: 'helper-box', text: '未检测到明显气泡或开放边。' })] : [])
    );
  }
  renderSide();

  return {
    element,
    cleanup: () => {
      cleanupFns.forEach(fn => fn());
      resizeObs?.disconnect();
      controls?.dispose();
      renderer?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}

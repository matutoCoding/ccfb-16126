/** 页面 2：耳印模扫描 —— STL 导入 / 程序化测试印模 / 自动解剖标记 / 手动拖点 / 缺陷标注 */
import { app } from '../state';
import { h, clear, toast } from './dom';
import { EarImpression, SyntheticKind, SYNTHETIC_LABEL, AnnoMarker } from '../core/types';
import { generateImpression } from '../core/synthetic';
import { parseSTL } from '../core/stl';
import { findBends, findCanalMouth, detectDefects } from '../core/synthetic';
import { Viewport, defaultLayerConfig, createViewportDeferred } from '../render/Viewport';
import { ClipPlane } from '../render/GLRenderer';
import { buildScene, markerMesh, centerOfBounds, boundsRadius } from '../render/scene';
import { uid } from '../core/db';
import { Mesh, rayMeshFirstHit, computeVertexNormals, boundaryEdges } from '../core/geometry';
import { Vec3, dist3, sub3, add3, scale3 } from '../core/math';

const noClip: ClipPlane = { point: [0, 0, 0], normal: [1, 0, 0], enabled: false };
const MARKER_COLOR: Record<AnnoMarker['kind'], [number, number, number]> = {
  'canal-mouth': [0.3, 0.8, 1],
  'first-bend': [1, 0.8, 0.2],
  'second-bend': [0.2, 1, 0.6],
  defect: [1, 0.2, 0.15],
  bubble: [1, 0.45, 0.2],
};

export function renderScanPage(root: HTMLElement): void {
  clear(root);
  root.append(h('h2', {}, '耳印模扫描与解剖标记'));
  const c = app.currentCustomer;
  if (!c) { root.append(h('div', { class: 'card muted' }, '请先在「客户档案」选择客户。')); return; }

  const side = app.currentSide;
  let im = app.currentImpression;
  const viewHost = h('div', { class: 'viewport-wrap' });
  const sidePanel = h('div', { class: 'card', style: 'width:320px;flex:0 0 320px;overflow:auto' });

  let viewport: Viewport | null = null;
  const refreshView = () => {
    if (!viewport || !im) return;
    const items = buildScene(null, null, im, true);
    for (const mk of im.markers) items.push(markerMesh(mk.position, mk.radius ?? 0.7, MARKER_COLOR[mk.kind]));
    viewport.setItems(items);
    const center = centerOfBounds(im.centerline);
    viewport.frame(center, boundsRadius(im.centerline, center) + 4);
  };

  const persist = async (next: EarImpression) => {
    im = next;
    await app.saveImpression(next);
    const ear = c.ears[side];
    ear.impressionId = next.id;
    await app.saveCustomer(c);
    app.selectImpression(next.id);
    drawPanel();
    refreshView();
  };

  const makeImpressionFromMesh = (mesh: Mesh, source: EarImpression['source'], kind?: SyntheticKind): EarImpression => {
    // 由网格反推中心线：沿 y 分层求质心
    const p = mesh.positions;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < p.length; i += 3) { minY = Math.min(minY, p[i]); maxY = Math.max(maxY, p[i]); }
    const stations = 80;
    const centers: Vec3[] = [];
    const radii: number[] = [];
    for (let s = 0; s < stations; s++) {
      const y0 = minY + ((maxY - minY) * s) / stations;
      const y1 = minY + ((maxY - minY) * (s + 1)) / stations;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (let i = 0; i < p.length; i += 3) {
        if (p[i + 1] >= y0 && p[i + 1] < y1) { sx += p[i]; sy += p[i + 1]; sz += p[i + 2]; n++; }
      }
      if (n === 0 && centers.length) { centers.push(centers[centers.length - 1]); radii.push(radii[radii.length - 1]); continue; }
      const ctr: Vec3 = n ? [sx / n, (y0 + y1) / 2, sz / n] : [0, (y0 + y1) / 2, 0];
      centers.push(ctr);
      let rr = 0;
      for (let i = 0; i < p.length; i += 3) {
        if (p[i + 1] >= y0 && p[i + 1] < y1) rr = Math.max(rr, dist3([p[i], p[i + 1], p[i + 2]], ctr));
      }
      radii.push(rr || 3);
    }
    const ringR = radii.map((r): [number, number] => [r, r * 0.92]);
    const mouth = findCanalMouth(ringR);
    const { first, second } = findBends(centers);
    const markers: AnnoMarker[] = [
      { id: 'mk-mouth', kind: 'canal-mouth', position: centers[mouth], label: '耳道口' },
      { id: 'mk-bend1', kind: 'first-bend', position: centers[first], label: '第一弯' },
      { id: 'mk-bend2', kind: 'second-bend', position: centers[second], label: '第二弯' },
      ...detectDefects(mesh, centers, ringR),
    ];
    const edges = boundaryEdges(mesh);
    return {
      id: uid('imp'),
      customerId: c!.id,
      side,
      createdAt: Date.now(),
      meshData: { positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) },
      centerline: centers,
      markers,
      canalRadii: radii.slice(mouth),
      source,
      syntheticKind: kind,
      ...(edges.length ? {} : {}),
    };
  };

  const drawPanel = () => {
    clear(sidePanel);
    sidePanel.append(
      h('h3', {}, '数据来源'),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, `当前客户：${c.name} · ${side === 'left' ? '左' : '右'}耳`),
      h('label', { class: 'btn ghost', style: 'display:block;text-align:center;margin-bottom:8px;cursor:pointer' },
        '导入 STL 耳印模',
        h('input', {
          type: 'file', accept: '.stl', style: 'display:none',
          onchange: async (e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            try {
              const buf = await file.arrayBuffer();
              const mesh = parseSTL(buf);
              if (mesh.indices.length / 3 < 100) throw new Error('三角面数量过少');
              const next = makeImpressionFromMesh(mesh, 'imported-stl');
              await persist(next);
              toast(`STL 已导入：${mesh.indices.length / 3} 个三角面，自动标记完成`);
            } catch (err) {
              toast('导入失败：' + (err as Error).message);
            }
          },
        })),
      h('h3', {}, '程序化测试印模（4 副）'),
      ...(Object.keys(SYNTHETIC_LABEL) as SyntheticKind[]).map((kind) =>
        h('button', {
          class: 'btn ghost', style: 'display:block;width:100%;margin-bottom:6px;text-align:left',
          onclick: async () => {
            const g = generateImpression(kind, side);
            const next: EarImpression = {
              id: uid('imp'), customerId: c!.id, side, createdAt: Date.now(),
              meshData: { positions: Array.from(g.mesh.positions), indices: Array.from(g.mesh.indices) },
              centerline: g.centerline, markers: g.markers, canalRadii: g.canalRadii,
              source: 'synthetic', syntheticKind: kind,
            };
            await persist(next);
            toast(`已生成测试印模：${SYNTHETIC_LABEL[kind]}`);
          },
        }, SYNTHETIC_LABEL[kind])),
    );

    if (im) {
      const triCount = im.meshData.indices.length / 3;
      const mesh: Mesh = {
        positions: Float32Array.from(im.meshData.positions),
        normals: new Float32Array(im.meshData.positions.length),
        indices: Uint32Array.from(im.meshData.indices),
      };
      computeVertexNormals(mesh);
      const edges = boundaryEdges(mesh);
      const defects = im.markers.filter((m) => m.kind === 'bubble' || m.kind === 'defect');
      sidePanel.append(
        h('h3', {}, '当前印模'),
        h('div', { class: 'muted' },
          `来源：${im.source === 'synthetic' ? '程序生成（' + SYNTHETIC_LABEL[im.syntheticKind!] + '）' : 'STL 导入'}`),
        h('div', { class: 'muted' }, `三角面：${triCount} · 中心线站：${im.centerline.length}`),
        h('div', { style: 'margin:8px 0' },
          h('span', { class: 'badge ' + (edges.length ? 'bad' : 'ok') }, edges.length ? `开口边界 ${edges.length} 条边` : '水密网格 ✓')),
        h('h3', {}, '标记点（可在视口拖动）'),
        ...im.markers.map((mk, idx) => h('div', {
          class: 'layer-row',
          style: 'cursor:pointer;border:1px solid var(--border);border-radius:6px;padding:5px 7px',
        },
          h('span', { style: `width:10px;height:10px;border-radius:50%;background:rgb(${MARKER_COLOR[mk.kind].map((v) => v * 255).join(',')})` }),
          h('span', { style: 'flex:1' }, mk.label ?? mk.kind),
          h('button', {
            class: 'btn ghost small', onclick: () => {
              const pos = prompt('输入新坐标 x,y,z（mm）', mk.position.join(','));
              if (!pos) return;
              const parts = pos.split(',').map(Number);
              if (parts.length === 3 && parts.every(Number.isFinite)) {
                im!.markers[idx] = { ...mk, position: parts as Vec3 };
                persist(im!);
              }
            },
          }, '坐标'),
        )),
        h('h3', {}, '缺陷与气泡'),
        defects.length
          ? h('div', {}, ...defects.map((d) => h('div', {
            class: 'collision-item ' + (d.kind === 'defect' ? 'bad' : 'warn'),
          }, `${d.label}：半径 ${(d.radius ?? 0).toFixed(1)}mm @ (${d.position.map((v) => v.toFixed(1)).join(', ')})`)))
          : h('div', { class: 'badge ok' }, '未检出明显气泡/缺损'),
        h('button', {
          class: 'btn ghost', style: 'margin-top:10px;width:100%', onclick: async () => {
            const re = makeImpressionFromMesh(mesh, im!.source, im!.syntheticKind);
            re.id = im!.id;
            await persist(re);
            toast('已重新自动检测标记点');
          },
        }, '重新自动检测'),
      );
    }
  };

  // 标记点拖动：射线求交印模表面，把标记吸附到命中点
  const bindMarkerDrag = (vp: Viewport) => {
    const canvas = vp.canvas;
    let dragging: AnnoMarker | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (!im || e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const ray = vp.pickRay(e.clientX - rect.left, e.clientY - rect.top);
      let best: { mk: AnnoMarker; d: number } | null = null;
      for (const mk of im.markers) {
        // 射线到标记球心距离
        const oc = sub3(mk.position, ray.origin);
        const t = 0;
        void t;
        const proj = scale3(ray.dir, 0);
        void proj;
        const along = oc[0] * ray.dir[0] + oc[1] * ray.dir[1] + oc[2] * ray.dir[2];
        const closest = add3(ray.origin, scale3(ray.dir, along));
        const d = dist3(closest, mk.position);
        if (d < (mk.radius ?? 0.7) + 1.2 && (!best || d < best.d)) best = { mk, d };
      }
      if (best) {
        dragging = best.mk;
        canvas.setPointerCapture(e.pointerId);
        e.stopImmediatePropagation();
      }
    }, true);
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging || !im) return;
      const rect = canvas.getBoundingClientRect();
      const ray = vp.pickRay(e.clientX - rect.left, e.clientY - rect.top);
      const mesh: Mesh = {
        positions: Float32Array.from(im.meshData.positions),
        normals: new Float32Array(im.meshData.positions.length),
        indices: Uint32Array.from(im.meshData.indices),
      };
      const hit = rayMeshFirstHit(mesh, ray);
      if (hit) {
        const newPos = add3(ray.origin, scale3(ray.dir, hit.t));
        dragging.position = newPos;
        refreshView();
      }
    });
    canvas.addEventListener('pointerup', async () => {
      if (dragging && im) {
        await app.saveImpression(im);
        toast(`标记「${dragging.label}」已移动并保存`);
        dragging = null;
        drawPanel();
      }
    });
  };

  root.append(h('div', { style: 'display:flex;gap:16px;height:calc(100% - 40px);min-height:0' }, viewHost, sidePanel));
  createViewportDeferred(viewHost, [0, 0, 0], 30, {
    layerConfig: defaultLayerConfig(),
    heatMode: false,
    minWall: 0.6,
    clip: noClip,
  }, (vp) => {
    viewport = vp;
    bindMarkerDrag(viewport);
    drawPanel();
    refreshView();
  });
}

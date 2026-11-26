// 内部排布页：受话器/电池仓/面板/芯片按真实尺寸摆放，器件碰撞与壳体干涉检测
import { h, clear, toast } from '../ui/dom';
import { createViewerHost } from '../ui/viewerHost';
import { store } from '../state/store';
import {
  COMPONENT_LIB, PlacedComponent, defaultLayout, detectCollisions, componentShellCollisions, componentMesh,
} from '../core/components';
import { markerMesh, ViewerEntry } from '../render/viewer';
import { v3, Vec3 } from '../core/math';

export function layoutPage(root: HTMLElement): void {
  const host = createViewerHost();
  const col = h('div', { class: 'page-col wide scroll' });
  const imp = store.state.impression;
  const shell = store.state.shellResult;

  if (!imp || !shell) {
    clear(root);
    root.append(h('div', { class: 'page' }, col, h('div', { class: 'viewer-wrap' },
      h('div', { class: 'empty-hint' }, '请先完成耳印扫描与外壳设计'))));
    return;
  }

  let placed: PlacedComponent[] = store.state.components
    ? store.state.components.map((c) => ({ ...c, center: [...c.center] as Vec3, axis: [...c.axis] as Vec3 }))
    : defaultLayout(imp.centerline, imp.landmarks, imp.radiusAt);
  store.setComponents(placed);

  const render3D = (): void => {
    const v = host.ensure();
    v.clear();
    v.transparent = true;
    v.setEntry({ id: 'shell', label: '外壳(透明)', mesh: shell.mesh, color: [0.6, 0.72, 0.85], alpha: 0.25, visible: true, pickable: true });
    for (const c of placed) {
      const spec = COMPONENT_LIB[c.specIndex];
      v.setEntry({
        id: c.id, label: c.label, mesh: componentMesh(c, COMPONENT_LIB),
        color: spec.color, alpha: 0.95, visible: true, pickable: true,
      });
    }
    v.fitView();
  };

  const collisionCard = h('div', { class: 'card' });
  const checkCollisions = (): void => {
    const cc = detectCollisions(placed, COMPONENT_LIB);
    const sc = componentShellCollisions(placed, COMPONENT_LIB, shell.field);
    clear(collisionCard);
    collisionCard.append(h('h3', {}, '碰撞 / 干涉检测'));
    if (cc.length === 0 && sc.length === 0) {
      collisionCard.append(h('span', { class: 'tag ok' }, '✓ 器件之间、器件与壳体均无干涉'));
    } else {
      for (const x of cc) {
        collisionCard.append(h('div', { class: 'metric' },
          h('span', { class: 'k fail' }, `器件碰撞 ${x.a}↔${x.b}`),
          h('span', { class: 'v fail' }, `侵入 ${x.penetration.toFixed(2)}mm`)));
        host.ensure().setEntry({ id: `col-${x.a}-${x.b}`, label: '碰撞点', mesh: markerMesh(x.point, 0.4, [1, 0.2, 0.2]), color: [1, 0.2, 0.2], alpha: 1, visible: true, pickable: false });
      }
      for (const x of sc) {
        collisionCard.append(h('div', { class: 'metric' },
          h('span', { class: 'k fail' }, `器件穿壳 ${x.component}`),
          h('span', { class: 'v fail' }, `深度 ${x.depth.toFixed(2)}mm`)));
      }
    }
  };

  const listCard = h('div', { class: 'card' });
  const renderList = (): void => {
    clear(listCard);
    listCard.append(h('h3', {}, '器件排布（真实尺寸 mm）'));
    for (const c of placed) {
      const spec = COMPONENT_LIB[c.specIndex];
      listCard.append(
        h('div', { style: { borderBottom: '1px solid var(--border)', padding: '8px 0' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
            h('strong', { style: { fontSize: '13px' } }, c.label),
            h('select', {
              style: { width: '130px' },
              onchange: (e: Event) => { c.specIndex = parseInt((e.target as HTMLSelectElement).value); persist(); },
            }, ...COMPONENT_LIB.map((s, i) => h('option', { value: i, selected: i === c.specIndex }, s.label))),
          ),
          h('div', { class: 'muted mono', style: { fontSize: '11px', margin: '4px 0' } },
            `半尺寸 ${spec.half.map((x) => x.toFixed(1)).join('×')}  中心 ${c.center.map((x) => x.toFixed(1)).join(',')}`),
          h('div', { class: 'row', style: { gap: '4px' } },
            ...([['沿耳道前进', 1], ['沿耳道后退', -1]] as [string, number][]).map(([lab, d]) =>
              h('button', {
                class: 'btn ghost', style: { padding: '5px', fontSize: '11px' },
                onclick: () => moveComponent(c, d),
              }, lab)),
          ),
        ),
      );
    }
  };

  const moveComponent = (c: PlacedComponent, dir: number): void => {
    const cl = imp.centerline;
    const proj = cl.project(c.center);
    const ns = Math.max(0.5, Math.min(cl.totalLen - 0.5, proj.s + dir * 0.8));
    c.center = cl.pointAt(ns);
    c.axis = cl.tangentAt(ns);
    persist();
  };

  const persist = (): void => {
    store.setComponents(placed);
    render3D();
    renderList();
    checkCollisions();
  };

  col.append(
    h('div', { class: 'card' },
      h('h3', {}, '内部排布'),
      h('div', { class: 'muted', style: { marginBottom: '8px' } }, '器件沿耳道中心线摆放，可调整型号与前后位置，系统实时检测干涉'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost', onclick: () => { placed = defaultLayout(imp.centerline, imp.landmarks, imp.radiusAt); persist(); } }, '恢复默认排布'),
        h('button', { class: 'btn', onclick: () => { checkCollisions(); toast('碰撞检测完成'); } }, '重新检测'),
      ),
    ),
    listCard,
    collisionCard,
  );

  renderList();
  render3D();
  checkCollisions();

  clear(root);
  root.append(h('div', { class: 'page' }, col, host.wrap));
}

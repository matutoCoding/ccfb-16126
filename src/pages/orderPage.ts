// 工厂订单页：壳体 STL、材料颜色、通气孔、声管长度，附三张透视截图；历次订单壳型对比
import { h, clear, toast, download } from '../ui/dom';
import { createViewerHost } from '../ui/viewerHost';
import { store } from '../state/store';
import { db, FactoryOrder, uid, ClientProfile } from '../db/database';
import { exportBinarySTL } from '../core/mesh';
import { polylineToTubeMesh, ViewerEntry } from '../render/viewer';
import { componentMesh, COMPONENT_LIB } from '../core/components';

const COLORS = ['肤色', '透明', '咖啡', '粉肉色'];

export function orderPage(root: HTMLElement): void {
  const host = createViewerHost();
  const col = h('div', { class: 'page-col wide scroll' });
  const imp = store.state.impression;
  const shell = store.state.shellResult;
  const client = store.currentClient();

  if (!imp || !shell || !client) {
    clear(root);
    root.append(h('div', { class: 'page' }, col, h('div', { class: 'viewer-wrap' },
      h('div', { class: 'empty-hint' }, '请先选择客户并完成外壳设计'))));
    return;
  }

  let materialColor = COLORS[0];
  const screenshots: Blob[] = [];

  const buildViewer = (): void => {
    const v = host.ensure();
    v.clear();
    v.transparent = true;
    v.setEntry({ id: 'shell', label: '外壳', mesh: shell.mesh, color: [0.6, 0.74, 0.9], alpha: 0.4, visible: true, pickable: true });
    const p = store.state.shellParams!;
    if (p.soundPath.length >= 2) v.setEntry({ id: 'sound', label: '声管', mesh: polylineToTubeMesh(p.soundPath, p.soundTubeDiameter / 2), color: [0.25, 0.95, 0.55], alpha: 0.7, visible: true, pickable: false });
    if (p.ventPath.length >= 2) v.setEntry({ id: 'vent', label: '通气孔', mesh: polylineToTubeMesh(p.ventPath, p.ventDiameter / 2), color: [0.98, 0.72, 0.25], alpha: 0.7, visible: true, pickable: false });
    for (const c of store.state.components ?? []) {
      v.setEntry({ id: c.id, label: c.label, mesh: componentMesh(c, COMPONENT_LIB), color: COMPONENT_LIB[c.specIndex].color, alpha: 0.8, visible: true, pickable: false });
    }
    v.fitView();
  };

  const soundTubeLength = pathLength(store.state.shellParams!.soundPath);
  const shotCard = h('div', { class: 'card' }, h('h3', {}, '透视截图（3 张）'), h('div', { class: 'muted' }, '旋转到不同角度后依次截取'));
  const renderShots = (): void => {
    const imgs = shotCard.querySelectorAll('img');
    imgs.forEach((im) => im.remove());
    screenshots.forEach((blob, i) => {
      const url = URL.createObjectURL(blob);
      shotCard.append(h('img', { src: url, style: { width: '90px', height: '90px', objectFit: 'cover', border: '1px solid var(--border)', borderRadius: '6px', margin: '4px' }, title: `截图${i + 1}` }));
    });
  };

  const takeShot = (): void => {
    const blob = host.ensure().screenshot();
    screenshots.push(blob);
    if (screenshots.length > 3) screenshots.shift();
    renderShots();
    toast(`已截图 ${screenshots.length}/3`);
  };

  const submit = async (): Promise<void> => {
    const stlBlob = exportBinarySTL(shell.mesh);
    const order: FactoryOrder = {
      id: uid('ord'),
      clientId: client.id,
      shellDesignId: store.state.shellParams ? uid('shl') : uid('shl'),
      side: store.state.currentSide,
      materialColor,
      ventDiameter: store.state.shellParams!.ventDiameter,
      soundTubeLength,
      stlBlob,
      screenshots: [...screenshots],
      createdAt: Date.now(),
      status: 'submitted',
    };
    await db.put('orders', order);
    // 挂到客户该侧历史
    const ear = client[store.state.currentSide];
    ear.history.push(order.id);
    ear.shellDesignId = order.shellDesignId;
    await store.saveClient(client);
    toast('工厂订单已生成并归档');
    renderHistory();
  };

  const historyCard = h('div', { class: 'card' });
  const renderHistory = async (): Promise<void> => {
    clear(historyCard);
    const orders = await db.getAllByIndex<FactoryOrder>('orders', 'clientId', client.id);
    historyCard.append(h('h3', {}, `历次订单（${orders.length}）`));
    if (!orders.length) {
      historyCard.append(h('div', { class: 'muted' }, '暂无订单'));
      return;
    }
    historyCard.append(
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '日期'), h('th', {}, '耳侧'), h('th', {}, '颜色'), h('th', {}, '通气孔'), h('th', {}, '状态'))),
        h('tbody', {}, ...orders.map((o) =>
          h('tr', {},
            h('td', {}, new Date(o.createdAt).toLocaleDateString('zh-CN')),
            h('td', {}, o.side === 'left' ? '左' : '右'),
            h('td', {}, o.materialColor),
            h('td', { class: 'mono' }, `${o.ventDiameter.toFixed(1)}mm`),
            h('td', {}, h('span', { class: o.status === 'submitted' ? 'tag ok' : 'tag warn' }, o.status === 'submitted' ? '已下单' : '草稿')),
          ))),
      ),
    );
    if (orders.length >= 2) {
      historyCard.append(
        h('div', { style: { marginTop: '10px' } },
          h('button', { class: 'btn ghost', onclick: () => compareOrders(orders, client) }, '对比历次壳型差异'),
        ),
      );
    }
  };

  col.append(
    h('div', { class: 'card' },
      h('h3', {}, '工厂订单参数'),
      h('div', { class: 'field' }, h('label', {}, '材料颜色'),
        h('select', { onchange: (e: Event) => { materialColor = (e.target as HTMLSelectElement).value; } },
          ...COLORS.map((c) => h('option', { value: c }, c)))),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '通气孔直径'), h('span', { class: 'v' }, `${store.state.shellParams!.ventDiameter.toFixed(1)} mm（可调 1~3）`)),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '声管长度'), h('span', { class: 'v' }, `${soundTubeLength.toFixed(2)} mm`)),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '壳体三角面'), h('span', { class: 'v' }, String(shell.mesh.indices.length / 3))),
      h('div', { class: 'btn-row', style: { marginTop: '10px' } },
        h('button', { class: 'btn ghost', onclick: () => { download(`shell-${Date.now()}.stl`, exportBinarySTL(shell.mesh)); } }, '下载壳体 STL'),
      ),
    ),
    shotCard,
    h('div', { class: 'card' },
      h('h3', {}, '出单'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost', onclick: takeShot }, '📷 截取当前视角'),
        h('button', { class: 'btn', onclick: submit }, '生成工厂订单'),
      ),
      h('div', { class: 'muted', style: { marginTop: '6px' } }, '订单含 STL、材料颜色、通气孔直径、声管长度与透视截图，全部存本机 IndexedDB'),
    ),
    historyCard,
  );

  buildViewer();
  renderHistory();
  clear(root);
  root.append(h('div', { class: 'page' }, col, host.wrap));
}

function pathLength(points: { length: number } & { [i: number]: [number, number, number] }): number {
  let len = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return len;
}

// 历次订单壳型对比：当前壳与最近一次订单参数差异
function compareOrders(orders: FactoryOrder[], client: ClientProfile): void {
  const latest = orders[orders.length - 1];
  const cur = store.state.shellParams!;
  const lines = [
    `客户：${client.name}（${store.state.currentSide === 'left' ? '左' : '右'}耳）`,
    `最近订单：${new Date(latest.createdAt).toLocaleDateString('zh-CN')}`,
    `通气孔直径：上次 ${latest.ventDiameter.toFixed(1)}mm → 本次 ${cur.ventDiameter.toFixed(1)}mm`,
    `声管长度：上次 ${latest.soundTubeLength.toFixed(1)}mm → 本次 ${pathLength(cur.soundPath).toFixed(1)}mm`,
    `材料颜色：上次 ${latest.materialColor}`,
    `截短位置：本次 s=${cur.trimS.toFixed(2)}mm`,
  ];
  alert(lines.join('\n'));
}

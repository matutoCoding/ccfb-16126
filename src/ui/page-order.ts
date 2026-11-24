/** 页面 6：工厂订单 —— 壳体 STL / 材料颜色 / 通气孔 / 声管长度 / 三张透视截图 / 历次壳型差异 */
import { app } from '../state';
import { h, clear, toast, fmt } from './dom';
import { FactoryOrder, MATERIAL_LABEL } from '../core/types';
import { buildShellWithStyle, tubeLength } from '../design-service';
import { exportBinarySTL, downloadArrayBuffer } from '../core/stl';
import { Viewport, defaultLayerConfig, createViewportDeferred } from '../render/Viewport';
import { buildScene, centerOfBounds, boundsRadius } from '../render/scene';
import { uid } from '../core/db';

export function renderOrderPage(root: HTMLElement): void {
  clear(root);
  root.append(h('h2', {}, '工厂订单与版本对比'));
  const c = app.currentCustomer;
  const im = app.currentImpression;
  if (!c || !im) { root.append(h('div', { class: 'card muted' }, '请先准备客户与设计。')); return; }
  const design = app.currentDesign;
  if (!design) { root.append(h('div', { class: 'card muted' }, '当前耳还没有设计稿。')); return; }
  let shell = app.currentShell ?? buildShellWithStyle(im, design, c.ears[app.currentSide].shellStyle);

  const viewHost = h('div', { class: 'viewport-wrap' });
  const panel = h('div', { class: 'card', style: 'width:340px;flex:0 0 340px;overflow:auto' });
  root.append(h('div', { style: 'display:flex;gap:16px;height:calc(100% - 40px);min-height:0' }, viewHost, panel));

  let viewport: Viewport | null = null;
  const shots: string[] = [];
  // 缩略图容器独立于内容区的 clear 周期，作为 panel 固定子节点
  const thumbBox = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px' });
  const renderThumbs = () => {
    clear(thumbBox);
    thumbBox.append(...shots.map((s) => h('img', { class: 'snapshot-thumb', src: s })));
  };
  // drawPanel 只重建 content，thumbBox 与 historyBox 不受影响
  const content = h('div', {});

  const drawPanel = () => {
    clear(content);
    const stlBuf = exportBinarySTL(shell.mesh);
    const stlBlob = new Blob([stlBuf]);
    content.append(
      h('h3', {}, '订单参数'),
      h('table', { class: 'data' }, h('tbody', {},
        h('tr', {}, h('td', {}, '客户'), h('td', {}, `${c.name}（${app.currentSide === 'left' ? '左' : '右'}耳）`)),
        h('tr', {}, h('td', {}, '材料'), h('td', {}, MATERIAL_LABEL[design.material])),
        h('tr', {}, h('td', {}, '颜色'), h('td', {}, h('span', {
          style: `display:inline-block;width:14px;height:14px;border-radius:3px;background:${design.color};border:1px solid #fff4;margin-right:6px`,
        }), design.color)),
        h('tr', {}, h('td', {}, '壁厚'), h('td', { class: 'mono' }, `${fmt(design.wallThickness, 2)} mm`)),
        h('tr', {}, h('td', {}, '通气孔直径'), h('td', { class: 'mono' }, `${fmt(design.vent?.diameterMm ?? 0, 1)} mm`)),
        h('tr', {}, h('td', {}, '声管长度'), h('td', { class: 'mono' }, `${fmt(tubeLength(design.soundTube), 2)} mm`)),
        h('tr', {}, h('td', {}, '壳体三角面'), h('td', { class: 'mono' }, String(shell.mesh.indices.length / 3))),
        h('tr', {}, h('td', {}, 'STL 大小'), h('td', { class: 'mono' }, `${(stlBlob.size / 1024).toFixed(1)} KB`)),
      )),
      h('div', { style: 'display:flex;gap:8px;margin:12px 0' },
        h('button', { class: 'btn', onclick: () => downloadArrayBuffer(stlBuf, `${c.name}-${app.currentSide}-shell.stl`) }, '下载壳体 STL'),
      ),
      h('h3', {}, '三张透视截图'),
      h('div', { class: 'muted', style: 'margin-bottom:6px' }, '自动从三个角度各拍一张，存入订单'),
      h('button', {
        class: 'btn ghost', style: 'width:100%', onclick: async () => {
          if (!viewport) return;
          shots.length = 0;
          const yaws = [0.3, 2.2, 4.2];
          for (const yaw of yaws) {
            viewport.camera.yaw = yaw;
            viewport.camera.pitch = 0.3;
            viewport.invalidate();
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            const url = viewport.snapshot();
            shots.push(url);
          }
          renderThumbs();
          toast('三张透视截图已拍摄');
        },
      }, '拍摄三张透视截图'),
      h('button', {
        class: 'btn', style: 'width:100%;margin-top:12px', onclick: async () => {
          if (shots.length < 3) { toast('请先拍摄三张透视截图'); return; }
          const order: FactoryOrder = {
            id: uid('order'),
            designId: design.id,
            customerId: c.id,
            side: app.currentSide,
            createdAt: Date.now(),
            color: design.color,
            ventDiameterMm: design.vent?.diameterMm ?? 0,
            soundTubeLengthMm: tubeLength(design.soundTube),
            snapshots: shots.slice(),
            shellStl: stlBuf,
            orderNo: 'PO' + Date.now().toString().slice(-8),
          };
          await app.saveOrder(order);
          toast(`订单 ${order.orderNo} 已生成并存入 IndexedDB`);
          drawHistory();
        },
      }, '生成工厂订单'),
    );
    drawHistory();
  };

  const historyBox = h('div', {});
  const drawHistory = () => {
    clear(historyBox);
    const orders = app.orders.filter((o) => o.customerId === c.id && o.side === app.currentSide);
    historyBox.append(
      h('h3', {}, `本客户本耳历次订单（${orders.length}）`),
      orders.length === 0 ? h('div', { class: 'muted' }, '暂无订单。') : h('div', {},
        ...orders.map((o) => h('div', { class: 'card', style: 'margin-bottom:8px;padding:10px' },
          h('div', { style: 'display:flex;justify-content:space-between' },
            h('strong', {}, o.orderNo),
            h('span', { class: 'muted' }, new Date(o.createdAt).toLocaleDateString('zh-CN'))),
          h('div', { class: 'muted mono', style: 'margin:4px 0' },
            `通气孔 ${fmt(o.ventDiameterMm, 1)}mm · 声管 ${fmt(o.soundTubeLengthMm, 1)}mm · ${o.color}`),
          h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
            ...o.snapshots.map((s) => h('img', { class: 'snapshot-thumb', src: s, style: 'width:90px;height:60px' })),
            h('button', {
              class: 'btn ghost small', onclick: () => {
                if (o.shellStl) downloadArrayBuffer(o.shellStl, `${o.orderNo}.stl`);
              },
            }, 'STL'),
          ),
        ))),
      h('h3', {}, '壳型差异对比（历次设计参数）'),
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, '版本'), h('th', {}, '壁厚'), h('th', {}, '截短位'), h('th', {}, '倒圆'), h('th', {}, '通气孔'), h('th', {}, '时间'))),
        h('tbody', {}, ...c.ears[app.currentSide].designHistory.map((id) => {
          const d = app.designs.get(id);
          if (!d) return h('tr', {}, h('td', { colspan: 6, class: 'muted' }, '版本数据已删除'));
          return h('tr', { style: d.id === design.id ? 'background:rgba(79,156,249,0.1)' : '' },
            h('td', { class: 'mono' }, `v${d.version}`),
            h('td', { class: 'mono' }, fmt(d.wallThickness, 2)),
            h('td', { class: 'mono' }, Math.round(d.trimPosition * 100) + '%'),
            h('td', { class: 'mono' }, fmt(d.edgeRadius, 2)),
            h('td', { class: 'mono' }, fmt(d.vent?.diameterMm ?? 0, 1)),
            h('td', {}, new Date(d.createdAt).toLocaleDateString('zh-CN')),
          );
        })),
      ),
    );
  };

  panel.append(content, thumbBox, historyBox);
  createViewportDeferred(viewHost, [0, 0, 0], 30, {
    layerConfig: defaultLayerConfig(),
    heatMode: false,
    minWall: app.settings.hardMinWall,
    clip: { point: [0, 0, 0], normal: [1, 0, 0], enabled: false },
  }, (vp) => {
    viewport = vp;
    const center = centerOfBounds(im.centerline);
    viewport.frame(center, boundsRadius(im.centerline, center) + 3);
    viewport.setItems(buildScene(shell, design, im, false));
    drawPanel();
  });
}

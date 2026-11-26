import type { EarSide, FactoryOrder } from '../types';
import { db, uid } from '../db';
import { writeBinarySTL } from '../geom/stl';
import { pathLength } from '../geom/pathgeom';
import { shellSignature } from '../geom/signature';
import { getCurrentDesign, getCurrentScan } from '../state';
import { h, clear, downloadBlob, formatDate } from './dom';
import type { UiContext } from './context';
import { captureThreeShots } from './sceneFactory';

export function closeModals() {
  document.querySelectorAll('.modal-backdrop').forEach(m => m.remove());
}

export function modalShell(title: string): { backdrop: HTMLElement; body: HTMLElement; close: () => void } {
  const body = h('div', { class: 'modal-bd' });
  const close = () => backdrop.remove();
  const backdrop = h('div', { class: 'modal-backdrop', onClick: (e: MouseEvent) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-hd' }, h('h3', { text: title }), h('button', { class: 'btn sm ghost', onClick: close, text: '✕' })),
      body
    )
  );
  document.body.appendChild(backdrop);
  return { backdrop, body, close };
}

export async function openOrderCreator(ctx: UiContext, preferredSide: EarSide = 'right') {
  const scan = getCurrentScan(ctx.state);
  const maybeDesign = getCurrentDesign(ctx.state);
  if (!scan || !maybeDesign) return ctx.toast('请先选择耳印并生成外壳设计', 'bad');
  const design = maybeDesign;
  const client = ctx.state.clients.find(c => c.id === ctx.state.currentClientId) ?? ctx.state.clients[0];
  if (!client) return ctx.toast('请先新建客户档案', 'bad');

  let side: EarSide = preferredSide;
  const sideSelect = h('select', { class: 'input' },
    h('option', { value: 'right', selected: side === 'right', text: '右耳' }),
    h('option', { value: 'left', selected: side === 'left', text: '左耳' })
  ) as HTMLSelectElement;
  const sideKpi = h('b', { style: 'font-size:16px', text: `${client.name} · ${side === 'left' ? '左耳' : '右耳'}` });
  sideSelect.addEventListener('change', () => { side = sideSelect.value as EarSide; sideKpi.textContent = `${client.name} · ${side === 'left' ? '左耳' : '右耳'}`; });
  let material = design.params.material;
  const materialSelect = h('select', { class: 'input' },
    h('option', { value: 'hard-acrylic', selected: material === 'hard-acrylic', text: '硬壳丙烯酸' }),
    h('option', { value: 'soft-silicone', selected: material === 'soft-silicone', text: '软硅胶' })
  ) as HTMLSelectElement;
  materialSelect.addEventListener('change', () => { material = materialSelect.value as FactoryOrder['material']; });
  const { body, close } = modalShell('生成工厂订单');
  const colorInput = h('input', { class: 'input', type: 'color', value: '#f2c9a0' }) as HTMLInputElement;
  const ventInput = h('input', { class: 'input', type: 'range', min: '1', max: '3', step: '0.1', value: String(design.params.ventDiameter) }) as HTMLInputElement;
  const ventOut = h('output', { text: `${design.params.ventDiameter.toFixed(1)} mm` });
  ventInput.addEventListener('input', () => { ventOut.textContent = `${ventInput.value} mm`; });
  const noteInput = h('textarea', { class: 'input', placeholder: '工厂备注：出声孔防护、抛光、包装等', text: '请重点检查第二弯壁厚；出声孔加装防耵聍网。' }) as HTMLTextAreaElement;
  const status = h('div', { class: 'helper-box', text: '将导出壳体二进制 STL，并从三个角度截取透视图片。' });

  body.append(
    h('div', { class: 'diff-grid' },
      h('div', { class: 'stack' },
        h('div', { class: 'field' }, h('label', { text: '订单耳别' }), sideSelect),
        h('div', { class: 'field' }, h('label', {}, '材料'), materialSelect),
        h('div', { class: 'field' }, h('label', {}, '材料颜色'), colorInput),
        h('div', { class: 'field' }, h('label', {}, '通气孔直径 ', ventOut), ventInput),
        h('div', { class: 'field' }, h('label', {}, '备注'), noteInput)
      ),
      h('div', { class: 'stack' },
        h('div', { class: 'kpi' }, h('span', { text: '客户 / 耳别' }), sideKpi),
        h('div', { class: 'kpi' }, h('span', { text: '壳体三角面' }), h('b', { style: 'font-size:16px', text: `${Math.round(design.shellMesh.indices.length / 3).toLocaleString()} 面` })),
        status
      )
    ),
    h('div', { class: 'hr' }),
    h('div', { class: 'flex-end' },
      h('button', { class: 'btn', onClick: close, text: '取消' }),
      h('button', { class: 'btn primary', onClick: async (e: MouseEvent) => {
        const btn = e.currentTarget as HTMLButtonElement;
        btn.disabled = true; btn.textContent = '正在生成截图和 STL…';
        try {
          design.params.ventDiameter = Number(ventInput.value);
          const shots = await captureThreeShots(scan, design);
          const stl = writeBinarySTL(design.shellMesh, `${client.name}-${side}-${design.id}`);
          const soundPath = design.paths.find(p => p.kind === 'sound');
          const tubeLength = soundPath ? pathLength(soundPath.points) + 2 : 0;
          const order: FactoryOrder = {
            id: uid('order'), clientId: client.id, side, designId: design.id, createdAt: Date.now(),
            material, color: colorInput.value, ventDiameter: Number(ventInput.value),
            soundTubeLength: Math.round(tubeLength * 10) / 10, stl, screenshots: shots, note: noteInput.value,
            shellSignature: shellSignature(scan, design.shellMesh)
          };
          await db.orders.save(order);
          ctx.state.orders.unshift(order);
          client.updatedAt = Date.now();
          client[side].orderIds.push(order.id);
          client.history.unshift({ id: uid('h'), date: Date.now(), side, orderId: order.id, designId: design.id, version: client.history.length + 1, note: '生成工厂订单' });
          await db.clients.save(client);
          ctx.toast('订单已存入 IndexedDB，可下载 STL 和截图', 'ok');
          close();
          openOrderDetail(ctx, order.id);
        } catch (err) {
          console.error(err);
          ctx.toast(`订单生成失败：${(err as Error).message}`, 'bad');
          btn.disabled = false; btn.textContent = '创建订单';
        }
      }, text: '创建订单' })
    )
  );
}

export function openOrderDetail(ctx: UiContext, orderId: string) {
  const order = ctx.state.orders.find(o => o.id === orderId);
  if (!order) return;
  const client = ctx.state.clients.find(c => c.id === order.clientId);
  const { body, close } = modalShell(`工厂订单 ${order.id.slice(-6).toUpperCase()}`);
  const sig = order.shellSignature;
  body.append(
    h('div', { class: 'row between' },
      h('div', { class: 'stack' },
        h('strong', { text: `${client?.name ?? '客户'} · ${order.side === 'left' ? '左耳' : '右耳'}` }),
        h('span', { class: 'muted small', text: formatDate(order.createdAt) })
      ),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary sm', onClick: () => downloadBlob(order.stl, `${order.id}.stl`), text: '下载壳体 STL' }),
        h('button', { class: 'btn sm', onClick: () => openOrderComparison(ctx, order.clientId), text: '历次壳型对比' }),
        h('button', { class: 'btn ghost sm', onClick: close, text: '关闭' })
      )
    ),
    h('div', { class: 'kpi-grid', style: 'margin:14px 0' },
      kpi('材料', order.material === 'hard-acrylic' ? '硬壳' : '软硅胶'),
      kpi('颜色', order.color),
      kpi('通气孔', `${order.ventDiameter.toFixed(1)} mm`),
      kpi('声管长度', `${order.soundTubeLength.toFixed(1)} mm`)
    ),
    h('div', { class: 'shot-grid' }, ...order.screenshots.map((src, i) => h('img', { src, alt: `透视截图 ${i + 1}` }))),
    h('div', { class: 'helper-box', style: 'margin-top:14px', text: order.note || '无备注' }),
    ...(sig ? [h('pre', { class: 'verification-log', style: 'margin-top:14px', text: JSON.stringify(sig, null, 2) })] : [])
  );
}

function kpi(label: string, value: string) {
  return h('div', { class: 'kpi' }, h('span', { text: label }), h('b', { style: 'font-size:16px', text: value }));
}

export function openOrderComparison(ctx: UiContext, clientId: string) {
  const orders = ctx.state.orders.filter(o => o.clientId === clientId && o.shellSignature);
  const { body } = modalShell('同一客户历次订单壳型差异');
  if (orders.length < 1) {
    body.append(h('div', { class: 'helper-box', text: '该客户还没有带壳型签名的订单。创建至少一张订单后即可比较长度、宽度、弯角和体积。' }));
    return;
  }
  const latest = orders[0];
  const previous = orders[1];
  body.append(
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', { text: '订单/时间' }), h('th', { text: '长度' }), h('th', { text: '最大宽度' }), h('th', { text: '第二弯弯角' }), h('th', { text: '体积' }), h('th', { text: '差异' }))),
      h('tbody', {}, ...orders.map((o, i) => h('tr', {},
        h('td', {}, h('strong', { text: `${o.id.slice(-6).toUpperCase()}${i === 0 ? '（最新）' : ''}` }), h('div', { class: 'tiny muted', text: formatDate(o.createdAt) })),
        h('td', { text: `${o.shellSignature!.lengthMm} mm` }),
        h('td', { text: `${o.shellSignature!.maxWidthMm} mm` }),
        h('td', { text: `${o.shellSignature!.bendAngle}°` }),
        h('td', { text: `${o.shellSignature!.volumeMm3} mm³` }),
        h('td', { text: i === 0 && previous ? diffText(previous.shellSignature!, o.shellSignature!) : '—' })
      )))
    ),
    h('div', { class: 'diff-grid', style: 'margin-top:16px' },
      h('div', {}, h('h4', { text: previous ? '旧壳透视' : '当前订单透视' }), h('img', { class: 'compare-svg', src: (previous ?? latest).screenshots[0], style: 'height:260px;object-fit:cover' })),
      h('div', {}, h('h4', { text: '最新壳透视' }), h('img', { class: 'compare-svg', src: latest.screenshots[1] ?? latest.screenshots[0], style: 'height:260px;object-fit:cover' }))
    )
  );
}

function diffText(a: NonNullable<FactoryOrder['shellSignature']>, b: NonNullable<FactoryOrder['shellSignature']>): string {
  return `长度 ${signed(b.lengthMm - a.lengthMm)} / 宽 ${signed(b.maxWidthMm - a.maxWidthMm)} / 弯角 ${signed(b.bendAngle - a.bendAngle, 1)}° / 体积 ${Math.round(b.volumeMm3 - a.volumeMm3)}`;
}
function signed(n: number, d = 1) { return `${n >= 0 ? '+' : ''}${n.toFixed(d)}`; }

// Avoid unused import in some build configurations while keeping clear available for future modal updates.
void clear;

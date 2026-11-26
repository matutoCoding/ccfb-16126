import { db, idb } from '../../db';
import { VARIANT_META } from '../../geom/procedural';
import type { VerifyResult } from '../../types';
import { runAllVerification } from '../../verify/harness';
import { h } from '../dom';
import type { UiContext } from '../context';

export function renderSettingsPage(ctx: UiContext) {
  const element = h('div', { class: 'page-grid', style: 'grid-template-columns:minmax(0,1fr) 380px;align-items:start' });
  const main = h('div', { class: 'stack' });
  const side = h('div', { class: 'stack' });

  const verifyLog = h('div', { class: 'verification-log', text: '尚未运行。点击“运行两项硬性验收”。' });
  const verifyCard = h('div', { class: 'card' },
    h('div', { class: 'card-hd' }, h('div', {}, h('h3', { text: '透视正确性验收' }), h('p', { text: '真实 WebGL2 画布 + CPU 参考结果' })), h('button', {
      class: 'btn success sm', text: '运行两项硬性验收',
      onClick: async (e: MouseEvent) => {
        const btn = e.currentTarget as HTMLButtonElement;
        btn.disabled = true; btn.textContent = '验收运行中…';
        verifyLog.textContent = '正在创建 16 层叠层并逐像素求交，请稍候…';
        let results: VerifyResult[] = [];
        try {
          results = await runAllVerification();
        } catch (err) {
          results = [{ name: '验收异常', pass: false, message: (err as Error).stack ?? String(err) }];
        }
        verifyLog.textContent = results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n  ${r.message}`).join('\n\n');
        ctx.toast(results.every(r => r.pass) ? '像素排序和壁厚误差验收通过' : '有验收项未通过，请查看日志', results.every(r => r.pass) ? 'ok' : 'bad');
        btn.disabled = false; btn.textContent = '重新运行验收';
      }
    })),
    h('div', { class: 'card-bd stack' },
      h('div', { class: 'kpi-grid', style: 'grid-template-columns:1fr 1fr' },
        metric('色阶容差', '≤ 2'), metric('壁厚容差', '< 0.05 mm')
      ),
      verifyLog
    )
  );

  const dataCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', { text: 'IndexedDB 与数据' })));
  const dataBody = h('div', { class: 'card-bd stack' });
  async function refreshStats() {
    const [clients, scans, designs, orders] = await Promise.all([db.clients.all(), db.scans.all(), db.designs.all(), db.orders.all()]);
    let estimate = '浏览器未提供';
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.usage) estimate = `${(est.usage / 1024 / 1024).toFixed(2)} MB / 配额 ${est.quota ? (est.quota / 1024 / 1024 / 1024).toFixed(1) : '?'} GB`;
    } catch { /* noop */ }
    dataBody.innerHTML = '';
    dataBody.append(
      h('div', { class: 'kpi-grid' },
        metric('客户', String(clients.length)), metric('耳印', String(scans.length)),
        metric('设计', String(designs.length)), metric('订单', String(orders.length))
      ),
      h('div', { class: 'helper-box', text: `存储占用：${estimate}。所有客户档案、TypedArray 网格、STL Blob、订单截图均保存在本机 IndexedDB 数据库 ear-shell-studio。` }),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', text: '重新播种四副测试耳模', onClick: async () => {
          const { seedScansIfNeeded } = await import('../../seed');
          await seedScansIfNeeded();
          ctx.toast('测试耳模已就绪', 'ok'); ctx.rerender();
        } }),
        h('button', { class: 'btn danger', text: '清空全部本机数据并重置', onClick: async () => {
          if (!confirm('确定清空客户、耳印、设计和订单？此操作不可恢复。')) return;
          await Promise.all(['clients', 'scans', 'designs', 'orders', 'kv'].map(s => idb.clear(s)));
          location.reload();
        } })
      )
    );
  }
  dataCard.append(dataBody);
  void refreshStats();

  const renderCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', { text: '渲染与精度' })),
    h('div', { class: 'card-bd stack' },
      h('div', { class: 'field' }, h('label', { text: '画布渲染分辨率缩放' }),
        h('select', { class: 'input', onChange: (e: Event) => { ctx.state.settings.rendererScale = Number((e.target as HTMLSelectElement).value); void db.settings.save(ctx.state.settings); ctx.toast('切换页面后生效', 'ok'); } },
          ...[['0.75', '省电 0.75×'], ['1', '标准 1×'], ['1.25', '高精度 1.25×']].map(([v, t]) => h('option', { value: v, selected: ctx.state.settings.rendererScale === Number(v), text: t }))
        )
      ),
      h('div', { class: 'field' }, h('label', { text: '最大深度剥离层数' }),
        h('select', { class: 'input', onChange: (e: Event) => { ctx.state.settings.maxPeelLayers = Number((e.target as HTMLSelectElement).value); void db.settings.save(ctx.state.settings); } },
          ...[['20', '20 层'], ['28', '28 层（推荐）'], ['40', '40 层（较慢）']].map(([v, t]) => h('option', { value: v, selected: ctx.state.settings.maxPeelLayers === Number(v), text: t }))
        )
      ),
      h('div', { class: 'helper-box', text: '透明结果使用 RGBA32F 累加目标；壁厚层距离使用 R32F，避免 24-bit 深度缓冲在毫米读数上量化。' })
    )
  );

  const scansCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', { text: '程序生成验收耳模' })),
    h('div', { class: 'card-bd stack' }, ...ctx.state.scans.map(s => h('button', {
      class: 'list-item', onClick: () => ctx.navigate('scan', s.id)
    }, h('strong', { text: s.name }), h('span', { text: VARIANT_META[s.variant]?.description ?? '导入 STL' }))))
  );

  main.append(verifyCard, dataCard);
  side.append(renderCard, scansCard);
  element.append(main, side);
  return element;
}

function metric(label: string, value: string) {
  return h('div', { class: 'kpi' }, h('span', { text: label }), h('b', { style: 'font-size:18px', text: value }));
}

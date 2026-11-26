import type { ClientRecord, EarSide, MoldType } from '../../types';
import { db, uid } from '../../db';
import { defaultAudiogram } from '../../seed';
import { h, formatDate } from '../dom';
import type { UiContext } from '../context';
import { audiogramSVG } from '../audiogram';
import { openOrderComparison, openOrderCreator, openOrderDetail } from '../orders';

const MOLD_OPTIONS: Array<[MoldType, string]> = [
  ['full-concha', '全耳甲腔式'],
  ['half-concha', '半耳甲腔式'],
  ['canal', '耳道式'],
  ['deep-canal', '深耳道式']
];

export function renderClientsPage(ctx: UiContext): HTMLElement {
  let selectedSide: EarSide = 'right';
  const layout = h('div', { class: 'clients-layout' });

  const listCard = h('div', { class: 'card' },
    h('div', { class: 'card-hd' },
      h('div', {}, h('h3', { text: '客户列表' }), h('p', { text: '档案保存在 IndexedDB' })),
      h('button', { class: 'btn primary sm', text: '＋ 新建', onClick: async () => {
        const now = Date.now();
        const client: ClientRecord = {
          id: uid('client'), name: `新客户 ${ctx.state.clients.length + 1}`, phone: '', age: undefined,
          createdAt: now, updatedAt: now,
          left: { side: 'left', audiogram: defaultAudiogram(), deviceModel: '', moldType: 'full-concha', orderIds: [], note: '' },
          right: { side: 'right', audiogram: defaultAudiogram(), deviceModel: '', moldType: 'deep-canal', orderIds: [], note: '' },
          history: []
        };
        await db.clients.save(client);
        ctx.state.clients.unshift(client);
        ctx.state.currentClientId = client.id;
        ctx.rerender();
      } })
    ),
    h('div', { class: 'card-bd' }, h('div', { class: 'list' }, ...ctx.state.clients.map(c =>
      h('button', {
        class: `list-item ${ctx.state.currentClientId === c.id ? 'active' : ''}`,
        onClick: () => { ctx.state.currentClientId = c.id; ctx.rerender(); }
      }, h('strong', { text: c.name }), h('span', { text: `${c.phone || '未留电话'} · 档案 ${formatDate(c.createdAt)}` }))
    )))
  );

  const detailHost = h('div');
  layout.append(listCard, detailHost);

  function renderDetail() {
    const client = ctx.state.clients.find(c => c.id === ctx.state.currentClientId) ?? ctx.state.clients[0];
    detailHost.innerHTML = '';
    if (!client) {
      detailHost.append(h('div', { class: 'card card-bd helper-box', text: '还没有客户，请先新建档案。' }));
      return;
    }
    ctx.state.currentClientId = client.id;
    const profile = client[selectedSide];
    const sideOrders = ctx.state.orders.filter(o => o.clientId === client.id && o.side === selectedSide);

    const nameInput = h('input', { class: 'input', value: client.name }) as HTMLInputElement;
    nameInput.addEventListener('change', () => save({ name: nameInput.value }));
    const phoneInput = h('input', { class: 'input', value: client.phone, placeholder: '联系电话' }) as HTMLInputElement;
    phoneInput.addEventListener('change', () => save({ phone: phoneInput.value }));
    const ageInput = h('input', { class: 'input', type: 'number', value: String(client.age ?? ''), placeholder: '年龄' }) as HTMLInputElement;
    ageInput.addEventListener('change', () => save({ age: ageInput.value ? Number(ageInput.value) : undefined }));

    const modelInput = h('input', { class: 'input', value: profile.deviceModel, placeholder: '例如：Audeo L50 / 定制 CIC' }) as HTMLInputElement;
    modelInput.addEventListener('change', () => saveProfile({ deviceModel: modelInput.value }));
    const moldSelect = h('select', { class: 'input' }, ...MOLD_OPTIONS.map(([v, label]) => h('option', { value: v, selected: profile.moldType === v, text: label }))) as HTMLSelectElement;
    moldSelect.addEventListener('change', () => saveProfile({ moldType: moldSelect.value as MoldType }));
    const noteInput = h('textarea', { class: 'input', text: profile.note, placeholder: '胀、顶痛、耵聍堵塞、老人往返意见等' }) as HTMLTextAreaElement;
    noteInput.addEventListener('change', () => saveProfile({ note: noteInput.value }));

    const audioHost = h('div', { html: audiogramSVG(profile.audiogram) });
    const thresholdInputs = profile.audiogram.frequencies.map((f, i) => {
      const input = h('input', {
        class: 'input', type: 'number', min: '-10', max: '120',
        value: String(profile.audiogram[selectedSide][i] ?? '')
      }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const value = input.value === '' ? null : Number(input.value);
        profile.audiogram[selectedSide][i] = value;
        client.updatedAt = Date.now();
        void db.clients.save(client).then(() => { audioHost.innerHTML = audiogramSVG(profile.audiogram); });
      });
      return h('div', { class: 'field' }, h('label', {}, f >= 1000 ? `${f / 1000}k` : String(f)), input);
    });

    detailHost.append(
      h('div', { class: 'stack' },
        h('div', { class: 'card card-bd' },
          h('div', { class: 'row between' },
            h('div', { class: 'client-head' },
              h('div', { class: 'avatar', text: client.name.slice(0, 1) }),
              h('div', {}, h('h2', { style: 'margin:0;font-size:22px', text: client.name }), h('div', { class: 'muted small', text: `建档 ${formatDate(client.createdAt)} · 最近更新 ${formatDate(client.updatedAt)}` }))
            ),
            h('div', { class: 'row' },
              h('button', { class: 'btn primary', text: '出工厂订单', onClick: () => openOrderCreator(ctx, selectedSide) }),
              h('button', { class: 'btn', text: '壳型差异对比', onClick: () => openOrderComparison(ctx, client.id) })
            )
          ),
          h('div', { class: 'grid-2', style: 'display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-top:16px' },
            h('div', { class: 'field' }, h('label', { text: '姓名' }), nameInput),
            h('div', { class: 'field' }, h('label', { text: '年龄' }), ageInput),
            h('div', { class: 'field', style: 'grid-column:1 / -1' }, h('label', { text: '电话' }), phoneInput)
          )
        ),

        h('div', { class: 'ear-tabs' },
          ...(['left', 'right'] as EarSide[]).map(side => h('button', {
            class: `ear-tab ${selectedSide === side ? 'active' : ''}`,
            onClick: () => { selectedSide = side; renderDetail(); }
          }, h('strong', { text: side === 'left' ? '左耳档案' : '右耳档案' }), h('div', { class: 'small muted', style: 'margin-top:4px', text: `${MOLD_OPTIONS.find(m => m[0] === client[side].moldType)?.[1]} · ${client[side].orderIds.length} 张订单` })))
        ),

        h('div', { class: 'page-grid', style: 'grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);gap:16px' },
          h('div', { class: 'card' },
            h('div', { class: 'card-hd' }, h('div', {}, h('h3', { text: '听力图' }), h('p', { text: '蓝叉为左耳，红圈为右耳；可在右侧修改当前耳阈值' })), h('span', { class: 'pill info', text: 'AC 气导' })),
            h('div', { class: 'card-bd' }, audioHost)
          ),
          h('div', { class: 'card' },
            h('div', { class: 'card-hd' }, h('h3', { text: `${selectedSide === 'left' ? '左' : '右'}耳验配参数` })),
            h('div', { class: 'card-bd' },
              h('div', { class: 'field' }, h('label', { text: '机型' }), modelInput),
              h('div', { class: 'field' }, h('label', { text: '耳模/外壳类型' }), moldSelect),
              h('div', { class: 'field' }, h('label', { text: '听力阈值 dB HL' }), h('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:7px', ...{} }, ...thresholdInputs)),
              h('div', { class: 'field' }, h('label', { text: '复诊备注' }), noteInput)
            )
          )
        ),

        h('div', { class: 'card' },
          h('div', { class: 'card-hd' }, h('div', {}, h('h3', { text: '旧壳 / 新壳挂接与复诊记录' }), h('p', { text: '同一客户左右耳和历次工厂订单串联' })), h('span', { class: 'pill', text: `${client.history.length} 条记录` })),
          h('div', { class: 'card-bd tight' },
            h('table', { class: 'table' },
              h('thead', {}, h('tr', {}, h('th', { text: '日期' }), h('th', { text: '耳别/版本' }), h('th', { text: '问题' }), h('th', { text: '备注/订单' }), h('th', { text: '操作' }))),
              h('tbody', {}, ...client.history.map(item => h('tr', {},
                h('td', { class: 'small', text: formatDate(item.date) }),
                h('td', {}, h('span', { class: 'pill info', text: `${item.side === 'left' ? '左' : '右'} · v${item.version}` })),
                h('td', { text: item.issue ?? '—' }),
                h('td', { class: 'small muted', text: item.note ?? '—' }),
                h('td', {}, item.orderId ? h('div', { class: 'row' },
                  h('button', { class: 'btn sm', text: '查看订单', onClick: () => openOrderDetail(ctx, item.orderId!) }),
                  h('button', { class: 'btn sm ghost', text: '壳型对比', onClick: () => openOrderComparison(ctx, client.id) })
                ) : h('span', { class: 'muted tiny', text: '未关联订单' }))
              )))
            )
          )
        ),

        sideOrders.length ? h('div', { class: 'card' },
          h('div', { class: 'card-hd' }, h('h3', { text: `${selectedSide === 'left' ? '左' : '右'}耳订单` })),
          h('div', { class: 'card-bd', style: 'display:grid;gap:10px' }, ...sideOrders.map(o =>
            h('button', { class: 'list-item', onClick: () => openOrderDetail(ctx, o.id) },
              h('strong', { text: `${o.id.slice(-6).toUpperCase()} · ${o.ventDiameter.toFixed(1)} mm 通气孔` }),
              h('span', { text: `${formatDate(o.createdAt)} · 声管 ${o.soundTubeLength.toFixed(1)} mm · ${o.shellSignature ? `${o.shellSignature.lengthMm} mm 长` : ''}` })
            )
          ))
        ) : null
      )
    );

    async function save(patch: Partial<ClientRecord>) {
      Object.assign(client, patch, { updatedAt: Date.now() });
      await db.clients.save(client);
      ctx.toast('客户档案已保存', 'ok');
    }
    async function saveProfile(patch: Partial<ClientRecord[EarSide]>) {
      Object.assign(profile, patch);
      client.updatedAt = Date.now();
      await db.clients.save(client);
      ctx.toast('耳别参数已保存', 'ok');
    }
  }

  renderDetail();
  return layout;
}

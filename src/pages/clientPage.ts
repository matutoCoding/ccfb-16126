// 客户档案页：客户列表 + 左右耳档案 + 听力图
import { h, clear, field, toast } from '../ui/dom';
import { store } from '../state/store';
import {
  ClientProfile, EarSide, ShellType, SHELL_TYPE_LABEL, createClient, db, defaultAudiogram,
} from '../db/database';

const SHELL_TYPES: ShellType[] = ['fullShell', 'halfShell', 'itc', 'cic'];

export function clientPage(root: HTMLElement): void {
  const render = (): void => {
    const listCol = h('div', { class: 'page-col' });
    const detailCol = h('div', { class: 'page-col wide scroll' });

    // 左：客户列表
    listCol.append(
      h('div', { class: 'btn-row', style: { marginBottom: '12px' } },
        h('button', {
          class: 'btn',
          onclick: async () => {
            const c = await createClient({ name: '新客户' });
            await store.loadClients();
            await store.selectClient(c.id);
            toast('已创建新客户');
          },
        }, '+ 新建客户'),
      ),
      ...store.state.clients.map((c) =>
        h('div', {
          class: `list-item${c.id === store.state.currentClientId ? ' sel' : ''}`,
          onclick: () => store.selectClient(c.id),
        },
          h('div', { class: 't' }, c.name),
          h('div', { class: 'd' }, `${c.gender || '—'} · ${c.age}岁 · ${c.phone || '无电话'}`),
        ),
      ),
    );

    const client = store.currentClient();
    if (!client) {
      detailCol.append(h('div', { class: 'empty-hint', style: { position: 'static' } }, '请选择或新建客户'));
    } else {
      renderDetail(detailCol, client);
    }

    clear(root);
    root.append(h('div', { class: 'page' }, listCol, detailCol));
  };
  const unsub = store.subscribe(render);
  render();
  // 页面卸载后由 renderPage 替换 DOM，订阅在下一次 render 时通过 store 清理较复杂，
  // 这里用 MutationObserver 监听 root 被清空来退订
  const obs = new MutationObserver(() => { if (!root.isConnected) { unsub(); obs.disconnect(); } });
  obs.observe(root.parentElement ?? root, { childList: true });
}

function renderDetail(col: HTMLElement, client: ClientProfile): void {
  const save = async (patch: Partial<ClientProfile>): Promise<void> => {
    await store.saveClient({ ...client, ...patch });
  };

  col.append(
    h('div', { class: 'card' },
      h('h3', {}, '基本信息'),
      field('姓名', Object.assign(h('input', { value: client.name, oninput: (e: Event) => save({ name: (e.target as HTMLInputElement).value }) }))),
      h('div', { class: 'row' },
        field('年龄', Object.assign(h('input', { type: 'number', value: client.age, oninput: (e: Event) => save({ age: parseInt((e.target as HTMLInputElement).value) || 0 }) }))),
        field('性别', h('select', { onchange: (e: Event) => save({ gender: (e.target as HTMLSelectElement).value }) },
          h('option', { value: '', selected: !client.gender }, '—'),
          h('option', { value: '女', selected: client.gender === '女' }, '女'),
          h('option', { value: '男', selected: client.gender === '男' }, '男'),
        )),
      ),
      field('电话', h('input', { value: client.phone, oninput: (e: Event) => save({ phone: (e.target as HTMLInputElement).value }) })),
      field('备注', h('textarea', { rows: 2, oninput: (e: Event) => save({ note: (e.target as HTMLTextAreaElement).value }) }, client.note)),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn danger ghost',
          onclick: async () => {
            if (confirm(`确认删除客户「${client.name}」及其档案？`)) {
              await store.deleteClient(client.id);
              toast('客户已删除');
            }
          },
        }, '删除客户'),
      ),
    ),
  );

  // 左右耳切换
  const sideTabs = h('div', { class: 'side-tabs' },
    ...(['left', 'right'] as EarSide[]).map((side) =>
      h('button', {
        class: store.state.currentSide === side ? 'active' : '',
        onclick: () => store.setSide(side),
      }, side === 'left' ? '左耳' : '右耳'),
    ),
  );

  const earCard = h('div', { class: 'card' });
  const renderEar = (): void => {
    const side = store.state.currentSide;
    const ear = client[side];
    clear(earCard);
    earCard.append(
      h('h3', {}, side === 'left' ? '左耳档案' : '右耳档案'),
      field('耳模 / 外壳类型', h('select', {
        onchange: (e: Event) => {
          client[side].shellType = (e.target as HTMLSelectElement).value as ShellType;
          save({ [side]: client[side] } as Partial<ClientProfile>);
        },
      }, ...SHELL_TYPES.map((t) => h('option', { value: t, selected: ear.shellType === t }, SHELL_TYPE_LABEL[t])))),
      field('机型', h('input', {
        value: ear.deviceModel,
        placeholder: '如：CIC 10A 深耳道机',
        oninput: (e: Event) => {
          client[side].deviceModel = (e.target as HTMLInputElement).value;
          save({ [side]: client[side] } as Partial<ClientProfile>);
        },
      })),
      h('div', { class: 'muted', style: { marginBottom: '8px' } },
        `关联耳印：${ear.impressionId ?? '无'} · 当前外壳：${ear.shellDesignId ?? '无'}`),
      h('div', { class: 'muted' }, `历史订单/外壳版本：${ear.history.length} 个`),
      ear.history.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '版本ID'), h('th', {}, '类型'))),
            h('tbody', {}, ...ear.history.map((id) => h('tr', {}, h('td', { class: 'mono' }, id.slice(0, 18)), h('td', {}, SHELL_TYPE_LABEL[ear.shellType])))))
        : h('div', { class: 'muted' }, '暂无历史，新壳出单后会自动挂接，复诊可新旧对比'),
    );
  };
  renderEar();
  const unsub = store.subscribe(renderEar);
  const obs = new MutationObserver(() => { if (!col.isConnected) { unsub(); obs.disconnect(); } });
  obs.observe(col.parentElement ?? col, { childList: true });

  // 听力图
  const audioCard = h('div', { class: 'card' });
  const renderAudio = (): void => {
    const c = store.currentClient();
    if (!c) return;
    clear(audioCard);
    audioCard.append(
      h('h3', {}, '听力图（dB HL）'),
      h('table', { class: 'audiogram' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Hz'), ...c.audiogram.map((p) => h('th', {}, String(p.freq))))),
        h('tbody', {},
          audioRow(c, 'left', '左耳'),
          audioRow(c, 'right', '右耳'),
        ),
      ),
      h('div', { class: 'btn-row', style: { marginTop: '10px' } },
        h('button', { class: 'btn ghost', onclick: () => save({ audiogram: defaultAudiogram() }) }, '重置听力图'),
      ),
    );
  };
  renderAudio();

  col.append(sideTabs, earCard, audioCard);
}

function audioRow(client: ClientProfile, side: EarSide, label: string): HTMLElement {
  return h('tr', {},
    h('td', { class: 'muted' }, label),
    ...client.audiogram.map((p, i) => {
      const val = p[side];
      const input = h('input', {
        type: 'number', placeholder: '—', value: val ?? '',
        oninput: (e: Event) => {
          const raw = (e.target as HTMLInputElement).value;
          client.audiogram[i][side] = raw === '' ? null : parseInt(raw);
          store.saveClient(client);
        },
      });
      return h('td', {}, input);
    }),
  );
}

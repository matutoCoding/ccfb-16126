import type { Client, EarCase, MoldType, Side } from '../../types';
import { MOLD_TYPE_LABEL } from '../../types';
import { store } from '../../core/state/store';
import { AudiogramChart, emptyAudiogram } from '../AudiogramChart';
import { badge, button, clear, fmtDate, h, labelRow, modal, selectInput, toast } from '../dom';

export class ProfilesPage {
  readonly el: HTMLElement;
  private listEl: HTMLElement;
  private detailEl: HTMLElement;
  private unsubscribe: () => void;

  constructor() {
    this.el = h('div', { class: 'page page-profiles' },
      h('div', { class: 'page-head' },
        h('h2', {}, '客户档案'),
        h('div', { class: 'spacer' }),
        button('＋ 新建客户', () => this.editClient(null), 'primary'),
      ),
      h('div', { class: 'profiles-layout' },
        (this.listEl = h('div', { class: 'client-list panel' })),
        (this.detailEl = h('div', { class: 'client-detail panel' })),
      ),
    );
    // 订阅 store：选择/增删客户后自动刷新列表与详情
    this.unsubscribe = store.subscribe(() => {
      if (this.el.isConnected) this.render();
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  render(): void {
    this.renderList();
    this.renderDetail();
  }

  private renderList(): void {
    clear(this.listEl);
    const { clients, cases } = store.state;
    if (clients.length === 0) {
      this.listEl.append(h('div', { class: 'empty-hint' }, '还没有客户档案，点击右上角新建。'));
      return;
    }
    for (const c of clients) {
      const earCases = cases.filter((ec) => ec.clientId === c.id);
      const active = c.id === store.state.selectedClientId;
      const row = h('div', {
        class: `client-row ${active ? 'active' : ''}`,
        onclick: () => store.select(c.id, null),
      },
        h('div', { class: 'client-row-main' },
          h('strong', {}, c.name || '未命名'),
          h('span', { class: 'client-meta' }, `${c.gender || '—'} · ${c.age || '?'}岁 · ${c.phone || '无电话'}`),
        ),
        h('div', { class: 'client-row-tags' },
          badge(`${earCases.length} 个耳例`),
        ),
      );
      this.listEl.append(row);
    }
  }

  private renderDetail(): void {
    clear(this.detailEl);
    const client = store.currentClient;
    if (!client) {
      this.detailEl.append(h('div', { class: 'empty-hint' }, '选择左侧客户查看详情，或新建客户。'));
      return;
    }
    const cases = store.state.cases
      .filter((ec) => ec.clientId === client.id)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    this.detailEl.append(
      h('div', { class: 'detail-head' },
        h('h3', {}, client.name),
        h('div', { class: 'spacer' }),
        button('编辑资料', () => this.editClient(client)),
        button('删除', () => {
          if (confirm(`确认删除客户 ${client.name} 及其全部耳例？`)) {
            void store.deleteClient(client.id);
          }
        }, 'danger'),
      ),
      h('dl', { class: 'info-grid' },
        h('div', {}, h('dt', {}, '性别'), h('dd', {}, client.gender || '—')),
        h('div', {}, h('dt', {}, '年龄'), h('dd', {}, String(client.age))),
        h('div', {}, h('dt', {}, '电话'), h('dd', {}, client.phone || '—')),
        h('div', {}, h('dt', {}, '建档时间'), h('dd', {}, fmtDate(client.createdAt))),
        h('div', { class: 'span-2' }, h('dt', {}, '备注'), h('dd', {}, client.note || '—')),
      ),
      h('div', { class: 'ear-cases' },
        h('div', { class: 'section-title' },
          h('h4', {}, '左右耳病例'),
          h('div', { class: 'spacer' }),
          button('＋ 左耳病例', () => this.editEarCase(client, 'left'), 'primary'),
          button('＋ 右耳病例', () => this.editEarCase(client, 'right'), 'primary'),
        ),
        ...(['left', 'right'] as Side[]).map((side) => this.earColumn(client.id, side, cases.filter((c) => c.side === side))),
      ),
    );
  }

  private earColumn(clientId: string, side: Side, cases: EarCase[]): HTMLElement {
    return h('div', { class: `ear-col ear-${side}` },
      h('div', { class: 'ear-col-head' }, side === 'left' ? '左耳' : '右耳'),
      ...(cases.length === 0
        ? [h('div', { class: 'empty-hint small' }, '无病例')]
        : cases.map((ec) => {
            const designs = store.state.designs.filter((d) => d.caseId === ec.id);
            const scans = store.state.scans.filter((s) => s.caseId === ec.id);
            return h('div', {
              class: `ear-case-card ${ec.id === store.state.selectedCaseId ? 'active' : ''}`,
              onclick: () => {
                store.select(clientId, ec.id);
                store.goto('scan');
              },
            },
              h('div', { class: 'ear-case-line' },
                h('strong', {}, ec.model || '未指定机型'),
                badge(MOLD_TYPE_LABEL[ec.moldType]),
                ec.deviceKind === 'earmold' ? badge('耳模') : badge('定制机'),
              ),
              h('div', { class: 'ear-case-meta' },
                `${scans.length} 次扫描 · ${designs.length} 个壳型 · 更新 ${fmtDate(ec.updatedAt)}`,
              ),
              h('div', { class: 'ear-case-actions', onclick: (e: Event) => e.stopPropagation() },
                button('透视检查', () => {
                  store.select(clientId, ec.id);
                  store.goto('inspect');
                }),
                button('删除', () => {
                  if (confirm('删除该耳例及其扫描和设计？')) void store.deleteCase(ec.id);
                }, 'danger'),
              ),
            );
          })),
    );
  }

  private editClient(client: Client | null): void {
    const draft: Client = client
      ? structuredClone(client)
      : {
          id: store.newId('cli'),
          name: '',
          gender: '男',
          age: 70,
          phone: '',
          note: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
    const nameInput = h('input', { value: draft.name, placeholder: '客户姓名' }) as HTMLInputElement;
    const genderSel = selectInput(draft.gender || '男', [
      { value: '男', label: '男' },
      { value: '女', label: '女' },
      { value: '', label: '未知' },
    ], (v) => (draft.gender = v as Client['gender']));
    const ageInput = h('input', { type: 'number', value: String(draft.age), min: '0', max: '120' }) as HTMLInputElement;
    const phoneInput = h('input', { value: draft.phone, placeholder: '联系电话' }) as HTMLInputElement;
    const noteInput = h('textarea', { rows: '3' }, draft.note) as HTMLTextAreaElement;
    const body = h('div', { class: 'form-stack' },
      labelRow('姓名', nameInput),
      labelRow('性别', genderSel),
      labelRow('年龄', ageInput),
      labelRow('电话', phoneInput),
      labelRow('备注', noteInput),
    );
    const m = modal(client ? '编辑客户' : '新建客户', body, h('div', {},
      button('取消', () => m.close()),
      button('保存', () => {
        draft.name = nameInput.value.trim();
        draft.age = parseInt(ageInput.value, 10) || 0;
        draft.phone = phoneInput.value.trim();
        draft.note = noteInput.value;
        if (!draft.name) return toast('请填写姓名', 'error');
        void store.saveClient(draft).then(() => {
          store.select(draft.id);
          m.close();
          this.render();
          toast('已保存', 'ok');
        });
      }, 'primary'),
    ));
  }

  private editEarCase(client: Client, side: Side): void {
    const draft: EarCase = {
      id: store.newId('case'),
      clientId: client.id,
      side,
      deviceKind: 'customShell',
      moldType: 'canal',
      model: '',
      audiogram: emptyAudiogram(),
      designIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const modelInput = h('input', { value: '', placeholder: '如：ITE-标准功率' }) as HTMLInputElement;
    const kindSel = selectInput(draft.deviceKind, [
      { value: 'customShell', label: '定制机外壳' },
      { value: 'earmold', label: '耳模' },
    ], (v) => (draft.deviceKind = v as EarCase['deviceKind']));
    const moldSel = selectInput(draft.moldType,
      (Object.keys(MOLD_TYPE_LABEL) as MoldType[]).map((k) => ({ value: k, label: MOLD_TYPE_LABEL[k] })),
      (v) => (draft.moldType = v as MoldType));
    const chart = new AudiogramChart(draft.audiogram, (a) => (draft.audiogram = a));
    const body = h('div', { class: 'form-stack' },
      labelRow('机型', modelInput),
      labelRow('类型', kindSel),
      labelRow('耳模/外壳形态', moldSel),
      h('div', { class: 'form-row column' }, h('span', { class: 'form-label' }, '听力图（点击或拖动绘点）'), chart.el),
    );
    const m = modal(`${side === 'left' ? '左' : '右'}耳病例`, body, h('div', {},
      button('取消', () => m.close()),
      button('建立病例', () => {
        draft.model = modelInput.value.trim();
        void store.saveCase(draft).then(() => {
          store.select(client.id, draft.id);
          m.close();
          this.render();
          store.goto('scan');
          toast('病例已建立，进入耳印扫描', 'ok');
        });
      }, 'primary'),
    ));
  }
}

/** 页面 1：客户档案（左右耳分开、听力图、机型、耳模类型、复诊新旧壳） */
import { app } from '../state';
import { h, clear, toast } from './dom';
import { Customer, EarRecord, Side, SHELL_STYLE_LABEL, MATERIAL_LABEL, ShellStyle, ShellMaterial } from '../core/types';
import { uid } from '../core/db';
import { renderAudiogram } from './audiogram';

function emptyEar(side: Side): EarRecord {
  return {
    side,
    audiogram: [250, 500, 1000, 2000, 4000, 8000].map((f) => ({ freqHz: f, db: 25 })),
    shellStyle: 'canal',
    material: 'hard',
    designHistory: [],
    notes: '',
  };
}

export function renderCustomerPage(root: HTMLElement): void {
  clear(root);
  root.append(h('h2', {}, '客户档案'));

  // 左：客户列表
  const list = h('div', { class: 'card', style: 'width:320px;flex:0 0 320px;overflow:auto' });
  const drawList = () => {
    clear(list);
    list.append(h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('button', {
        class: 'btn', onclick: async () => {
          const nc: Customer = {
            id: uid('cust'), name: '新客户', age: 70, gender: '未填', phone: '',
            createdAt: Date.now(), updatedAt: Date.now(),
            ears: { left: emptyEar('left'), right: emptyEar('right') }, tags: [],
          };
          await app.saveCustomer(nc);
          app.selectCustomer(nc.id);
        },
      }, '+ 新建客户'),
    ));
    for (const cu of [...app.customers].sort((a, b) => b.updatedAt - a.updatedAt)) {
      list.append(h('div', {
        class: 'customer-item' + (cu.id === app.currentCustomerId ? ' selected' : ''),
        onclick: () => app.selectCustomer(cu.id),
      },
        h('div', {}, h('div', { style: 'font-weight:600' }, cu.name), h('div', { class: 'muted' }, `${cu.age} 岁 · ${cu.phone || '无电话'}`)),
        h('button', {
          class: 'btn danger small', onclick: (e: Event) => {
            e.stopPropagation();
            if (confirm(`删除客户「${cu.name}」及其印模、设计？`)) app.deleteCustomer(cu.id);
          },
        }, '删除'),
      ));
    }
    if (!app.customers.length) list.append(h('div', { class: 'muted' }, '还没有客户，点击「新建客户」开始。'));
  };

  // 右：详情
  const detail = h('div', { style: 'flex:1;min-width:0;overflow:auto' });
  const drawDetail = () => {
    clear(detail);
    const c = app.currentCustomer;
    if (!c) {
      detail.append(h('div', { class: 'card muted' }, '请选择或新建一位客户。'));
      return;
    }
    const ear = c.ears[app.currentSide];
    const otherSide: Side = app.currentSide === 'left' ? 'right' : 'left';

    const nameInput = h('input', { value: c.name }) as HTMLInputElement;
    const ageInput = h('input', { type: 'number', value: String(c.age) }) as HTMLInputElement;
    const genderInput = h('input', { value: c.gender }) as HTMLInputElement;
    const phoneInput = h('input', { value: c.phone }) as HTMLInputElement;
    const saveTop = async () => {
      c.name = nameInput.value || '未命名';
      c.age = Number(ageInput.value) || 0;
      c.gender = genderInput.value;
      c.phone = phoneInput.value;
      await app.saveCustomer(c);
      toast('档案已保存');
    };

    const styleSel = h('select', {}, ...(Object.keys(SHELL_STYLE_LABEL) as ShellStyle[]).map((s) =>
      h('option', { value: s, ...(ear.shellStyle === s ? { selected: true } : {}) }, SHELL_STYLE_LABEL[s]))) as HTMLSelectElement;
    const matSel = h('select', {}, ...(Object.keys(MATERIAL_LABEL) as ShellMaterial[]).map((s) =>
      h('option', { value: s, ...(ear.material === s ? { selected: true } : {}) }, MATERIAL_LABEL[s]))) as HTMLSelectElement;
    const notes = h('textarea', { rows: 3 }, ear.notes) as HTMLTextAreaElement;

    const audioCanvas = h('canvas', { style: 'width:100%;height:220px' }) as HTMLCanvasElement;
    const redrawAudio = () => renderAudiogram(audioCanvas, ear.audiogram, app.currentSide, true, (pts) => {
      ear.audiogram = pts;
      app.saveCustomer(c);
      redrawAudio();
    });
    requestAnimationFrame(redrawAudio);

    // 历次壳体版本（复诊新旧壳挂在一起）
    const history = h('div', {});
    const drawHistory = () => {
      clear(history);
      if (!ear.designHistory.length) {
        history.append(h('div', { class: 'muted' }, '该耳暂无设计版本。'));
        return;
      }
      history.append(h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, '版本'), h('th', {}, '创建时间'), h('th', {}, '壁厚(mm)'), h('th', {}, '材料'), h('th', {}, '操作'))),
        h('tbody', {}, ...ear.designHistory.map((id, idx) => {
          const d = app.designs.get(id);
          if (!d) return h('tr', {}, h('td', { colspan: 5, class: 'muted' }, `版本 ${idx + 1}（数据已删除）`));
          return h('tr', {},
            h('td', {}, `v${d.version}`),
            h('td', {}, new Date(d.createdAt).toLocaleString('zh-CN')),
            h('td', { class: 'mono' }, String(d.wallThickness)),
            h('td', {}, MATERIAL_LABEL[d.material]),
            h('td', {}, h('button', {
              class: 'btn ghost small', onclick: () => {
                app.currentDesignId = d.id;
                app.emit();
                toast(`已载入 v${d.version}，可在外壳设计页对比`);
              },
            }, '载入对比')),
          );
        })),
      ));
    };
    drawHistory();

    detail.append(
      h('div', { class: 'side-tabs' },
        h('button', { class: app.currentSide === 'left' ? 'active' : '', onclick: () => app.selectCustomer(c.id, 'left') }, '左耳'),
        h('button', { class: app.currentSide === 'right' ? 'active' : '', onclick: () => app.selectCustomer(c.id, 'right') }, '右耳'),
      ),
      h('div', { class: 'card' },
        h('h3', {}, '基本信息'),
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', {}, '姓名'), nameInput),
          h('label', { class: 'field' }, h('span', {}, '年龄'), ageInput),
          h('label', { class: 'field' }, h('span', {}, '性别'), genderInput),
          h('label', { class: 'field' }, h('span', {}, '电话'), phoneInput),
        ),
        h('button', { class: 'btn', onclick: saveTop }, '保存基本信息'),
        h('button', {
          class: 'btn ghost', style: 'margin-left:8px', onclick: () => toast(`已切换查看${otherSide === 'left' ? '左' : '右'}耳`),
        }, `对侧：${otherSide === 'left' ? '左耳' : '右耳'}`),
      ),
      h('div', { class: 'grid cols-2', style: 'margin-top:14px' },
        h('div', { class: 'card' },
          h('h3', {}, `${app.currentSide === 'left' ? '左' : '右'}耳 · 听力图（可拖动）`),
          h('div', { class: 'audiogram-wrap' }, audioCanvas),
          h('div', { class: 'muted', style: 'margin-top:6px' }, app.currentSide === 'right' ? '红色 ○ 为右耳气导' : '蓝色 × 为左耳气导'),
        ),
        h('div', { class: 'card' },
          h('h3', {}, '机型与耳模类型'),
          h('label', { class: 'field' }, h('span', {}, '外壳机型'), styleSel),
          h('label', { class: 'field' }, h('span', {}, '壳体材料'), matSel),
          h('label', { class: 'field' }, h('span', {}, '备注'), notes),
          h('button', {
            class: 'btn', onclick: async () => {
              ear.shellStyle = styleSel.value as ShellStyle;
              ear.material = matSel.value as ShellMaterial;
              ear.notes = notes.value;
              await app.saveCustomer(c);
              toast('耳配置已保存');
            },
          }, '保存耳配置'),
          h('div', { class: 'muted', style: 'margin-top:8px' },
            ear.impressionId ? '已关联耳印模 ✓' : '尚未关联耳印模，请前往「耳印扫描」页导入或生成。'),
        ),
      ),
      h('div', { class: 'card', style: 'margin-top:14px' },
        h('h3', {}, '复诊版本（新旧壳挂在一起）'),
        history,
      ),
    );
  };

  app.subscribe(() => { drawList(); drawDetail(); });
  drawList();
  drawDetail();
  root.append(h('div', { style: 'display:flex;gap:16px;height:100%;min-height:0' }, list, detail));
}

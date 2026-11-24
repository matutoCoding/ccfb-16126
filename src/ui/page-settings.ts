/** 页面 7：设置 —— 壁厚下限、默认颜色、A-buffer 节点容量、数据管理 */
import { app } from '../state';
import { h, clear, toast } from './dom';
import { AppSettings } from '../core/types';

export function renderSettingsPage(root: HTMLElement): void {
  clear(root);
  root.append(h('h2', {}, '系统设置'));
  const s: AppSettings = structuredClone(app.settings);

  const hard = h('input', { type: 'number', step: '0.05', value: String(s.hardMinWall) }) as HTMLInputElement;
  const silicone = h('input', { type: 'number', step: '0.05', value: String(s.siliconeMinWall) }) as HTMLInputElement;
  const color = h('input', { type: 'color', value: s.defaultColor }) as HTMLInputElement;
  const nodes = h('input', { type: 'number', step: '16', min: '32', max: '512', value: String(s.abufferMaxNodes) }) as HTMLInputElement;

  root.append(
    h('div', { class: 'card', style: 'max-width:640px' },
      h('h3', {}, '壁厚下限（mm）'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', {}, '硬壳（亚克力）下限'), hard),
        h('label', { class: 'field' }, h('span', {}, '软硅胶下限'), silicone),
      ),
      h('h3', {}, '默认壳体颜色'),
      h('label', { class: 'field', style: 'max-width:160px' }, color),
      h('h3', {}, 'A-buffer 每像素最大节点数'),
      h('label', { class: 'field', style: 'max-width:200px' }, h('span', {}, '节点池容量（层数多时调大，刷新后生效）'), nodes),
      h('div', { style: 'display:flex;gap:10px;margin-top:14px' },
        h('button', {
          class: 'btn', onclick: async () => {
            s.hardMinWall = Number(hard.value);
            s.siliconeMinWall = Number(silicone.value);
            s.defaultColor = color.value;
            s.abufferMaxNodes = Math.max(32, Math.min(512, Number(nodes.value)));
            app.settings = s;
            await app.saveSettings(s);
            toast('设置已保存，刷新页面后节点容量生效');
          },
        }, '保存设置'),
        h('button', {
          class: 'btn danger', onclick: async () => {
            if (!confirm('清空 IndexedDB 中全部客户、印模、设计与订单？此操作不可恢复。')) return;
            await app.wipe();
            app.customers = []; app.impressions.clear(); app.designs.clear();
            app.orders = []; app.currentCustomerId = null;
            app.emit();
            toast('本地数据已清空');
          },
        }, '清空全部本地数据'),
      ),
    ),
    h('div', { class: 'card', style: 'max-width:640px;margin-top:16px' },
      h('h3', {}, '技术说明'),
      h('div', { class: 'muted' },
        '透明渲染采用每像素链表 A-buffer：所有透明片元原子写入 SSBO，resolve 阶段逐像素按深度精确排序后做 back-to-front over 合成；',
        '壁厚由相邻 shell 片元的线性眼深差换算为世界距离，并由 CPU Möller–Trumbore 射线求交独立复核。',
        '所有档案、网格、截图与 STL 均保存在浏览器 IndexedDB，不上传任何服务器。'),
    ),
  );
}

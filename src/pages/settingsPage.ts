// 设置页：材料壁厚下限、渲染/剥离参数、IndexedDB 数据管理、系统信息
import { h, clear, toast, field } from '../ui/dom';
import { db } from '../db/database';
import { WALL_LIMIT } from '../core/shell';

const SETTINGS_KEY = 'earmold-settings';

export interface AppSettings {
  hardWallLimit: number;
  softWallLimit: number;
  maxPeelLayers: number;
  mcResolution: number;
  thicknessTolerance: number;
  colorTolerance: number;
}

export function loadSettings(): AppSettings {
  const def: AppSettings = {
    hardWallLimit: WALL_LIMIT.hard,
    softWallLimit: WALL_LIMIT.soft,
    maxPeelLayers: 24,
    mcResolution: 96,
    thicknessTolerance: 0.05,
    colorTolerance: 2,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...def, ...JSON.parse(raw) } : def;
  } catch {
    return def;
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function settingsPage(root: HTMLElement): void {
  const settings = loadSettings();
  const col = h('div', { class: 'page-col wide scroll' });

  const stats = h('div', { class: 'card' });
  const renderStats = async (): Promise<void> => {
    clear(stats);
    const [clients, impressions, designs, orders] = await Promise.all([
      db.getAll('clients'), db.getAll('impressions'), db.getAll('designs'), db.getAll('orders'),
    ]);
    stats.append(
      h('h3', {}, '本地数据（IndexedDB）'),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '客户档案'), h('span', { class: 'v' }, String(clients.length))),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '耳印记录'), h('span', { class: 'v' }, String(impressions.length))),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '外壳设计'), h('span', { class: 'v' }, String(designs.length))),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '工厂订单'), h('span', { class: 'v' }, String(orders.length))),
      h('button', {
        class: 'btn danger', style: { width: '100%', marginTop: '12px' },
        onclick: async () => {
          if (!confirm('确认清空所有本地数据？此操作不可恢复。')) return;
          for (const storeName of ['clients', 'impressions', 'designs', 'orders'] as const) {
            const all = await db.getAll<{ id: string }>(storeName);
            for (const r of all) await db.delete(storeName, r.id);
          }
          localStorage.removeItem(SETTINGS_KEY);
          toast('已清空全部数据，刷新页面后重建示例客户');
          renderStats();
        },
      }, '清空全部数据'),
    );
  };

  const update = (patch: Partial<AppSettings>): void => {
    Object.assign(settings, patch);
    saveSettings(settings);
  };

  col.append(
    h('div', { class: 'card' },
      h('h3', {}, '材料壁厚下限 (mm)'),
      field('硬壳（亚克力）下限', num(settings.hardWallLimit, (v) => update({ hardWallLimit: v }))),
      field('软硅胶下限', num(settings.softWallLimit, (v) => update({ softWallLimit: v }))),
      h('div', { class: 'muted' }, '低于下限的壁厚会在外壳设计与透视检查中标红'),
    ),
    h('div', { class: 'card' },
      h('h3', {}, '渲染与精度'),
      field('深度剥离最大层数', num(settings.maxPeelLayers, (v) => update({ maxPeelLayers: v }), 1)),
      field('Marching Cubes 分辨率', num(settings.mcResolution, (v) => update({ mcResolution: v }), 8)),
      field('壁厚自检容差 (mm)', num(settings.thicknessTolerance, (v) => update({ thicknessTolerance: v }), 0.01)),
      field('色差自检容差（色阶）', num(settings.colorTolerance, (v) => update({ colorTolerance: v }), 1)),
      h('div', { class: 'muted' }, '验收标准：色差 ≤ 2 色阶，壁厚误差 < 0.05mm'),
    ),
    h('div', { class: 'card' },
      h('h3', {}, '技术架构'),
      h('div', { class: 'muted', style: { lineHeight: '1.8' } },
        '· TypeScript + WebGL2，着色器全部手写 GLSL\n· 几何内核：SDF 隐式场 + 自写 Marching Cubes\n· 透明：深度剥离（Depth Peeling）精确顺序无关渲染\n· 参考实现：CPU 逐像素射线求交 + 精确深度排序\n· 射线加速：均匀网格 + Amanatides-Woo 遍历\n· 持久化：IndexedDB，零后端、零第三方 3D 库'),
    ),
    stats,
  );
  renderStats();

  clear(root);
  root.append(h('div', { class: 'page' }, col, h('div', { class: 'viewer-wrap' },
    h('div', { class: 'empty-hint' }, '耳模工坊 · 所有数据与计算均在本机浏览器完成'))));
}

function num(value: number, onInput: (v: number) => void, step = 0.1): HTMLInputElement {
  const i = h('input', { type: 'number', step, value }) as HTMLInputElement;
  i.addEventListener('change', () => {
    onInput(parseFloat(i.value));
    toast('设置已保存');
  });
  return i;
}

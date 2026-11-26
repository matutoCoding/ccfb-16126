import './styles.css';
import { h, mount } from './ui/dom';
import { store } from './state/store';
import { createClient } from './db/database';
import { clientPage } from './pages/clientPage';
import { scanPage } from './pages/scanPage';
import { shellPage } from './pages/shellPage';
import { layoutPage } from './pages/layoutPage';
import { inspectPage } from './pages/inspectPage';
import { orderPage } from './pages/orderPage';
import { settingsPage } from './pages/settingsPage';

export type PageId = 'client' | 'scan' | 'shell' | 'layout' | 'inspect' | 'order' | 'settings';

const NAV: { id: PageId; label: string; ico: string }[] = [
  { id: 'client', label: '客户档案', ico: '👤' },
  { id: 'scan', label: '耳印扫描', ico: '🦻' },
  { id: 'shell', label: '外壳设计', ico: '🧊' },
  { id: 'layout', label: '内部排布', ico: '🔩' },
  { id: 'inspect', label: '透视检查', ico: '🔍' },
  { id: 'order', label: '工厂订单', ico: '📦' },
  { id: 'settings', label: '设置', ico: '⚙️' },
];

const PAGE_FN: Record<PageId, (root: HTMLElement) => void> = {
  client: clientPage,
  scan: scanPage,
  shell: shellPage,
  layout: layoutPage,
  inspect: inspectPage,
  order: orderPage,
  settings: settingsPage,
};

let currentPage: PageId = 'client';

function renderShell(): void {
  const app = document.getElementById('app')!;
  const client = store.currentClient();
  const sidebar = h('nav', { class: 'sidebar' },
    ...NAV.map((n) =>
      h('button', {
        class: `nav-btn${n.id === currentPage ? ' active' : ''}`,
        onclick: () => navigate(n.id),
      }, h('span', { class: 'ico' }, n.ico), n.label),
    ),
    h('div', { class: 'foot' }, '数据存于本机 IndexedDB，不上传'),
  );
  const header = h('header', { class: 'app-header' },
    h('div', {},
      h('h1', {}, '耳模工坊'),
      h('div', { class: 'sub' }, '定制机外壳 / 耳模 浏览器内设计系统'),
    ),
    h('div', { class: 'client-chip' },
      ...(client
        ? [
            h('strong', {}, client.name),
            h('span', { class: 'muted' }, `${client.age}岁 · ${store.state.currentSide === 'left' ? '左耳' : '右耳'}`),
          ]
        : [h('span', { class: 'muted' }, '未选择客户')]),
    ),
  );
  const main = h('main', { class: 'main', id: 'page-root' });
  mount(h('div', { style: { display: 'contents' } }, header, h('div', { class: 'layout' }, sidebar, main)) as unknown as HTMLElement, app);
  renderPage();
}

function renderPage(): void {
  const root = document.getElementById('page-root')!;
  PAGE_FN[currentPage](root);
}

export function navigate(page: PageId): void {
  currentPage = page;
  location.hash = page;
  renderShell();
}

async function bootstrap(): Promise<void> {
  await store.loadClients();
  const hash = location.hash.replace('#', '') as PageId;
  if (NAV.some((n) => n.id === hash)) currentPage = hash;
  // 首次启动若无客户，建一个示例客户，便于立即体验
  if (!store.state.clients.length) {
    await createClient({ name: '王桂芳', age: 72, gender: '女', phone: '138****2046', note: '示例客户，右耳 CIC，复诊旧壳偏松' });
  }
  window.addEventListener('hashchange', () => {
    const p = location.hash.replace('#', '') as PageId;
    if (NAV.some((n) => n.id === p)) { currentPage = p; renderShell(); }
  });
  renderShell();
}

bootstrap();

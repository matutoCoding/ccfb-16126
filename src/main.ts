import './styles.css';
import { app } from './state';
import { h, clear } from './ui/dom';
import { renderCustomerPage } from './ui/page-customer';
import { renderScanPage } from './ui/page-scan';
import { renderShellPage } from './ui/page-shell';
import { renderLayoutPage } from './ui/page-layout';
import { renderInspectionPage } from './ui/page-inspection';
import { renderOrderPage } from './ui/page-order';
import { renderSettingsPage } from './ui/page-settings';
import { disposeAllViewports } from './render/Viewport';
import { Side } from './core/types';

type PageId = 'customer' | 'scan' | 'shell' | 'layout' | 'inspection' | 'order' | 'settings';

const NAV: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'customer', label: '客户档案', icon: '👤' },
  { id: 'scan', label: '耳印扫描', icon: '📡' },
  { id: 'shell', label: '外壳设计', icon: '🧱' },
  { id: 'layout', label: '内部排布', icon: '🔧' },
  { id: 'inspection', label: '透视检查', icon: '🔍' },
  { id: 'order', label: '工厂订单', icon: '📦' },
  { id: 'settings', label: '设置', icon: '⚙️' },
];

let currentPage: PageId = 'customer';

function render(): void {
  disposeAllViewports();
  const appEl = document.getElementById('app')!;
  clear(appEl);

  const nav = h('nav', { class: 'sidebar' },
    h('div', { class: 'brand' }, '耳模工作室'),
    ...NAV.map((n) => h('button', {
      class: 'nav-item' + (n.id === currentPage ? ' active' : ''),
      onclick: () => { currentPage = n.id; render(); },
    }, h('span', {}, n.icon), h('span', {}, n.label))),
    h('div', { class: 'spacer' }),
  );

  const main = h('main', {});
  const page = h('div', { class: 'page' });
  main.append(page);

  const c = app.currentCustomer;
  if (c) {
    const tabs = h('div', { class: 'side-tabs', style: 'margin:10px 12px 0' },
      h('button', {
        class: app.currentSide === 'left' ? 'active' : '',
        onclick: () => app.selectCustomer(c.id, 'left' as Side),
      }, '左耳'),
      h('button', {
        class: app.currentSide === 'right' ? 'active' : '',
        onclick: () => app.selectCustomer(c.id, 'right' as Side),
      }, '右耳'),
    );
    nav.append(tabs);
    const who = h('div', { class: 'muted', style: 'padding:8px 12px;font-size:12px' },
      `${c.name} · ${app.currentSide === 'left' ? '左' : '右'}耳`);
    nav.append(who);
  }

  appEl.append(nav, main);
  try {
    switch (currentPage) {
      case 'customer': renderCustomerPage(page); break;
      case 'scan': renderScanPage(page); break;
      case 'shell': renderShellPage(page); break;
      case 'layout': renderLayoutPage(page); break;
      case 'inspection': renderInspectionPage(page); break;
      case 'order': renderOrderPage(page); break;
      case 'settings': renderSettingsPage(page); break;
    }
  } catch (err) {
    page.append(h('div', { class: 'card', style: 'border-color:var(--danger)' },
      h('strong', { style: 'color:var(--danger)' }, '页面渲染出错：'),
      h('pre', { class: 'mono', style: 'white-space:pre-wrap' }, (err as Error).stack ?? String(err))));
  }
}

async function bootstrap(): Promise<void> {
  if (location.hash === '#/selftest') {
    const { runSelfTest } = await import('../tests/browser/selftest');
    const pre = document.createElement('pre');
    pre.style.cssText = 'padding:16px;font-size:12px;color:#9fe8c8;white-space:pre-wrap';
    document.getElementById('app')!.append(pre);
    await runSelfTest(pre);
    return;
  }
  await app.init();
  render();
}
bootstrap();

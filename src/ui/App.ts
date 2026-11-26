import type { AppState } from '../app-types';
import type { PageKey } from '../types';
import { h, clear } from './dom';
import type { UiContext } from './context';
import { renderClientsPage } from './pages/clients';
import { renderScanPage } from './pages/scan';
import { renderShellPage } from './pages/shell';
import { renderLayoutPage } from './pages/layout';
import { renderPerspectivePage } from './pages/perspective';
import { renderSettingsPage } from './pages/settings';

const NAV: Array<{ key: PageKey; label: string; icon: string; title: string; sub: string }> = [
  { key: 'clients', label: '客户档案', icon: '👤', title: '客户档案', sub: '左右耳分开、听力图、机型耳模与历次壳体' },
  { key: 'scan', label: '耳印扫描', icon: '🧊', title: '耳印模扫描与标记', sub: 'STL 导入、耳道弯道识别、气泡和缺损标记' },
  { key: 'shell', label: '外壳设计', icon: '🛡️', title: '参数化外壳设计', sub: '壁厚下限、耳道截短、边缘倒圆与过弯检查' },
  { key: 'layout', label: '内部排布', icon: '🧩', title: '器件与管路排布', sub: '真实尺寸器件、声管/通气孔路径和碰撞报告' },
  { key: 'perspective', label: '透视检查', icon: '🔬', title: '透视与壁厚检查', sub: '深度剥离精确排序、逐像素层深、截面封口' },
  { key: 'settings', label: '设置', icon: '⚙️', title: '设置与验收', sub: 'IndexedDB、测试耳模、像素排序和壁厚误差验证' }
];

export class App implements UiContext {
  state: AppState;
  private content!: HTMLElement;
  private toastWrap!: HTMLElement;
  private cleanup?: () => void;

  constructor(state: AppState) {
    this.state = state;
  }

  navigate = (page: PageKey, scanId?: string) => {
    if (scanId) this.state.currentScanId = scanId;
    this.state.page = page;
    this.rerender();
  };

  toast = (message: string, kind: 'ok' | 'bad' | 'info' = 'info') => {
    const t = h('div', { class: `toast ${kind}`, text: message });
    this.toastWrap.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
      setTimeout(() => t.remove(), 220);
    }, 3600);
  };

  rerender = () => {
    this.cleanup?.();
    clear(document.getElementById('app')!);
    const nav = NAV.find(n => n.key === this.state.page) ?? NAV[0];
    const app = h('div', { class: 'app-shell' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' },
          h('div', { class: 'brand-mark' }),
          h('div', {}, h('h1', { text: '耳模外壳设计系统' }), h('p', { text: 'Ear Shell Studio · WebGL2' }))
        ),
        h('nav', { class: 'nav' }, ...NAV.map(item => h('button', {
          class: `nav-btn ${this.state.page === item.key ? 'active' : ''}`,
          onClick: () => this.navigate(item.key)
        }, h('span', { class: 'ico', text: item.icon }), h('span', { text: item.label })))),
        h('div', { class: 'side-foot' },
          h('div', {}, h('span', { class: 'status-dot' }), 'IndexedDB 已连接'),
          h('div', { style: 'margin-top:7px', text: '档案、STL、设计和订单均保存在本机浏览器。' })
        )
      ),
      h('main', { class: 'main' },
        h('header', { class: 'topbar' },
          h('div', {}, h('h2', { text: nav.title }), h('div', { class: 'sub', text: nav.sub })),
          h('div', { class: 'top-actions' },
            h('span', { class: 'pill info', text: `测试耳模 ${this.state.scans.length} 副` }),
            h('span', { class: 'pill ok', text: '深度剥离 OIT' })
          )
        ),
        this.content = h('section', { class: 'content' })
      )
    );
    this.toastWrap = h('div', { class: 'toast-wrap' });
    app.appendChild(this.toastWrap);
    document.getElementById('app')!.appendChild(app);
    this.renderPage();
  };

  private renderPage() {
    clear(this.content);
    const ctx: UiContext = this;
    let result: HTMLElement | { element: HTMLElement; cleanup?: () => void };
    switch (this.state.page) {
      case 'clients': result = renderClientsPage(ctx); break;
      case 'scan': result = renderScanPage(ctx); break;
      case 'shell': result = renderShellPage(ctx); break;
      case 'layout': result = renderLayoutPage(ctx); break;
      case 'perspective': result = renderPerspectivePage(ctx); break;
      case 'settings': result = renderSettingsPage(ctx); break;
    }
    const element = result instanceof HTMLElement ? result : result.element;
    this.cleanup = result instanceof HTMLElement ? undefined : result.cleanup;
    this.content.appendChild(element);
  }
}

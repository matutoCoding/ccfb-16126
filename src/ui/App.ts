import { store, PAGE_LABEL, type PageId } from '../core/state/store';
import { h, clear } from './dom';
import { ProfilesPage } from './pages/ProfilesPage';
import { ScanPage } from './pages/ScanPage';
import { ShellPage } from './pages/ShellPage';
import { LayoutPage } from './pages/LayoutPage';
import { InspectPage } from './pages/InspectPage';
import { SettingsPage } from './pages/SettingsPage';

interface PageEntry {
  id: PageId;
  instance: { el: HTMLElement; render: () => void; dispose?: () => void } | null;
}

const PAGE_ORDER: PageId[] = ['profiles', 'scan', 'shell', 'layout', 'inspect', 'settings'];

export class App {
  private root: HTMLElement;
  private navEl: HTMLElement;
  private contentEl: HTMLElement;
  private crumbEl: HTMLElement;
  private pages = new Map<PageId, PageEntry>();
  private currentPage: PageId | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.navEl = h('nav', { class: 'side-nav' });
    this.crumbEl = h('div', { class: 'crumb' });
    this.contentEl = h('main', { class: 'content' });
    root.append(
      h('div', { class: 'app-shell' },
        this.navEl,
        h('div', { class: 'app-main' }, this.crumbEl, this.contentEl),
      ),
    );
    let lastPage = store.state.page;
    store.subscribe(() => {
      this.sync();
      // store.goto 可能来自页面内部按钮，统一在此挂载，避免导航状态与视图脱节
      if (store.state.page !== lastPage) {
        lastPage = store.state.page;
        this.mount(store.state.page);
      }
    });
  }

  start(): void {
    this.renderNav();
    this.mount(store.state.page);
    this.sync();
  }

  private renderNav(): void {
    clear(this.navEl);
    this.navEl.append(
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, '耳'), h('div', {},
        h('strong', {}, '耳模设计工作站'),
        h('small', {}, 'WebGL2 · 本地 IndexedDB'),
      )),
      ...PAGE_ORDER.map((id) =>
        h('button', {
          class: `nav-item ${store.state.page === id ? 'active' : ''}`,
          'data-page': id,
          onclick: () => store.goto(id),
        }, PAGE_LABEL[id]),
      ),
    );
  }

  private mount(id: PageId): void {
    this.currentPage = id;
    let entry = this.pages.get(id);
    // 销毁含 WebGL 上下文的旧页面，避免多 canvas 占显存
    for (const [pid, e] of this.pages) {
      if (pid !== id && e?.instance?.dispose) {
        e.instance.dispose();
        e.instance = null;
      }
    }
    if (!entry) {
      entry = { id, instance: null };
      this.pages.set(id, entry);
    }
    if (!entry.instance) {
      entry.instance = this.createPage(id);
    }
    const instance = entry.instance!;
    clear(this.contentEl);
    this.contentEl.append(instance.el);
    instance.render();
  }

  private createPage(id: PageId): PageEntry['instance'] {
    switch (id) {
      case 'profiles': return new ProfilesPage();
      case 'scan': return new ScanPage();
      case 'shell': return new ShellPage();
      case 'layout': return new LayoutPage();
      case 'inspect': return new InspectPage();
      case 'settings': return new SettingsPage();
    }
  }

  private sync(): void {
    this.renderNav();
    const s = store.state;
    const parts: string[] = [PAGE_LABEL[s.page]];
    if (s.selectedClientId) parts.push(store.currentClient?.name ?? '');
    if (s.selectedCaseId) parts.push(store.currentCase?.side === 'left' ? '左耳' : '右耳');
    clear(this.crumbEl);
    this.crumbEl.append(h('span', {}, parts.filter(Boolean).join(' / ')));
  }
}

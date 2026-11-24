/** 全局应用状态：当前客户/耳侧/印模/设计 + 事件订阅 */
import {
  AppSettings, Customer, EarImpression, FactoryOrder, ShellDesign, Side,
} from './core/types';
import { store, uid } from './core/db';
import { GeneratedShell } from './core/shellgen';

type Listener = () => void;

class AppState {
  customers: Customer[] = [];
  impressions = new Map<string, EarImpression>();
  designs = new Map<string, ShellDesign>();
  orders: FactoryOrder[] = [];
  settings!: AppSettings;
  currentCustomerId: string | null = null;
  currentSide: Side = 'right';
  currentImpressionId: string | null = null;
  currentDesignId: string | null = null;
  /** 设计派生的壳体缓存（designId → 生成结果） */
  shellCache = new Map<string, GeneratedShell>();
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  async init(): Promise<void> {
    [this.customers, this.orders, this.settings] = await Promise.all([
      store.loadCustomers(),
      store.loadOrders(),
      store.loadSettings(),
    ]);
    for (const im of await store.loadAllImpressions()) this.impressions.set(im.id, im);
    for (const d of await store.loadDesigns()) this.designs.set(d.id, d);
    this.emit();
  }

  get currentCustomer(): Customer | null {
    return this.customers.find((c) => c.id === this.currentCustomerId) ?? null;
  }
  get currentEar() {
    const c = this.currentCustomer;
    return c ? c.ears[this.currentSide] : null;
  }
  get currentImpression(): EarImpression | null {
    return this.currentImpressionId ? this.impressions.get(this.currentImpressionId) ?? null : null;
  }
  get currentDesign(): ShellDesign | null {
    return this.currentDesignId ? this.designs.get(this.currentDesignId) ?? null : null;
  }
  get currentShell(): GeneratedShell | null {
    return this.currentDesignId ? this.shellCache.get(this.currentDesignId) ?? null : null;
  }

  async saveCustomer(c: Customer): Promise<void> {
    c.updatedAt = Date.now();
    await store.saveCustomer(c);
    const i = this.customers.findIndex((x) => x.id === c.id);
    if (i >= 0) this.customers[i] = c; else this.customers.push(c);
    this.emit();
  }

  async saveImpression(im: EarImpression): Promise<void> {
    await store.saveImpression(im);
    this.impressions.set(im.id, im);
    this.emit();
  }

  async saveDesign(d: ShellDesign, shell?: GeneratedShell | null): Promise<void> {
    await store.saveDesign(d);
    this.designs.set(d.id, d);
    if (shell) this.shellCache.set(d.id, shell);
    // 保存即选中，保证后续页面能读到当前设计与壳体
    this.currentDesignId = d.id;
    const c = this.customers.find((x) => x.id === d.customerId);
    if (c) {
      const ear = c.ears[d.side];
      ear.designId = d.id;
      if (!ear.designHistory.includes(d.id)) ear.designHistory.push(d.id);
      ear.impressionId = d.impressionId;
      await this.saveCustomer(c);
    }
    this.emit();
  }

  async saveOrder(o: FactoryOrder): Promise<void> {
    await store.saveOrder(o);
    const i = this.orders.findIndex((x) => x.id === o.id);
    if (i >= 0) this.orders[i] = o; else this.orders.push(o);
    this.emit();
  }

  async deleteCustomer(id: string): Promise<void> {
    const c = this.customers.find((x) => x.id === id);
    if (c) {
      for (const side of ['left', 'right'] as Side[]) {
        const ear = c.ears[side];
        if (ear.impressionId) await store.deleteImpression(ear.impressionId);
        for (const did of ear.designHistory) await store.deleteImpression(did).catch(() => undefined);
      }
    }
    await store.deleteCustomer(id);
    this.customers = this.customers.filter((x) => x.id !== id);
    if (this.currentCustomerId === id) this.currentCustomerId = null;
    this.emit();
  }

  selectCustomer(id: string | null, side: Side = this.currentSide): void {
    this.currentCustomerId = id;
    this.currentSide = side;
    const c = this.currentCustomer;
    const ear = c?.ears[side];
    this.currentImpressionId = ear?.impressionId ?? null;
    this.currentDesignId = ear?.designId ?? null;
    this.emit();
  }

  /** 显式切换当前印模（扫描页导入/生成后调用） */
  selectImpression(id: string): void {
    this.currentImpressionId = id;
    this.currentDesignId = null;
    this.shellCache.clear();
    this.emit();
  }

  async saveSettings(s: AppSettings): Promise<void> {
    await store.saveSettings(s);
    this.settings = s;
    this.emit();
  }

  async wipe(): Promise<void> {
    await store.wipe();
    this.impressions.clear();
    this.designs.clear();
    this.shellCache.clear();
  }

  newId(prefix: string): string {
    return uid(prefix);
  }
}

export const app = new AppState();

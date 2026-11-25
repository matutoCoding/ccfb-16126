import type {
  AppSettings,
  Client,
  EarCase,
  FactoryOrder,
  ScanRecord,
  ShellDesign,
  LayerStyle,
  LayerId,
} from '../../types';
import {
  DEFAULT_SETTINGS,
  idbPut,
  loadSettings,
  repository,
  uid,
} from '../storage/idb';

export { DEFAULT_SETTINGS };

export interface AppState {
  settings: AppSettings;
  clients: Client[];
  cases: EarCase[];
  scans: ScanRecord[];
  designs: ShellDesign[];
  orders: FactoryOrder[];
  selectedClientId: string | null;
  selectedCaseId: string | null;
  selectedScanId: string | null;
  selectedDesignId: string | null;
  layerStyles: LayerStyle[];
  page: PageId;
}

export type PageId = 'profiles' | 'scan' | 'shell' | 'layout' | 'inspect' | 'settings';

export const PAGE_LABEL: Record<PageId, string> = {
  profiles: '客户档案',
  scan: '耳印扫描',
  shell: '外壳设计',
  layout: '内部排布',
  inspect: '透视检查',
  settings: '设置',
};

const LAYER_META: { id: LayerId; label: string }[] = [
  { id: 'shell', label: '外壳' },
  { id: 'tube', label: '声管' },
  { id: 'vent', label: '通气孔' },
  { id: 'receiver', label: '受话器' },
  { id: 'battery', label: '电池仓' },
  { id: 'faceplate', label: '面板' },
  { id: 'amplifier', label: '放大器芯片' },
];

type Listener = (state: AppState) => void;

class Store {
  state: AppState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = {
      settings: structuredClone(DEFAULT_SETTINGS),
      clients: [],
      cases: [],
      scans: [],
      designs: [],
      orders: [],
      selectedClientId: null,
      selectedCaseId: null,
      selectedScanId: null,
      selectedDesignId: null,
      layerStyles: [],
      page: 'profiles',
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  async init(): Promise<void> {
    const settings = await loadSettings();
    const [clients, cases, scans, designs, orders] = await Promise.all([
      repository.listClients(),
      repository.listCases(),
      repository.listScans(),
      repository.listDesigns(),
      repository.listOrders(),
    ]);
    this.state = {
      ...this.state,
      settings,
      clients: clients.sort((a, b) => b.updatedAt - a.updatedAt),
      cases: cases.sort((a, b) => b.updatedAt - a.updatedAt),
      scans,
      designs,
      orders,
      layerStyles: this.buildLayerStyles(settings),
    };
    this.emit();
  }

  private buildLayerStyles(settings: AppSettings): LayerStyle[] {
    return LAYER_META.map((m) => ({
      id: m.id,
      label: m.label,
      visible: true,
      alpha: settings.layerDefaults[m.id].alpha,
      color: settings.layerDefaults[m.id].color,
    }));
  }

  update(fn: (draft: AppState) => void): void {
    fn(this.state);
    this.emit();
  }

  goto(page: PageId): void {
    this.update((s) => {
      s.page = page;
    });
  }

  select(clientId: string | null, caseId?: string | null, scanId?: string | null, designId?: string | null): void {
    this.update((s) => {
      s.selectedClientId = clientId;
      if (caseId !== undefined) s.selectedCaseId = caseId;
      if (scanId !== undefined) s.selectedScanId = scanId;
      if (designId !== undefined) s.selectedDesignId = designId;
    });
  }

  async saveClient(c: Client): Promise<void> {
    c.updatedAt = Date.now();
    await repository.saveClient(c);
    this.update((s) => {
      const i = s.clients.findIndex((x) => x.id === c.id);
      if (i >= 0) s.clients[i] = c;
      else s.clients.unshift(c);
    });
  }

  async deleteClient(id: string): Promise<void> {
    const relatedCases = this.state.cases.filter((c) => c.clientId === id);
    for (const ec of relatedCases) await this.deleteCase(ec.id);
    await repository.deleteClient(id);
    this.update((s) => {
      s.clients = s.clients.filter((c) => c.id !== id);
      if (s.selectedClientId === id) s.selectedClientId = null;
    });
  }

  async saveCase(c: EarCase): Promise<void> {
    c.updatedAt = Date.now();
    await repository.saveCase(c);
    this.update((s) => {
      const i = s.cases.findIndex((x) => x.id === c.id);
      if (i >= 0) s.cases[i] = c;
      else s.cases.unshift(c);
    });
  }

  async deleteCase(id: string): Promise<void> {
    const scans = this.state.scans.filter((x) => x.caseId === id);
    for (const sc of scans) await repository.deleteScan(sc.id);
    const designs = this.state.designs.filter((x) => x.caseId === id);
    for (const d of designs) await repository.deleteDesign(d.id);
    await repository.deleteCase(id);
    this.update((s) => {
      s.scans = s.scans.filter((x) => x.caseId !== id);
      s.designs = s.designs.filter((x) => x.caseId !== id);
      s.cases = s.cases.filter((c) => c.id !== id);
      if (s.selectedCaseId === id) s.selectedCaseId = null;
    });
  }

  async saveScan(scan: ScanRecord): Promise<void> {
    await repository.saveScan(scan);
    this.update((s) => {
      const i = s.scans.findIndex((x) => x.id === scan.id);
      if (i >= 0) s.scans[i] = scan;
      else s.scans.push(scan);
      s.selectedScanId = scan.id;
    });
  }

  async saveDesign(design: ShellDesign): Promise<void> {
    await repository.saveDesign(design);
    this.update((s) => {
      const i = s.designs.findIndex((x) => x.id === design.id);
      if (i >= 0) s.designs[i] = design;
      else s.designs.push(design);
      s.selectedDesignId = design.id;
    });
  }

  async deleteDesign(id: string): Promise<void> {
    await repository.deleteDesign(id);
    this.update((s) => {
      s.designs = s.designs.filter((d) => d.id !== id);
    });
  }

  async saveOrder(order: FactoryOrder): Promise<void> {
    await repository.saveOrder(order);
    this.update((s) => {
      const i = s.orders.findIndex((x) => x.id === order.id);
      if (i >= 0) s.orders[i] = order;
      else s.orders.unshift(order);
    });
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    await idbPut('settings', 'app', settings);
    this.update((s) => {
      s.settings = settings;
      s.layerStyles = this.buildLayerStyles(settings);
    });
  }

  updateLayerStyle(id: LayerId, patch: Partial<LayerStyle>): void {
    this.update((s) => {
      const st = s.layerStyles.find((x) => x.id === id);
      if (st) Object.assign(st, patch);
    });
  }

  newId(prefix: string): string {
    return uid(prefix);
  }

  // 选择器
  get currentClient(): Client | null {
    return this.state.clients.find((c) => c.id === this.state.selectedClientId) ?? null;
  }
  get currentCase(): EarCase | null {
    return this.state.cases.find((c) => c.id === this.state.selectedCaseId) ?? null;
  }
  get currentScan(): ScanRecord | null {
    return this.state.scans.find((c) => c.id === this.state.selectedScanId) ?? null;
  }
  get currentDesign(): ShellDesign | null {
    return this.state.designs.find((c) => c.id === this.state.selectedDesignId) ?? null;
  }
}

export const store = new Store();

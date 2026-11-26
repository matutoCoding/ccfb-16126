// 应用中央状态：当前客户/耳侧、耳印、外壳参数、排布结果，简单订阅模式
import { ClientProfile, EarSide, db, uid } from '../db/database';
import { Impression } from '../core/impression';
import { ShellDesignParams, ShellDesignResult } from '../core/shell';
import { PlacedComponent } from '../core/components';

type Listener = () => void;

export interface AppState {
  clients: ClientProfile[];
  currentClientId: string | null;
  currentSide: EarSide;
  // 运行时几何（不持久化到 state 序列化，单独持有）
  impression: Impression | null;
  shellParams: ShellDesignParams | null;
  shellResult: ShellDesignResult | null;
  components: PlacedComponent[] | null;
}

class Store {
  state: AppState = {
    clients: [],
    currentClientId: null,
    currentSide: 'right',
    impression: null,
    shellParams: null,
    shellResult: null,
    components: null,
  };
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  async loadClients(): Promise<void> {
    this.state.clients = await db.getAll<ClientProfile>('clients');
    // 恢复上次选中的客户
    if (!this.state.currentClientId) {
      const saved = localStorage.getItem('earmold-current-client');
      if (saved && this.state.clients.some((c) => c.id === saved)) {
        this.state.currentClientId = saved;
      }
    }
    this.emit();
  }

  async selectClient(id: string): Promise<void> {
    this.state.currentClientId = id;
    localStorage.setItem('earmold-current-client', id);
    this.state.impression = null;
    this.state.shellParams = null;
    this.state.shellResult = null;
    this.state.components = null;
    this.emit();
  }

  setSide(side: EarSide): void {
    this.state.currentSide = side;
    this.emit();
  }

  currentClient(): ClientProfile | undefined {
    return this.state.clients.find((c) => c.id === this.state.currentClientId);
  }

  async saveClient(client: ClientProfile): Promise<void> {
    client.updatedAt = Date.now();
    await db.put('clients', client);
    await this.loadClients();
  }

  async deleteClient(id: string): Promise<void> {
    await db.delete('clients', id);
    if (this.state.currentClientId === id) {
      this.state.currentClientId = null;
      localStorage.removeItem('earmold-current-client');
    }
    await this.loadClients();
  }

  setImpression(imp: Impression | null): void {
    this.state.impression = imp;
    this.emit();
  }
  setShell(params: ShellDesignParams | null, result: ShellDesignResult | null): void {
    this.state.shellParams = params;
    this.state.shellResult = result;
    this.emit();
  }
  setComponents(c: PlacedComponent[] | null): void {
    this.state.components = c;
    this.emit();
  }
}

export const store = new Store();
export { uid };

/**
 * IndexedDB 持久化。store 划分：
 *  customers / impressions（网格内联）/ designs / orders（含 STL ArrayBuffer）/ settings
 */
import {
  AppSettings, Customer, DEFAULT_SETTINGS, EarImpression, FactoryOrder, ShellDesign,
} from './types';

const DB_NAME = 'earmold-studio-db';
const DB_VERSION = 1;
const STORES = ['customers', 'impressions', 'designs', 'orders', 'settings'] as const;
type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbPut<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(structuredClone(value)));
}
export async function idbGet<T>(store: StoreName, id: string): Promise<T | undefined> {
  return tx(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
}
export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}
export async function idbDelete(store: StoreName, id: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(id));
}

export interface Store {
  loadCustomers(): Promise<Customer[]>;
  saveCustomer(c: Customer): Promise<void>;
  deleteCustomer(id: string): Promise<void>;
  loadImpression(id: string): Promise<EarImpression | undefined>;
  loadAllImpressions(): Promise<EarImpression[]>;
  saveImpression(im: EarImpression): Promise<void>;
  deleteImpression(id: string): Promise<void>;
  loadDesigns(): Promise<ShellDesign[]>;
  saveDesign(d: ShellDesign): Promise<void>;
  loadOrders(): Promise<FactoryOrder[]>;
  saveOrder(o: FactoryOrder): Promise<void>;
  loadSettings(): Promise<AppSettings>;
  saveSettings(s: AppSettings): Promise<void>;
  /** 测试辅助：清空全部数据 */
  wipe(): Promise<void>;
}

export const store: Store = {
  loadCustomers: () => idbGetAll<Customer>('customers'),
  saveCustomer: (c) => idbPut('customers', c),
  deleteCustomer: (id) => idbDelete('customers', id),
  loadImpression: (id) => idbGet<EarImpression>('impressions', id),
  loadAllImpressions: () => idbGetAll<EarImpression>('impressions'),
  saveImpression: (im) => idbPut('impressions', im),
  deleteImpression: (id) => idbDelete('impressions', id),
  loadDesigns: () => idbGetAll<ShellDesign>('designs'),
  saveDesign: (d) => idbPut('designs', d),
  loadOrders: () => idbGetAll<FactoryOrder>('orders'),
  saveOrder: (o) => idbPut('orders', o),
  async loadSettings() {
    const s = await idbGet<AppSettings>('settings', 'singleton');
    return s ?? structuredClone(DEFAULT_SETTINGS);
  },
  saveSettings: (s) => idbPut('settings', s),
  async wipe() {
    for (const sName of STORES) {
      const all = await idbGetAll<{ id: string }>(sName);
      for (const item of all) await idbDelete(sName, item.id);
    }
  },
};

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

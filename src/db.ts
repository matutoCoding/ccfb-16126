import type { ClientRecord, DesignRecord, FactoryOrder, ScanRecord, SettingsRecord } from './types';

const DB_NAME = 'ear-shell-studio';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('clients')) db.createObjectStore('clients', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('scans')) db.createObjectStore('scans', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('designs')) db.createObjectStore('designs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('orders')) db.createObjectStore('orders', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = run(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const idb = {
  async put<T extends { id: string }>(store: string, value: T): Promise<T> {
    await tx(store, 'readwrite', s => s.put(value));
    return value;
  },
  get<T>(store: string, id: string): Promise<T | undefined> {
    return tx<T | undefined>(store, 'readonly', s => s.get(id) as IDBRequest<T | undefined>);
  },
  async all<T>(store: string): Promise<T[]> {
    return tx<T[]>(store, 'readonly', s => s.getAll() as IDBRequest<T[]>);
  },
  async delete(store: string, id: string): Promise<void> {
    await tx(store, 'readwrite', s => s.delete(id));
  },
  async clear(store: string): Promise<void> {
    await tx(store, 'readwrite', s => s.clear());
  }
};

export const db = {
  clients: {
    all: () => idb.all<ClientRecord>('clients'),
    get: (id: string) => idb.get<ClientRecord>('clients', id),
    save: (c: ClientRecord) => idb.put('clients', c),
    remove: (id: string) => idb.delete('clients', id)
  },
  scans: {
    all: () => idb.all<ScanRecord>('scans'),
    get: (id: string) => idb.get<ScanRecord>('scans', id),
    save: (s: ScanRecord) => idb.put('scans', s),
    remove: (id: string) => idb.delete('scans', id)
  },
  designs: {
    all: () => idb.all<DesignRecord>('designs'),
    get: (id: string) => idb.get<DesignRecord>('designs', id),
    save: (d: DesignRecord) => idb.put('designs', d),
    remove: (id: string) => idb.delete('designs', id)
  },
  orders: {
    all: () => idb.all<FactoryOrder>('orders'),
    get: (id: string) => idb.get<FactoryOrder>('orders', id),
    save: (o: FactoryOrder) => idb.put('orders', o),
    remove: (id: string) => idb.delete('orders', id)
  },
  settings: {
    async get(): Promise<SettingsRecord> {
      const existing = await idb.get<SettingsRecord>('kv', 'app');
      return existing ?? { id: 'app', rendererScale: 1, maxPeelLayers: 28, heatmapEnabled: true, strictVerification: true };
    },
    save: (s: SettingsRecord) => idb.put('kv', s)
  }
};

export function uid(prefix = 'id'): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)}`;
}

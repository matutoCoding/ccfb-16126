import type {
  AppSettings,
  Client,
  EarCase,
  FactoryOrder,
  ScanRecord,
  ShellDesign,
} from '../../types';

const DB_NAME = 'earmold-studio';
const DB_VERSION = 1;

export type StoreName = 'clients' | 'cases' | 'scans' | 'designs' | 'orders' | 'settings' | 'blobs';

const STORES: StoreName[] = ['clients', 'cases', 'scans', 'designs', 'orders', 'settings', 'blobs'];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function idbPut<T>(store: StoreName, key: string, value: T): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbClear(store: StoreName): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const uid = (prefix = 'id'): string =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

export const DEFAULT_SETTINGS: AppSettings = {
  wallMinHard: 0.8,
  wallMinSoftSilicone: 1.2,
  ventMin: 1.0,
  ventMax: 3.0,
  maxPeelLayers: 12,
  colorTolerance: 2,
  thicknessTolerance: 0.05,
  layerDefaults: {
    shell: { alpha: 0.32, color: [0.55, 0.78, 1.0] },
    tube: { alpha: 0.55, color: [1.0, 0.72, 0.3] },
    vent: { alpha: 0.5, color: [0.5, 1.0, 0.75] },
    receiver: { alpha: 0.75, color: [1.0, 0.45, 0.45] },
    battery: { alpha: 0.75, color: [0.75, 0.6, 1.0] },
    faceplate: { alpha: 0.7, color: [0.85, 0.85, 0.9] },
    amplifier: { alpha: 0.75, color: [1.0, 0.9, 0.4] },
  },
};

export async function loadSettings(): Promise<AppSettings> {
  const s = await idbGet<AppSettings>('settings', 'app');
  if (!s) {
    await idbPut('settings', 'app', DEFAULT_SETTINGS);
    return structuredClone(DEFAULT_SETTINGS);
  }
  // 合并新增字段
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...s,
    layerDefaults: { ...DEFAULT_SETTINGS.layerDefaults, ...s.layerDefaults },
  };
}

// 仓储封装：档案/病例/扫描/设计/订单
export const repository = {
  listClients: () => idbGetAll<Client>('clients'),
  saveClient: (c: Client) => idbPut('clients', c.id, c),
  deleteClient: (id: string) => idbDelete('clients', id),

  listCases: () => idbGetAll<EarCase>('cases'),
  saveCase: (c: EarCase) => idbPut('cases', c.id, c),
  deleteCase: (id: string) => idbDelete('cases', id),

  listScans: () => idbGetAll<ScanRecord>('scans'),
  saveScan: (s: ScanRecord) => idbPut('scans', s.id, s),
  deleteScan: (id: string) => idbDelete('scans', id),

  listDesigns: () => idbGetAll<ShellDesign>('designs'),
  saveDesign: (d: ShellDesign) => idbPut('designs', d.id, d),
  deleteDesign: (id: string) => idbDelete('designs', id),

  listOrders: () => idbGetAll<FactoryOrder>('orders'),
  saveOrder: (o: FactoryOrder) => idbPut('orders', o.id, o),
  deleteOrder: (id: string) => idbDelete('orders', id),
};

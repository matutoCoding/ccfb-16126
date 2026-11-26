// IndexedDB 持久层：客户档案、耳印 STL、外壳设计、工厂订单
import { ImpressionKind } from '../core/impression';

const DB_NAME = 'earmold-studio';
const DB_VERSION = 1;

export interface AudiogramPoint {
  freq: number; // Hz
  left: number | null; // dB HL
  right: number | null;
}

export type EarSide = 'left' | 'right';
export type ShellType = 'fullShell' | 'halfShell' | 'itc' | 'cic';
export const SHELL_TYPE_LABEL: Record<ShellType, string> = {
  fullShell: '全耳甲式',
  halfShell: '半耳甲式',
  itc: '耳道式 ITC',
  cic: '深耳道式 CIC',
};

export interface EarRecord {
  side: EarSide;
  shellType: ShellType;
  deviceModel: string;
  impressionId?: string; // 关联耳印
  shellDesignId?: string; // 关联当前外壳
  history: string[]; // 历次外壳/订单 id，新旧挂在一起
}

export interface ClientProfile {
  id: string;
  name: string;
  age: number;
  gender: string;
  phone: string;
  note: string;
  audiogram: AudiogramPoint[];
  left: EarRecord;
  right: EarRecord;
  createdAt: number;
  updatedAt: number;
}

export interface ImpressionRecord {
  id: string;
  clientId: string;
  side: EarSide;
  kind: ImpressionKind | 'imported';
  stlBlob?: Blob;
  createdAt: number;
  note?: string;
}

export interface ShellDesignRecord {
  id: string;
  clientId: string;
  impressionId: string;
  side: EarSide;
  paramsJson: string; // ShellDesignParams 序列化
  stlBlob?: Blob;
  createdAt: number;
  version: number;
}

export interface FactoryOrder {
  id: string;
  clientId: string;
  shellDesignId: string;
  side: EarSide;
  materialColor: string;
  ventDiameter: number;
  soundTubeLength: number;
  stlBlob?: Blob;
  screenshots: Blob[]; // 三张透视截图
  createdAt: number;
  status: 'draft' | 'submitted';
}

type Store = 'clients' | 'impressions' | 'designs' | 'orders';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('clients')) db.createObjectStore('clients', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('impressions')) {
        const s = db.createObjectStore('impressions', { keyPath: 'id' });
        s.createIndex('clientId', 'clientId');
      }
      if (!db.objectStoreNames.contains('designs')) {
        const s = db.createObjectStore('designs', { keyPath: 'id' });
        s.createIndex('clientId', 'clientId');
      }
      if (!db.objectStoreNames.contains('orders')) {
        const s = db.createObjectStore('orders', { keyPath: 'id' });
        s.createIndex('clientId', 'clientId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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

export const db = {
  async put<T>(store: Store, value: T): Promise<IDBValidKey> {
    return tx(store, 'readwrite', (s) => s.put(value as unknown as Record<string, unknown>));
  },
  async get<T>(store: Store, key: string): Promise<T | undefined> {
    return tx(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  },
  async delete(store: Store, key: string): Promise<void> {
    await tx(store, 'readwrite', (s) => s.delete(key));
  },
  async getAll<T>(store: Store): Promise<T[]> {
    return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  async getAllByIndex<T>(store: Store, index: string, value: string): Promise<T[]> {
    return openDb().then(
      (db) =>
        new Promise<T[]>((resolve, reject) => {
          const t = db.transaction(store, 'readonly');
          const req = t.objectStore(store).index(index).getAll(value);
          req.onsuccess = () => resolve(req.result as T[]);
          req.onerror = () => reject(req.error);
        }),
    );
  },
};

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultAudiogram(): AudiogramPoint[] {
  return [250, 500, 1000, 2000, 4000, 8000].map((freq) => ({ freq, left: null, right: null }));
}

export function emptyEar(side: EarSide): EarRecord {
  return { side, shellType: 'itc', deviceModel: '', history: [] };
}

export async function createClient(partial: Partial<ClientProfile>): Promise<ClientProfile> {
  const now = Date.now();
  const client: ClientProfile = {
    id: uid('cli'),
    name: partial.name ?? '新客户',
    age: partial.age ?? 70,
    gender: partial.gender ?? '',
    phone: partial.phone ?? '',
    note: partial.note ?? '',
    audiogram: defaultAudiogram(),
    left: emptyEar('left'),
    right: emptyEar('right'),
    createdAt: now,
    updatedAt: now,
  };
  await db.put('clients', client);
  return client;
}

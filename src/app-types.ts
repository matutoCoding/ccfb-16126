import type { ClientRecord, DesignRecord, FactoryOrder, PageKey, ScanRecord, SettingsRecord } from './types';

export interface AppState {
  page: PageKey;
  clients: ClientRecord[];
  scans: ScanRecord[];
  designs: DesignRecord[];
  orders: FactoryOrder[];
  settings: SettingsRecord;
  currentScanId?: string;
  currentClientId?: string;
  currentDesignId?: string;
  toast?: string;
}

import type { AppState } from '../app-types';
import type { PageKey } from '../types';

export interface UiContext {
  state: AppState;
  navigate: (page: PageKey, scanId?: string) => void;
  toast: (message: string, kind?: 'ok' | 'bad' | 'info') => void;
  rerender: () => void;
}

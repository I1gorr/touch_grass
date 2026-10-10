import type { MlKind } from './protocol';

/** What the app knows about a model on this phone. */
export type ModelStatus =
  | { state: 'absent' }
  | { state: 'downloading'; fraction: number; bytes: number }
  | { state: 'ready' }
  | { state: 'error'; message: string };

const KEY = 'touch_grass.models';

/**
 * Remembers which models finished downloading (browsers don't tell us what is in Cache Storage cheaply).
 * If the browser later evicts the files, loading just fails as "not downloaded" and the person can download again.
 */
export class DownloadedModels {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {}

  private read(): Record<string, number> {
    try {
      const v = JSON.parse(this.storage?.getItem(KEY) ?? '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  has(kind: MlKind, model: string): boolean {
    return typeof this.read()[`${kind}:${model}`] === 'number';
  }

  mark(kind: MlKind, model: string, at = Date.now()): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify({ ...this.read(), [`${kind}:${model}`]: at }));
    } catch {
      /* private mode: forgotten next visit, files stay cached */
    }
  }

  forget(kind: MlKind, model: string): void {
    const all = this.read();
    delete all[`${kind}:${model}`];
    try {
      this.storage?.setItem(KEY, JSON.stringify(all));
    } catch {
      /* nothing to forget */
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

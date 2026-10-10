import type { ReportClient } from '../data/reports';
import type { PackRefresher } from '../data/packDownloader';
import type { SyncService } from '../sync/syncService';

/**
 * What to do when the internet comes back: back up walks, send reports made offline, refresh stale map
 * packs. Skipped entirely while a walk is active (a walk never touches the network).
 */
export class OnlineTasks {
  private running = false;
  private off: (() => void) | null = null;

  constructor(
    private readonly o: {
      walkInProgress: () => Promise<boolean>;
      sync?: SyncService | null;
      reports?: ReportClient | null;
      refresher?: PackRefresher | null;
    },
  ) {}

  /** Returns false if it did nothing (walk active or already running). */
  async onOnline(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      if (await this.o.walkInProgress()) return false;
      await this.o.sync?.syncNow(false);
      await this.o.reports?.flush();
      await this.o.refresher?.refreshStale();
      return true;
    } catch (e) {
      console.warn('[online] tasks failed:', e);
      return false;
    } finally {
      this.running = false;
    }
  }

  /** `subscribe` calls the callback each time the connection comes back; returns an unsubscribe function. */
  start(subscribe: (cb: () => void) => () => void): void {
    this.stop();
    this.off = subscribe(() => void this.onOnline());
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }
}

/** The browser's `online` event. (`navigator.onLine` only says a network link exists, not that the internet works.) */
export const browserOnline = (cb: () => void): (() => void) => {
  window.addEventListener('online', cb);
  return () => window.removeEventListener('online', cb);
};

import type { DownloadProgress } from './protocol';

/**
 * Turns per-file download events into one overall fraction. The total grows as new files are discovered, so the
 * number can dip when a big file appears; it is only ever shown, never relied on.
 */
export class ProgressTracker {
  private readonly files = new Map<string, { loaded: number; total: number }>();

  update(p: DownloadProgress): number {
    this.files.set(p.file, { loaded: Math.min(p.loaded, p.total || p.loaded), total: p.total });
    return this.fraction;
  }

  get fraction(): number {
    let loaded = 0;
    let total = 0;
    for (const f of this.files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    return total > 0 ? Math.min(1, loaded / total) : 0;
  }

  get bytesLoaded(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.loaded;
    return n;
  }

  reset(): void {
    this.files.clear();
  }
}

export const formatMb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

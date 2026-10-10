import { batchCount, type SyncBatch } from '../db/walkRepo';
import { Emitter } from '../util/emitter';
import { SyncException, type SyncTransport } from './transport';

/** Local store that tracks which rows changed since the last upload. Implemented by WalkRepo. */
export interface SyncableStore {
  /** Up to `limitPerTable` changed rows from each table. Each row includes `updated_at`. */
  pendingChanges(limitPerTable?: number): Promise<SyncBatch>;
  /** Marks exactly the uploaded versions as synced. Rows changed again after being read stay pending. */
  markSynced(batch: SyncBatch): Promise<void>;
  pendingCount(): Promise<number>;
}

export interface SyncResult {
  uploaded: number;
  error?: unknown;
  /** Nothing was sent because a walk is in progress (not an error). */
  skippedForWalk?: boolean;
}

export interface SyncServiceOptions {
  store: SyncableStore;
  transport: SyncTransport;
  deviceId: string;
  /** Subscribe to local changes (e.g. `repo.onChange`); an upload is attempted `debounceMs` after the last one. */
  onChange?: (fn: () => void) => () => void;
  intervalMs?: number;
  debounceMs?: number;
  batchSize?: number;
  /** Safety cap so a store that never clears its pending rows can't loop forever. */
  maxBatchesPerRun?: number;
  /** False when the transport was supplied from outside (and is reused), so `close` must not shut it. */
  ownsTransport?: boolean;
  /** A walk never touches the network. When this returns true (a walk is active), runs are skipped and resume after. */
  walkInProgress?: () => Promise<boolean>;
  clock?: () => Date;
}

/**
 * Uploads local walk/stop/entry changes to the cloud whenever possible. Photos are never uploaded.
 * The local database stays the source of truth: a failed sync never blocks or loses anything; rows just stay
 * pending until the next attempt.
 *
 * Attempts happen: `debounceMs` after local changes, every `intervalMs`, and on `syncNow` (Settings button, walk finished).
 */
export class SyncService {
  lastSuccess: Date | null = null;
  lastError: unknown = null;
  pending = 0;
  running = false;
  /** True when the last attempt was skipped because a walk is in progress. */
  waitingForWalk = false;
  /** Rows the server refused because a different install owns them. Should stay 0. */
  refused = 0;
  /** A permanent failure (e.g. wrong API key) stops automatic retries until `syncNow` is called explicitly. */
  paused = false;

  private readonly emitter = new Emitter();
  private inFlight: Promise<SyncResult> | null = null;
  /** A sync was requested while one was running: its changes may have missed that run, so go once more. */
  private again = false;
  private periodic: ReturnType<typeof setInterval> | null = null;
  private debounced: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private disposed = false;

  private readonly o: Required<Omit<SyncServiceOptions, 'onChange' | 'walkInProgress'>> &
    Pick<SyncServiceOptions, 'onChange' | 'walkInProgress'>;

  constructor(o: SyncServiceOptions) {
    this.o = {
      intervalMs: 5 * 60_000,
      debounceMs: 5000,
      batchSize: 200,
      maxBatchesPerRun: 50,
      ownsTransport: true,
      clock: () => new Date(),
      ...o,
    };
  }

  /** Listen for state changes (running, pending, errors). Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    return this.emitter.subscribe(fn);
  }

  start(): void {
    this.periodic ??= setInterval(() => this.auto(), this.o.intervalMs);
    this.unsub ??= this.o.onChange?.(() => {
      if (this.debounced) clearTimeout(this.debounced);
      this.debounced = setTimeout(() => this.auto(), this.o.debounceMs);
    }) ?? null;
    this.auto();
  }

  private auto(): void {
    if (!this.paused && !this.disposed) void this.syncNow(false);
  }

  /**
   * Uploads everything pending. Concurrent calls share one run. A call that arrives mid-run makes that run
   * do one more pass afterwards, so a change made while an upload was finishing is not left waiting for the
   * next timer.
   */
  syncNow(manual = true): Promise<SyncResult> {
    if (manual) this.paused = false;
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    return (this.inFlight = this.runLoop().finally(() => (this.inFlight = null)));
  }

  private async runLoop(): Promise<SyncResult> {
    let uploaded = 0;
    let last: SyncResult;
    do {
      this.again = false;
      last = await this.run();
      uploaded += last.uploaded;
    } while (this.again && !last.error && !last.skippedForWalk && !this.disposed);
    return { ...last, uploaded };
  }

  private async run(): Promise<SyncResult> {
    this.running = true;
    this.notify();
    const guard = this.o.walkInProgress;
    if (guard && (await guard())) {
      this.waitingForWalk = true;
      this.running = false;
      try {
        this.pending = await this.o.store.pendingCount();
      } catch {
        /* keep the old count */
      }
      this.notify();
      return { uploaded: 0, skippedForWalk: true };
    }
    this.waitingForWalk = false;
    let uploaded = 0;
    let refusedRows = 0;
    try {
      for (let i = 0; i < this.o.maxBatchesPerRun; i++) {
        const batch = await this.o.store.pendingChanges(this.o.batchSize);
        if (batchCount(batch) === 0) break;
        // Rows the server refused because another install owns them can never be written by this one;
        // mark them done but tell the user.
        refusedRows += await this.o.transport.push(this.o.deviceId, batch);
        await this.o.store.markSynced(batch);
        uploaded += batchCount(batch);
      }
      this.lastSuccess = this.o.clock();
      this.lastError = null;
      if (refusedRows > 0) {
        this.refused += refusedRows;
        console.warn(`[sync] ${refusedRows} rows refused: owned by another install`);
      }
      return { uploaded };
    } catch (e) {
      this.lastError = e;
      if (e instanceof SyncException && e.isPermanent) this.paused = true;
      return { uploaded, error: e };
    } finally {
      try {
        this.pending = await this.o.store.pendingCount();
      } catch {
        /* keep the old count */
      }
      this.running = false;
      this.notify();
    }
  }

  private notify(): void {
    if (!this.disposed) this.emitter.emit();
  }

  /** Stops scheduling, waits for any upload in progress, then releases the transport (if owned). */
  async close(): Promise<void> {
    this.stopTimers();
    try {
      await this.inFlight;
    } catch {
      /* the run already reported its error */
    }
    if (this.o.ownsTransport) await this.o.transport.close();
    this.disposed = true;
    this.emitter.clear();
  }

  private stopTimers(): void {
    if (this.periodic) clearInterval(this.periodic);
    if (this.debounced) clearTimeout(this.debounced);
    this.unsub?.();
    this.periodic = this.debounced = this.unsub = null;
  }
}

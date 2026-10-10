import type { DownloadProgress, MlRequest, MlResponse } from './protocol';

/** The worker as the client sees it: `new Worker(...)` fits, and so does an in-process fake in tests. */
export interface WorkerLike {
  postMessage(msg: MlRequest, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: MlResponse }) => void) | null;
  onerror?: ((ev: { message?: string }) => void) | null;
  terminate(): void;
}

export class MlRequestError extends Error {
  override name = 'MlRequestError';
  constructor(
    message: string,
    readonly code: 'unavailable' | 'error',
  ) {
    super(message);
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** Request/response over a worker, with progress events. */
export class MlClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: DownloadProgress) => void }
  >();
  private dead = false;

  constructor(private readonly worker: WorkerLike) {
    worker.onmessage = (ev) => this.onMessage(ev.data);
    worker.onerror = (ev) => this.fail(new Error(ev.message ?? 'the model worker crashed'));
  }

  private onMessage(m: MlResponse): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    if ('event' in m) {
      p.onProgress?.(m.progress);
      return;
    }
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new MlRequestError(m.error, m.code));
  }

  /** The worker died (out of memory, bad script): every waiting request fails, and later ones too. */
  private fail(e: Error): void {
    this.dead = true;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  call<T>(req: DistributiveOmit<MlRequest, 'id'>, o: { onProgress?: (p: DownloadProgress) => void; transfer?: Transferable[] } = {}): Promise<T> {
    if (this.dead) return Promise.reject(new Error('the model worker is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress: o.onProgress });
      this.worker.postMessage({ ...req, id } as MlRequest, o.transfer);
    });
  }

  terminate(): void {
    this.fail(new Error('the model worker was stopped'));
    this.worker.terminate();
  }
}

/** An in-process "worker" backed by a runtime: for tests and for browsers without module workers. */
export function localWorker(handle: (req: MlRequest, emit: (r: MlResponse) => void) => Promise<void>): WorkerLike {
  const w: WorkerLike = {
    onmessage: null,
    postMessage(msg) {
      // Like a real worker, answer asynchronously.
      queueMicrotask(() => void handle(msg, (r) => w.onmessage?.({ data: r })));
    },
    terminate() {},
  };
  return w;
}

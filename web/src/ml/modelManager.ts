import type { MlClient } from './client';
import { DownloadedModels, type ModelStatus } from './models.state';
import type { ModelOption } from './models';
import { specFor } from './engines';
import { ProgressTracker } from './progress';
import { Emitter } from '../util/emitter';
import type { MlConfig } from '../config/config';

/** The cache transformers.js stores model files (and the ONNX runtime) in. */
export const MODEL_CACHE_NAME = 'transformers-cache';

/**
 * Deletes every cached file of `model` from Cache Storage. Returns how many were removed.
 * Files are keyed by URL, and a model's URLs all contain `/<model id>/`.
 */
export async function clearModelFiles(model: string, caches: Pick<CacheStorage, 'open'> | undefined = globalThis.caches): Promise<number> {
  if (!caches) return 0;
  const cache = await caches.open(MODEL_CACHE_NAME);
  let n = 0;
  for (const req of await cache.keys()) {
    if (req.url.includes(`/${model}/`) && (await cache.delete(req))) n++;
  }
  return n;
}

/**
 * Downloads, tracks and removes the on-device models. A download only ever starts from an explicit call (the
 * Settings button), never on its own, because these are hundreds of megabytes.
 */
export class ModelManager {
  private readonly emitter = new Emitter();
  private readonly live = new Map<string, ModelStatus>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly client: () => MlClient,
    readonly downloaded: DownloadedModels,
    private readonly config: () => MlConfig,
    private readonly clearFiles: (model: string) => Promise<number> = clearModelFiles,
  ) {}

  private key = (o: ModelOption) => `${o.kind}:${o.id}`;

  subscribe(fn: () => void): () => void {
    return this.emitter.subscribe(fn);
  }

  status(o: ModelOption): ModelStatus {
    return this.live.get(this.key(o)) ?? (this.downloaded.has(o.kind, o.id) ? { state: 'ready' } : { state: 'absent' });
  }

  isReady(o: ModelOption): boolean {
    return this.status(o).state === 'ready';
  }

  private set(o: ModelOption, s: ModelStatus | null): void {
    if (s) this.live.set(this.key(o), s);
    else this.live.delete(this.key(o));
    this.emitter.emit();
  }

  /** Downloads and checks the model, then unloads it again (the engines load it when they need it). Concurrent calls share one download. */
  download(o: ModelOption): Promise<void> {
    const k = this.key(o);
    const existing = this.inFlight.get(k);
    if (existing) return existing;
    const tracker = new ProgressTracker();
    this.set(o, { state: 'downloading', fraction: 0, bytes: 0 });
    const run = (async () => {
      try {
        const client = this.client();
        await client.call(
          { op: 'load', kind: o.kind, spec: { ...specFor(o.kind, this.config(), false), model: o.id, dtype: o.dtype }, allowDownload: true },
          { onProgress: (p) => this.set(o, { state: 'downloading', fraction: tracker.update(p), bytes: tracker.bytesLoaded }) },
        );
        await client.call({ op: 'release', kind: o.kind }).catch(() => undefined); // free the memory until it is needed
        this.downloaded.mark(o.kind, o.id);
        this.set(o, null);
      } catch (e) {
        this.set(o, { state: 'error', message: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        this.inFlight.delete(k);
      }
    })();
    this.inFlight.set(k, run);
    return run;
  }

  /** Deletes the model's files from this phone. */
  async remove(o: ModelOption): Promise<void> {
    await this.client().call({ op: 'release', kind: o.kind }).catch(() => undefined);
    await this.clearFiles(o.id);
    this.downloaded.forget(o.kind, o.id);
    this.set(o, null);
  }
}

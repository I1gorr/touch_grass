import { MlClient, type WorkerLike } from './client';

/**
 * Starts the model worker and returns a client for it, or null where module workers don't exist (very old
 * browsers, tests). The worker only loads the heavy library when a model is actually used.
 */
export function createWorkerClient(): MlClient | null {
  try {
    if (typeof Worker === 'undefined') return null;
    const worker = new Worker(new URL('./workers/mlWorker.ts', import.meta.url), { type: 'module' });
    return new MlClient(worker as unknown as WorkerLike);
  } catch (e) {
    console.warn('[ml] model worker unavailable:', e);
    return null;
  }
}

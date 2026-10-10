import { type PlanJob, type RouteOption, planRoutes } from './recommender';

/**
 * Runs `planRoutes` off the UI thread (graph building is the slow part).
 * Falls back to the main thread where workers are unavailable (e.g. tests).
 */
export async function planRoutesInWorker(job: PlanJob): Promise<RouteOption[]> {
  if (typeof Worker === 'undefined') return planRoutes(job);
  const worker = new Worker(new URL('./planWorker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<RouteOption[]>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<{ routes?: RouteOption[]; error?: string }>) =>
        ev.data.error ? reject(new Error(ev.data.error)) : resolve(ev.data.routes!);
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage({ id: 0, job });
    });
  } finally {
    worker.terminate();
  }
}

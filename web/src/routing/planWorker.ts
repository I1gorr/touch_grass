/// <reference lib="webworker" />
import { type PlanJob, planRoutes } from './recommender';

self.onmessage = (ev: MessageEvent<{ id: number; job: PlanJob }>) => {
  const { id, job } = ev.data;
  try {
    self.postMessage({ id, routes: planRoutes(job) });
  } catch (e) {
    self.postMessage({ id, error: String(e) });
  }
};

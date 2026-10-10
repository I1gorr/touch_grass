/// <reference lib="webworker" />
import type { MlRequest, MlResponse } from '../protocol';
import { MlRuntime } from '../runtime';
import { loadTransformersPipeline } from '../transformersLoader';

// Models live here, off the UI thread: loading and running them would freeze the screen otherwise.
const runtime = new MlRuntime(loadTransformersPipeline);
self.onmessage = (ev: MessageEvent<MlRequest>) => {
  void runtime.handle(ev.data, (r: MlResponse) => self.postMessage(r));
};

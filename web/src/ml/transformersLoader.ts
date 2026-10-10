// The ONNX runtime is served from this site (not a third-party CDN): it works offline once cached, keeps the
// person's address away from a CDN, and the version always matches the library we ship. These are the files
// transformers.js would otherwise fetch from jsdelivr (`.asyncify`, for both the WebAssembly and WebGPU backends).
import ortWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortFactoryUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import type { PipelineLoader } from './protocol';
import { hasWebGpu } from './capabilities';
import { adaptLlm, adaptStt } from './transformersAdapters';

const isSameOrigin = (url: string | URL): boolean => {
  try {
    return new URL(String(url), self.location.href).origin === self.location.origin;
  } catch {
    return false;
  }
};

/**
 * The real model loader (runs inside the worker). Speech uses WebAssembly with the small int8 weights: they are
 * a fraction of the download and int8 isn't supported by the WebGPU backend. The language model uses WebGPU when
 * (required: the 4-bit weights don't run on WebAssembly).
 */
export const loadTransformersPipeline: PipelineLoader = async (kind, o) => {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  env.useBrowserCache = true; // models, and the ONNX runtime itself, are kept in Cache Storage for offline use
  // "Only what is already downloaded": the cache is read first, and the only fetches allowed are this site's own files
  // (the runtime) unless a download was explicitly requested. (The library rejects `local_files_only` and
  // `allowRemoteModels = false` here, because it refuses to read its cache with both local and remote models off.)
  env.allowRemoteModels = true;
  env.fetch = (input, init) =>
    o.allowDownload || isSameOrigin(input) ? fetch(input, init) : Promise.reject(new Error('the model is not downloaded'));
  // Several threads need cross-origin isolation; without it the runtime would silently use one anyway.
  const onnx = env.backends.onnx as any;
  if (onnx?.wasm) {
    onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    // Must be set before the first model loads; transformers.js then caches both files for offline use.
    onnx.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href, mjs: new URL(ortFactoryUrl, self.location.href).href };
  }

  // The language model only runs on WebGPU (see capabilities.ts); speech uses WebAssembly.
  if (kind === 'llm' && !(await hasWebGpu())) throw new Error('the language model needs WebGPU, which this browser does not have');
  const device = kind === 'llm' ? 'webgpu' : 'wasm';
  const pipe: any = await pipeline(kind === 'stt' ? 'automatic-speech-recognition' : 'text-generation', o.model, {
    dtype: o.dtype as any,
    device: device as any,
    progress_callback: (p: any) => {
      if (p?.status === 'progress' && p.file && p.total) o.onProgress({ file: p.file, loaded: p.loaded, total: p.total });
    },
  } as any);
  return kind === 'stt' ? adaptStt(pipe) : adaptLlm(pipe);
};

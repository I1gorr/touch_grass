/** Messages between the app and the model worker. Kept free of any library types so both sides stay testable. */

export type MlKind = 'stt' | 'llm';

/** Which model to use. Every request carries it, so "load, then run" is one step that nothing can interleave. */
export interface ModelSpec {
  model: string;
  dtype: string;
  /** Unload the other model first (low-memory phones keep one model in memory at a time). */
  exclusive: boolean;
}

/** Downloads (when `allowDownload`) and loads a model. Used by the Settings download button and to warm up. */
export interface LoadRequest {
  op: 'load';
  kind: MlKind;
  spec: ModelSpec;
  /** False = use only what is already downloaded (never start a surprise download). */
  allowDownload: boolean;
}
export interface TranscribeRequest {
  op: 'transcribe';
  spec: ModelSpec;
  samples: Float32Array;
  sampleRate: number;
}
export interface GenerateRequest {
  op: 'generate';
  spec: ModelSpec;
  prompt: string;
  maxTokens: number;
  temperature: number;
}
export interface ReleaseRequest {
  op: 'release';
  /** Omit to release everything. */
  kind?: MlKind;
}

export type MlRequest = (LoadRequest | TranscribeRequest | GenerateRequest | ReleaseRequest) & { id: number };

export interface DownloadProgress {
  file: string;
  loaded: number;
  total: number;
}

export type MlResponse =
  | { id: number; ok: true; result: unknown }
  /** `unavailable`: the model isn't downloaded and downloading wasn't allowed. */
  | { id: number; ok: false; error: string; code: 'unavailable' | 'error' }
  | { id: number; event: 'progress'; progress: DownloadProgress };

export interface TranscribeResult {
  text: string;
  segments: { startMs: number; endMs: number; text: string }[];
}

/** What the real library wrapper (in the worker) provides. Faked in tests. */
export interface LoadedPipeline {
  run(input: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}
export interface PipelineLoaderOptions {
  model: string;
  dtype: string;
  allowDownload: boolean;
  onProgress: (p: DownloadProgress) => void;
}
export type PipelineLoader = (kind: MlKind, o: PipelineLoaderOptions) => Promise<LoadedPipeline>;

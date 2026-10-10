/** The ONNX runtime both models need (a 27 MB file, about 7 MB over the wire), downloaded once with the first model. */
export const RUNTIME_DOWNLOAD_MB = 7;

/**
 * The models the app can download and run in the browser (transformers.js / ONNX). Sizes are what a download
 * transfers (quantised weights + tokenizer, plus about 7 MB for the runtime on the first one), from the Hugging Face file listings.
 */
export interface ModelOption {
  id: string;
  kind: 'stt' | 'llm';
  label: string;
  /** Approximate download size in megabytes. */
  sizeMb: number;
  /** transformers.js `dtype` for the weights. */
  dtype: string;
  note: string;
}

export const STT_MODELS: ModelOption[] = [
  { id: 'onnx-community/whisper-base.en', kind: 'stt', label: 'Whisper base (English)', sizeMb: 80, dtype: 'q8', note: 'Better accuracy. The default.' },
  { id: 'onnx-community/whisper-tiny.en', kind: 'stt', label: 'Whisper tiny (English)', sizeMb: 43, dtype: 'q8', note: 'Smaller and faster, for slow phones.' },
];

export const LLM_MODELS: ModelOption[] = [
  { id: 'onnx-community/gemma-3-1b-it-ONNX', kind: 'llm', label: 'Gemma 3 1B', sizeMb: 880, dtype: 'q4', note: 'Recommended. Writes well and keeps to the facts, but it is a large download and needs a recent phone.' },
  { id: 'onnx-community/gemma-3-270m-it-ONNX', kind: 'llm', label: 'Gemma 3 270M', sizeMb: 345, dtype: 'q4', note: 'Much smaller, but in testing it often made things up or repeated its instructions, so its answers are usually discarded in favour of the pre-written text.' },
];

export const DEFAULT_STT_MODEL = STT_MODELS[0].id;
export const DEFAULT_LLM_MODEL = LLM_MODELS[0].id;

export const findModel = (kind: 'stt' | 'llm', id: string): ModelOption | undefined =>
  (kind === 'stt' ? STT_MODELS : LLM_MODELS).find((m) => m.id === id);

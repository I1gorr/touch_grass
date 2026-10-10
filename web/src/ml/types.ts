import type { StopFacts } from '../models/types';

export type LlmTask = 'blurb' | 'question' | 'cleanup';

/**
 * Input: a prompt built from structured facts only (see prompts.ts).
 * Output: short blurb or cleaned entry. Implementations must NEVER invent facts.
 */
export interface Llm {
  generate(prompt: string): Promise<string>;
}

/**
 * Optional: implementations that don't need prompt text (fakes, fallbacks) receive the structured request
 * instead. LlmTasks prefers this when available, so prompt template changes can't break them.
 */
export interface StructuredLlm {
  respond(task: LlmTask, o: { facts?: StopFacts; transcript?: string }): Promise<string>;
}

export const isStructured = (l: unknown): l is StructuredLlm => typeof (l as StructuredLlm)?.respond === 'function';

export interface TranscriptSegment {
  /** Offsets from the start of the clip, in milliseconds. */
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcription {
  rawText: string;
  segments: TranscriptSegment[];
}

/** 16 kHz mono PCM, the format speech models expect. */
export interface AudioClip {
  samples: Float32Array;
  sampleRate: number;
}

export const STT_SAMPLE_RATE = 16000;

export interface Stt {
  /**
   * Transcribes a clip. Audio is never deleted here: callers delete it only after the transcript is
   * safely stored (see EntryPipeline), so a failure can't lose a recording.
   */
  transcribe(clip: AudioClip): Promise<Transcription>;
}

/** The speech engine can't run (model missing or failed to load). The recording is kept for later. */
export class SttUnavailableError extends Error {
  override name = 'SttUnavailableError';
}

/** Which implementation is live. Shown in Settings via `engineLabel`. */
export type EngineKind = 'device' | 'fallback' | 'fake';

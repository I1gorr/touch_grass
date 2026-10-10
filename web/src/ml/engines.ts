import type { MlConfig } from '../config/config';
import { findModel } from './models';
import { MlRequestError, type MlClient } from './client';
import type { ModelSpec, TranscribeResult } from './protocol';
import { type AudioClip, type Llm, SttUnavailableError, type Stt, type Transcription } from './types';

/** Which model files a request should use. `exclusive` keeps one model in memory at a time (low-memory phones). */
export function specFor(kind: 'stt' | 'llm', config: MlConfig, exclusive: boolean): ModelSpec {
  const id = kind === 'stt' ? config.sttModel : config.llmModel;
  const option = findModel(kind, id);
  if (!option) throw new Error(`unknown ${kind} model ${id}`);
  return { model: option.id, dtype: option.dtype, exclusive };
}

/** Phones with little memory keep one model loaded at a time; the extra load from the cache costs a moment per note. */
export function shouldKeepOneModel(nav: { deviceMemory?: number } = (globalThis.navigator ?? {}) as { deviceMemory?: number }): boolean {
  return (nav.deviceMemory ?? 4) < 6;
}

/** Whisper in the worker. Never starts a download: if the files aren't on the phone the note waits (SttUnavailableError). */
export class WebStt implements Stt {
  constructor(
    private readonly client: MlClient,
    private readonly config: MlConfig,
    private readonly exclusive: boolean,
    /** Other speech models already on the phone, tried in order if the chosen one fails to load or run (e.g. out of memory). */
    private readonly alternates: string[] = [],
  ) {}

  /** Loads the model ahead of time (e.g. while the quest is being prepared). Failures are fine: transcribe reports them. */
  async warmUp(): Promise<void> {
    await this.client.call({ op: 'load', kind: 'stt', spec: specFor('stt', this.config, this.exclusive), allowDownload: false }).catch(() => undefined);
  }

  async transcribe(clip: AudioClip): Promise<Transcription> {
    let firstError: unknown;
    for (const model of [this.config.sttModel, ...this.alternates.filter((m) => m !== this.config.sttModel)]) {
      try {
        const r = await this.client.call<TranscribeResult>({
          op: 'transcribe',
          spec: specFor('stt', { ...this.config, sttModel: model }, this.exclusive),
          // Copy: the worker takes ownership of what it is sent, and a retry needs the audio again.
          samples: clip.samples.slice(),
          sampleRate: clip.sampleRate,
        });
        return { rawText: r.text.trim(), segments: r.segments };
      } catch (e) {
        firstError ??= e;
        console.warn(`[ml] speech model ${model} failed, trying the next one:`, e);
      }
    }
    if (firstError instanceof MlRequestError && firstError.code === 'unavailable') throw new SttUnavailableError(firstError.message);
    throw firstError;
  }
}

/** Gemma in the worker. Errors propagate; LlmTasks supplies the timeout, guards and fallbacks. */
export class WebLlm implements Llm {
  constructor(
    private readonly client: MlClient,
    private readonly config: MlConfig,
    private readonly exclusive: boolean,
  ) {}

  async warmUp(): Promise<void> {
    await this.client.call({ op: 'load', kind: 'llm', spec: specFor('llm', this.config, this.exclusive), allowDownload: false }).catch(() => undefined);
  }

  generate(prompt: string): Promise<string> {
    // Cleanup needs room for the whole entry; blurbs and questions are short.
    const maxTokens = prompt.startsWith('TASK: cleanup') ? this.config.cleanupMaxTokens : this.config.blurbMaxTokens;
    return this.client.call<string>({
      op: 'generate',
      spec: specFor('llm', this.config, this.exclusive),
      prompt,
      maxTokens,
      temperature: this.config.temperature,
    });
  }
}

/** Stands in for speech recognition while no model is on the phone: notes are kept and wait for one. */
export class UnavailableStt implements Stt {
  async transcribe(_clip: AudioClip): Promise<Transcription> {
    throw new SttUnavailableError('The speech model is not downloaded yet.');
  }
}

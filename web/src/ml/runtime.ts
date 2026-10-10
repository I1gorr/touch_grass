import type {
  DownloadProgress, GenerateRequest, LoadedPipeline, MlKind, MlRequest, MlResponse, ModelSpec, PipelineLoader,
  TranscribeRequest, TranscribeResult,
} from './protocol';

/** The model isn't downloaded and downloading wasn't allowed. */
export class ModelUnavailableError extends Error {
  override name = 'ModelUnavailableError';
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Slot {
  model: string;
  pipeline: LoadedPipeline;
}

/**
 * Owns the loaded models inside the worker. Requests run strictly one at a time (a model handles a single
 * request at a time, and two loads at once would double the memory), a model is only downloaded when the
 * request explicitly allows it, and `exclusive` loads unload the other model first.
 */
export class MlRuntime {
  private readonly slots: Partial<Record<MlKind, Slot>> = {};
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly loader: PipelineLoader) {}

  /** Which models are in memory right now (for diagnostics and tests). */
  get loaded(): { stt: string | null; llm: string | null } {
    return { stt: this.slots.stt?.model ?? null, llm: this.slots.llm?.model ?? null };
  }

  /** Handles one request and reports download progress through `emit`. Never throws: errors become responses. */
  handle(req: MlRequest, emit: (r: MlResponse) => void): Promise<void> {
    const run = this.queue.then(async () => {
      try {
        const result = await this.dispatch(req, (progress) => emit({ id: req.id, event: 'progress', progress }));
        emit({ id: req.id, ok: true, result });
      } catch (e) {
        emit({
          id: req.id,
          ok: false,
          code: e instanceof ModelUnavailableError ? 'unavailable' : 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
    this.queue = run;
    return run;
  }

  private async dispatch(req: MlRequest, onProgress: (p: DownloadProgress) => void): Promise<unknown> {
    switch (req.op) {
      case 'load':
        await this.ensure(req.kind, req.spec, req.allowDownload, onProgress);
        return null;
      case 'transcribe':
        return this.transcribe(req);
      case 'generate':
        return this.generate(req);
      case 'release':
        return this.release(req.kind);
    }
  }

  /** Makes sure `spec` is loaded (reusing it if it already is). Downloads only when `allowDownload`. */
  private async ensure(kind: MlKind, spec: ModelSpec, allowDownload: boolean, onProgress: (p: DownloadProgress) => void): Promise<LoadedPipeline> {
    if (spec.exclusive) await this.release(kind === 'stt' ? 'llm' : 'stt');
    const have = this.slots[kind];
    if (have?.model === spec.model) return have.pipeline;
    if (have) await this.release(kind); // a different model of the same kind
    try {
      const pipeline = await this.loader(kind, { model: spec.model, dtype: spec.dtype, allowDownload, onProgress });
      this.slots[kind] = { model: spec.model, pipeline };
      return pipeline;
    } catch (e) {
      // Keep the real reason: "not downloaded" and "downloaded but failed to start" need different fixes.
      console.warn(`[ml] could not load ${spec.model}${allowDownload ? '' : ' (local files only)'}:`, e);
      if (!allowDownload) throw new ModelUnavailableError(`${spec.model} is not available on this phone: ${reasonOf(e)}`);
      throw e;
    }
  }

  private async transcribe(r: TranscribeRequest): Promise<TranscribeResult> {
    const pipe = await this.ensure('stt', r.spec, false, () => {});
    return (await this.guarded('stt', () => pipe.run({ samples: r.samples, sampleRate: r.sampleRate }))) as TranscribeResult;
  }

  private async generate(r: GenerateRequest): Promise<string> {
    const pipe = await this.ensure('llm', r.spec, false, () => {});
    return (await this.guarded('llm', () => pipe.run({ prompt: r.prompt, maxTokens: r.maxTokens, temperature: r.temperature }))) as string;
  }

  /**
   * Runs a model call. If it throws (out of memory, a corrupted session), the model is dropped so the next request loads it
   * fresh instead of reusing a broken session.
   */
  private async guarded<T>(kind: MlKind, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      await this.release(kind);
      throw e;
    }
  }

  private async release(kind?: MlKind): Promise<null> {
    for (const k of kind ? [kind] : (['stt', 'llm'] as const)) {
      const s = this.slots[k];
      if (!s) continue;
      delete this.slots[k];
      try {
        await s.pipeline.dispose();
      } catch {
        /* already gone */
      }
    }
    return null;
  }
}

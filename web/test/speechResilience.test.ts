import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ML } from '../src/config/config';
import { localWorker, MlClient } from '../src/ml/client';
import { WebStt } from '../src/ml/engines';
import { createMlServices } from '../src/ml/factory';
import { FallbackLlm } from '../src/ml/fallbackLlm';
import { FakeLlm } from '../src/ml/fakes';
import { LlmTasks } from '../src/ml/llmTasks';
import { STT_MODELS } from '../src/ml/models';
import { DownloadedModels } from '../src/ml/models.state';
import type { PipelineLoader } from '../src/ml/protocol';
import { MlRuntime } from '../src/ml/runtime';
import { SttUnavailableError } from '../src/ml/types';
import { EntryPipeline } from '../src/services/entryPipeline';
import { DEFAULT_CONFIG } from '../src/config/config';
import { clip, makeStack, type Stack, stop, UnavailableStt, walk } from './stack';

const BASE = STT_MODELS[0].id;
const TINY = STT_MODELS[1].id;
const memoryModels = () => {
  const m = new Map<string, string>();
  return new DownloadedModels({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) });
};
const audio = () => ({ samples: new Float32Array(1600), sampleRate: 16000 });

/** A loader where chosen models "fail" in chosen ways, so every failure path runs through the real runtime and client. */
function world(o: { loadFails?: string[]; runFailsOnce?: string[] } = {}) {
  const loads: string[] = [];
  const runFailed = new Set<string>();
  const loader: PipelineLoader = async (_kind, opts) => {
    loads.push(opts.model);
    if (o.loadFails?.includes(opts.model)) throw new Error(`cannot allocate memory for ${opts.model}`);
    return {
      run: async () => {
        if (o.runFailsOnce?.includes(opts.model) && !runFailed.has(opts.model)) {
          runFailed.add(opts.model);
          throw new Error('session crashed (out of memory)');
        }
        return { text: `heard by ${opts.model.split('/')[1]}`, segments: [] };
      },
      dispose: async () => {},
    };
  };
  const rt = new MlRuntime(loader);
  return { client: new MlClient(localWorker((r, e) => rt.handle(r, e))), loads, rt };
}
const config = (sttModel = BASE) => ({ ...DEFAULT_ML, sttModel });

describe('speech never depends on the language model', () => {
  it('a language model that cannot load leaves speech untouched', async () => {
    const loader: PipelineLoader = async (kind) => {
      if (kind === 'llm') throw new Error('the language model needs WebGPU, which this browser does not have');
      return { run: async () => ({ text: 'spoken words', segments: [] }), dispose: async () => {} };
    };
    const rt = new MlRuntime(loader);
    const client = new MlClient(localWorker((r, e) => rt.handle(r, e)));
    const dl = memoryModels();
    dl.mark('stt', BASE);
    dl.mark('llm', 'onnx-community/gemma-3-1b-it-ONNX');
    for (const keepOneModel of [true, false]) {
      const ml = createMlServices({ config: { ...DEFAULT_CONFIG, llmMode: 'device', sttMode: 'device' }, client, downloaded: dl, fallback: new FallbackLlm(), keepOneModel });
      // The language model fails, then speech is asked: it must still work, even when memory is tight (one model at a time).
      expect(await ml.tasks.blurb({ name: 'X', tagType: '', timeOfDay: 'morning', weatherSummary: '' })).toBeTruthy(); // fell back
      expect((await ml.stt.transcribe(audio())).rawText).toBe('spoken words');
      expect(await ml.tasks.cleanup('uh hello hello')).toBe('Hello.'); // and cleanup still works too
      expect((await ml.stt.transcribe(audio())).rawText).toBe('spoken words');
    }
  });
});

describe('a speech model that fails', () => {
  it('falls back to the other downloaded speech model, and does not retry the broken one forever', async () => {
    const w = world({ loadFails: [BASE] });
    const r = await new WebStt(w.client, config(BASE), false, [TINY]).transcribe(audio());
    expect(r.rawText).toBe('heard by whisper-tiny.en');
    expect(w.loads).toEqual([BASE, TINY]);
  });

  it('also falls back when the model loads but crashes while transcribing', async () => {
    const w = world({ runFailsOnce: [BASE] });
    expect((await new WebStt(w.client, config(BASE), false, [TINY]).transcribe(audio())).rawText).toBe('heard by whisper-tiny.en');
  });

  it('a crashed model is dropped and reloaded fresh on the next request', async () => {
    const w = world({ runFailsOnce: [BASE] });
    const stt = new WebStt(w.client, config(BASE), false); // no alternates
    await expect(stt.transcribe(audio())).rejects.toThrow('out of memory');
    expect(w.rt.loaded.stt).toBeNull(); // the broken session is gone
    expect((await stt.transcribe(audio())).rawText).toBe('heard by whisper-base.en');
    expect(w.loads).toEqual([BASE, BASE]); // loaded again, not reused
  });

  it('the audio can be sent more than once (a retry needs it after the first attempt took it)', async () => {
    const w = world({ loadFails: [BASE] });
    const c = audio();
    c.samples.fill(0.5);
    await new WebStt(w.client, config(BASE), false, [TINY]).transcribe(c);
    expect(c.samples.every((v) => v === 0.5)).toBe(true);
  });

  it('when every model fails the error is reported (the note then waits or can be typed)', async () => {
    const w = world({ loadFails: [BASE, TINY] });
    await expect(new WebStt(w.client, config(BASE), false, [TINY]).transcribe(audio())).rejects.toThrow('cannot allocate memory');
  });

  it('the factory offers only models that are actually downloaded as alternates', async () => {
    const w = world({ loadFails: [BASE] });
    const only = memoryModels();
    only.mark('stt', BASE);
    expect([only.has('stt', BASE), only.has('stt', TINY)]).toEqual([true, false]);
    const noAlt = createMlServices({ config: { ...DEFAULT_CONFIG, sttMode: 'device' }, client: w.client, downloaded: only, fallback: new FallbackLlm(), keepOneModel: false });
    await expect(noAlt.stt.transcribe(audio())).rejects.toBeInstanceOf(Error);
    expect(w.loads).toEqual([BASE]); // tiny was never tried: it isn't on the phone
    const both = memoryModels();
    both.mark('stt', BASE);
    both.mark('stt', TINY);
    expect([both.has('stt', BASE), both.has('stt', TINY)]).toEqual([true, true]);
    const withAlt = createMlServices({ config: { ...DEFAULT_CONFIG, sttMode: 'device' }, client: w.client, downloaded: both, fallback: new FallbackLlm(), keepOneModel: false });
    expect((await withAlt.stt.transcribe(audio())).rawText).toBe('heard by whisper-tiny.en');
  });

  it('missing files still read as "unavailable" (the note waits for the download)', async () => {
    const loader: PipelineLoader = async () => { throw new Error('not in cache'); };
    const rt = new MlRuntime(loader);
    const client = new MlClient(localWorker((r, e) => rt.handle(r, e)));
    await expect(new WebStt(client, config(BASE), false, [TINY]).transcribe(audio())).rejects.toBeInstanceOf(SttUnavailableError);
  });
});

describe('typing a note instead', () => {
  let s: Stack;
  beforeEach(async () => {
    s = await makeStack();
    await s.repo.insertWalk(walk('w'), [stop('a')]);
  });
  afterEach(() => s.close());
  const pipe = (stt = new UnavailableStt()) => new EntryPipeline(s.repo, stt, new LlmTasks(new FakeLlm(0)), s.recordings);

  it('turns a waiting recording into a cleaned note, and frees the audio', async () => {
    const p = pipe();
    const id = await p.submitRecording({ stopId: 'a', clip: clip() });
    await p.drain();
    expect(p.stateOf(id)).toBe('waiting');
    expect(await p.submitText(id, '  um the fountain is is lovely  ')).toBe(true);
    const e = (await s.repo.getEntry(id))!;
    expect([e.rawTranscript, e.cleanedText]).toEqual(['um the fountain is is lovely', 'The fountain is lovely.']);
    expect(p.stateOf(id)).toBeUndefined();
    expect(p.waitingCount).toBe(0);
    expect(await s.recordings.ids()).toEqual([]);
  });

  it('works for a recording whose transcription failed', async () => {
    const failing = { transcribe: async () => { throw new Error('boom'); } };
    const p = pipe(failing as never);
    const id = await p.submitRecording({ stopId: 'a', clip: clip() });
    await p.drain();
    expect(p.stateOf(id)).toBe('failed');
    expect(await p.submitText(id, 'typed instead')).toBe(true);
    expect((await s.repo.getEntry(id))!.cleanedText).toBe('Typed instead.');
    expect(p.stateOf(id)).toBeUndefined();
  });

  it('refuses empty text, unknown notes, notes that already have text, and notes being worked on', async () => {
    const p = pipe();
    const id = await p.submitRecording({ stopId: 'a', clip: clip() });
    await p.drain();
    expect(await p.submitText(id, '   ')).toBe(false);
    expect(await p.submitText('nope', 'text')).toBe(false);
    expect(p.stateOf(id)).toBe('waiting'); // untouched

    await p.submitText(id, 'first');
    expect(await p.submitText(id, 'second')).toBe(false); // already has text
    expect((await s.repo.getEntry(id))!.rawTranscript).toBe('first');

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = pipe({ transcribe: async () => (await gate, { rawText: 'late', segments: [] }) } as never);
    const id2 = await slow.submitRecording({ stopId: 'a', clip: clip() });
    await new Promise((r) => setTimeout(r, 20));
    expect(slow.stateOf(id2)).toBe('transcribing');
    expect(await slow.submitText(id2, 'typed')).toBe(false); // would race the running job
    release();
    await slow.drain();
    expect((await s.repo.getEntry(id2))!.rawTranscript).toBe('late');
  });

  it('a typed note syncs like any other (it is a normal entry row)', async () => {
    const p = pipe();
    const id = await p.submitRecording({ stopId: 'a', clip: clip() });
    await p.drain();
    await p.submitText(id, 'seen from the bridge');
    const row = (await s.repo.pendingChanges()).entry.find((r) => r.id === id)!;
    expect(row).toMatchObject({ raw_transcript: 'seen from the bridge', cleaned_text: 'Seen from the bridge.' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { clearModelFiles, ModelManager } from '../src/ml/modelManager';
import { DownloadedModels } from '../src/ml/models.state';
import { localWorker, MlClient, MlRequestError } from '../src/ml/client';
import { createMlServices } from '../src/ml/factory';
import { shouldKeepOneModel, specFor, UnavailableStt, WebLlm, WebStt } from '../src/ml/engines';
import { FakeLlm, FakeStt } from '../src/ml/fakes';
import { FallbackLlm } from '../src/ml/fallbackLlm';
import { findModel, LLM_MODELS, STT_MODELS } from '../src/ml/models';
import { ProgressTracker } from '../src/ml/progress';
import type { LoadedPipeline, MlKind, PipelineLoader } from '../src/ml/protocol';
import { MlRuntime } from '../src/ml/runtime';
import { lastAssistantText, toTranscription, adaptLlm, adaptStt } from '../src/ml/transformersAdapters';
import { SttUnavailableError } from '../src/ml/types';
import { ALL_FAKES, DEFAULT_CONFIG, DEFAULT_ML } from '../src/config/config';

const STT = STT_MODELS[0];
const LLM = LLM_MODELS[0];

/** A loader double: records loads/disposes, and can be told which models are "downloaded". */
function fakeLoader(downloaded: Set<string> = new Set([STT.id, LLM.id, STT_MODELS[1].id, LLM_MODELS[1].id])) {
  const log: string[] = [];
  const disposed: string[] = [];
  const loader: PipelineLoader = async (kind, o) => {
    log.push(`${kind}:${o.model}${o.allowDownload ? ':dl' : ''}`);
    if (!downloaded.has(o.model)) {
      if (!o.allowDownload) throw new Error('not in cache');
      o.onProgress({ file: 'a.onnx', loaded: 50, total: 100 });
      o.onProgress({ file: 'a.onnx', loaded: 100, total: 100 });
      downloaded.add(o.model);
    }
    const p: LoadedPipeline = {
      run: async (input: any) =>
        kind === 'stt'
          ? { text: ` heard ${input.samples.length} `, segments: [{ startMs: 0, endMs: 500, text: 'heard' }] }
          : `answer to: ${input.prompt}`,
      dispose: async () => void disposed.push(`${kind}:${o.model}`),
    };
    return p;
  };
  return { loader, log, disposed, downloaded };
}

const setup = (o: Parameters<typeof fakeLoader>[0] = undefined) => {
  const f = fakeLoader(o);
  const runtime = new MlRuntime(f.loader);
  const client = new MlClient(localWorker((req, emit) => runtime.handle(req, emit)));
  return { ...f, runtime, client };
};
const spec = (kind: 'stt' | 'llm', exclusive = false) => specFor(kind, DEFAULT_ML, exclusive);
const clip = (n = 160) => ({ samples: new Float32Array(n), sampleRate: 16000 });

describe('runtime', () => {
  it('loads on demand, reuses a loaded model, and never downloads by itself', async () => {
    const { client, log, runtime } = setup();
    const stt = new WebStt(client, DEFAULT_ML, false);
    expect((await stt.transcribe(clip())).rawText).toBe('heard 160');
    await stt.transcribe(clip());
    expect(log).toEqual([`stt:${STT.id}`]); // loaded once
    expect(runtime.loaded).toEqual({ stt: STT.id, llm: null });
  });

  it('a model that is not downloaded is "unavailable", and nothing is downloaded', async () => {
    const { client, log } = setup(new Set());
    await expect(new WebStt(client, DEFAULT_ML, false).transcribe(clip())).rejects.toBeInstanceOf(SttUnavailableError);
    expect(log).toEqual([`stt:${STT.id}`]); // one local-only attempt, no ":dl"
    await expect(new WebLlm(client, DEFAULT_ML, false).generate('TASK: blurb\nx')).rejects.toBeInstanceOf(MlRequestError);
  });

  it('exclusive mode keeps one model in memory at a time and reloads from the cache as needed', async () => {
    const { client, disposed, runtime } = setup();
    const stt = new WebStt(client, DEFAULT_ML, true);
    const llm = new WebLlm(client, DEFAULT_ML, true);
    await stt.transcribe(clip());
    expect(runtime.loaded).toEqual({ stt: STT.id, llm: null });
    await llm.generate('TASK: blurb\nx');
    expect(runtime.loaded).toEqual({ stt: null, llm: LLM.id });
    expect(disposed).toEqual([`stt:${STT.id}`]);
    await stt.transcribe(clip());
    expect(runtime.loaded).toEqual({ stt: STT.id, llm: null });
  });

  it('non-exclusive mode keeps both loaded', async () => {
    const { client, disposed, runtime } = setup();
    await new WebStt(client, DEFAULT_ML, false).transcribe(clip());
    await new WebLlm(client, DEFAULT_ML, false).generate('TASK: blurb\nx');
    expect(runtime.loaded).toEqual({ stt: STT.id, llm: LLM.id });
    expect(disposed).toEqual([]);
  });

  it('interleaved requests from both engines cannot unload each other mid-request', async () => {
    const { client } = setup();
    const stt = new WebStt(client, DEFAULT_ML, true);
    const llm = new WebLlm(client, DEFAULT_ML, true);
    const results = await Promise.all([
      stt.transcribe(clip(1)), llm.generate('TASK: blurb\na'), stt.transcribe(clip(2)), llm.generate('TASK: blurb\nb'),
    ]);
    expect([results[0], results[2]].map((r) => (r as any).rawText)).toEqual(['heard 1', 'heard 2']);
    expect([results[1], results[3]]).toEqual(['answer to: TASK: blurb\na', 'answer to: TASK: blurb\nb']);
  });

  it('switching to another model of the same kind unloads the old one', async () => {
    const { client, disposed, runtime } = setup();
    await new WebStt(client, DEFAULT_ML, false).transcribe(clip());
    await new WebStt(client, { ...DEFAULT_ML, sttModel: STT_MODELS[1].id }, false).transcribe(clip());
    expect(runtime.loaded.stt).toBe(STT_MODELS[1].id);
    expect(disposed).toEqual([`stt:${STT.id}`]);
  });

  it('picks max tokens from the task and passes the temperature', async () => {
    const seen: any[] = [];
    const loader: PipelineLoader = async () => ({ run: async (i) => (seen.push(i), 'ok'), dispose: async () => {} });
    const client = new MlClient(localWorker((r, e) => new MlRuntime(loader).handle(r, e)));
    const llm = new WebLlm(client, DEFAULT_ML, false);
    await llm.generate('TASK: cleanup\nx');
    await llm.generate('TASK: blurb\nx');
    expect(seen.map((s) => s.maxTokens)).toEqual([DEFAULT_ML.cleanupMaxTokens, DEFAULT_ML.blurbMaxTokens]);
    expect(seen[0].temperature).toBe(DEFAULT_ML.temperature);
  });

  it('requests run one at a time, in order', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const loader: PipelineLoader = async () => ({
      run: async (i: any) => {
        order.push(`start ${i.prompt}`);
        if (i.prompt === 'first') await gate;
        order.push(`end ${i.prompt}`);
        return 'ok';
      },
      dispose: async () => {},
    });
    const rt = new MlRuntime(loader);
    const client = new MlClient(localWorker((r, e) => rt.handle(r, e)));
    const llm = new WebLlm(client, DEFAULT_ML, false);
    const a = llm.generate('first');
    const b = llm.generate('second');
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start first']); // the second waits its turn
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['start first', 'end first', 'start second', 'end second']);
  });

  it('a failing model run is reported, and the next request still works', async () => {
    let fail = true;
    const loader: PipelineLoader = async () => ({
      run: async () => {
        if (fail) throw new Error('out of memory');
        return 'fine';
      },
      dispose: async () => {},
    });
    const rt = new MlRuntime(loader);
    const llm = new WebLlm(new MlClient(localWorker((r, e) => rt.handle(r, e))), DEFAULT_ML, false);
    await expect(llm.generate('x')).rejects.toThrow('out of memory');
    fail = false;
    expect(await llm.generate('x')).toBe('fine');
  });

  it('releases one kind or everything, and tolerates a model that fails to dispose', async () => {
    const loader: PipelineLoader = async () => ({ run: async () => 'x', dispose: async () => { throw new Error('gone'); } });
    const rt = new MlRuntime(loader);
    const client = new MlClient(localWorker((r, e) => rt.handle(r, e)));
    await client.call({ op: 'load', kind: 'stt', spec: spec('stt'), allowDownload: false });
    await client.call({ op: 'load', kind: 'llm', spec: spec('llm'), allowDownload: false });
    await client.call({ op: 'release', kind: 'stt' });
    expect(rt.loaded).toEqual({ stt: null, llm: LLM.id });
    await client.call({ op: 'release' });
    expect(rt.loaded).toEqual({ stt: null, llm: null });
  });
});

describe('client', () => {
  it('a crashed worker fails waiting requests and later ones, with a clear message', async () => {
    const w = { onmessage: null, onerror: null as any, postMessage: () => {}, terminate: () => {} };
    const c = new MlClient(w as any);
    const waiting = c.call({ op: 'release' });
    w.onerror({ message: 'boom' });
    await expect(waiting).rejects.toThrow('boom');
    await expect(c.call({ op: 'release' })).rejects.toThrow(/not running/);
  });

  it('terminate stops everything', async () => {
    const terminate = vi.fn();
    const c = new MlClient({ onmessage: null, postMessage: () => {}, terminate });
    const waiting = c.call({ op: 'release' });
    c.terminate();
    await expect(waiting).rejects.toThrow(/stopped/);
    expect(terminate).toHaveBeenCalled();
  });

  it('ignores replies for requests it does not know', () => {
    const w = { onmessage: null as any, postMessage: () => {}, terminate: () => {} };
    new MlClient(w as any);
    expect(() => w.onmessage({ data: { id: 999, ok: true, result: 1 } })).not.toThrow();
  });
});

describe('download manager', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  const manager = (o: Parameters<typeof fakeLoader>[0] = new Set()) => {
    const s = setup(o);
    const downloaded = new DownloadedModels(memory());
    const cleared: string[] = [];
    const m = new ModelManager(() => s.client, downloaded, () => DEFAULT_ML, async (id) => (cleared.push(id), 1));
    return { ...s, m, downloaded, cleared };
  };

  it('downloads with progress, remembers it, and unloads again', async () => {
    const { m, downloaded, runtime, log } = manager();
    expect(m.status(LLM)).toEqual({ state: 'absent' });
    const seen: string[] = [];
    m.subscribe(() => seen.push(m.status(LLM).state));
    await m.download(LLM);
    expect(log).toEqual([`llm:${LLM.id}:dl`]);
    expect(seen).toContain('downloading');
    expect(m.status(LLM)).toEqual({ state: 'ready' });
    expect(downloaded.has('llm', LLM.id)).toBe(true);
    expect(runtime.loaded.llm).toBeNull(); // memory is freed until it is needed
  });

  it('reports fractions while downloading', async () => {
    const { m } = manager();
    const fractions: number[] = [];
    m.subscribe(() => {
      const s = m.status(STT);
      if (s.state === 'downloading') fractions.push(s.fraction);
    });
    await m.download(STT);
    expect(fractions).toEqual(expect.arrayContaining([0, 0.5, 1]));
  });

  it('concurrent downloads of one model share a single download', async () => {
    const { m, log } = manager();
    await Promise.all([m.download(LLM), m.download(LLM)]);
    expect(log).toEqual([`llm:${LLM.id}:dl`]);
  });

  it('a failed download shows the error and can be retried', async () => {
    let failing = true;
    const loader: PipelineLoader = async (_k, o) => {
      if (failing) throw new Error('network down');
      o.onProgress({ file: 'f', loaded: 1, total: 1 });
      return { run: async () => '', dispose: async () => {} };
    };
    const rt = new MlRuntime(loader);
    const m = new ModelManager(() => new MlClient(localWorker((r, e) => rt.handle(r, e))), new DownloadedModels(memory()), () => DEFAULT_ML);
    await expect(m.download(STT)).rejects.toThrow('network down');
    expect(m.status(STT)).toEqual({ state: 'error', message: 'network down' });
    failing = false;
    await m.download(STT);
    expect(m.status(STT)).toEqual({ state: 'ready' });
  });

  it('removes a model: unloads it, deletes its files, forgets it', async () => {
    const { m, downloaded, cleared } = manager();
    await m.download(STT);
    await m.remove(STT);
    expect(cleared).toEqual([STT.id]);
    expect(downloaded.has('stt', STT.id)).toBe(false);
    expect(m.status(STT)).toEqual({ state: 'absent' });
  });

  it('clears only the model\'s files from Cache Storage', async () => {
    const urls = [
      `https://huggingface.co/${STT.id}/resolve/main/onnx/encoder.onnx`,
      `https://huggingface.co/${STT.id}/resolve/main/config.json`,
      `https://huggingface.co/${LLM.id}/resolve/main/onnx/model.onnx`,
    ];
    const kept = new Set(urls);
    const cache = {
      keys: async () => [...kept].map((u) => ({ url: u }) as Request),
      delete: async (r: Request) => kept.delete(r.url),
    };
    const n = await clearModelFiles(STT.id, { open: async () => cache as unknown as Cache });
    expect([n, [...kept]]).toEqual([2, [urls[2]]]);
    expect(await clearModelFiles(STT.id, undefined)).toBe(0);
  });

  it('remembers downloads across sessions, and survives broken storage', () => {
    const store = memory();
    new DownloadedModels(store).mark('stt', STT.id);
    expect(new DownloadedModels(store).has('stt', STT.id)).toBe(true);
    expect(new DownloadedModels(store).has('llm', STT.id)).toBe(false);
    expect(new DownloadedModels({ getItem: () => 'garbage', setItem: () => { throw new Error('full'); } }).has('stt', STT.id)).toBe(false);
    expect(() => new DownloadedModels(null).mark('stt', STT.id)).not.toThrow();
  });
});

describe('progress', () => {
  it('combines files into one fraction and never exceeds 1', () => {
    const t = new ProgressTracker();
    expect(t.fraction).toBe(0);
    t.update({ file: 'a', loaded: 50, total: 100 });
    expect(t.update({ file: 'b', loaded: 0, total: 100 })).toBe(0.25);
    expect(t.update({ file: 'a', loaded: 100, total: 100 })).toBe(0.5);
    expect(t.update({ file: 'b', loaded: 999, total: 100 })).toBe(1);
    expect(t.bytesLoaded).toBe(200);
    t.reset();
    expect(t.fraction).toBe(0);
  });
});

describe('transformers.js output mapping (shapes seen from the real library)', () => {
  it('maps a Whisper result to text and millisecond segments', () => {
    const r = toTranscription({
      text: ' And so my fellow Americans ask not what your country can do for you ask what you can do for your country.',
      chunks: [
        { timestamp: [0, 7.74], text: ' And so my fellow Americans ask not what your country can do for you' },
        { timestamp: [7.74, 10.64], text: ' ask what you can do for your country.' },
        { timestamp: [10.64, null], text: ' tail' },
      ],
    });
    expect(r.text.startsWith('And so my fellow Americans')).toBe(true);
    expect(r.segments.map((s) => [s.startMs, s.endMs])).toEqual([[0, 7740], [7740, 10640], [10640, 10640]]);
    expect(r.segments[0].text).toBe('And so my fellow Americans ask not what your country can do for you');
    expect(toTranscription({})).toEqual({ text: '', segments: [] });
  });

  it('takes the assistant reply from chat output', () => {
    const out = [{ generated_text: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }];
    expect(lastAssistantText(out)).toBe('hello');
    expect(lastAssistantText([{ generated_text: 'plain' }])).toBe('plain');
    expect(() => lastAssistantText([{ generated_text: [{ role: 'user', content: 'hi' }] }])).toThrow(/nothing/);
    expect(() => lastAssistantText([])).toThrow();
  });

  it('adapters call the pipelines the way transformers.js expects', async () => {
    const asr = vi.fn(async () => ({ text: ' hi ', chunks: [] }));
    const sttPipe: any = Object.assign(asr, { dispose: vi.fn(async () => {}) });
    const samples = new Float32Array(3);
    expect(await adaptStt(sttPipe).run({ samples })).toEqual({ text: 'hi', segments: [] });
    expect(asr).toHaveBeenCalledWith(samples, { chunk_length_s: 30, return_timestamps: true });

    const gen = vi.fn(async () => [{ generated_text: [{ role: 'assistant', content: 'ok' }] }]);
    const llmPipe: any = Object.assign(gen, { dispose: vi.fn(async () => {}) });
    expect(await adaptLlm(llmPipe).run({ prompt: 'p', maxTokens: 9, temperature: 0.3 })).toBe('ok');
    expect(gen).toHaveBeenCalledWith([{ role: 'user', content: 'p' }], { max_new_tokens: 9, do_sample: true, temperature: 0.3 });
    await adaptLlm(llmPipe).run({ prompt: 'p', maxTokens: 9, temperature: 0 });
    expect((gen.mock.calls[1] as any)[1]).toEqual({ max_new_tokens: 9, do_sample: false });
    await adaptLlm(llmPipe).dispose();
    expect(llmPipe.dispose).toHaveBeenCalled();
  });
});

describe('engine factory', () => {
  const fallback = new FallbackLlm();
  const memory = () => {
    const m = new Map<string, string>();
    return new DownloadedModels({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) });
  };
  const client = () => setup().client;
  const make = (config = DEFAULT_CONFIG, downloaded = memory(), c: MlClient | null = client()) =>
    createMlServices({ config, client: c, downloaded, fallback, keepOneModel: false });

  it('auto without downloads: pre-written text, and voice notes wait for the model (no fake transcripts)', () => {
    const s = make();
    expect([s.llmKind, s.sttKind]).toEqual(['fallback', 'unavailable']);
    expect(s.llm).toBe(fallback);
    expect(s.stt).toBeInstanceOf(UnavailableStt);
  });

  it('auto with downloaded models: on-device, with the pre-written text as the backup', () => {
    const dl = memory();
    dl.mark('llm', LLM.id);
    dl.mark('stt', STT.id);
    const s = make(DEFAULT_CONFIG, dl);
    expect([s.llmKind, s.sttKind]).toEqual(['device', 'device']);
    expect(s.llm).toBeInstanceOf(WebLlm);
    expect(s.stt).toBeInstanceOf(WebStt);
  });

  it('device mode is on-device even before the download (it then reports unavailable instead of downloading)', () => {
    const s = make({ ...DEFAULT_CONFIG, llmMode: 'device', sttMode: 'device' });
    expect([s.llmKind, s.sttKind]).toEqual(['device', 'device']);
  });

  it('fallback and fake modes', () => {
    expect(make({ ...DEFAULT_CONFIG, llmMode: 'fallback' }).llmKind).toBe('fallback');
    const f = make(ALL_FAKES);
    expect([f.llmKind, f.sttKind]).toEqual(['fake', 'fake']);
    expect(f.llm).toBeInstanceOf(FakeLlm);
    expect(f.stt).toBeInstanceOf(FakeStt);
  });

  it('without a model worker only fakes and fallbacks are possible', () => {
    const dl = memory();
    dl.mark('llm', LLM.id);
    dl.mark('stt', STT.id);
    const s = make({ ...DEFAULT_CONFIG, llmMode: 'device', sttMode: 'device' }, dl, null);
    expect([s.llmKind, s.sttKind]).toEqual(['fallback', 'unavailable']);
  });

  it('tasks work end to end through the fallback when nothing is downloaded', async () => {
    const s = make();
    expect(await s.tasks.cleanup('um hello hello there')).toBe('Hello there.');
    expect(await s.tasks.blurb({ name: 'X', tagType: '', timeOfDay: 'morning', weatherSummary: '' })).toContain('X');
  });

  it('warmUp only touches the on-device engines', async () => {
    const calls: string[] = [];
    const loader: PipelineLoader = async (k: MlKind) => (calls.push(k), { run: async () => '', dispose: async () => {} });
    const rt = new MlRuntime(loader);
    const c = new MlClient(localWorker((r, e) => rt.handle(r, e)));
    const dl = memory();
    dl.mark('llm', LLM.id);
    dl.mark('stt', STT.id);
    createMlServices({ config: DEFAULT_CONFIG, client: c, downloaded: dl, fallback, keepOneModel: false }).warmUp();
    await vi.waitFor(() => expect(calls.sort()).toEqual(['llm', 'stt']));
    calls.length = 0;
    make(ALL_FAKES).warmUp();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
  });

  it('the memory policy: small phones keep one model at a time', () => {
    expect(shouldKeepOneModel({ deviceMemory: 2 })).toBe(true);
    expect(shouldKeepOneModel({ deviceMemory: 4 })).toBe(true);
    expect(shouldKeepOneModel({ deviceMemory: 8 })).toBe(false);
    expect(shouldKeepOneModel({})).toBe(true);
  });

  it('knows its models and refuses unknown ones', () => {
    expect(findModel('stt', STT.id)).toBe(STT);
    expect(findModel('llm', STT.id)).toBeUndefined();
    expect(() => specFor('llm', { ...DEFAULT_ML, llmModel: 'nope/model' }, false)).toThrow(/unknown llm model/);
  });
});

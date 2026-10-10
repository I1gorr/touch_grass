import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLlm, FakeStt } from '../src/ml/fakes';
import { LlmTasks } from '../src/ml/llmTasks';
import { EntryPipeline } from '../src/services/entryPipeline';
import { clip, CountingStt, HangingStt, makeStack, type Stack, stop, UnavailableStt, walk } from './stack';

let s: Stack;
beforeEach(async () => {
  s = await makeStack();
  await s.repo.insertWalk(walk('w'), [stop('s')]);
});
afterEach(() => s.close());

const pipeline = (stt: ConstructorParameters<typeof EntryPipeline>[1], repo = s.repo) =>
  new EntryPipeline(repo, stt, new LlmTasks(new FakeLlm(0)), s.recordings);

describe('entry pipeline', () => {
  it('records -> transcribes -> cleans, and leaves no job state or audio behind', async () => {
    const p = pipeline(new CountingStt());
    const id = await p.submitRecording({ stopId: 's', clip: clip() });
    expect(await s.recordings.ids()).toEqual([id]); // audio is stored before processing
    expect((await s.repo.getEntry(id))!.rawTranscript).toBeNull(); // the row exists at once
    await p.drain();
    const e = (await s.repo.getEntry(id))!;
    expect([e.rawTranscript, e.cleanedText]).toEqual(['um so the light is nice', 'So the light is nice.']);
    expect(p.stateOf(id)).toBeUndefined();
    expect(await s.recordings.ids()).toEqual([]);
  });

  it('shows progress while it works', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = pipeline({ transcribe: async () => (await gate, { rawText: 'hi', segments: [] }) });
    const seen: (string | undefined)[] = [];
    let id = '';
    p.subscribe(() => seen.push(p.stateOf(id)));
    id = await p.submitRecording({ stopId: 's', clip: clip() });
    await vi.waitFor(() => expect(p.stateOf(id)).toBe('transcribing'));
    expect(p.busy).toBe(true);
    release();
    await p.drain();
    expect(seen).toContain('transcribing');
    expect(seen).toContain('cleaning');
    expect(p.busy).toBe(false);
  });

  it('missing audio -> failed with a clear error, no crash', async () => {
    const p = pipeline(new CountingStt());
    vi.spyOn(s.recordings, 'get').mockResolvedValue(null); // e.g. storage was cleared under us
    const id = await p.submitRecording({ stopId: 's', clip: clip() });
    await p.drain();
    expect(p.stateOf(id)).toBe('failed');
    expect(String(p.errorOf(id))).toContain('missing');
    expect(p.busy).toBe(false);
  });

  it('the transcript is saved BEFORE the audio is deleted; if saving fails the audio is kept', async () => {
    const p = pipeline(new CountingStt());
    const spy = vi.spyOn(s.repo, 'updateEntry').mockRejectedValueOnce(new Error('disk full (raw)'));
    const id = await p.submitRecording({ stopId: 's', clip: clip() });
    await p.drain();
    expect(p.stateOf(id)).toBe('failed');
    expect(await s.recordings.ids()).toEqual([id]); // the audio is the only copy of the entry
    expect((await s.repo.getEntry(id))!.rawTranscript).toBeNull();

    spy.mockRestore();
    await p.retry(id);
    expect(p.stateOf(id)).toBeUndefined();
    expect(await s.recordings.ids()).toEqual([]);
  });

  it('cleanup-save failure -> retry only re-runs cleanup, not speech recognition', async () => {
    const stt = new CountingStt();
    const p = pipeline(stt);
    const real = s.repo.updateEntry.bind(s.repo);
    let failClean = 1;
    vi.spyOn(s.repo, 'updateEntry').mockImplementation(async (id, f) => {
      if (f.cleanedText !== undefined && failClean-- > 0) throw new Error('disk full (clean)');
      return real(id, f);
    });
    const id = await p.submitRecording({ stopId: 's', clip: clip() });
    await p.drain();
    expect(p.stateOf(id)).toBe('failed');
    expect((await s.repo.getEntry(id))!.rawTranscript).not.toBeNull();

    await p.retry(id);
    expect(stt.calls).toBe(1);
    expect((await s.repo.getEntry(id))!.cleanedText).toBeTruthy();
  });

  it('a speech error leaves the audio for a retry', async () => {
    const stt = new CountingStt(1);
    const p = pipeline(stt);
    const id = await p.submitRecording({ stopId: 's', clip: clip() });
    await p.drain();
    expect(p.stateOf(id)).toBe('failed');
    expect(String(p.errorOf(id))).toContain('stt failure');
    expect(await s.recordings.ids()).toEqual([id]);
    await p.retry(id);
    expect(p.stateOf(id)).toBeUndefined();
    expect((await s.repo.getEntry(id))!.cleanedText).toBeTruthy();
  });

  it('retry on unknown / healthy entries is a no-op', async () => {
    const stt = new CountingStt();
    const p = pipeline(stt);
    await p.retry('does-not-exist');
    const id = await p.submitRecording({ stopId: 's', clip: clip() });
    await p.drain();
    await p.retry(id);
    expect(stt.calls).toBe(1);
  });

  it('many quick recordings all complete and leave no job state', async () => {
    const p = pipeline(new CountingStt());
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await p.submitRecording({ stopId: 's', clip: clip() }));
    await p.drain();
    expect(ids.map((i) => p.stateOf(i))).toEqual(new Array(5).fill(undefined));
    expect(p.busy).toBe(false);
    expect((await s.repo.entriesForStop('s')).filter((e) => e.cleanedText !== null)).toHaveLength(5);
  });

  it('silence (empty transcript) is saved as empty, not an error', async () => {
    const p = pipeline(new FakeStt('', 0));
    const id = await p.submitRecording({ stopId: 's', clip: clip() });
    await p.drain();
    expect(p.stateOf(id)).toBeUndefined();
    const e = (await s.repo.getEntry(id))!;
    expect([e.rawTranscript, e.cleanedText]).toEqual(['', '']);
  });

  it('app killed mid-transcription -> recoverPending finishes the entry', async () => {
    const dying = pipeline(new HangingStt());
    const id = await dying.submitRecording({ stopId: 's', clip: clip() });
    expect(await s.recordings.ids()).toEqual([id]);

    const fresh = pipeline(new CountingStt());
    expect(await fresh.recoverPending()).toEqual([id]);
    await fresh.drain();
    expect((await s.repo.getEntry(id))!.cleanedText).toBeTruthy();
    expect(await s.recordings.ids()).toEqual([]);
  });

  it('recoverPending ignores orphan audio, cleans up finished entries, and does not double-run', async () => {
    await s.recordings.put('orphan', clip(10));
    const p = pipeline(new CountingStt());
    const done = await p.submitRecording({ stopId: 's', clip: clip() });
    await p.drain();
    await s.recordings.put(done, clip(10)); // a leftover whose transcript is already stored
    expect(await p.recoverPending()).toEqual([]);
    expect(await s.recordings.ids()).toEqual(['orphan']); // unknown audio is never deleted
    expect(await p.recoverPending()).toEqual([]);
  });

  it('a failed entry insert does not leave orphan audio behind', async () => {
    const p = pipeline(new CountingStt());
    vi.spyOn(s.repo, 'insertEntry').mockRejectedValueOnce(new Error('db down'));
    await expect(p.submitRecording({ stopId: 's', clip: clip() })).rejects.toThrow('db down');
    expect(await s.recordings.ids()).toEqual([]);
  });
});

describe('speech model not available yet', () => {
  it('keeps the audio and waits, then resumes once the model is there', async () => {
    const stt = new UnavailableStt();
    const p = pipeline(stt);
    const id = await p.submitRecording({ stopId: 's', clip: clip() });
    await p.drain();
    expect(p.stateOf(id)).toBe('waiting');
    expect(p.waitingCount).toBe(1);
    expect(p.busy).toBe(false);
    expect(await s.recordings.ids()).toEqual([id]);
    expect((await s.repo.getEntry(id))!.rawTranscript).toBeNull();

    stt.available = true;
    expect(await p.recoverPending()).toEqual([id]);
    await p.drain();
    expect(p.stateOf(id)).toBeUndefined();
    expect(p.waitingCount).toBe(0);
    expect((await s.repo.getEntry(id))!.rawTranscript).toBe('hello there');
    expect(await s.recordings.ids()).toEqual([]);
  });

  it('can be retried by hand, or finished after swapping the engines', async () => {
    const p = pipeline(new UnavailableStt());
    const id = await p.submitRecording({ stopId: 's', clip: clip() });
    await p.drain();
    expect(p.stateOf(id)).toBe('waiting');
    p.setEngines(new CountingStt(0, 'hello again'), new LlmTasks(new FakeLlm(0)));
    await p.retry(id);
    expect((await s.repo.getEntry(id))!.rawTranscript).toBe('hello again');
  });
});

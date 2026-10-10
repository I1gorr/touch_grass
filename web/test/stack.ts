import 'fake-indexeddb/auto';
import { vi } from 'vitest';
import { RecordingStore } from '../src/db/recordingStore';
import { openTgDb, type TgDb } from '../src/db/schema';
import { WalkRepo } from '../src/db/walkRepo';
import { type CapturedPhoto, type PhotoCapture, validatePhoto } from '../src/media/camera';
import { FakeRecorder, type VoiceRecorder } from '../src/media/recorder';
import { newStop, type Walk } from '../src/models/types';
import { FakeLlm, FakeStt } from '../src/ml/fakes';
import { LlmTasks } from '../src/ml/llmTasks';
import { type AudioClip, SttUnavailableError, type Stt, type Transcription } from '../src/ml/types';
import { EntryPipeline } from '../src/services/entryPipeline';

let n = 0;

export interface Stack {
  db: TgDb;
  repo: WalkRepo;
  recordings: RecordingStore;
  pipeline: EntryPipeline;
  close(): void;
}

/** A repo + recording store + pipeline on a fresh in-memory IndexedDB, with fake speech and language engines. */
export async function makeStack(o: { stt?: Stt; name?: string } = {}): Promise<Stack> {
  const name = o.name ?? `stack-${++n}`;
  const repo = await WalkRepo.open({ name });
  const db = repo.db;
  const recordings = new RecordingStore(db);
  const pipeline = new EntryPipeline(repo, o.stt ?? new FakeStt('um so the light here is really nice', 0), new LlmTasks(new FakeLlm(0)), recordings);
  return { db, repo, recordings, pipeline, close: () => repo.close() };
}

export const walk = (id: string): Walk => ({
  id, createdAt: 1, startLat: 0, startLng: 0, timeOfDay: 'morning', weatherSummary: '', status: 'ready', routeJson: null,
});
export const stop = (id: string) => newStop({ id, osmId: `node/${id}`, name: `Place ${id}`, lat: 51.5, lng: -0.1 });

export const clip = (ms = 100): AudioClip => ({ samples: new Float32Array(16 * ms), sampleRate: 16000 });

/** Counts calls; fails the first `failTimes` calls. */
export class CountingStt implements Stt {
  calls = 0;
  constructor(private readonly failTimes = 0, private readonly text = 'um so the light is nice') {}
  async transcribe(_c: AudioClip): Promise<Transcription> {
    if (this.calls++ < this.failTimes) throw new Error(`stt failure #${this.calls}`);
    return { rawText: this.text, segments: [] };
  }
}

/** Speech engine whose model is not available (yet). */
export class UnavailableStt implements Stt {
  available = false;
  calls = 0;
  async transcribe(_c: AudioClip): Promise<Transcription> {
    this.calls++;
    if (!this.available) throw new SttUnavailableError('model not downloaded');
    return { rawText: 'hello there', segments: [] };
  }
}

/** Never completes, like a process killed mid-call. */
export class HangingStt implements Stt {
  transcribe(): Promise<Transcription> {
    return new Promise(() => {});
  }
}

export class ScriptedRecorder implements VoiceRecorder {
  stops = 0;
  private readonly inner = new FakeRecorder();
  constructor(public permission = true, public throwOnStart = false) {}
  async ensurePermission() {
    return this.permission;
  }
  async start() {
    if (this.throwOnStart) throw new Error('mic busy');
    await this.inner.start();
  }
  async stop() {
    this.stops++;
    return this.inner.stop();
  }
  async dispose() {}
}

/** Recorder whose start() waits until released, to hit the "mic starting" gap. */
export class SlowStartRecorder extends ScriptedRecorder {
  release!: () => void;
  private readonly gate = new Promise<void>((r) => (this.release = r));
  override async start() {
    await this.gate;
    await super.start();
  }
}

export class CancelledPhoto implements PhotoCapture {
  async capture(): Promise<CapturedPhoto | null> {
    return null;
  }
}

/** A camera that returns arbitrary bytes, run through the real validation. */
export class BytesPhoto implements PhotoCapture {
  constructor(private readonly bytes: Uint8Array | number[]) {}
  async capture(): Promise<CapturedPhoto | null> {
    return validatePhoto(Uint8Array.from(this.bytes));
  }
}

/** Builds a minimal PNG: signature + chunks (CRCs zeroed; nothing here checks them). */
export function pngBytes(o: { animated?: boolean; idatLen?: number } = {}): number[] {
  const chunk = (type: string, len: number) => [
    (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...new Array<number>(len + 4).fill(0),
  ];
  return [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', 13),
    ...(o.animated ? chunk('acTL', 8) : []),
    ...chunk('IDAT', o.idatLen ?? 4),
    ...chunk('IEND', 0),
  ];
}

export { vi };

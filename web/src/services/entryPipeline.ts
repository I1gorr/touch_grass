import type { RecordingStore } from '../db/recordingStore';
import type { WalkRepo } from '../db/walkRepo';
import { newEntry } from '../models/types';
import type { LlmTasks } from '../ml/llmTasks';
import { type AudioClip, SttUnavailableError, type Stt } from '../ml/types';
import { newId } from '../util/ids';
import { Emitter } from '../util/emitter';

/** `waiting`: the speech model isn't available yet; the audio is kept and resumes when it is. */
export type EntryJobState = 'transcribing' | 'cleaning' | 'failed' | 'waiting';

/**
 * record -> store audio -> entry row -> transcribe (raw saved before the audio is deleted) -> clean -> cleaned
 * text saved. Runs in the background; listen for per-entry state.
 */
export class EntryPipeline {
  private readonly emitter = new Emitter();
  private readonly state = new Map<string, EntryJobState>();
  private readonly errors = new Map<string, unknown>();
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly repo: WalkRepo,
    private stt: Stt,
    private tasks: LlmTasks,
    private readonly recordings: RecordingStore,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Swaps the engines (e.g. after the on-device models finish downloading). */
  setEngines(stt: Stt, tasks: LlmTasks): void {
    this.stt = stt;
    this.tasks = tasks;
  }

  subscribe(fn: () => void): () => void {
    return this.emitter.subscribe(fn);
  }

  stateOf(entryId: string): EntryJobState | undefined {
    return this.state.get(entryId);
  }

  errorOf(entryId: string): unknown {
    return this.errors.get(entryId);
  }

  /** True while anything is being worked on (jobs waiting for a model or failed don't count). */
  get busy(): boolean {
    return [...this.state.values()].some((s) => s === 'transcribing' || s === 'cleaning');
  }

  /** How many notes are waiting for the speech model. */
  get waitingCount(): number {
    return [...this.state.values()].filter((s) => s === 'waiting').length;
  }

  /**
   * Stores the audio, creates the entry row at once and processes the audio in the background. The audio is
   * saved under the entry id, so `recoverPending` can match it to its entry after an app restart.
   */
  async submitRecording(o: { stopId: string; clip: AudioClip }): Promise<string> {
    const id = newId();
    await this.recordings.put(id, o.clip);
    try {
      await this.repo.insertEntry(newEntry({ id, stopId: o.stopId, recordedAt: this.clock() }));
    } catch (e) {
      await this.recordings.delete(id).catch(() => undefined); // no entry will ever own this audio
      throw e;
    }
    this.track(this.process(id));
    return id;
  }

  /**
   * Resumes entries whose audio survived an app kill (or a missing model): every stored recording whose entry has
   * no raw transcript yet is reprocessed. Audio whose transcript is already saved is cleaned up; audio with no
   * entry is left alone. Returns the resumed entry ids.
   */
  async recoverPending(): Promise<string[]> {
    const resumed: string[] = [];
    for (const id of await this.recordings.ids()) {
      const s = this.state.get(id);
      if (s === 'transcribing' || s === 'cleaning') continue;
      const entry = await this.repo.getEntry(id);
      if (!entry) continue;
      if (entry.rawTranscript !== null) {
        await this.recordings.delete(id).catch(() => undefined); // a leftover: the transcript is safely stored
        continue;
      }
      this.track(this.process(id));
      resumed.push(id);
    }
    return resumed;
  }

  /** Retries a failed (or waiting) job from where it stopped (transcription or cleanup). */
  async retry(entryId: string): Promise<void> {
    const s = this.state.get(entryId);
    if (s !== 'failed' && s !== 'waiting') return;
    const p = this.process(entryId);
    this.track(p);
    await p;
  }

  /**
   * The person typed the note instead of waiting for (or retrying) speech recognition. Works for any note that has no
   * transcript yet and isn't being transcribed right now. Returns false if it wasn't applied.
   */
  async submitText(entryId: string, text: string): Promise<boolean> {
    const t = text.trim();
    const s = this.state.get(entryId);
    if (t === '' || s === 'transcribing' || s === 'cleaning') return false;
    const entry = await this.repo.getEntry(entryId);
    if (!entry || entry.rawTranscript !== null) return false;
    await this.repo.updateEntry(entryId, { rawTranscript: t });
    await this.recordings.delete(entryId).catch(() => undefined); // the words are saved; the audio is no longer needed
    this.set(entryId, null);
    const p = this.process(entryId); // cleans it up like any other note
    this.track(p);
    await p;
    return true;
  }

  /** Waits for all in-flight jobs (tests, app shutdown). */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private track(p: Promise<void>): void {
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
  }

  private set(id: string, s: EntryJobState | null, error?: unknown): void {
    if (s === null) this.state.delete(id);
    else this.state.set(id, s);
    if (error !== undefined) this.errors.set(id, error);
    else this.errors.delete(id);
    this.emitter.emit();
  }

  private async process(id: string): Promise<void> {
    try {
      let raw = (await this.repo.getEntry(id))?.rawTranscript ?? null;
      if (raw === null) {
        const clip = await this.recordings.get(id);
        if (!clip) throw new Error(`audio for entry ${id} is missing`);
        this.set(id, 'transcribing');
        const t = await this.stt.transcribe(clip);
        // Save the transcript, and only then delete the audio.
        await this.repo.updateEntry(id, { rawTranscript: t.rawText });
        await this.recordings.delete(id);
        raw = t.rawText;
      }
      this.set(id, 'cleaning');
      await this.repo.updateEntry(id, { cleanedText: await this.tasks.cleanup(raw) });
      this.set(id, null);
    } catch (e) {
      if (e instanceof SttUnavailableError) {
        this.set(id, 'waiting', e); // keep the audio; resumes when a model is available
      } else {
        console.warn(`[pipeline] entry ${id} failed:`, e);
        this.set(id, 'failed', e);
      }
    }
  }
}

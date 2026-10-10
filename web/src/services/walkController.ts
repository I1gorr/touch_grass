import type { WalkRepo } from '../db/walkRepo';
import { type CapturedPhoto, InvalidPhoto, type PhotoCapture } from '../media/camera';
import type { VoiceRecorder } from '../media/recorder';
import { type Entry, newEntry, type Stop, samePhotoStamp, type Walk, type WalkPhoto } from '../models/types';
import { Emitter } from '../util/emitter';
import { newId } from '../util/ids';
import type { EntryPipeline } from './entryPipeline';

export interface WalkControllerDeps {
  walkId: string;
  repo: WalkRepo;
  pipeline: EntryPipeline;
  recorder: VoiceRecorder;
  photos: PhotoCapture;
  clock?: () => number;
}

/** State + actions for one walk session. UI-free so it can be tested with fakes. */
export class WalkController {
  walk: Walk | null = null;
  stops: Stop[] = [];
  index = 0;
  entries: Entry[] = [];
  /** The walk's single photo (one per trip), wherever it was taken. */
  walkPhoto: WalkPhoto | null = null;
  loading = true;
  recording = false;
  busy = false;
  showCleaned = true;
  message: string | null = null;

  private readonly emitter = new Emitter();
  private offRepo: (() => void) | null = null;
  private offPipeline: (() => void) | null = null;
  private disposed = false;
  private readonly clock: () => number;

  /** The stop where the current recording began (fixed at start, so a note always lands where it was started). */
  private clipStopId: string | null = null;

  constructor(private readonly d: WalkControllerDeps) {
    this.clock = d.clock ?? Date.now;
  }

  subscribe(fn: () => void): () => void {
    return this.emitter.subscribe(fn);
  }

  get hasPhoto(): boolean {
    return this.walkPhoto !== null;
  }
  get current(): Stop | null {
    return this.stops.length === 0 ? null : this.stops[this.index];
  }
  get isFirst(): boolean {
    return this.index === 0;
  }
  get isLast(): boolean {
    return this.index >= this.stops.length - 1;
  }
  get isDone(): boolean {
    return this.walk?.status === 'done';
  }
  /** True while anything is in flight: navigation and finishing wait for it. */
  get locked(): boolean {
    return this.busy || this.recording;
  }

  async load(): Promise<void> {
    const { repo, walkId } = this.d;
    this.walk = await repo.getWalk(walkId);
    this.stops = await repo.stopsForWalk(walkId);
    if (!this.walk || this.stops.length === 0) {
      this.message = 'Walk not found';
      this.loading = false;
      this.notify();
      return;
    }
    if (this.walk.status === 'ready') {
      await repo.updateWalkStatus(walkId, 'active');
      this.walk = { ...this.walk, status: 'active' };
    }
    // Resume at the last stop that has entries.
    const all = await repo.entriesForWalk(walkId);
    if (all.length > 0) {
      const i = this.stops.findIndex((s) => s.id === all[all.length - 1].stopId);
      this.index = Math.min(Math.max(i, 0), this.stops.length - 1);
    }
    // Fire-and-forget refresh: the database may be closing (teardown, another tab upgrading it), so never let it throw.
    this.offRepo = repo.onChange(() => void this.reloadEntries().catch((e) => console.warn('[walk] refresh failed:', e)));
    this.offPipeline = this.d.pipeline.subscribe(() => this.notify());
    await this.reloadEntries();
    this.loading = false;
    this.notify();
  }

  private async reloadEntries(): Promise<void> {
    const s = this.current;
    if (!s || this.disposed) return;
    const loaded = await this.d.repo.entriesForStop(s.id);
    await this.refreshPhoto();
    if (this.current?.id !== s.id || this.disposed) return; // user moved on while loading
    this.entries = loaded;
    this.notify();
  }

  /** Reloads the photo bytes only when the stored photo actually changed, so a multi-MB image isn't re-read on every note update. */
  private async refreshPhoto(): Promise<void> {
    const stamp = await this.d.repo.walkPhotoStamp(this.d.walkId);
    const have = this.walkPhoto
      ? { entryId: this.walkPhoto.entryId, createdAtMs: this.walkPhoto.createdAt, size: this.walkPhoto.bytes.length }
      : null;
    if (samePhotoStamp(stamp, have)) return;
    this.walkPhoto = stamp === null ? null : await this.d.repo.walkPhoto(this.d.walkId);
  }

  async toggleRecording(): Promise<void> {
    const stop = this.current;
    if (!stop || this.busy) return;
    this.busy = true;
    this.notify();
    try {
      if (!this.recording) {
        if (!(await this.d.recorder.ensurePermission())) {
          this.message = 'Allow microphone access to record a note.';
          return;
        }
        this.clipStopId = stop.id;
        await this.d.recorder.start();
        if (this.disposed) {
          // The screen closed while the mic was starting: don't leave it on.
          await this.discardClip();
          return;
        }
        this.recording = true;
      } else {
        this.recording = false;
        const clip = await this.d.recorder.stop();
        const stopId = this.clipStopId ?? stop.id;
        this.clipStopId = null;
        if (clip) await this.d.pipeline.submitRecording({ stopId, clip });
      }
    } catch (e) {
      this.recording = false;
      await this.discardClip();
      console.warn('[walk] recording failed:', e);
      this.message = 'Recording stopped unexpectedly. Try again.';
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  /**
   * One photo per walk, stored in the local database. The first photo belongs to the latest entry at this stop (or a
   * new photo-only entry). If the walk already has its photo, nothing happens unless `replace` is true; then the
   * new image replaces the old one.
   */
  async takePhoto(o: { replace?: boolean } = {}): Promise<void> {
    const { repo, walkId } = this.d;
    const stop = this.current;
    if (!stop || this.busy || this.recording) return;
    this.busy = true;
    this.notify();
    try {
      const existing = await repo.walkPhoto(walkId); // cached state may lag
      if (existing && !o.replace) {
        this.walkPhoto = existing; // so the UI offers "Replace" on the next tap
        this.message = 'This walk already has its photo. Tap the camera again to replace it.';
        return;
      }
      const shot: CapturedPhoto | null = await this.d.photos.capture();
      if (!shot) return;
      const now = this.clock();

      // The photo belongs to the stop where it's taken, and no entry is ever left empty:
      //  1. the current holder is at this stop -> keep it;
      //  2. the current holder is a photo-only entry elsewhere -> move it here;
      //  3. otherwise the latest note here, or a new photo-only entry.
      let entryId: string | null = null;
      let fresh: Entry | undefined;
      const old = existing ? await repo.getEntry(existing.entryId) : null;
      if (old && old.stopId === stop.id) {
        entryId = old.id;
      } else if (old && old.rawTranscript === null) {
        await repo.moveEntry(old.id, { stopId: stop.id, recordedAt: now });
        entryId = old.id;
      } else {
        const here = await repo.entriesForStop(stop.id);
        if (here.length > 0) entryId = here[here.length - 1].id;
      }
      if (entryId === null) {
        fresh = newEntry({ id: newId(), stopId: stop.id, recordedAt: now });
        entryId = fresh.id;
      }
      await repo.putWalkPhoto({ walkId, entryId, mime: shot.mime, bytes: shot.bytes, createdAt: now }, { newEntry: fresh });
      await this.refreshPhoto();
    } catch (e) {
      if (e instanceof InvalidPhoto) {
        this.message = `Photo not saved. ${e.message}.`;
      } else {
        console.warn('[walk] photo failed:', e);
        this.message = 'Couldn’t save the photo. Try again.';
      }
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  toggleView(): void {
    this.showCleaned = !this.showCleaned;
    this.notify();
  }

  async goTo(i: number): Promise<void> {
    if (this.locked || i < 0 || i >= this.stops.length) return;
    this.index = i;
    this.entries = [];
    this.notify();
    await this.reloadEntries();
  }

  next(): Promise<void> {
    return this.goTo(this.index + 1);
  }
  previous(): Promise<void> {
    return this.goTo(this.index - 1);
  }

  /** Saves an in-progress recording first. Returns false (and does nothing) while the mic is starting or a photo is being saved. */
  async finish(): Promise<boolean> {
    if (this.busy) return false;
    if (this.recording) await this.toggleRecording();
    await this.d.repo.updateWalkStatus(this.d.walkId, 'done');
    if (this.walk) this.walk = { ...this.walk, status: 'done' };
    this.notify();
    return true;
  }

  clearMessage(): void {
    this.message = null;
  }

  private notify(): void {
    if (!this.disposed) this.emitter.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.offRepo?.();
    this.offPipeline?.();
    this.emitter.clear();
    if (this.recording) {
      this.recording = false;
      void this.discardClip(); // leaving mid-note discards it
    }
  }

  /** Stops the mic if needed and drops the unsaved clip (it only ever lived in memory). */
  private async discardClip(): Promise<void> {
    this.clipStopId = null;
    try {
      await this.d.recorder.stop();
    } catch {
      /* the mic was never on */
    }
  }
}

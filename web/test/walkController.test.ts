import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePhotoCapture, type PhotoCapture } from '../src/media/camera';
import type { VoiceRecorder } from '../src/media/recorder';
import { newEntry, type WalkPhoto } from '../src/models/types';
import { WalkController } from '../src/services/walkController';
import { MAX_PHOTO_BYTES } from '../src/util/imageType';
import { BytesPhoto, CancelledPhoto, makeStack, pngBytes, ScriptedRecorder, SlowStartRecorder, type Stack, stop, walk } from './stack';

let s: Stack;
beforeEach(async () => {
  s = await makeStack();
  await s.repo.insertWalk(walk('w'), [stop('a'), stop('b'), stop('c')]);
});
afterEach(() => s.close());

const ctl = (o: { rec?: VoiceRecorder; photos?: PhotoCapture; walkId?: string } = {}) =>
  new WalkController({
    walkId: o.walkId ?? 'w',
    repo: s.repo,
    pipeline: s.pipeline,
    recorder: o.rec ?? new ScriptedRecorder(),
    photos: o.photos ?? new FakePhotoCapture(),
  });
const entries = () => s.repo.entriesForWalk('w');
const photoBytes = (): WalkPhoto => ({ walkId: 'w', entryId: 'x', mime: 'image/png', bytes: Uint8Array.of(1), createdAt: 1 });

describe('walk session', () => {
  it('starts a ready walk, shows its first stop, and resumes at the last stop with notes', async () => {
    const c = ctl();
    await c.load();
    expect(c.walk!.status).toBe('active');
    expect((await s.repo.getWalk('w'))!.status).toBe('active');
    expect([c.current!.id, c.isFirst, c.isLast, c.loading]).toEqual(['a', true, false, false]);

    await s.repo.insertEntry(newEntry({ id: 'e', stopId: 'c', recordedAt: 5 }));
    const again = ctl();
    await again.load();
    expect(again.index).toBe(2);
    expect(again.isLast).toBe(true);
  });

  it('unknown walk id -> "Walk not found", no crash, actions are no-ops', async () => {
    const c = ctl({ walkId: 'missing' });
    await c.load();
    expect(c.message).toBe('Walk not found');
    expect(c.current).toBeNull();
    await c.toggleRecording();
    await c.takePhoto();
    expect(c.recording).toBe(false);
  });

  it('records a note at the current stop and processes it', async () => {
    const c = ctl();
    await c.load();
    await c.toggleRecording();
    expect(c.recording).toBe(true);
    await c.toggleRecording();
    await s.pipeline.drain();
    // The screen shows the entry at once and fills in the text as the pipeline saves it.
    await vi.waitFor(() => expect(c.entries[0]?.cleanedText).toBeTruthy());
    expect(c.entries).toHaveLength(1);
  });

  it('mic permission denied -> message, not recording, nothing saved', async () => {
    const c = ctl({ rec: new ScriptedRecorder(false) });
    await c.load();
    await c.toggleRecording();
    expect(c.recording).toBe(false);
    expect(c.message).toContain('microphone access');
    expect(await entries()).toEqual([]);
  });

  it('recorder throws on start -> recovers to idle with a friendly message', async () => {
    const c = ctl({ rec: new ScriptedRecorder(true, true) });
    await c.load();
    await c.toggleRecording();
    expect([c.recording, c.busy]).toEqual([false, false]);
    expect(c.message).toBe('Recording stopped unexpectedly. Try again.');
    expect(c.message).not.toContain('mic busy'); // no raw exception text shown to the user
  });

  it('cannot change stop or take a photo while recording', async () => {
    const c = ctl();
    await c.load();
    await c.toggleRecording();
    await c.next();
    expect(c.index).toBe(0);
    await c.takePhoto();
    expect(await entries()).toHaveLength(0);
    await c.toggleRecording();
  });

  it('out-of-range navigation is ignored', async () => {
    const c = ctl();
    await c.load();
    await c.goTo(-1);
    await c.goTo(99);
    await c.previous();
    expect(c.index).toBe(0);
    await c.goTo(2);
    await c.next();
    expect(c.index).toBe(2);
  });

  it('finish while recording saves the clip first, and marks the walk done', async () => {
    const rec = new ScriptedRecorder();
    const c = ctl({ rec });
    await c.load();
    await c.toggleRecording();
    expect(await c.finish()).toBe(true);
    await s.pipeline.drain();
    expect(rec.stops).toBe(1);
    expect([c.recording, c.isDone]).toEqual([false, true]);
    expect((await entries())[0].cleanedText).toBeTruthy();
    expect((await s.repo.getWalk('w'))!.status).toBe('done');
  });

  it('dispose while recording stops the mic', async () => {
    const rec = new ScriptedRecorder();
    const c = ctl({ rec });
    await c.load();
    await c.toggleRecording();
    c.dispose();
    await vi.waitFor(() => expect(rec.stops).toBe(1));
    expect(await entries()).toEqual([]); // leaving mid-note discards it
    expect(await s.recordings.ids()).toEqual([]);
  });

  it('double-tap record while busy does not start two recordings', async () => {
    const c = ctl();
    await c.load();
    await Promise.all([c.toggleRecording(), c.toggleRecording()]);
    expect(c.recording).toBe(true);
    await c.toggleRecording();
    await s.pipeline.drain();
    expect(await entries()).toHaveLength(1);
  });

  it('Next and Finish are ignored while the mic is starting (no stray recording)', async () => {
    const rec = new SlowStartRecorder();
    const c = ctl({ rec });
    await c.load();
    const starting = c.toggleRecording(); // mic is starting: busy, not yet recording
    expect(c.busy).toBe(true);
    await c.next();
    expect(c.index).toBe(0); // navigation waits for the mic
    expect(await c.finish()).toBe(false); // finish waits for the mic
    rec.release();
    await starting;
    expect(c.recording).toBe(true);
    await c.toggleRecording();
    await s.pipeline.drain();
    expect(await s.repo.entriesForStop('a')).toHaveLength(1); // the note lands on the stop where recording began
  });

  it('closing the screen while the mic starts stops it and keeps nothing', async () => {
    const rec = new SlowStartRecorder();
    const c = ctl({ rec });
    await c.load();
    const starting = c.toggleRecording();
    c.dispose();
    rec.release();
    await starting;
    expect(rec.stops).toBeGreaterThanOrEqual(1); // mic turned off
    expect(await s.recordings.ids()).toEqual([]);
  });

  it('toggles between cleaned and raw text', async () => {
    const c = ctl();
    await c.load();
    expect(c.showCleaned).toBe(true);
    c.toggleView();
    expect(c.showCleaned).toBe(false);
  });
});

describe('the one photo per walk', () => {
  it('camera cancelled -> no entry created', async () => {
    const c = ctl({ photos: new CancelledPhoto() });
    await c.load();
    await c.takePhoto();
    expect(await entries()).toEqual([]);
    expect(c.busy).toBe(false);
  });

  it('the first photo gets a photo-only entry at the current stop', async () => {
    const c = ctl();
    await c.load();
    await c.takePhoto();
    const photo = (await s.repo.walkPhoto('w'))!;
    expect((await s.repo.getEntry(photo.entryId))!.stopId).toBe('a');
    expect(c.hasPhoto).toBe(true);
  });

  it('a second tap does not replace it, it offers Replace', async () => {
    const c = ctl();
    await c.load();
    await c.takePhoto();
    await c.takePhoto();
    expect(c.message).toContain('already has its photo');
    expect(await entries()).toHaveLength(1);
  });

  it('replace when the walk has no photo yet just takes the first photo', async () => {
    const c = ctl();
    await c.load();
    await c.takePhoto({ replace: true });
    expect(await s.repo.walkPhoto('w')).not.toBeNull();
  });

  it('cancelled replacement keeps the existing photo', async () => {
    const c = ctl();
    await c.load();
    await c.takePhoto();
    const before = (await s.repo.walkPhoto('w'))!;
    const c2 = ctl({ photos: new CancelledPhoto() });
    await c2.load();
    await c2.takePhoto({ replace: true });
    const after = (await s.repo.walkPhoto('w'))!;
    expect([after.entryId, [...after.bytes]]).toEqual([before.entryId, [...before.bytes]]);
  });

  it('replacing elsewhere moves a photo-only entry instead of leaving it empty', async () => {
    const c = ctl();
    await c.load();
    await c.takePhoto();
    const first = (await s.repo.walkPhoto('w'))!;
    const jpeg = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
    const c2 = ctl({ photos: new BytesPhoto(jpeg) });
    await c2.load();
    await c2.goTo(2); // the photo-only entry from stop a moves to stop c
    await c2.takePhoto({ replace: true });
    const second = (await s.repo.walkPhoto('w'))!;
    expect([second.entryId, second.mime, [...second.bytes]]).toEqual([first.entryId, 'image/jpeg', jpeg]);
    expect((await s.repo.getEntry(second.entryId))!.stopId).toBe('c');
    expect(await s.repo.entriesForStop('a')).toEqual([]);
  });

  it('replacing at a stop with notes keeps the old note and attaches to the new stop', async () => {
    const c = ctl();
    await c.load();
    await c.toggleRecording();
    await c.toggleRecording();
    await s.pipeline.drain();
    await c.takePhoto(); // photo on the voice note at stop a
    await c.goTo(1);
    await c.toggleRecording();
    await c.toggleRecording();
    await s.pipeline.drain();
    await c.takePhoto({ replace: true });
    const photo = (await s.repo.walkPhoto('w'))!;
    expect((await s.repo.getEntry(photo.entryId))!.stopId).toBe('b');
    const atA = (await s.repo.entriesForStop('a'))[0];
    expect([atA.rawTranscript !== null, atA.hasPhoto]).toEqual([true, false]);
  });

  const refused: [string, number[]][] = [
    ['GIF', [...'GIF89a'].map((c) => c.charCodeAt(0))],
    ['WebP', [...'RIFF', 0, 0, 0, 0, ...'WEBPVP8 '].map((c) => (typeof c === 'string' ? c.charCodeAt(0) : c))],
    ['animated PNG', pngBytes({ animated: true })],
    ['MP4 video', [0, 0, 0, 0x18, ...[...'ftypmp42'].map((c) => c.charCodeAt(0))]],
    ['empty file', []],
  ];
  it.each(refused)('%s from the camera is refused: nothing stored, clear message', async (_name, bytes) => {
    const c = ctl({ photos: new BytesPhoto(bytes) });
    await c.load();
    await c.takePhoto();
    expect(await s.repo.walkPhoto('w')).toBeNull();
    expect(await entries()).toEqual([]); // no empty photo-only entry left behind
    expect(c.message).toMatch(/^Photo not saved/);
    expect(c.busy).toBe(false);
  });

  it('oversized photo (> 8 MB) refused', async () => {
    const c = ctl({ photos: new BytesPhoto([0xff, 0xd8, 0xff, ...new Array(MAX_PHOTO_BYTES).fill(0)]) });
    await c.load();
    await c.takePhoto();
    expect(await s.repo.walkPhoto('w')).toBeNull();
    expect(c.message).toContain('limit');
  });

  it('photos are per walk: another walk can have its own', async () => {
    await s.repo.insertWalk(walk('w2'), [stop('x')]);
    const c1 = ctl();
    await c1.load();
    await c1.takePhoto();
    const c2 = ctl({ walkId: 'w2' });
    await c2.load();
    expect(c2.hasPhoto).toBe(false);
    await c2.takePhoto();
    expect(await s.repo.walkPhoto('w2')).not.toBeNull();
    expect((await s.repo.walkPhoto('w'))!.entryId).not.toBe((await s.repo.walkPhoto('w2'))!.entryId);
  });

  it('stale cache: an already-stored photo makes the next tap offer Replace', async () => {
    const c = ctl();
    await c.load();
    await s.repo.putWalkPhoto(photoBytes());
    expect(c.hasPhoto).toBe(false); // cache not refreshed yet
    await c.takePhoto();
    expect(c.hasPhoto).toBe(true);
  });

  it('a failed photo write leaves no empty entry behind', async () => {
    vi.spyOn(s.repo, 'putWalkPhoto').mockRejectedValueOnce(new Error('disk full'));
    const c = ctl();
    await c.load();
    await c.takePhoto();
    expect(await entries()).toEqual([]);
    expect(await s.repo.walkPhoto('w')).toBeNull();
    expect(c.message).toBe('Couldn’t save the photo. Try again.');
  });

  it('photo bytes are not re-read on every note update', async () => {
    const reads = vi.spyOn(s.repo, 'walkPhoto');
    const c = ctl();
    await c.load();
    await c.takePhoto();
    const before = reads.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      await c.toggleRecording();
      await c.toggleRecording();
    }
    await s.pipeline.drain();
    await new Promise((r) => setTimeout(r, 20));
    expect(reads.mock.calls.length).toBe(before); // only the cheap stamp is checked while the photo is unchanged
  });
});

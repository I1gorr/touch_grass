import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { batchCount, WalkRepo } from '../src/db/walkRepo';
import { newEntry, newStop, type Walk, type WalkPhoto } from '../src/models/types';

let n = 0;
let clock = 1_000_000;
let repo: WalkRepo;
beforeEach(async () => {
  clock = 1_000_000;
  repo = await WalkRepo.open({ name: `test-${++n}`, nowMs: () => clock });
});
afterEach(() => repo.close());

const walk = (id: string, t: number, o: Partial<Walk> = {}): Walk => ({
  id,
  createdAt: t,
  startLat: 1,
  startLng: 2,
  timeOfDay: 'morning',
  weatherSummary: 'sunny',
  status: 'ready',
  routeJson: null,
  ...o,
});
const stop = (id: string, o: Partial<ReturnType<typeof newStop>> = {}) =>
  newStop({ id, osmId: `node/${id}`, name: `Stop ${id}`, lat: 1, lng: 2, blurb: 'b', prompt: 'p', ...o });
const photo = (walkId: string, entryId: string, bytes: number[], mime = 'image/jpeg'): WalkPhoto => ({
  walkId,
  entryId,
  mime,
  bytes: Uint8Array.from(bytes),
  createdAt: 2026,
});
const count = (fn: (cb: () => void) => () => void) => {
  const c = { n: 0 };
  const off = fn(() => c.n++);
  return { c, off };
};

describe('walks and stops', () => {
  it('round-trip in order', async () => {
    await repo.insertWalk(walk('w1', 1000), [stop('a'), stop('b'), stop('c')]);
    await repo.insertWalk(walk('w2', 2000), [stop('d')]);
    expect((await repo.listWalks()).map((w) => w.id)).toEqual(['w2', 'w1']);
    expect((await repo.stopsForWalk('w1')).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect((await repo.stopsForWalk('w1'))[0].blurb).toBe('b');
    await repo.updateWalkStatus('w1', 'done');
    expect((await repo.getWalk('w1'))!.status).toBe('done');
    expect(await repo.getWalk('nope')).toBeNull();
  });

  it('keeps the planned route json', async () => {
    await repo.saveQuest({ walk: walk('w1', 1, { routeJson: '{"v":1}' }), stops: [stop('a')] });
    expect((await repo.getWalk('w1'))!.routeJson).toBe('{"v":1}');
  });

  it('stops take their position from list order', async () => {
    await repo.insertWalk(walk('w1', 1), [stop('z', { position: 9 }), stop('y', { position: 0 })]);
    expect((await repo.stopsForWalk('w1')).map((s) => [s.id, s.position])).toEqual([['z', 0], ['y', 1]]);
  });

  it('status only moves forward through setStatus', async () => {
    await repo.insertWalk(walk('w1', 1), [stop('a')]);
    await repo.setStatus('w1', 'active');
    await repo.setStatus('w1', 'active');
    await repo.setStatus('w1', 'done');
    await expect(repo.setStatus('w1', 'ready')).rejects.toThrow(/back to ready/);
    await expect(repo.setStatus('missing', 'done')).rejects.toThrow(/No walk/);
  });

  it('hasActiveWalk follows the active status', async () => {
    await repo.insertWalk(walk('w1', 1), [stop('a')]);
    expect(await repo.hasActiveWalk()).toBe(false);
    await repo.setStatus('w1', 'active');
    expect(await repo.hasActiveWalk()).toBe(true);
    await repo.setStatus('w1', 'done');
    expect(await repo.hasActiveWalk()).toBe(false);
  });

  it('setBlurb updates one stop', async () => {
    await repo.insertWalk(walk('w1', 1), [stop('a'), stop('b')]);
    await repo.setBlurb('a', 'new');
    expect((await repo.stopsForWalk('w1')).map((s) => s.blurb)).toEqual(['new', 'b']);
    await expect(repo.setBlurb('zzz', 'x')).rejects.toThrow();
  });

  it('loadWalk bundles stops and entries', async () => {
    await repo.insertWalk(walk('w1', 1), [stop('a'), stop('b')]);
    await repo.insertEntry(newEntry({ id: 'e1', stopId: 'b', recordedAt: 5 }));
    const b = (await repo.loadWalk('w1'))!;
    expect(b.stops.map((s) => s.id)).toEqual(['a', 'b']);
    expect(b.entriesByStop['a']).toEqual([]);
    expect(b.entriesByStop['b'].map((e) => e.id)).toEqual(['e1']);
    expect(await repo.loadWalk('nope')).toBeNull();
  });
});

describe('place history', () => {
  it('counts finished walks only, per place, with the latest visit', async () => {
    const mk = async (id: string, t: number, status: 'done' | 'active', osm: string[]) => {
      await repo.insertWalk(walk(id, t, { status }), osm.map((o, i) => stop(`${id}-${i}`, { osmId: o })));
    };
    await mk('w1', 100, 'done', ['node/1', 'node/2']);
    await mk('w2', 300, 'done', ['node/1']);
    await mk('w3', 900, 'active', ['node/1', 'node/3']);
    await mk('w4', 50, 'done', ['']); // no osm id: ignored
    expect(await repo.placeHistory()).toEqual({
      'node/1': { visits: 2, lastVisitedMs: 300 },
      'node/2': { visits: 1, lastVisitedMs: 100 },
    });
  });

  it('counts a walk once even if it visits a place twice', async () => {
    await repo.insertWalk(walk('w1', 7, { status: 'done' }), [stop('a', { osmId: 'node/1' }), stop('b', { osmId: 'node/1' })]);
    expect((await repo.placeHistory())['node/1'].visits).toBe(1);
  });
});

describe('entries', () => {
  beforeEach(() => repo.insertWalk(walk('w1', 1000), [stop('a'), stop('b')]));

  it('partial updates keep other fields', async () => {
    await repo.insertEntry(newEntry({ id: 'e1', stopId: 'a', recordedAt: 5 }));
    await repo.insertEntry(newEntry({ id: 'e2', stopId: 'b', recordedAt: 6 }));
    await repo.updateEntry('e1', { rawTranscript: 'raw' });
    await repo.updateEntry('e1', { cleanedText: 'Clean.' });
    const e = (await repo.getEntry('e1'))!;
    expect([e.rawTranscript, e.cleanedText, e.hasPhoto]).toEqual(['raw', 'Clean.', false]);
    expect((await repo.entriesForStop('a')).map((x) => x.id)).toEqual(['e1']);
    expect((await repo.entriesForWalk('w1')).map((x) => x.id)).toEqual(['e1', 'e2']);
    await expect(repo.updateEntry('missing', { rawTranscript: 'x' })).rejects.toThrow(/not found/);
  });

  it("an empty string is a transcript ('' = silence), not 'not transcribed'", async () => {
    await repo.insertEntry(newEntry({ id: 'e1', stopId: 'a', recordedAt: 5 }));
    expect((await repo.getEntry('e1'))!.rawTranscript).toBeNull();
    await repo.updateEntry('e1', { rawTranscript: '' });
    expect((await repo.getEntry('e1'))!.rawTranscript).toBe('');
  });

  it('entries come oldest first and move between stops', async () => {
    await repo.insertEntry(newEntry({ id: 'late', stopId: 'a', recordedAt: 9 }));
    await repo.insertEntry(newEntry({ id: 'early', stopId: 'a', recordedAt: 3 }));
    expect((await repo.entriesForStop('a')).map((e) => e.id)).toEqual(['early', 'late']);
    await repo.moveEntry('early', { stopId: 'b', recordedAt: 20 });
    expect((await repo.entriesForStop('b')).map((e) => [e.id, e.recordedAt])).toEqual([['early', 20]]);
    await expect(repo.moveEntry('ghost', { stopId: 'a', recordedAt: 1 })).rejects.toThrow(/not found/);
  });

  it('entriesForWalk orders by stop position, then time', async () => {
    await repo.insertEntry(newEntry({ id: 'on-b', stopId: 'b', recordedAt: 1 }));
    await repo.insertEntry(newEntry({ id: 'on-a-2', stopId: 'a', recordedAt: 8 }));
    await repo.insertEntry(newEntry({ id: 'on-a-1', stopId: 'a', recordedAt: 4 }));
    expect((await repo.entriesForWalk('w1')).map((e) => e.id)).toEqual(['on-a-1', 'on-a-2', 'on-b']);
  });

  it('change listeners fire on writes', async () => {
    const { c, off } = count((cb) => repo.onChange(cb));
    await repo.insertWalk(walk('w2', 1), [stop('x')]);
    await repo.insertEntry(newEntry({ id: 'e1', stopId: 'x', recordedAt: 1 }));
    expect(c.n).toBe(2);
    off();
    await repo.insertEntry(newEntry({ id: 'e2', stopId: 'x', recordedAt: 2 }));
    expect(c.n).toBe(2);
  });

  describe('sharing', () => {
    beforeEach(async () => {
      await repo.insertEntry(newEntry({ id: 'e1', stopId: 'a', recordedAt: 5, rawTranscript: 'raw', cleanedText: '  The light here is lovely.  ' }));
    });

    it('shares a trimmed snapshot of the cleaned text', async () => {
      await repo.shareEntry('e1');
      let e = (await repo.getEntry('e1'))!;
      expect([e.shared, e.sharedText]).toEqual([true, 'The light here is lovely.']);
      await repo.updateEntry('e1', { cleanedText: 'Edited later.' });
      e = (await repo.getEntry('e1'))!;
      expect(e.sharedText).toBe('The light here is lovely.'); // snapshot, not a live view
      await repo.unshareEntry('e1');
      e = (await repo.getEntry('e1'))!;
      expect([e.shared, e.sharedText]).toEqual([false, null]);
    });

    it('trims to 280 chars and refuses empty text', async () => {
      await repo.shareEntry('e1', 'x'.repeat(500));
      expect((await repo.getEntry('e1'))!.sharedText!.length).toBe(280);
      await repo.insertEntry(newEntry({ id: 'e2', stopId: 'a', recordedAt: 6, rawTranscript: 'only raw' }));
      await expect(repo.shareEntry('e2')).rejects.toThrow(/Nothing to share/);
      await expect(repo.shareEntry('ghost')).rejects.toThrow(/No entry/);
    });
  });
});

describe('debug dump', () => {
  it('exposes all tables; photo bytes are summarised, not dumped', async () => {
    await repo.insertWalk(walk('w1', 1), [stop('a')]);
    await repo.insertEntry(newEntry({ id: 'e1', stopId: 'a', recordedAt: 1 }));
    await repo.putWalkPhoto(photo('w1', 'e1', [1, 2, 3]));
    const d = await repo.dumpTables();
    expect(Object.keys(d)).toEqual(expect.arrayContaining(['walk', 'stop', 'entry', 'photo']));
    expect((d.stop[0] as any).walk_id).toBe('w1');
    expect((d.photo[0] as any).data).toBe('<3 bytes>');
  });
});

describe('photos (local only, one per walk)', () => {
  beforeEach(async () => {
    await repo.insertWalk(walk('w1', 1), [stop('a'), stop('b')]);
    await repo.insertEntry(newEntry({ id: 'e1', stopId: 'a', recordedAt: 1 }));
    await repo.insertEntry(newEntry({ id: 'e2', stopId: 'b', recordedAt: 1 }));
  });

  it('bytes round-trip exactly', async () => {
    const bytes = Array.from({ length: 1000 }, (_, i) => i % 256);
    await repo.putWalkPhoto(photo('w1', 'e1', bytes, 'image/png'));
    const p = (await repo.walkPhoto('w1'))!;
    expect([p.entryId, p.mime]).toEqual(['e1', 'image/png']);
    expect(Array.from(p.bytes)).toEqual(bytes);
  });

  it('a walk has at most one photo: putting again replaces it', async () => {
    await repo.putWalkPhoto(photo('w1', 'e1', [1]));
    await repo.putWalkPhoto(photo('w1', 'e2', [2, 2]));
    const p = (await repo.walkPhoto('w1'))!;
    expect([p.entryId, Array.from(p.bytes)]).toEqual(['e2', [2, 2]]);
    expect((await repo.dumpTables()).photo).toHaveLength(1);
  });

  it('entries report hasPhoto for the photo holder only', async () => {
    await repo.putWalkPhoto(photo('w1', 'e2', [9]));
    const byId = Object.fromEntries((await repo.entriesForWalk('w1')).map((e) => [e.id, e.hasPhoto]));
    expect(byId).toEqual({ e1: false, e2: true });
    expect((await repo.getEntry('e2'))!.hasPhoto).toBe(true);
    expect((await repo.entriesForStop('b'))[0].hasPhoto).toBe(true);
  });

  it('no photo gives null; photos are per walk; stamps follow the stored photo', async () => {
    expect(await repo.walkPhoto('w1')).toBeNull();
    expect(await repo.walkPhoto('nope')).toBeNull();
    expect(await repo.walkPhotoStamp('w1')).toBeNull();
    await repo.putWalkPhoto(photo('w1', 'e1', [1, 2, 3]));
    expect(await repo.walkPhotoStamp('w1')).toEqual({ entryId: 'e1', createdAtMs: 2026, size: 3 });
  });

  it('storing a photo notifies listeners once', async () => {
    const { c } = count((cb) => repo.onChange(cb));
    await repo.putWalkPhoto(photo('w1', 'e1', [1]));
    expect(c.n).toBe(1);
  });

  it('a new entry is stored with its photo in one step; a failed write leaves nothing behind', async () => {
    await repo.putWalkPhoto(photo('w1', 'e3', [5]), { newEntry: newEntry({ id: 'e3', stopId: 'a', recordedAt: 7 }) });
    expect((await repo.getEntry('e3'))!.hasPhoto).toBe(true);

    // A photo that cannot be cloned into IndexedDB (a function inside) must roll the entry back too.
    const bad = { ...photo('w1', 'e4', [1]), bytes: (() => 1) as unknown as Uint8Array };
    await expect(
      repo.putWalkPhoto(bad, { newEntry: newEntry({ id: 'e4', stopId: 'a', recordedAt: 8 }) }),
    ).rejects.toThrow();
    expect(await repo.getEntry('e4')).toBeNull();
    expect((await repo.walkPhoto('w1'))!.entryId).toBe('e3');
  });
});

describe('sync bookkeeping', () => {
  beforeEach(async () => {
    await repo.insertWalk(walk('w', 1), [stop('w-0')]);
    await repo.insertEntry(newEntry({ id: 'e', stopId: 'w-0', recordedAt: 2 }));
  });

  it('everything is pending at first; marking the uploaded batch clears it', async () => {
    expect(await repo.pendingCount()).toBe(3);
    const batch = await repo.pendingChanges();
    expect(batchCount(batch)).toBe(3);
    await repo.markSynced(batch);
    expect(await repo.pendingCount()).toBe(0);
    expect(batchCount(await repo.pendingChanges())).toBe(0);
  });

  it('a row changed after it was read stays pending', async () => {
    const batch = await repo.pendingChanges();
    await repo.updateEntry('e', { rawTranscript: 'hello' });
    await repo.markSynced(batch);
    const again = await repo.pendingChanges();
    expect(again.entry.map((r) => r.id)).toEqual(['e']);
    expect(again.walk).toHaveLength(0);
    expect(again.entry[0].raw_transcript).toBe('hello');
  });

  it('the stamp never goes backwards when the clock does', async () => {
    const a = repo.stamp();
    clock -= 100_000;
    const b = repo.stamp();
    const c = repo.stamp();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('batches are limited per table and ordered by version', async () => {
    for (let i = 0; i < 5; i++) await repo.insertEntry(newEntry({ id: `x${i}`, stopId: 'w-0', recordedAt: 10 + i }));
    const batch = await repo.pendingChanges(3);
    expect(batch.entry).toHaveLength(3);
    const versions = batch.entry.map((r) => r.updated_at as number);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  it('photos are never offered for upload; entry rows carry has_photo but no image or path', async () => {
    await repo.putWalkPhoto(photo('w', 'e', [1, 2, 3]));
    const batch = await repo.pendingChanges();
    expect(Object.keys(batch).sort()).toEqual(['entry', 'stop', 'walk']);
    const row = batch.entry.find((r) => r.id === 'e')!;
    expect(row.has_photo).toBe(1);
    expect('photo_path' in row).toBe(false);
    expect('synced_at' in row).toBe(false);
    const values = [...batch.walk, ...batch.stop, ...batch.entry].flatMap((r) => Object.values(r));
    expect(values.some((v) => v instanceof Uint8Array)).toBe(false);
  });

  it('rows match what the server accepts (flags are 0/1, snake_case)', async () => {
    const row = (await repo.pendingChanges()).entry[0];
    expect(row).toMatchObject({ id: 'e', stop_id: 'w-0', shared: 0, has_photo: 0 });
  });

  it('marking synced does not fire change listeners (it would re-trigger sync forever)', async () => {
    const { c } = count((cb) => repo.onChange(cb));
    await repo.markSynced(await repo.pendingChanges());
    expect(c.n).toBe(0);
  });
});

describe('device id', () => {
  it('is generated once and stable', async () => {
    const a = await repo.deviceId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await repo.deviceId()).toBe(a);
  });

  it('survives reopening the database', async () => {
    const name = `persist-${++n}`;
    const r1 = await WalkRepo.open({ name });
    const id = await r1.deviceId();
    await r1.insertWalk(walk('w', 1), [stop('a')]);
    const stored = Math.max(...(await r1.pendingChanges()).walk.map((r) => r.updated_at as number));
    r1.close();
    const r2 = await WalkRepo.open({ name, nowMs: () => 0 });
    expect(await r2.deviceId()).toBe(id);
    expect((await r2.listWalks()).map((w) => w.id)).toEqual(['w']);
    expect(r2.stamp()).toBeGreaterThan(stored); // the clock resumes after the stored versions
    r2.close();
  });
});

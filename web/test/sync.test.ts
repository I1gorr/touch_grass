import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchCount, type SyncBatch, WalkRepo } from '../src/db/walkRepo';
import { newEntry, newStop, type Walk, type WalkPhoto } from '../src/models/types';
import { type SyncableStore, SyncService } from '../src/sync/syncService';
import { HttpSyncTransport, SyncException, type SyncTransport } from '../src/sync/transport';
import { json, mockFetch, offline, text } from './helpers';

const DEVICE = '0123456789abcdef0123456789abcdef';

/** Records pushes; can be told to fail or to run a hook mid-push. */
class FakeTransport implements SyncTransport {
  pushes: SyncBatch[] = [];
  failWith: Error | null = null;
  duringPush: (() => Promise<void>) | null = null;
  /** Rows the "server" reports as owned by another install, per push. */
  refuse = 0;
  closed = false;

  get rowsPushed() {
    return this.pushes.reduce((n, b) => n + batchCount(b), 0);
  }

  async push(deviceId: string, batch: SyncBatch): Promise<number> {
    expect(deviceId).toBe(DEVICE);
    if (this.failWith) throw this.failWith;
    await this.duringPush?.();
    this.pushes.push(batch);
    return this.refuse;
  }

  async close() {
    this.closed = true;
  }
}

let n = 0;
let repo: WalkRepo;
let transport: FakeTransport;
beforeEach(async () => {
  repo = await WalkRepo.open({ name: `sync-${++n}` });
  transport = new FakeTransport();
});
afterEach(() => repo.close());

const walk = (id: string): Walk => ({
  id, createdAt: 1, startLat: 1, startLng: 2, timeOfDay: 'am', weatherSummary: '', status: 'ready', routeJson: null,
});
const stop = (id: string) => newStop({ id, osmId: `node/${id}`, name: id, lat: 1, lng: 2 });
const seed = () => repo.insertWalk(walk('w'), [stop('w-0'), stop('w-1')]);
const service = (batchSize = 200) => new SyncService({ store: repo, transport, deviceId: DEVICE, batchSize });
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0]);
const photo = (entryId: string, bytes = pngBytes): WalkPhoto => ({ walkId: 'w', entryId, mime: 'image/png', bytes, createdAt: 1 });

describe('change tracking', () => {
  it('new rows are pending; a sync uploads them once', async () => {
    await seed();
    expect(await repo.pendingCount()).toBe(3);
    const s = service();
    const r = await s.syncNow();
    expect([r.error === undefined, r.uploaded]).toEqual([true, 3]);
    expect(await repo.pendingCount()).toBe(0);
    expect((await s.syncNow()).uploaded).toBe(0);
    expect(transport.pushes).toHaveLength(1);
  });

  it('edits after a sync make the row pending again', async () => {
    await seed();
    await service().syncNow();
    await repo.updateWalkStatus('w', 'done');
    const pending = await repo.pendingChanges();
    expect(pending.walk[0].status).toBe('done');
    expect(pending.stop).toHaveLength(0);
  });

  it('a row edited while its upload is in flight stays pending', async () => {
    await seed();
    await repo.insertEntry(newEntry({ id: 'e', stopId: 'w-0', recordedAt: 1 }));
    transport.duringPush = () => repo.updateEntry('e', { rawTranscript: 'late edit' });
    await service().syncNow();
    expect((await repo.pendingChanges()).entry[0].raw_transcript).toBe('late edit');
  });

  it('updated_at is strictly increasing even within one millisecond', async () => {
    const fixed = await WalkRepo.open({ name: `sync-fixed-${++n}`, nowMs: () => 5000 });
    await fixed.insertWalk(walk('a'), []);
    await fixed.insertWalk(walk('b'), []);
    const rows = (await fixed.pendingChanges()).walk;
    expect(rows[1].updated_at as number).toBeGreaterThan(rows[0].updated_at as number);
    fixed.close();
  });

  it('marking synced does not fire the change signal (no sync loop)', async () => {
    await seed();
    let events = 0;
    repo.onChange(() => events++);
    await service().syncNow();
    expect(events).toBe(0);
  });
});

describe('failure handling', () => {
  it('offline: nothing lost, error recorded, next attempt uploads', async () => {
    await seed();
    const s = service();
    transport.failWith = new SyncException('timed out (offline?)');
    const r = await s.syncNow();
    expect(r.error).toBeInstanceOf(SyncException);
    expect(s.lastError).toBeInstanceOf(SyncException);
    expect(s.pending).toBe(3);
    expect(s.paused).toBe(false); // network errors are retried automatically

    transport.failWith = null;
    expect((await s.syncNow()).uploaded).toBe(3);
    expect(s.lastError).toBeNull();
    expect(s.pending).toBe(0);
  });

  it('a wrong API key (401) pauses auto-sync until a manual retry', async () => {
    await seed();
    const s = service();
    transport.failWith = new SyncException('invalid api key', 401);
    await s.syncNow(false);
    expect(s.paused).toBe(true);

    transport.failWith = null;
    await s.syncNow();
    expect(s.paused).toBe(false);
    expect(s.pending).toBe(0);
  });

  it('server errors (5xx, 408, 429) are retryable, not permanent', () => {
    expect(new SyncException('x', 500).isPermanent).toBe(false);
    expect(new SyncException('x', 429).isPermanent).toBe(false);
    expect(new SyncException('x', 408).isPermanent).toBe(false);
    expect(new SyncException('x', 400).isPermanent).toBe(true);
    expect(new SyncException('x').isPermanent).toBe(false);
  });

  it('failure mid-way keeps earlier batches synced', async () => {
    for (let i = 0; i < 5; i++) await repo.insertWalk(walk(`w${i}`), []);
    let calls = 0;
    transport.duringPush = async () => {
      if (++calls === 2) throw new SyncException('dropped');
    };
    const r = await service(2).syncNow();
    expect(r.uploaded).toBe(2);
    expect(await repo.pendingCount()).toBe(3);
  });

  it('concurrent syncNow calls share one run', async () => {
    await seed();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    transport.duringPush = () => gate;
    const s = service();
    const a = s.syncNow();
    const b = s.syncNow();
    expect(s.running).toBe(true);
    release();
    await Promise.all([a, b]);
    expect(transport.pushes).toHaveLength(1);
    expect(s.running).toBe(false);
  });

  it('rows owned by another install are surfaced, not retried forever', async () => {
    await seed();
    transport.refuse = 2;
    const s = service();
    const r = await s.syncNow();
    expect(r.error).toBeUndefined();
    expect(s.refused).toBe(2);
    expect(await repo.pendingCount()).toBe(0);
  });

  it('close waits for the upload in flight, then releases an owned transport', async () => {
    await seed();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    transport.duringPush = () => gate;
    const s = service();
    const run = s.syncNow();
    let closedDone = false;
    const closing = s.close().then(() => (closedDone = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(closedDone).toBe(false); // must not close under a running upload
    release();
    await run;
    await closing;
    expect(transport.closed).toBe(true);
  });

  it('a transport supplied from outside is not closed', async () => {
    const s = new SyncService({ store: repo, transport, deviceId: DEVICE, ownsTransport: false });
    await s.close();
    expect(transport.closed).toBe(false);
  });

  it('a store that never clears is capped, not an infinite loop', async () => {
    const stuck: SyncableStore = {
      pendingChanges: async () => ({ walk: [{ id: 'x', updated_at: 1 }], stop: [], entry: [] }),
      markSynced: async () => {},
      pendingCount: async () => 1,
    };
    await new SyncService({ store: stuck, transport, deviceId: DEVICE, maxBatchesPerRun: 3 }).syncNow();
    expect(transport.pushes).toHaveLength(3);
  });

  it('a walk in progress blocks the upload and resumes after', async () => {
    await seed();
    let walking = true;
    const s = new SyncService({ store: repo, transport, deviceId: DEVICE, walkInProgress: async () => walking });
    const r = await s.syncNow();
    expect(r).toEqual({ uploaded: 0, skippedForWalk: true });
    expect(s.waitingForWalk).toBe(true);
    expect(s.pending).toBe(3);
    expect(transport.pushes).toHaveLength(0);
    walking = false;
    expect((await s.syncNow()).uploaded).toBe(3);
    expect(s.waitingForWalk).toBe(false);
  });

  it('a sync requested while one is finishing is not lost', async () => {
    await seed();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    transport.duringPush = () => gate;
    const s = service();
    const first = s.syncNow();
    await vi.waitFor(() => expect(s.running).toBe(true));
    await repo.insertWalk(walk('late'), []); // changes while the first upload is in flight
    const second = s.syncNow(false);
    transport.duringPush = null;
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.uploaded).toBe(4); // 3 first, then the late walk in the follow-up pass
    expect(b).toEqual(a);
    expect(await repo.pendingCount()).toBe(0);
  });

  it('subscribers hear about state changes until they unsubscribe', async () => {
    await seed();
    const s = service();
    let heard = 0;
    const off = s.subscribe(() => heard++);
    await s.syncNow();
    expect(heard).toBeGreaterThanOrEqual(2); // running, then done
    off();
    const before = heard;
    await s.syncNow();
    expect(heard).toBe(before);
  });
});

describe('scheduling', () => {
  // Only the timers the service uses: fake-indexeddb needs the real setImmediate.
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it('uploads at start, after changes (debounced), and on the interval', async () => {
    const s = new SyncService({
      store: repo, transport, deviceId: DEVICE, onChange: (fn) => repo.onChange(fn), debounceMs: 5000, intervalMs: 300_000,
    });
    await repo.insertWalk(walk('w1'), []);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect([s.running, s.pending]).toEqual([false, 0])); // initial attempt, fully done
    expect(transport.rowsPushed).toBe(1);

    await repo.insertWalk(walk('w2'), []);
    await repo.insertWalk(walk('w3'), []);
    await vi.advanceTimersByTimeAsync(4000);
    expect(transport.rowsPushed).toBe(1); // still within the debounce window
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(transport.rowsPushed).toBe(3)); // one upload for both edits
    expect(transport.pushes).toHaveLength(2);

    await repo.markSynced(await repo.pendingChanges());
    await vi.advanceTimersByTimeAsync(0);
    await s.close();
  });

  it('a permanent failure stops automatic retries', async () => {
    await repo.insertWalk(walk('w1'), []);
    transport.failWith = new SyncException('bad key', 403);
    const s = new SyncService({ store: repo, transport, deviceId: DEVICE, intervalMs: 1000 });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.paused).toBe(true);
    transport.failWith = null;
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.pushes).toHaveLength(0); // no automatic retry while paused
    expect((await s.syncNow()).uploaded).toBe(1); // a manual sync resumes
    await s.close();
  });

  it('close stops the timers', async () => {
    const s = new SyncService({ store: repo, transport, deviceId: DEVICE, intervalMs: 1000 });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    await s.close();
    await repo.insertWalk(walk('late'), []);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.pushes).toHaveLength(0);
  });
});

describe('photos stay on the phone', () => {
  it('a walk with a photo syncs its rows, never the image', async () => {
    await repo.insertWalk(walk('w'), [stop('w-0')]);
    await repo.insertEntry(newEntry({ id: 'e', stopId: 'w-0', recordedAt: 1 }));
    await repo.putWalkPhoto(photo('e'));
    expect(await repo.pendingCount()).toBe(3); // walk + stop + entry; the photo is not a sync item

    await service().syncNow();
    const sent = transport.pushes[0];
    expect(Object.keys(sent).sort()).toEqual(['entry', 'stop', 'walk']);
    const values = [...sent.walk, ...sent.stop, ...sent.entry].flatMap((r) => Object.values(r));
    expect(values.some((v) => v instanceof Uint8Array || ArrayBuffer.isView(v))).toBe(false);
    expect('photo_path' in sent.entry[0]).toBe(false);
    expect(await repo.pendingCount()).toBe(0);
  });

  it('taking or replacing a photo re-uploads only the has_photo flag, never the image', async () => {
    await seed();
    await repo.insertEntry(newEntry({ id: 'e1', stopId: 'w-0', recordedAt: 1 }));
    await repo.insertEntry(newEntry({ id: 'e2', stopId: 'w-1', recordedAt: 1 }));
    await service().syncNow();
    expect(await repo.pendingCount()).toBe(0);

    const flags = async () => Object.fromEntries((await repo.pendingChanges()).entry.map((r) => [r.id as string, r.has_photo]));
    await repo.putWalkPhoto(photo('e1'));
    expect(await flags()).toEqual({ e1: 1 });
    await service().syncNow();

    // Replace at another entry: both entries change, the flag moves.
    await repo.putWalkPhoto(photo('e2'));
    expect(await flags()).toEqual({ e1: 0, e2: 1 });
    await service().syncNow();
    const sent = transport.pushes[transport.pushes.length - 1].entry;
    expect(sent.flatMap((r) => Object.values(r)).some((v) => ArrayBuffer.isView(v))).toBe(false);
  });
});

describe('HTTP transport', () => {
  const batch: SyncBatch = { walk: [{ id: 'w' }], stop: [], entry: [] };

  it('posts JSON with the API key to /v1/sync', async () => {
    let seen: any;
    const t = new HttpSyncTransport('https://sync.example.com/', 'k'.repeat(20), 15000, mockFetch((r) => ((seen = r), json({ ok: true }))));
    await t.push(DEVICE, batch);
    expect(seen.url.toString()).toBe('https://sync.example.com/v1/sync');
    expect(seen.method).toBe('POST');
    expect(seen.headers['x-api-key']).toBe('k'.repeat(20));
    expect(seen.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen.body)).toEqual({ deviceId: DEVICE, walks: [{ id: 'w' }], stops: [], entries: [] });
  });

  it("reads the server's count of rows owned by another install", async () => {
    const t = new HttpSyncTransport('https://x.test', 'k', 15000, mockFetch(() => json({
      ok: true, counts: { walks: { written: 1, skipped: 0, foreign: 2 }, entries: { written: 0, skipped: 0, foreign: 1 } },
    })));
    expect(await t.push(DEVICE, { walk: [], stop: [], entry: [] })).toBe(3);
    expect(await new HttpSyncTransport('https://x.test', 'k', 15000, mockFetch(() => text('not json'))).push(DEVICE, batch)).toBe(0);
    expect(await new HttpSyncTransport('https://x.test', 'k', 15000, mockFetch(() => json({ counts: 5 }))).push(DEVICE, batch)).toBe(0);
  });

  it('maps HTTP errors and network failures to SyncException', async () => {
    const via = (f: Parameters<typeof mockFetch>[0]) => new HttpSyncTransport('https://x.test', 'k', 15000, mockFetch(f));
    await expect(via(() => json({ error: 'invalid api key' }, 401)).push(DEVICE, batch)).rejects.toMatchObject({ isPermanent: true, status: 401 });
    await expect(via(() => text('', 503)).push(DEVICE, batch)).rejects.toMatchObject({ status: 503, isPermanent: false });
    await expect(via(() => offline()).push(DEVICE, batch)).rejects.toMatchObject({ status: undefined });
    await expect(via(() => offline()).push(DEVICE, batch)).rejects.toBeInstanceOf(SyncException);
  });

  it('times out instead of hanging when the network stalls', async () => {
    const t = new HttpSyncTransport('https://x.test', 'k', 50, mockFetch(() => new Promise<Response>(() => {})));
    await expect(t.push(DEVICE, batch)).rejects.toThrow(/timed out/);
  });
});

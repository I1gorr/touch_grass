import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTgDb, type TgDb } from '../src/db/schema';
import { WalkRepo } from '../src/db/walkRepo';
import { OfflinePack, packIdFor, packRadiusFor, reachFor } from '../src/data/offlinePack';
import { OfflinePackStore } from '../src/data/packStore';
import { PackDownloader, PackRefresher } from '../src/data/packDownloader';
import { buildQuery, buildWaysQuery, OverpassClient } from '../src/data/overpass';
import { PlaceStatsClient } from '../src/data/placeStatsClient';
import { NoPackError, RouteService } from '../src/data/routeService';
import { ReportClient, ReportQueue } from '../src/data/reports';
import { describeCode, WeatherService } from '../src/data/weather';
import { loadBundledPack } from '../src/data/bundledPack';
import { budgetM, planRoutes, type PlanJob } from '../src/routing/recommender';
import type { PlaceStats } from '../src/routing/placeStats';
import type { LatLng } from '../src/routing/geo';
import { newStop } from '../src/models/types';
import { Grid } from './grid';
import { json, mockFetch, offline, text } from './helpers';
import { readFileSync } from 'node:fs';

const grid = new Grid(21);
const DAY = 24 * 60 * 60 * 1000;
let n = 0;
let db: TgDb;
let store: OfflinePackStore;
beforeEach(async () => {
  db = await openTgDb(`dt-${++n}`);
  store = new OfflinePackStore(db);
});
afterEach(() => db.close());

const ps = (id: string, o: Partial<PlaceStats> = {}): PlaceStats => ({
  osmId: id, walks: 4, devices: 4, entries: 8, notes: 6, photos: 2, sharedNotes: [], ...o,
});

const packAt = (c: LatLng, radius: number, createdAt = 1000, extra: Partial<OfflinePack> = {}): OfflinePack => ({
  id: packIdFor(c, radius),
  centerLat: c.lat,
  centerLng: c.lng,
  radiusM: radius,
  createdAt,
  pois: grid.pois(),
  ways: grid.ways().slice(0, 10),
  stats: {},
  statsAt: 0,
  communityRadiusM: null,
  ...extra,
});
const fullPack = (radius = 2500) => packAt(grid.center, radius, 1, { ways: grid.ways() });

const overpassBodies = (log?: string[]) =>
  mockFetch((r) => {
    const isWays = r.query!.includes('out geom');
    log?.push(isWays ? 'ways' : 'pois');
    return text(isWays ? grid.overpassWaysBody() : grid.overpassPoisBody());
  });
const overpass = (f = overpassBodies()) => new OverpassClient(f, ['http://x/']);
const failingOverpass = () => new OverpassClient(mockFetch(() => text('busy', 504)), ['http://x/']);

describe('pack sizing', () => {
  it('radius and reach scale with the walk and are clamped', () => {
    expect(packRadiusFor(500)).toBe(800);
    expect(packRadiusFor(2400)).toBe(1380);
    expect(packRadiusFor(50000)).toBe(4000);
    expect(reachFor(2400)).toBeCloseTo(1320, 0);
  });
  it('pack ids are filename-safe', () => expect(packIdFor({ lat: 40.7829, lng: -73.9654 }, 1500)).toBe('40.783_m73.965_1500'));
});

describe('pack store', () => {
  it('round-trips pois and ways and lists metadata', async () => {
    const p = packAt(grid.center, 1500);
    await store.save(p);
    const back = (await store.load(p.id))!;
    expect(back.pois.map((c) => c.osmId)).toEqual(p.pois.map((c) => c.osmId));
    expect(back.pois[0].tags).toEqual(p.pois[0].tags);
    expect(back.ways).toHaveLength(10);
    expect(back.ways[0].coords).toEqual(p.ways[0].coords);
    expect((await store.list())[0]).toMatchObject({ radiusM: 1500 });
  });

  it('findCovering needs the whole reach inside; findContaining only the start', async () => {
    await store.save(packAt(grid.center, 1500));
    expect(await store.findCovering(grid.center, 1000)).not.toBeNull();
    expect(await store.findCovering(grid.center, 2000)).toBeNull();
    const edge = { lat: grid.center.lat + 0.012, lng: grid.center.lng }; // ~1.3 km north
    expect(await store.findCovering(edge, 500)).toBeNull();
    expect(await store.findContaining(edge)).not.toBeNull();
    expect(await store.findContaining({ lat: 50, lng: 8 })).toBeNull();
  });

  it('a bigger pack evicts the smaller packs it contains', async () => {
    await store.save(packAt(grid.center, 800));
    await store.save(packAt(grid.center, 2000));
    expect((await store.list()).map((i) => i.radiusM)).toEqual([2000]);
    expect(await db.getAll('packData')).toHaveLength(1);
    expect(await db.getAll('packStats')).toHaveLength(1);
  });

  it('a pack without its data (incomplete) can be listed but never loads or covers', async () => {
    const p = packAt(grid.center, 1500);
    await store.save(p);
    await db.delete('packData', p.id);
    expect(await store.load(p.id)).toBeNull();
    expect(await store.findCovering(grid.center, 100)).toBeNull();
  });

  it('saving stats replaces only the community data', async () => {
    const p = packAt(grid.center, 1500);
    await store.save(p);
    await store.saveStats(p.id, { 'node/3': ps('node/3') }, 777);
    const back = (await store.load(p.id))!;
    expect(back.stats['node/3'].notes).toBe(6);
    expect(back.statsAt).toBe(777);
    expect(back.ways).toHaveLength(10);
    await store.saveStats('ghost', {}, 1); // unknown pack: quietly nothing
    expect(await db.get('packStats', 'ghost')).toBeUndefined();
  });

  it('packs from before community data existed still load (no stats)', async () => {
    const p = packAt(grid.center, 1500);
    await store.save(p);
    await db.delete('packStats', p.id);
    const back = (await store.load(p.id))!;
    expect(back.stats).toEqual({});
    expect(back.statsAt).toBe(0);
  });
});

describe('overpass client', () => {
  it('posts the query as a form and returns the body', async () => {
    let seen: any;
    const c = new OverpassClient(
      mockFetch((r) => {
        seen = r;
        return text('{"elements":[]}');
      }),
      ['http://a/'],
    );
    expect(await c.fetchRaw(grid.center, 900)).toBe('{"elements":[]}');
    expect(seen.method).toBe('POST');
    expect(seen.query).toBe(buildQuery(grid.center, 900));
    expect(seen.headers['user-agent']).toBeUndefined(); // forbidden header in browsers
  });

  it('falls through to the next mirror on errors, and fails when all do', async () => {
    const hits: string[] = [];
    const c = new OverpassClient(
      mockFetch((r) => {
        hits.push(r.url.host);
        if (r.url.host === 'a') return text('busy', 504);
        if (r.url.host === 'b') return offline();
        if (r.url.host === 'c') return text('<html>rate limited</html>');
        return text('{"elements":[]}');
      }),
      ['http://a/', 'http://b/', 'http://c/', 'http://d/'],
    );
    expect(await c.fetchQuery('q')).toBe('{"elements":[]}');
    expect(hits).toEqual(['a', 'b', 'c', 'd']);
    await expect(overpassAllDown().fetchQuery('q')).rejects.toThrow(/Overpass failed/);
  });

  it('queries cover the places and walkable ways', () => {
    expect(buildQuery(grid.center)).toContain('out center 200');
    expect(buildWaysQuery(grid.center, 700)).toContain('around:700');
    expect(buildWaysQuery(grid.center)).toContain('out geom');
  });
});
const overpassAllDown = () => new OverpassClient(mockFetch(() => offline()), ['http://a/', 'http://b/']);

describe('pack downloader', () => {
  it('fetches pois and ways and saves a pack', async () => {
    const log: string[] = [];
    const d = new PackDownloader(overpass(overpassBodies(log)), store, null, () => 5555);
    const p = await d.download(grid.center, 1200);
    expect(log).toEqual(['pois', 'ways']);
    expect(p.pois).toHaveLength(8);
    expect(p.ways.length).toBeGreaterThan(0);
    expect(p.createdAt).toBe(5555);
    expect((await store.load(p.id))!.ways).toHaveLength(p.ways.length);
  });

  it('a failed download writes nothing and keeps the existing pack', async () => {
    const old = packAt(grid.center, 1200, 5);
    await store.save(old);
    await expect(new PackDownloader(failingOverpass(), store).download(grid.center, 1200)).rejects.toThrow();
    expect((await store.load(old.id))!.createdAt).toBe(5);
    expect(await db.getAll('packs')).toHaveLength(1);
  });

  it('refuses an area with no walkable ways', async () => {
    const noWays = new OverpassClient(mockFetch(() => text('{"elements":[]}')), ['http://x/']);
    await expect(new PackDownloader(noWays, store).download(grid.center, 1200)).rejects.toThrow(/No walkable ways/);
    expect(await store.list()).toEqual([]);
  });
});

describe('pack refresher', () => {
  it('updates only stale packs and survives failures', async () => {
    const now = 100 * DAY;
    await store.save(packAt(grid.center, 1200, now - 59 * DAY));
    const ok = new PackRefresher(store, new PackDownloader(overpass(), store, null, () => now), undefined, undefined, () => now);
    expect(await ok.refreshStale()).toBe(1);
    expect((await store.list())[0].createdAt).toBe(now);
    expect(await ok.refreshStale()).toBe(0); // a fresh pack is left alone

    const later = now + 40 * DAY;
    const broken = new PackRefresher(store, new PackDownloader(failingOverpass(), store), undefined, undefined, () => later);
    expect(await broken.refreshStale()).toBe(0);
    expect((await store.list())[0].createdAt).toBe(now); // old pack kept
  });
});

describe('community stats', () => {
  let statsCalls = 0;
  let serverUp = true;
  let lastUrl: URL | null = null;
  let lastHeaders: Record<string, string> = {};
  beforeEach(() => {
    statsCalls = 0;
    serverUp = true;
    lastUrl = null;
  });
  const statsClient = (key: string | null = null) =>
    new PlaceStatsClient(
      'http://server.test/',
      key,
      mockFetch((r) => {
        statsCalls++;
        lastUrl = r.url;
        lastHeaders = r.headers;
        if (!serverUp) return offline();
        return json({ places: [{ osm_id: 'node/3', walks: 4, devices: 4, entries: 8, notes: 6, photos: 2, shared_notes: [] }] });
      }),
    );
  const downloader = (now = 1000) => new PackDownloader(overpass(), store, statsClient(), () => now);

  it('asks for the chosen area (clamped) with the api key, and parses counts', async () => {
    const list = await statsClient('secret').fetch(grid.center, 1500);
    expect(list[0]).toMatchObject({ osmId: 'node/3', notes: 6 });
    expect(lastUrl!.pathname).toBe('/v1/places');
    expect(lastUrl!.searchParams.get('radius')).toBe('1500');
    expect(lastHeaders['x-api-key']).toBe('secret');
    await statsClient().fetch(grid.center, 99999);
    expect(lastUrl!.searchParams.get('radius')).toBe('5000');
    await statsClient().fetch(grid.center, 5);
    expect(lastUrl!.searchParams.get('radius')).toBe('100');
  });

  it('a non-200 reply is an error', async () => {
    const c = new PlaceStatsClient('http://s', null, mockFetch(() => text('no', 401)));
    await expect(c.fetch(grid.center, 500)).rejects.toThrow(/401/);
  });

  it('download stores community data for the user-chosen area inside the pack', async () => {
    const p = await downloader(1234).download(grid.center, 1500, 800);
    expect(lastUrl!.searchParams.get('radius')).toBe('800');
    const back = (await store.load(p.id))!;
    expect(back.stats['node/3'].notes).toBe(6);
    expect(back.statsAt).toBe(1234);
    expect(back.communityRadiusM).toBe(800);
  });

  it('community radius 0 means do not ask the server at all', async () => {
    const p = await downloader().download(grid.center, 1500, 0);
    expect(statsCalls).toBe(0);
    expect((await store.load(p.id))!.stats).toEqual({});
  });

  it('server down: the pack still downloads, and old community data is kept', async () => {
    const first = await downloader().download(grid.center, 1500);
    serverUp = false;
    const again = await downloader(2000).download(grid.center, 1500);
    expect(Object.keys(again.stats)).toEqual(['node/3']);
    expect(again.statsAt).toBe(0); // not refreshed
    expect((await store.load(first.id))!.stats['node/3']).toBeDefined();
  });

  it('refresher updates community data weekly without re-downloading the map', async () => {
    const created = 100 * DAY;
    await downloader(created).download(grid.center, 1500);
    statsCalls = 0;
    let mapCalls = 0;
    const counting = (now: number) =>
      new PackDownloader(new OverpassClient(mockFetch(() => (mapCalls++, text('{}'))), ['http://x/']), store, statsClient(), () => now);
    const at = (days: number) => created + days * DAY;
    const refresher = new PackRefresher(store, counting(at(8)), undefined, undefined, () => at(8));
    expect(await refresher.refreshStale()).toBe(1);
    expect(mapCalls).toBe(0); // streets are only 8 days old
    expect(statsCalls).toBe(1);
    const info = (await store.list())[0];
    expect(info.statsAt).toBe(at(8));
    expect(info.createdAt).toBe(created);
    expect((await store.load(info.id))!.ways.length).toBeGreaterThan(0);
    expect(await refresher.refreshStale()).toBe(0); // fresh now

    serverUp = false;
    const later = new PackRefresher(store, counting(at(20)), undefined, undefined, () => at(20));
    expect(await later.refreshStale()).toBe(0); // failure keeps what we have
    expect((await store.load(info.id))!.stats['node/3']).toBeDefined();
  });
});

describe('route service', () => {
  let overpassCalls = 0;
  let weatherCalls = 0;
  beforeEach(() => {
    overpassCalls = 0;
    weatherCalls = 0;
  });
  const req = { start: grid.center, minutes: 30 };
  const counted = (fail: boolean) =>
    mockFetch((r) => {
      overpassCalls++;
      if (fail) return offline();
      return text(r.query!.includes('out geom') ? grid.overpassWaysBody() : grid.overpassPoisBody());
    });
  const weather = new WeatherService(
    mockFetch(() => (weatherCalls++, json({ current: { temperature_2m: 12.2, weather_code: 0 } }))),
  );
  const service = (o: { online?: boolean; bundled?: boolean; noDownloader?: boolean; extra?: Partial<ConstructorParameters<typeof RouteService>[0]> } = {}) => {
    const online = o.online ?? true;
    return new RouteService({
      packs: store,
      downloader: o.noDownloader ? null : new PackDownloader(new OverpassClient(counted(!online), ['http://x/']), store),
      weather,
      isOnline: async () => online,
      bundledPack: o.bundled ? async () => fullPack(1500) : undefined,
      clock: () => new Date(2026, 0, 1, 9),
      ...o.extra,
    });
  };

  it('with a downloaded pack, recommending makes no network call at all', async () => {
    await store.save(fullPack());
    const routes = await service({ online: false, noDownloader: true }).recommend(req);
    expect(routes.length).toBeGreaterThan(0);
    expect(overpassCalls).toBe(0);
    expect(weatherCalls).toBe(0);
    const q = routes[0].quest;
    expect(q.walk.id).toHaveLength(32);
    expect(q.walk.weatherSummary).toBe('unknown');
    expect(q.walk.timeOfDay).toBe('morning');
    expect(q.stops.map((s) => s.id)).toEqual(q.stops.map((_, i) => `${q.walk.id}-${i}`));
    expect(q.stops.every((s) => s.prompt !== '' && s.walkId === q.walk.id)).toBe(true);
    expect(new Set(routes.map((r) => r.quest.walk.id)).size).toBe(routes.length);
  });

  it('no pack + online: downloads one for this walk, saves it, then works offline', async () => {
    const first = await service().recommend(req);
    expect(first.length).toBeGreaterThan(0);
    expect(overpassCalls).toBe(2); // pois + ways
    expect(first[0].quest.walk.weatherSummary).toBe('clear, 12°C');
    expect((await store.list())[0].radiusM).toBe(packRadiusFor(budgetM(req)));

    overpassCalls = 0;
    const again = await service({ online: false }).recommend(req);
    expect(again.map((r) => r.option.picks.map((c) => c.osmId))).toEqual(first.map((r) => r.option.picks.map((c) => c.osmId)));
    expect(overpassCalls).toBe(0);
  });

  it('no pack + offline: bundled demo pack, else a clear error', async () => {
    expect((await service({ online: false, bundled: true }).recommend(req)).length).toBeGreaterThan(0);
    expect(weatherCalls).toBe(0); // offline: do not wait on weather
    await expect(service({ online: false }).recommend(req)).rejects.toBeInstanceOf(NoPackError);
  });

  it('a pack that holds the start but is too small is used when offline', async () => {
    await store.save(fullPack(900));
    const routes = await service({ online: false }).recommend(req);
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(r.option.picks.some((c) => c.name === 'Far Statue H')).toBe(false);
  });

  it('feeds pack community data, history and a daily seed into the plan', async () => {
    await store.save({ ...fullPack(), id: 'p', stats: { 'node/3': ps('node/3') }, statsAt: 1 });
    let seen: PlanJob | undefined;
    const svc = service({
      online: false,
      extra: {
        placeHistory: async () => ({ 'node/9': { visits: 2, lastVisitedMs: 5 } }),
        planner: async (job) => ((seen = job), planRoutes(job)),
        clock: () => new Date(Date.UTC(2026, 0, 10, 9)),
      },
    });
    expect((await svc.recommend(req)).length).toBeGreaterThan(0);
    expect(Object.keys(seen!.stats!)).toEqual(['node/3']);
    expect(seen!.history!['node/9'].visits).toBe(2);
    expect(seen!.request.seed).toBe(Math.trunc(Date.UTC(2026, 0, 10, 9) / DAY));
    expect(seen!.nowMs).toBe(Date.UTC(2026, 0, 10, 9));

    await svc.recommend({ ...req, seed: 42 });
    expect(seen!.request.seed).toBe(42); // an explicit seed wins
  });

  it('recalculate skips places and rerolls without touching the network', async () => {
    await store.save(fullPack());
    const svc = service({ online: false });
    const base = await svc.recommend(req);
    const victim = base[0].option.picks[0];
    const next = await svc.recalculate(req, { skip: [victim.osmId] });
    for (const r of next) expect(r.option.picks.some((c) => c.osmId === victim.osmId)).toBe(false);
    const again = await svc.recalculate({ ...req, excludeOsmIds: [victim.osmId] }, { skip: ['node/zzz'], reroll: true });
    for (const r of again) expect(r.quest.walk.routeJson).toContain(victim.osmId); // skipped ids are recorded
    expect(overpassCalls).toBe(0);
  });

  it('end to end: recommend offline -> save -> load from storage', async () => {
    await store.save(fullPack());
    const route = (await service({ online: false }).recommend(req))[0];
    const repo = await WalkRepo.open({ name: `e2e-${++n}` });
    await repo.saveQuest(route.quest);
    const bundle = (await repo.loadWalk(route.quest.walk.id))!;
    expect(bundle.walk.routeJson).toBe(route.quest.walk.routeJson);
    const r = JSON.parse(bundle.walk.routeJson!);
    expect(r).toMatchObject({ mode: 'street', total_m: route.option.legsM.reduce((a, b) => a + b, 0), duration_s: route.option.durationS });
    expect(r.stop_point_index).toHaveLength(route.quest.stops.length);
    expect(bundle.stops.map((s) => s.osmId)).toEqual(route.option.picks.map((c) => c.osmId));
    expect(newStop).toBeTypeOf('function');
    repo.close();
  });
});

describe('report queue and client', () => {
  it('a reported note is hidden at once, queued until sent, and stays hidden', async () => {
    const q = new ReportQueue(db);
    expect(await q.hiddenIds()).toEqual(new Set());
    await q.report('e1', 'spam');
    await q.report('e1', 'other'); // duplicate: ignored
    await q.report('e2');
    expect(await q.pending()).toEqual([{ entryId: 'e1', reason: 'spam' }, { entryId: 'e2', reason: 'other' }]);
    expect(await q.hiddenIds()).toEqual(new Set(['e1', 'e2']));
    await q.markSent('e1');
    expect((await q.pending()).map((p) => p.entryId)).toEqual(['e2']);
    expect(await q.hiddenIds()).toEqual(new Set(['e1', 'e2']));
  });

  it('recovers from a corrupt document', async () => {
    await db.put('kv', { key: 'reports', value: 'garbage' });
    const q = new ReportQueue(db);
    expect(await q.pending()).toEqual([]);
    await q.report('e1');
    expect((await q.pending()).length).toBe(1);
  });

  const client = (q: ReportQueue, handler: (status: number) => number, sent: any[] = []) =>
    new ReportClient('http://s/', q, async () => 'd'.repeat(32), 'k', mockFetch((r) => {
      sent.push({ ...JSON.parse(r.body), key: r.headers['x-api-key'], path: r.url.pathname });
      return text('', handler(sent.length));
    }));

  it('flush posts each report; 202/400/404 are done, anything else stops and keeps the rest', async () => {
    const q = new ReportQueue(db);
    for (const id of ['a', 'b', 'c', 'd']) await q.report(id);
    const sent: any[] = [];
    const statuses = [202, 404, 500, 202];
    const c = client(q, (i) => statuses[i - 1], sent);
    expect(await c.flush()).toBe(1);
    expect(sent.map((s) => s.entryId)).toEqual(['a', 'b', 'c']); // stopped at the 500
    expect(sent[0]).toMatchObject({ deviceId: 'd'.repeat(32), key: 'k', path: '/v1/reports', reason: 'other' });
    expect((await q.pending()).map((p) => p.entryId)).toEqual(['c', 'd']);
  });

  it('flush never throws when offline', async () => {
    const q = new ReportQueue(db);
    await q.report('a');
    const c = new ReportClient('http://s', q, async () => 'd'.repeat(32), null, mockFetch(() => offline()));
    expect(await c.flush()).toBe(0);
    expect(await q.pending()).toHaveLength(1);
  });
});

describe('weather', () => {
  it('summarises the current conditions, and says unknown on any failure', async () => {
    const ok = new WeatherService(mockFetch((r) => (expect(r.url.searchParams.get('latitude')).toBe(`${grid.center.lat}`), json({ current: { temperature_2m: 17.5, weather_code: 61 } }))));
    expect(await ok.snapshot(grid.center)).toBe('rainy, 18°C');
    expect(await new WeatherService(mockFetch(() => text('', 500))).snapshot(grid.center)).toBe('unknown');
    expect(await new WeatherService(mockFetch(() => offline())).snapshot(grid.center)).toBe('unknown');
    expect(await new WeatherService(mockFetch(() => text('not json'))).snapshot(grid.center)).toBe('unknown');
  });

  it('describes weather codes', () => {
    expect([0, 2, 45, 55, 73, 81, 99, 10].map(describeCode)).toEqual(['clear', 'cloudy', 'foggy', 'rainy', 'snowy', 'showers', 'stormy', 'mixed']);
  });
});

describe('bundled demo pack', () => {
  it('loads the shipped Central Park pack', async () => {
    const root = new URL('../public/', import.meta.url);
    const f = mockFetch((r) => text(readFileSync(new URL(r.url.pathname.replace(/^\//, ''), root), 'utf8')));
    const pack = (await loadBundledPack(f, 'http://localhost/'))!;
    expect(pack.id).toBe('bundled-demo');
    expect(pack.ways.length).toBeGreaterThan(1000);
    expect(pack.pois.length).toBeGreaterThan(10);
  });

  it('is null when the data is missing', async () => {
    expect(await loadBundledPack(mockFetch(() => text('', 404)))).toBeNull();
    expect(await loadBundledPack(mockFetch(() => offline()))).toBeNull();
  });
});

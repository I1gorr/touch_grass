import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseOverpass } from '../src/routing/candidate';
import { wayFromJson } from '../src/routing/walkWay';
import { WalkRepo } from '../src/db/walkRepo';
import { ALL_FAKES, DEFAULT_CONFIG, type AppConfig } from '../src/config/config';
import { FAKE_PNG, FakePhotoCapture } from '../src/media/camera';
import { FakeRecorder } from '../src/media/recorder';
import { localWorker, MlClient } from '../src/ml/client';
import { STT_MODELS } from '../src/ml/models';
import { DownloadedModels } from '../src/ml/models.state';
import type { PipelineLoader } from '../src/ml/protocol';
import { MlRuntime } from '../src/ml/runtime';
import type { OfflinePack } from '../src/data/offlinePack';
import { AppServices, type ServiceOverrides } from '../src/services/appServices';
import { WalkController } from '../src/services/walkController';
import type { SyncBatch } from '../src/db/walkRepo';
import type { SyncTransport } from '../src/sync/transport';
import { json, mockFetch, text } from './helpers';

const root = new URL('../public/fallback/', import.meta.url);
const demoPack = (): OfflinePack => ({
  id: 'bundled-demo', centerLat: 40.7829, centerLng: -73.9654, radiusM: 1500, createdAt: 0,
  pois: parseOverpass(readFileSync(new URL('demo_overpass.json', root), 'utf8')),
  ways: (JSON.parse(readFileSync(new URL('demo_ways.json', root), 'utf8')) as any[]).map(wayFromJson),
  stats: {}, statsAt: 0, communityRadiusM: null,
});
const files = mockFetch((r) => {
  const name = r.url.pathname.split('/').pop()!;
  try {
    return text(readFileSync(new URL(name, root), 'utf8'));
  } catch {
    return text('', 404);
  }
});

let n = 0;
const open: AppServices[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.dispose().catch(() => undefined);
});
async function make(config: AppConfig, o: ServiceOverrides = {}) {
  const repo = o.repo ?? (await WalkRepo.open({ name: `app-${++n}` }));
  const s = await AppServices.create(config, {
    repo, client: null, fetch: files, bundledPack: async () => demoPack(), downloaded: new DownloadedModels(null),
    recorder: new FakeRecorder(), photos: new FakePhotoCapture(), onlineEvents: () => () => {}, ...o,
  });
  open.push(s);
  return s;
}

describe('app services', () => {
  it('builds from the settings and says what is real and what is simulated', async () => {
    const s = await make({ ...ALL_FAKES, fakeDevices: true });
    expect(s.kinds).toEqual({
      'Language model': 'Sample', 'Speech-to-text': 'Sample', Places: 'Bundled map (Central Park)', Routes: 'Streets',
      Weather: 'Sample', 'Mic and camera': 'Simulated', 'Cloud backup': 'Off',
    });
    const real = await make({ ...DEFAULT_CONFIG, fakeQuest: true });
    expect(real.kinds['Language model']).toBe('Pre-written');
    expect(real.kinds['Speech-to-text']).toBe('Not downloaded');
    expect(real.kinds.Places).toBe('Bundled map (Central Park)');
  });

  it('turns the settings into a route request: stops cap and "vary routes"', async () => {
    const s = await make({ ...DEFAULT_CONFIG, fakeQuest: true, walkMinutes: 45, maxStops: 4, communityRadiusM: 500, routeVariety: true });
    expect(s.requestFor()).toEqual({
      start: DEFAULT_CONFIG.demoCoords, minutes: 45, options: 3, communityRadiusM: 500, maxStops: 4, seed: undefined,
    });
    const fixed = await make({ ...DEFAULT_CONFIG, fakeQuest: true, routeVariety: false });
    expect(fixed.requestFor().seed).toBe(0); // the same places every time
  });

  it('plans offline from the bundled map, saves the quest, and runs a whole walk', async () => {
    const s = await make({ ...ALL_FAKES, maxStops: 3 });
    const routes = await s.routes.recommend(s.requestFor());
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(r.option.picks.length).toBeLessThanOrEqual(3);
    const { walk, stops } = routes[0].quest;
    await s.repo.saveQuest({ walk, stops: stops.map((x) => ({ ...x, blurb: 'b' })) });

    const c = new WalkController({ walkId: walk.id, repo: s.repo, pipeline: s.pipeline, recorder: s.recorder, photos: s.photos });
    await c.load();
    await c.toggleRecording();
    await c.toggleRecording();
    await s.pipeline.drain();
    await c.takePhoto();
    expect(await c.finish()).toBe(true);
    const journal = (await s.repo.loadWalk(walk.id))!;
    expect(journal.walk.status).toBe('done');
    const entry = journal.entriesByStop[journal.stops[0].id][0];
    expect(entry.cleanedText).toBe('So the light here is really nice and the bench is still wet from the rain.');
    expect((await s.repo.walkPhoto(walk.id))!.bytes).toEqual(FAKE_PNG);
    c.dispose();
  });

  it('after a walk is done, the places are remembered and rotated out', async () => {
    const s = await make({ ...ALL_FAKES, routeVariety: false });
    const first = (await s.routes.recommend(s.requestFor()))[0];
    await s.repo.saveQuest(first.quest);
    await s.repo.setStatus(first.quest.walk.id, 'done');
    const again = (await s.routes.recommend(s.requestFor()))[0];
    const visited = new Set(first.option.picks.map((p) => p.osmId));
    expect(again.option.picks.filter((p) => visited.has(p.osmId)).length).toBeLessThan(first.option.picks.length);
  });
});

describe('a voice note recorded before the speech model exists', () => {
  /** A client whose "worker" runs a fake model loader, so downloads and transcription are real code paths. */
  function modelWorld() {
    const loader: PipelineLoader = async (kind, o) => {
      if (!o.allowDownload && !downloadedOnDisk.has(o.model)) throw new Error('not in cache');
      if (o.allowDownload) {
        o.onProgress({ file: 'm.onnx', loaded: 1, total: 2 });
        o.onProgress({ file: 'm.onnx', loaded: 2, total: 2 });
        downloadedOnDisk.add(o.model);
      }
      return {
        run: async () => (kind === 'stt' ? { text: 'the fountain is lovely', segments: [] } : 'x'),
        dispose: async () => {},
      };
    };
    const downloadedOnDisk = new Set<string>();
    const runtime = new MlRuntime(loader);
    return new MlClient(localWorker((req, emit) => runtime.handle(req, emit)));
  }

  it('is kept, waits, and becomes text once the model is downloaded', async () => {
    const client = modelWorld();
    const downloaded = new DownloadedModels(null);
    const memory = new Map<string, string>();
    const persistent = new DownloadedModels({ getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) });
    void downloaded;
    const s = await make({ ...DEFAULT_CONFIG, fakeQuest: true, llmMode: 'fallback' }, { client, downloaded: persistent });
    expect(s.ml.sttKind).toBe('unavailable');

    const route = (await s.routes.recommend(s.requestFor()))[0];
    await s.repo.saveQuest(route.quest);
    const c = new WalkController({ walkId: route.quest.walk.id, repo: s.repo, pipeline: s.pipeline, recorder: s.recorder, photos: s.photos });
    await c.load();
    await c.toggleRecording();
    await c.toggleRecording();
    await s.pipeline.drain();
    const id = (await s.repo.entriesForWalk(route.quest.walk.id))[0].id;
    expect(s.pipeline.stateOf(id)).toBe('waiting');
    expect((await s.repo.getEntry(id))!.rawTranscript).toBeNull();
    expect(await s.recordings.ids()).toEqual([id]); // the audio is safe

    // Download the model (what the Settings button does), then switch the engines over.
    await s.models.download(STT_MODELS[0]);
    expect(s.models.status(STT_MODELS[0])).toEqual({ state: 'ready' });
    await s.refreshEngines();
    expect(s.ml.sttKind).toBe('device');
    await s.pipeline.drain();

    const e = (await s.repo.getEntry(id))!;
    expect([e.rawTranscript, e.cleanedText]).toEqual(['the fountain is lovely', 'The fountain is lovely.']);
    expect(s.pipeline.stateOf(id)).toBeUndefined();
    expect(await s.recordings.ids()).toEqual([]);
    c.dispose();
  });
});

describe('backup and going back online', () => {
  const recording = () => {
    const pushes: SyncBatch[] = [];
    const transport: SyncTransport = { push: async (_d, b) => (pushes.push(b), 0), close: async () => {} };
    return { pushes, transport };
  };

  it('uploads a saved quest when a sync transport is configured', async () => {
    const { pushes, transport } = recording();
    const s = await make({ ...ALL_FAKES }, { syncTransport: transport });
    expect(s.kinds['Cloud backup']).toBe('On');
    const route = (await s.routes.recommend(s.requestFor()))[0];
    await s.repo.saveQuest(route.quest);
    await s.sync!.syncNow();
    expect(pushes.flatMap((b) => b.walk.map((w) => w.id))).toContain(route.quest.walk.id);
    expect(await s.repo.pendingCount()).toBe(0);
  });

  it('coming back online syncs, but never while a walk is in progress', async () => {
    const { pushes, transport } = recording();
    let online!: () => void;
    const s = await make({ ...DEFAULT_CONFIG, fakeQuest: false }, { syncTransport: transport, onlineEvents: (cb) => ((online = cb), () => {}), fetch: mockFetch(() => json({}, 404)) });
    // No network (every request 404s): the bundled map still plans the walk.
    const route = (await s.routes.recommend({ ...s.requestFor(), communityRadiusM: 0 }))[0];
    expect(route).toBeDefined();
    await s.repo.saveQuest(route.quest);
    await s.repo.setStatus(route.quest.walk.id, 'active');
    const before = pushes.length;
    online();
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes.length).toBe(before); // a walk never touches the network
    await s.repo.setStatus(route.quest.walk.id, 'done');
    online();
    await vi.waitFor(() => expect(pushes.length).toBeGreaterThan(before));
  });

  it('rebuilding with new settings keeps the same database', async () => {
    const s = await make({ ...ALL_FAKES });
    const route = (await s.routes.recommend(s.requestFor()))[0];
    await s.repo.saveQuest(route.quest);
    const next = await AppServices.create({ ...ALL_FAKES, walkMinutes: 60 }, {
      repo: s.repo, client: null, fetch: files, bundledPack: async () => demoPack(), downloaded: new DownloadedModels(null), onlineEvents: () => () => {},
    });
    open.push(next);
    await s.dispose({ keepRepo: true });
    expect((await next.repo.listWalks()).map((w) => w.id)).toEqual([route.quest.walk.id]);
    expect(next.requestFor().minutes).toBe(60);
  });
});

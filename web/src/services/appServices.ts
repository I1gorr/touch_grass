import { loadBundledPack } from '../data/bundledPack';
import type { OfflinePack } from '../data/offlinePack';
import { OfflinePackStore } from '../data/packStore';
import { PackDownloader, PackRefresher } from '../data/packDownloader';
import { OverpassClient } from '../data/overpass';
import { PlaceStatsClient } from '../data/placeStatsClient';
import { ReportClient, ReportQueue } from '../data/reports';
import { RouteService } from '../data/routeService';
import { WeatherService } from '../data/weather';
import { RecordingStore } from '../db/recordingStore';
import { WalkRepo } from '../db/walkRepo';
import { type AppConfig, syncEnabled } from '../config/config';
import { CameraPhotoCapture, FakePhotoCapture, type PhotoCapture } from '../media/camera';
import { FakeRecorder, MicRecorder, type VoiceRecorder } from '../media/recorder';
import type { MlClient } from '../ml/client';
import { createMlServices, type MlServices } from '../ml/factory';
import { FallbackLlm } from '../ml/fallbackLlm';
import { ModelManager } from '../ml/modelManager';
import { DownloadedModels } from '../ml/models.state';
import { PromptSet } from '../ml/prompts';
import { createWorkerClient } from '../ml/workerClient';
import { planRoutesInWorker } from '../routing/planClient';
import type { RouteRequest } from '../routing/recommender';
import { SyncService } from '../sync/syncService';
import { HttpSyncTransport, type SyncTransport } from '../sync/transport';
import { engineLabel } from '../ui/copy';
import { EntryPipeline } from './entryPipeline';
import { browserOnline, OnlineTasks } from './onlineTasks';

/** Swap any single piece without touching the rest. Unset fields are built from the config. */
export interface ServiceOverrides {
  repo?: WalkRepo;
  /** `null` = no model worker (tests). Leave unset to start the real one. */
  client?: MlClient | null;
  /** Which models are downloaded. Default: remembered in localStorage. */
  downloaded?: DownloadedModels;
  recorder?: VoiceRecorder;
  photos?: PhotoCapture;
  syncTransport?: SyncTransport;
  fetch?: typeof fetch;
  bundledPack?: () => Promise<OfflinePack | null>;
  /** Called each time the connection comes back. Default: the browser's `online` event. */
  onlineEvents?: (cb: () => void) => () => void;
}

export class AppServices {
  private constructor(
    readonly config: AppConfig,
    readonly repo: WalkRepo,
    readonly recordings: RecordingStore,
    readonly client: MlClient | null,
    readonly downloaded: DownloadedModels,
    readonly models: ModelManager,
    public ml: MlServices,
    readonly recorder: VoiceRecorder,
    readonly photos: PhotoCapture,
    readonly pipeline: EntryPipeline,
    readonly routes: RouteService,
    readonly reports: ReportQueue,
    readonly sync: SyncService | null,
    private readonly online: OnlineTasks | null,
    private readonly mlDeps: { fallback: FallbackLlm; prompts: PromptSet },
    private readonly ownsClient: boolean,
  ) {}

  /** `recoverPending` resumes recordings interrupted by closing the app; only the first build at startup should do this. */
  static async create(config: AppConfig, o: ServiceOverrides = {}, opts: { recoverPending?: boolean } = {}): Promise<AppServices> {
    const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const repo = o.repo ?? (await WalkRepo.open());
    const recordings = new RecordingStore(repo.db);
    const ownsClient = o.client === undefined;
    const client = o.client === undefined ? createWorkerClient() : o.client;
    const downloaded = o.downloaded ?? new DownloadedModels();
    const [fallback, prompts] = await Promise.all([FallbackLlm.load(f), PromptSet.load(f, import.meta.env?.VITE_PROMPTS_URL || undefined)]);

    const ml = createMlServices({ config, client, downloaded, fallback, prompts });
    ml.warmUp();
    const models = new ModelManager(
      () => {
        if (!client) throw new Error('On-device models are not supported in this browser.');
        return client;
      },
      downloaded,
      () => config.ml,
    );

    const pipeline = new EntryPipeline(repo, ml.stt, ml.tasks, recordings);

    // Cloud backup: only when a server address is set.
    let sync: SyncService | null = null;
    if (syncEnabled(config) || o.syncTransport) {
      sync = new SyncService({
        store: repo,
        transport: o.syncTransport ?? new HttpSyncTransport(config.syncUrl, config.syncApiKey, undefined, f),
        deviceId: await repo.deviceId(),
        onChange: (fn) => repo.onChange(fn),
        ownsTransport: !o.syncTransport,
        // A walk never touches the network.
        walkInProgress: () => repo.hasActiveWalk(),
      });
      sync.start();
    }

    // Street routing over offline map packs, community notes, reports. In sample mode nothing touches the network.
    const network = !config.fakeQuest;
    const api = network && syncEnabled(config) ? config.syncUrl : null;
    const key = config.syncApiKey || null;
    const packs = new OfflinePackStore(repo.db);
    const reports = new ReportQueue(repo.db);
    const placeStats = api ? new PlaceStatsClient(api, key, f) : null;
    const downloader = network ? new PackDownloader(new OverpassClient(f), packs, placeStats) : null;
    const refresher = downloader ? new PackRefresher(packs, downloader) : null;
    const reportClient = api ? new ReportClient(api, reports, () => repo.deviceId(), key, f) : null;

    let bundled: OfflinePack | null | undefined;
    const bundledPack = o.bundledPack ?? (async () => (bundled === undefined ? (bundled = await loadBundledPack(f, import.meta.env?.BASE_URL ?? '/')) : bundled));
    const routes = new RouteService({
      packs,
      downloader,
      weather: network ? new WeatherService(f) : null,
      isOnline: async () => navigator.onLine,
      bundledPack,
      placeHistory: () => repo.placeHistory(),
      reportQueue: reports,
      planner: planRoutesInWorker,
    });

    let online: OnlineTasks | null = null;
    if (network) {
      online = new OnlineTasks({ walkInProgress: () => repo.hasActiveWalk(), sync, reports: reportClient, refresher });
      online.start(o.onlineEvents ?? browserOnline);
    }

    const services = new AppServices(
      config, repo, recordings, client, downloaded, models, ml,
      o.recorder ?? (config.fakeDevices ? new FakeRecorder() : new MicRecorder()),
      o.photos ?? (config.fakeDevices ? new FakePhotoCapture() : new CameraPhotoCapture()),
      pipeline, routes, reports, sync, online, { fallback, prompts }, ownsClient,
    );
    if (opts.recoverPending) {
      pipeline.recoverPending().then(
        (ids) => ids.length > 0 && console.info(`[pipeline] resumed ${ids.length} interrupted recordings`),
        (e) => console.warn('[pipeline] recovery failed:', e),
      );
    }
    return services;
  }

  /** What is real and what is simulated, for the Settings screen. */
  get kinds(): Record<string, string> {
    const c = this.config;
    return {
      'Language model': engineLabel(this.ml.llmKind),
      'Speech-to-text': engineLabel(this.ml.sttKind),
      Places: c.fakeQuest ? 'Bundled map (Central Park)' : 'OpenStreetMap',
      Routes: 'Streets',
      Weather: c.fakeQuest ? 'Sample' : 'Live',
      'Mic and camera': c.fakeDevices ? 'Simulated' : 'Device',
      'Cloud backup': this.sync ? 'On' : 'Off',
    };
  }

  /** A route request built from the settings. */
  requestFor(): RouteRequest {
    const c = this.config;
    return {
      start: c.demoCoords,
      minutes: c.walkMinutes,
      options: 3,
      communityRadiusM: c.communityRadiusM,
      maxStops: c.maxStops,
      // "Vary routes" off = the same places every time for the same area (scripted demos).
      seed: c.routeVariety ? undefined : 0,
    };
  }

  /**
   * Rebuilds the speech and language engines, e.g. after a model finished downloading, and resumes voice notes
   * that were waiting for the speech model.
   */
  async refreshEngines(): Promise<void> {
    this.ml = createMlServices({ config: this.config, client: this.client, downloaded: this.downloaded, ...this.mlDeps });
    this.ml.warmUp();
    this.pipeline.setEngines(this.ml.stt, this.ml.tasks);
    await this.pipeline.recoverPending();
  }

  /** Releases everything. `keepRepo` leaves the database (and the model worker) open for the next build. */
  async dispose(opts: { keepRepo?: boolean } = {}): Promise<void> {
    this.online?.stop();
    await this.sync?.close(); // waits for an in-flight upload
    await this.pipeline.drain();
    await this.recorder.dispose();
    if (!opts.keepRepo) {
      if (this.ownsClient) this.client?.terminate();
      this.repo.close();
    }
  }
}

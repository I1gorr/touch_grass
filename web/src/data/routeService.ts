import { type PlanJob, planRoutes, type RouteOption, type RouteRequest, budgetM, toRouteJson } from '../routing/recommender';
import type { PlaceHistory } from '../routing/placeStats';
import type { PreparedQuest, Stop } from '../models/types';
import type { WalkWay } from '../routing/walkWay';
import { newId, stopIdFor } from '../util/ids';
import { timeOfDayFor } from '../util/stopFacts';
import { type OfflinePack, packRadiusFor, reachFor, packCovers } from './offlinePack';
import type { OfflinePackStore } from './packStore';
import type { PackDownloader } from './packDownloader';
import { promptForCandidate } from './prompts';
import type { ReportQueue } from './reports';
import type { WeatherService } from './weather';

/** No downloaded area covers the start and the network is not available to get one. */
export class NoPackError extends Error {
  override name = 'NoPackError';
}

/** A recommendation ready to show (`option`) and to save (`quest`) if the person picks it. */
export interface RecommendedRoute {
  option: RouteOption;
  quest: PreparedQuest;
  /** The downloaded local street network used to create this route. */
  mapWays: WalkWay[];
}

export interface RouteServiceDeps {
  packs: OfflinePackStore;
  /** Null = never touch the network. */
  downloader?: PackDownloader | null;
  weather?: WeatherService | null;
  /** Quick connectivity check used only to decide whether to ask for the weather. */
  isOnline?: () => Promise<boolean>;
  bundledPack?: () => Promise<OfflinePack | null>;
  /** This person's past visits (e.g. `repo.placeHistory`), used to rotate recommendations. */
  placeHistory?: () => Promise<Record<string, PlaceHistory>>;
  /** Notes this person reported are hidden from the review cards, even offline. */
  reportQueue?: ReportQueue;
  planner?: (job: PlanJob) => Promise<RouteOption[]>;
  clock?: () => Date;
  idGenerator?: () => string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Default seed: the day number, so the same request rotates through places from day to day. */
const daySeed = (t: Date) => Math.trunc(t.getTime() / DAY_MS);

/**
 * "Where should I walk for 30 minutes?" - works offline once a pack covers the start.
 * Order of data sources: downloaded pack -> download one (if online) -> bundled demo pack -> any pack containing the start.
 */
export class RouteService {
  private readonly planner: (job: PlanJob) => Promise<RouteOption[]>;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(private readonly d: RouteServiceDeps) {
    this.planner = d.planner ?? (async (job) => planRoutes(job));
    this.clock = d.clock ?? (() => new Date());
    this.idGenerator = d.idGenerator ?? newId;
  }

  /** Returns up to `request.options` loops, best first. Throws NoPackError if there is no data at all. */
  recommend(request: RouteRequest): Promise<RecommendedRoute[]> {
    return this.run(request, true);
  }

  /**
   * The person read the community notes and wants something different: skip some places and/or ask for a
   * fresh set of options. Runs on the data already on the phone, so it works in airplane mode.
   */
  recalculate(request: RouteRequest, o: { skip?: Iterable<string>; reroll?: boolean } = {}): Promise<RecommendedRoute[]> {
    const base = request.seed ?? daySeed(this.clock());
    return this.run(
      { ...request, excludeOsmIds: [...new Set([...(request.excludeOsmIds ?? []), ...(o.skip ?? [])])], seed: o.reroll ? base + 1 : base },
      false,
    );
  }

  private async run(request: RouteRequest, allowDownload: boolean): Promise<RecommendedRoute[]> {
    const budget = budgetM(request);
    const reach = reachFor(budget);
    const { packs, downloader, weather } = this.d;
    let downloaded = false;

    let pack = await packs.findCovering(request.start, reach);
    if (!pack && allowDownload && downloader) {
      try {
        pack = await downloader.download(request.start, packRadiusFor(budget), request.communityRadiusM ?? null);
        downloaded = true;
      } catch {
        /* offline: use what is on the phone */
      }
    }
    if (!pack) {
      const bundled = await this.d.bundledPack?.();
      if (bundled && packCovers(bundled, request.start, reach)) pack = bundled;
    }
    pack ??= await packs.findContaining(request.start);
    if (!pack) {
      const bundled = await this.d.bundledPack?.();
      if (bundled && packCovers(bundled, request.start, 0)) pack = bundled;
    }
    if (!pack) throw new NoPackError('No offline map covers this location. Connect to the internet to download one.');

    const now = this.clock();
    const history = (await this.d.placeHistory?.()) ?? {};
    const seeded: RouteRequest = request.seed != null ? request : { ...request, seed: daySeed(now) };
    const options = await this.planner({
      pois: pack.pois,
      ways: pack.ways,
      request: seeded,
      stats: pack.stats,
      history,
      hiddenNoteIds: [...((await this.d.reportQueue?.hiddenIds()) ?? [])],
      nowMs: now.getTime(),
    });

    let weatherSummary = 'unknown';
    if (weather && (downloaded || ((await this.d.isOnline?.()) ?? false))) {
      weatherSummary = await weather.snapshot(request.start);
    }

    return options.map((o) => {
      const walkId = this.idGenerator();
      const stops: Stop[] = o.picks.map((c, i) => ({
        id: stopIdFor(walkId, i),
        walkId,
        position: i,
        osmId: c.osmId,
        name: c.name,
        lat: c.lat,
        lng: c.lng,
        tagsJson: JSON.stringify(c.tags),
        blurb: '',
        prompt: promptForCandidate(c),
      }));
      return {
        option: o,
        mapWays: pack.ways,
        quest: {
          walk: {
            id: walkId,
            createdAt: now.getTime(),
            startLat: request.start.lat,
            startLng: request.start.lng,
            timeOfDay: timeOfDayFor(now),
            weatherSummary,
            status: 'ready' as const,
            routeJson: toRouteJson(o, seeded),
          },
          stops,
        },
      };
    });
  }
}

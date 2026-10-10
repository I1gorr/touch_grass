import { parseOverpass } from '../routing/candidate';
import type { LatLng } from '../routing/geo';
import type { PlaceStats } from '../routing/placeStats';
import { parseWays } from '../routing/walkWay';
import { type OfflinePack, type PackInfo, packIdFor } from './offlinePack';
import type { OfflinePackStore } from './packStore';
import { buildQuery, buildWaysQuery, type OverpassClient } from './overpass';
import type { PlaceStatsClient } from './placeStatsClient';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Downloads POIs and the walking network around a point and saves them as an offline pack.
 * Needs the network. If anything fails nothing is written and any existing pack is untouched.
 */
export class PackDownloader {
  constructor(
    private readonly overpass: OverpassClient,
    private readonly store: OfflinePackStore,
    private readonly placeStats: PlaceStatsClient | null = null,
    private readonly clock: () => number = Date.now,
    private readonly waysTimeoutMs = 60_000,
  ) {}

  /** `communityRadiusM` is the area the user chose for community data (null = the whole pack). */
  async download(center: LatLng, radiusM: number, communityRadiusM: number | null = null): Promise<OfflinePack> {
    const poiBody = await this.overpass.fetchQuery(buildQuery(center, radiusM, 500));
    const waysBody = await this.overpass.fetchQuery(buildWaysQuery(center, radiusM), this.waysTimeoutMs);
    const pois = parseOverpass(poiBody);
    const ways = parseWays(waysBody);
    if (ways.length === 0) throw new Error(`No walkable ways found around ${center.lat}, ${center.lng}`);
    const id = packIdFor(center, radiusM);
    let stats: Record<string, PlaceStats> = {};
    let statsAt = 0;
    // Community data is a bonus: if it can't be fetched keep what the old pack had (or nothing).
    if (this.placeStats && communityRadiusM !== 0) {
      try {
        const list = await this.placeStats.fetch(center, communityRadiusM ?? radiusM);
        stats = Object.fromEntries(list.map((p) => [p.osmId, p]));
        statsAt = this.clock();
      } catch {
        stats = await this.store.loadStats(id);
      }
    }
    const pack: OfflinePack = {
      id,
      centerLat: center.lat,
      centerLng: center.lng,
      radiusM,
      createdAt: this.clock(),
      pois,
      ways,
      stats,
      statsAt,
      communityRadiusM,
    };
    await this.store.save(pack);
    return pack;
  }

  /** Re-fetches only the community data of a saved pack. Returns false if it could not (offline, no client). */
  async refreshStats(info: PackInfo): Promise<boolean> {
    if (!this.placeStats || info.communityRadiusM === 0) return false;
    try {
      const list = await this.placeStats.fetch({ lat: info.centerLat, lng: info.centerLng }, info.communityRadiusM ?? info.radiusM);
      await this.store.saveStats(info.id, Object.fromEntries(list.map((p) => [p.osmId, p])), this.clock());
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Re-downloads packs older than `maxAgeMs`. Call when the internet is available.
 * A failed refresh keeps the old pack, so offline use is never made worse.
 */
export class PackRefresher {
  constructor(
    private readonly store: OfflinePackStore,
    private readonly downloader: PackDownloader,
    private readonly maxAgeMs = 30 * DAY,
    /** Community data changes faster than streets, so it is refreshed on its own, more often. */
    private readonly statsMaxAgeMs = 7 * DAY,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Returns how many packs (or their community data) were refreshed. */
  async refreshStale(): Promise<number> {
    let refreshed = 0;
    const now = this.clock();
    for (const info of await this.store.list()) {
      if (info.createdAt < now - this.maxAgeMs) {
        try {
          await this.downloader.download({ lat: info.centerLat, lng: info.centerLng }, info.radiusM, info.communityRadiusM);
          refreshed++;
        } catch {
          /* offline or busy: keep the old pack, try next time */
        }
      } else if (info.statsAt < now - this.statsMaxAgeMs && (await this.downloader.refreshStats(info))) {
        refreshed++;
      }
    }
    return refreshed;
  }
}

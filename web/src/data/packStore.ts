import type { TgDb } from '../db/schema';
import type { LatLng } from '../routing/geo';
import { wayFromJson, wayToJson } from '../routing/walkWay';
import { infoOfManifest, manifestOf, type OfflinePack, type PackInfo, packCovers } from './offlinePack';

/**
 * Packs in IndexedDB: a small manifest, the map data and the community stats are separate records, so
 * listing is cheap and a stats refresh never rewrites the map. A pack is saved in ONE transaction, so a
 * crash or a failed refresh never leaves a half-written pack or destroys the previous one.
 */
export class OfflinePackStore {
  constructor(private readonly db: TgDb) {}

  async save(pack: OfflinePack): Promise<void> {
    const tx = this.db.transaction(['packs', 'packData', 'packStats'], 'readwrite');
    await tx.objectStore('packData').put({ id: pack.id, pois: pack.pois, ways: pack.ways.map(wayToJson) });
    await tx.objectStore('packStats').put({ id: pack.id, stats: Object.values(pack.stats) });
    await tx.objectStore('packs').put(manifestOf(pack)); // the manifest marks the pack complete
    await tx.done;
    await this.evictCovered(pack);
  }

  /** A new pack makes the packs it fully contains redundant. */
  private async evictCovered(pack: OfflinePack): Promise<void> {
    for (const info of await this.list()) {
      if (info.id === pack.id) continue;
      if (packCovers(pack, { lat: info.centerLat, lng: info.centerLng }, info.radiusM)) await this.delete(info.id);
    }
  }

  /** Metadata of every complete pack, newest first. */
  async list(): Promise<PackInfo[]> {
    const all = (await this.db.getAll('packs')).map(infoOfManifest);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async load(id: string): Promise<OfflinePack | null> {
    try {
      const m = await this.db.get('packs', id);
      const data = await this.db.get('packData', id);
      if (!m || !data) return null;
      const info = infoOfManifest(m);
      return { ...info, pois: data.pois, ways: data.ways.map(wayFromJson), stats: await this.loadStats(id) };
    } catch {
      return null;
    }
  }

  /** Packs saved before community data existed have no stats row: that just means no stats. */
  async loadStats(id: string): Promise<OfflinePack['stats']> {
    try {
      const row = await this.db.get('packStats', id);
      return Object.fromEntries((row?.stats ?? []).map((s) => [s.osmId, s]));
    } catch {
      return {};
    }
  }

  /** Replaces only the community data (cheap: the map data is untouched). */
  async saveStats(id: string, stats: OfflinePack['stats'], statsAt: number): Promise<void> {
    const tx = this.db.transaction(['packs', 'packStats'], 'readwrite');
    const m = await tx.objectStore('packs').get(id);
    if (!m) {
      await tx.done;
      return;
    }
    await tx.objectStore('packStats').put({ id, stats: Object.values(stats) });
    await tx.objectStore('packs').put({ ...m, stats_at: statsAt });
    await tx.done;
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction(['packs', 'packData', 'packStats'], 'readwrite');
    await Promise.all([tx.objectStore('packs').delete(id), tx.objectStore('packData').delete(id), tx.objectStore('packStats').delete(id)]);
    await tx.done;
  }

  /** The newest pack in which a walk reaching `reachM` from `start` stays inside the downloaded area. */
  async findCovering(start: LatLng, reachM: number): Promise<OfflinePack | null> {
    for (const info of await this.list()) {
      if (packCovers(info, start, reachM)) {
        const p = await this.load(info.id);
        if (p) return p;
      }
    }
    return null;
  }

  /** Pack whose area contains `start` but is too small for the walk (better than nothing when offline). */
  findContaining(start: LatLng): Promise<OfflinePack | null> {
    return this.findCovering(start, 0);
  }
}

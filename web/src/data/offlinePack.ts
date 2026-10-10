import type { Candidate } from '../routing/candidate';
import { distanceMeters, type LatLng } from '../routing/geo';
import type { PlaceStats } from '../routing/placeStats';
import type { WalkWay } from '../routing/walkWay';
import type { PackManifest } from '../db/schema';

/**
 * A downloaded area: points of interest plus the walking network, like an offline map region.
 * Lives in IndexedDB (not the synced tables) and is never synced.
 */
export interface OfflinePack {
  id: string;
  centerLat: number;
  centerLng: number;
  radiusM: number;
  /** ms since epoch when the data was downloaded. */
  createdAt: number;
  pois: Candidate[];
  ways: WalkWay[];
  /** Community counts per place, for the area the user chose. Empty if none were fetched. */
  stats: Record<string, PlaceStats>;
  /** ms since epoch when `stats` were fetched (0 = never). */
  statsAt: number;
  /** Radius the community data was fetched for (the user's chosen area); null = the whole pack. */
  communityRadiusM: number | null;
}

/** Pack metadata without the (large) data files. */
export interface PackInfo {
  id: string;
  centerLat: number;
  centerLng: number;
  radiusM: number;
  createdAt: number;
  statsAt: number;
  communityRadiusM: number | null;
}

export const packIdFor = (center: LatLng, radiusM: number): string =>
  `${center.lat.toFixed(3)}_${center.lng.toFixed(3)}_${radiusM}`.replaceAll('-', 'm');

/** True if a walk of `reachM` from `start` stays inside this area. */
export const packCovers = (p: Pick<PackInfo, 'centerLat' | 'centerLng' | 'radiusM'>, start: LatLng, reachM: number): boolean =>
  distanceMeters(p.centerLat, p.centerLng, start.lat, start.lng) + reachM <= p.radiusM;

export const manifestOf = (p: OfflinePack): PackManifest => ({
  v: 1,
  id: p.id,
  center_lat: p.centerLat,
  center_lng: p.centerLng,
  radius_m: p.radiusM,
  created_at: p.createdAt,
  poi_count: p.pois.length,
  way_count: p.ways.length,
  stats_at: p.statsAt,
  community_radius_m: p.communityRadiusM,
});

export const infoOfManifest = (m: PackManifest): PackInfo => ({
  id: m.id,
  centerLat: m.center_lat,
  centerLng: m.center_lng,
  radiusM: m.radius_m,
  createdAt: m.created_at,
  statsAt: m.stats_at ?? 0,
  communityRadiusM: m.community_radius_m ?? null,
});

/**
 * Pack radius for a loop of `budgetM`: the farthest useful stop is about half the loop away, plus 15%
 * for streets that are not straight. Clamped to what Overpass will serve comfortably.
 */
export const packRadiusFor = (budgetM: number): number => Math.max(800, Math.min(4000, Math.ceil((budgetM / 2) * 1.15)));

/** How far from the start a loop of `budgetM` can reach (what a pack must cover). */
export const reachFor = (budgetM: number): number => (budgetM / 2) * 1.1;

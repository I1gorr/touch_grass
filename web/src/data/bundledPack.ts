import { parseOverpass } from '../routing/candidate';
import { wayFromJson } from '../routing/walkWay';
import type { Fetch } from './http';
import type { OfflinePack } from './offlinePack';

export const BUNDLED_WAYS_URL = 'fallback/demo_ways.json';
export const BUNDLED_POIS_URL = 'fallback/demo_overpass.json';
export const BUNDLED_RADIUS_M = 1500;

/** Placeholder demo coordinates (Central Park, NYC). */
export const DEMO_LOCATION = { lat: 40.7829, lng: -73.9654 };

/**
 * The demo area shipped with the app (and precached by the service worker), so recommendations work on
 * a fresh install with no internet. Returns null if the data can't be read.
 */
export async function loadBundledPack(f: Fetch = (...a) => fetch(...a), base = ''): Promise<OfflinePack | null> {
  try {
    const [waysRes, poisRes] = await Promise.all([f(base + BUNDLED_WAYS_URL), f(base + BUNDLED_POIS_URL)]);
    if (!waysRes.ok || !poisRes.ok) return null;
    const ways = ((await waysRes.json()) as any[]).map(wayFromJson);
    const pois = parseOverpass(await poisRes.text());
    return {
      id: 'bundled-demo',
      centerLat: DEMO_LOCATION.lat,
      centerLng: DEMO_LOCATION.lng,
      radiusM: BUNDLED_RADIUS_M,
      createdAt: 0,
      pois,
      ways,
      stats: {},
      statsAt: 0,
      communityRadiusM: null,
    };
  } catch {
    return null;
  }
}

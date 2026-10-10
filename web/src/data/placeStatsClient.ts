import type { LatLng } from '../routing/geo';
import { type PlaceStats, statsFromJson } from '../routing/placeStats';
import { type Fetch, fetchWithTimeout, trimSlash } from './http';

/** Max area the server will answer for. */
export const MAX_COMMUNITY_RADIUS_M = 5000;

/**
 * Fetches community counts for an area from the server (`GET /v1/places`).
 * Needs internet; only used while downloading or refreshing a pack, never during a walk.
 */
export class PlaceStatsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null = null,
    private readonly f: Fetch = (...a) => fetch(...a),
    private readonly timeoutMs = 10_000,
  ) {}

  async fetch(center: LatLng, radiusM: number): Promise<PlaceStats[]> {
    const r = Math.min(MAX_COMMUNITY_RADIUS_M, Math.max(100, radiusM));
    const q = new URLSearchParams({ lat: `${center.lat}`, lng: `${center.lng}`, radius: `${r}` });
    const res = await fetchWithTimeout(
      this.f,
      `${trimSlash(this.baseUrl)}/v1/places?${q}`,
      { headers: this.apiKey ? { 'x-api-key': this.apiKey } : {} },
      this.timeoutMs,
    );
    if (res.status !== 200) throw new Error(`places HTTP ${res.status}`);
    const body = (await res.json()) as { places?: unknown[] };
    return (body.places ?? []).map(statsFromJson);
  }
}

import type { LatLng } from '../routing/geo';
import { type Fetch, fetchWithTimeout } from './http';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export function buildQuery(l: LatLng, radius = 1200, limit = 200): string {
  const a = `(around:${radius},${l.lat},${l.lng})`;
  return (
    '[out:json][timeout:25];(' +
    `nwr["leisure"~"^(park|garden)$"]["name"]${a};` +
    `nwr["tourism"~"^(artwork|viewpoint|attraction)$"]["name"]${a};` +
    `nwr["historic"]["name"]${a};` +
    `nwr["amenity"~"^(fountain|place_of_worship)$"]["name"]${a};` +
    `nwr["man_made"~"^(tower|bridge)$"]["name"]${a};` +
    `);out center ${limit};`
  );
}

/** Walkable ways around `l` with full geometry (node ids + coordinates), for the offline routing graph. */
export function buildWaysQuery(l: LatLng, radius = 1200): string {
  return (
    '[out:json][timeout:60];(' +
    'way["highway"]["highway"!~"^(motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway|bus_guideway|corridor|elevator|escape|platform)$"]' +
    `["foot"!="no"]["access"!~"^(private|no)$"](around:${radius},${l.lat},${l.lng});` +
    ');out geom;'
  );
}

export class OverpassClient {
  constructor(
    private readonly f: Fetch = (...a) => fetch(...a),
    private readonly endpoints: string[] = OVERPASS_ENDPOINTS,
    private readonly timeoutMs = 12_000,
  ) {}

  /** Returns the raw JSON body. Tries each endpoint; throws if all fail. */
  fetchRaw(l: LatLng, radius = 1200): Promise<string> {
    return this.fetchQuery(buildQuery(l, radius));
  }

  /**
   * Runs any Overpass QL query. Big queries (routing ways) pass a longer timeout.
   * (Browsers forbid setting `User-Agent`, so none is sent.)
   */
  async fetchQuery(query: string, timeoutMs = this.timeoutMs): Promise<string> {
    let last: unknown;
    for (const url of this.endpoints) {
      try {
        const res = await fetchWithTimeout(
          this.f,
          url,
          { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: query }) },
          timeoutMs,
        );
        const body = await res.text();
        if (res.status === 200 && body.trimStart().startsWith('{')) return body;
        last = `HTTP ${res.status}`;
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`Overpass failed: ${last}`);
  }
}

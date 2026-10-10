import { roundHalfAway } from './geo';

/**
 * One walkable OSM way in the compact form stored in an offline pack:
 * `{id, h: highway class, n: [node ids], g: [lat, lon, lat, lon, ...]}`.
 */
export interface WalkWay {
  id: number;
  highway: string;
  nodes: number[];
  /** Flat lat/lon pairs, same length as `nodes * 2`. */
  coords: number[];
}

export interface WalkWayJson {
  id: number;
  h: string;
  n: number[];
  g: number[];
}

export const wayToJson = (w: WalkWay): WalkWayJson => ({ id: w.id, h: w.highway, n: w.nodes, g: w.coords });
export const wayFromJson = (j: WalkWayJson): WalkWay => ({ id: j.id, highway: j.h, nodes: j.n, coords: j.g });

const EXCLUDED = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'construction', 'proposed', 'raceway',
  'bus_guideway', 'corridor', 'elevator', 'escape', 'platform', 'bus_stop', 'rest_area', 'services',
]);

const round6 = (v: number) => roundHalfAway(v * 1e6) / 1e6;

/**
 * Parses an Overpass `out geom` body of highway ways into compact ways.
 * Drops non-walkable ways (motorways, `foot=no`, private access, ...) and broken geometry.
 */
export function parseWays(body: string): WalkWay[] {
  const data = JSON.parse(body) as { elements?: any[] };
  const out: WalkWay[] = [];
  for (const m of data.elements ?? []) {
    if (m.type !== 'way') continue;
    const tags = m.tags ?? {};
    const h = tags.highway;
    if (typeof h !== 'string' || EXCLUDED.has(h)) continue;
    if (tags.foot === 'no' || tags.access === 'private' || tags.access === 'no') continue;
    const nodes: number[] | undefined = m.nodes;
    const geom: any[] | undefined = m.geometry;
    if (!nodes || !geom || nodes.length < 2 || nodes.length !== geom.length) continue;
    const coords: number[] = [];
    let ok = true;
    for (const g of geom) {
      if (!g || g.lat == null || g.lon == null) {
        ok = false;
        break;
      }
      coords.push(round6(g.lat), round6(g.lon));
    }
    if (!ok) continue;
    out.push({ id: m.id, highway: h, nodes: [...nodes], coords });
  }
  return out;
}

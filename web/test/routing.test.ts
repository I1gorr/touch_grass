import { beforeEach, describe, expect, it } from 'vitest';
import { categoryOf } from '../src/routing/candidate';
import { distanceMeters, type LatLng } from '../src/routing/geo';
import { decodePolyline, encodePolyline, simplifyIndices } from '../src/routing/polyline';
import {
  budgetM,
  recommendRoutes,
  type RouteRequest,
  toRouteJson,
  totalM,
  WALK_SPEED_MPS,
} from '../src/routing/recommender';
import { astar, dijkstra } from '../src/routing/router';
import { WalkGraph } from '../src/routing/walkGraph';
import { parseWays, wayFromJson, wayToJson } from '../src/routing/walkWay';
import { Grid } from './grid';

const grid = new Grid(21);
let graph: WalkGraph;
beforeEach(() => {
  graph = WalkGraph.fromWays(grid.ways());
});

const inRange = (v: number, lo: number, hi: number) => {
  expect(v).toBeGreaterThanOrEqual(lo);
  expect(v).toBeLessThanOrEqual(hi);
};

describe('polyline', () => {
  it('round-trips to 1e-5 degrees', () => {
    const pts: LatLng[] = [
      { lat: 40.7829, lng: -73.9654 },
      { lat: 40.78301, lng: -73.96612 },
      { lat: -33.8688, lng: 151.2093 },
    ];
    const back = decodePolyline(encodePolyline(pts));
    pts.forEach((p, i) => {
      expect(Math.abs(back[i].lat - p.lat)).toBeLessThanOrEqual(1e-5);
      expect(Math.abs(back[i].lng - p.lng)).toBeLessThanOrEqual(1e-5);
    });
  });

  it('matches the encoding of the Google reference example', () => {
    const pts: LatLng[] = [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ];
    expect(encodePolyline(pts)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('simplify drops collinear points but keeps required indices', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ lat: 40 + i * 0.0001, lng: -73 }));
    expect(simplifyIndices(pts, 2)).toEqual([0, 19]);
    expect(simplifyIndices(pts, 2, new Set([7]))).toEqual([0, 7, 19]);
  });
});

describe('graph + router', () => {
  it('nearest node snaps within range, rejects far points', () => {
    const s = graph.nearestNode(grid.latAt(10) + 0.0001, grid.lngAt(10))!;
    expect(s.distM).toBeLessThan(15);
    expect(graph.nearestNode(41.0, -73.9654)).toBeNull();
  });

  it('A* finds the Manhattan distance on a grid and matches Dijkstra', () => {
    const a = graph.nearestNode(grid.latAt(2), grid.lngAt(2))!.node;
    const b = graph.nearestNode(grid.latAt(12), grid.lngAt(7))!.node;
    const p = astar(graph, a, b)!;
    expect(Math.abs(p.lengthM - 15 * 100)).toBeLessThanOrEqual(15);
    const dj = dijkstra(graph, a);
    expect(dj.cost[b]).toBeCloseTo(p.cost, 6);
    expect(dj.len[b]).toBeCloseTo(p.lengthM, 6);
  });

  it('routes around a wall and prefers footpaths over a busy road of equal length', () => {
    const wall = WalkGraph.fromWays(grid.ways('footway', (r1, c1, _r2, c2) => c1 === 10 && c2 === 11 && r1 < 20));
    const a = wall.nearestNode(grid.latAt(10), grid.lngAt(8))!.node;
    const b = wall.nearestNode(grid.latAt(10), grid.lngAt(12))!.node;
    expect(astar(wall, a, b)!.lengthM).toBeGreaterThan(1500); // must detour via row 20
    const busy = WalkGraph.fromWays(grid.ways('primary'));
    const x = busy.nearestNode(grid.latAt(10), grid.lngAt(8))!.node;
    const y = busy.nearestNode(grid.latAt(10), grid.lngAt(12))!.node;
    const p = astar(busy, x, y)!;
    expect(p.cost).toBeCloseTo(p.lengthM * 1.7, 6);
  });

  it('islands are excluded by the reachability mask', () => {
    const ways = [
      ...grid.ways(),
      { id: 999999, highway: 'footway', nodes: [9000001, 9000002], coords: [40.9, -73.9, 40.9005, -73.9] },
    ];
    const g = WalkGraph.fromWays(ways);
    const start = g.nearestNode(grid.latAt(10), grid.lngAt(10))!.node;
    const mask = g.reachableFrom(start);
    expect(g.nearestNode(40.9, -73.9, { mask })).toBeNull();
    expect(g.nearestNode(40.9, -73.9)).not.toBeNull();
    expect(astar(g, start, g.nearestNode(40.9, -73.9)!.node)).toBeNull();
  });

  it('parseWays keeps walkable highways and drops motorways, foot=no and private', () => {
    const body = `{"elements":[
      {"type":"way","id":1,"nodes":[1,2],"geometry":[{"lat":1,"lon":2},{"lat":1.001,"lon":2}],"tags":{"highway":"footway"}},
      {"type":"way","id":2,"nodes":[2,3],"geometry":[{"lat":1,"lon":2},{"lat":1.001,"lon":2}],"tags":{"highway":"motorway"}},
      {"type":"way","id":3,"nodes":[2,3],"geometry":[{"lat":1,"lon":2},{"lat":1.001,"lon":2}],"tags":{"highway":"service","access":"private"}},
      {"type":"way","id":4,"nodes":[2,3],"geometry":[{"lat":1,"lon":2},{"lat":1.001,"lon":2}],"tags":{"highway":"residential","foot":"no"}},
      {"type":"way","id":5,"nodes":[2,3],"tags":{"highway":"path"}},
      {"type":"node","id":6,"lat":1,"lon":2}]}`;
    const ways = parseWays(body);
    expect(ways.map((w) => w.id)).toEqual([1]);
    expect(wayFromJson(wayToJson(ways[0])).coords).toEqual(ways[0].coords);
  });
});

describe('recommender', () => {
  const req = (o: Partial<RouteRequest> = {}): RouteRequest => ({ start: grid.center, minutes: 30, ...o });
  const ids = (os: ReturnType<typeof recommendRoutes>) => os.map((o) => o.picks.map((c) => c.osmId));

  it('30 min loop: starts and ends at the start, fits the budget, 3-4 stops', () => {
    const r = req();
    const opts = recommendRoutes({ pois: grid.pois(), request: r, graph });
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.length).toBeLessThanOrEqual(3);
    for (const o of opts) {
      expect(o.mode).toBe('street');
      inRange(o.picks.length, 3, 4);
      inRange(totalM(o), 0.7 * budgetM(r), 1.1 * budgetM(r));
      expect(o.points[0].lat).toBe(grid.center.lat);
      expect(o.points[o.points.length - 1].lat).toBe(grid.center.lat);
      expect(o.legsM.length).toBe(o.picks.length + 1);
      expect(o.stopPointIndex.length).toBe(o.picks.length);
      o.picks.forEach((c, i) => {
        const p = o.points[o.stopPointIndex[i]];
        expect(distanceMeters(p.lat, p.lng, c.lat, c.lng)).toBeLessThan(60);
      });
      expect(Math.abs(o.durationS - totalM(o) / WALK_SPEED_MPS)).toBeLessThanOrEqual(1);
    }
  });

  it('options differ, are ranked best first, and results are deterministic', () => {
    const a = recommendRoutes({ pois: grid.pois(), request: req(), graph });
    const b = recommendRoutes({ pois: grid.pois().reverse(), request: req(), graph });
    expect(ids(a)).toEqual(ids(b));
    expect(new Set(a.map((o) => o.picks.map((c) => c.osmId).sort().join())).size).toBe(a.length);
    for (let i = 1; i < a.length; i++) expect(a[i - 1].score).toBeGreaterThanOrEqual(a[i].score);
  });

  it('distance input drives the length; at most 2 stops per category', () => {
    const r: RouteRequest = { start: grid.center, distanceM: 1500 };
    for (const o of recommendRoutes({ pois: grid.pois(), request: r, graph })) {
      inRange(totalM(o), 1050, 1650);
      const counts = new Map<string, number>();
      for (const c of o.picks) counts.set(categoryOf(c), (counts.get(categoryOf(c)) ?? 0) + 1);
      expect([...counts.values()].every((n) => n <= 2)).toBe(true);
    }
  });

  it('a longer walk time never gives a shorter best route', () => {
    const short = recommendRoutes({ pois: grid.pois(), request: req({ minutes: 15 }), graph });
    const long = recommendRoutes({ pois: grid.pois(), request: req({ minutes: 45 }), graph });
    expect(short.length).toBeGreaterThan(0);
    expect(long.length).toBeGreaterThan(0);
    expect(totalM(long[0])).toBeGreaterThan(totalM(short[0]));
  });

  it('far-away places are not picked for a short walk', () => {
    for (const o of recommendRoutes({ pois: grid.pois(), request: req({ minutes: 20 }), graph })) {
      expect(o.picks.some((c) => c.name === 'Far Statue H')).toBe(false);
    }
  });

  it('without a graph it falls back to straight-line legs', () => {
    const opts = recommendRoutes({ pois: grid.pois(), request: req() });
    expect(opts.length).toBeGreaterThan(0);
    expect(opts[0].mode).toBe('straight');
    expect(opts[0].points.length).toBe(opts[0].picks.length + 2);
  });

  it('a start far from the network finds nothing within reach', () => {
    const r: RouteRequest = { start: { lat: 40.79, lng: -73.9 }, minutes: 30 };
    const far = [grid.poi('Near Start', 10, 10, { amenity: 'fountain' })];
    expect(recommendRoutes({ pois: far, request: r, graph })).toEqual([]);
  });

  it('nothing nearby gives an empty list', () => {
    expect(recommendRoutes({ pois: [], request: req(), graph })).toEqual([]);
  });

  it('route_json fits the sync limit and decodes back', () => {
    const big = new Grid(120, 20); // dense geometry
    const g = WalkGraph.fromWays(big.ways());
    const r: RouteRequest = { start: big.center, distanceM: 4000 };
    const opts = recommendRoutes({ pois: big.pois(), request: r, graph: g });
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      const s = toRouteJson(o, r);
      expect(s.length).toBeLessThan(20000);
      expect(decodePolyline(JSON.parse(s).polyline).length).toBe(o.points.length);
    }
  });

  it('requires minutes or distance', () => {
    expect(() => budgetM({ start: grid.center })).toThrow();
  });
});

describe('maxStops', () => {
  const r = (o: Partial<RouteRequest>): RouteRequest => ({ start: grid.center, minutes: 30, ...o });
  it('caps the stops, and leaves the default alone when unset', () => {
    const uncapped = recommendRoutes({ pois: grid.pois(), request: r({}), graph });
    expect(Math.max(...uncapped.map((o) => o.picks.length))).toBeGreaterThanOrEqual(3);
    const capped = recommendRoutes({ pois: grid.pois(), request: r({ maxStops: 2 }), graph });
    expect(capped.length).toBeGreaterThan(0);
    for (const o of capped) expect(o.picks.length).toBeLessThanOrEqual(2);
  });
});

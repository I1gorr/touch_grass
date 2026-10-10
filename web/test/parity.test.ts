import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOverpass } from '../src/routing/candidate';
import type { PlaceHistory, PlaceStats } from '../src/routing/placeStats';
import { seededUnit } from '../src/routing/placeValue';
import { planRoutes, recommendRoutes, type RouteOption, toRouteJson, totalM } from '../src/routing/recommender';
import { encodePolyline } from '../src/routing/polyline';
import { WalkGraph } from '../src/routing/walkGraph';
import { wayFromJson } from '../src/routing/walkWay';
import { Grid } from './grid';

/**
 * Reference output of the Dart planner (scripts/web_parity/dump.dart). Regenerate with:
 *   dart run scripts/web_parity/dump.dart web/test/fixtures/dart_parity.json
 */
const dart = JSON.parse(readFileSync(new URL('./fixtures/dart_parity.json', import.meta.url), 'utf8'));

const day = 24 * 60 * 60 * 1000;
const now = 100 * day;

const summary = (o: RouteOption) => ({
  picks: o.picks.map((c) => c.osmId),
  legsM: o.legsM,
  totalM: totalM(o),
  stopPointIndex: o.stopPointIndex,
  pointCount: o.points.length,
  polyline: encodePolyline(o.points),
  durationS: o.durationS,
  mode: o.mode,
  reasons: o.reasons,
});
const expectSame = (actual: RouteOption[], ref: any[]) => {
  expect(actual.map(summary)).toEqual(ref.map(({ score: _s, ...r }) => r));
  actual.forEach((o, i) => expect(o.score).toBeCloseTo(ref[i].score, 9));
};

describe('parity with the Dart planner', () => {
  it('seededUnit gives the same values', () => {
    for (const [k, v] of Object.entries<number>(dart.seeded)) {
      const i = k.indexOf(':');
      expect(seededUnit(Number(k.slice(0, i)), k.slice(i + 1))).toBe(v);
    }
  });

  describe('grid', () => {
    const grid = new Grid(21);
    const graph = WalkGraph.fromWays(grid.ways());
    const byName = Object.fromEntries(grid.pois().map((c) => [c.name, c.osmId]));
    const stats = (osmId: string, o: Partial<PlaceStats>): PlaceStats => ({
      osmId, walks: 5, devices: 5, entries: 0, notes: 0, photos: 0, sharedNotes: [], ...o,
    });
    const run = (o: { seed?: number; stats?: Record<string, PlaceStats>; history?: Record<string, PlaceHistory>; radius?: number } = {}) =>
      recommendRoutes({
        pois: grid.pois(),
        request: { start: grid.center, minutes: 30, seed: o.seed ?? 0, communityRadiusM: o.radius },
        graph,
        stats: o.stats,
        history: o.history,
        nowMs: now,
      });
    const loved = { [byName['Chapel E']]: stats(byName['Chapel E'], { walks: 12, devices: 12, notes: 30, photos: 12 }) };

    it('seeds 0-9', () => {
      for (let s = 0; s < 10; s++) expectSame(run({ seed: s }), dart.gridSeeds[s]);
    });
    it('community data and radius', () => {
      expectSame(run({ stats: loved }), dart.gridLoved);
      expectSame(run({ stats: loved, radius: 100 }), dart.gridLovedRadius100);
      expectSame(run({ stats: loved, radius: 2000 }), dart.gridLovedRadius2000);
    });
    it('history', () => {
      const visited = Object.fromEntries(
        (dart.gridSeeds[0][0].picks as string[]).map((id) => [id, { visits: 1, lastVisitedMs: now - day }]),
      );
      expectSame(run({ history: visited }), dart.gridVisited);
    });
    it('straight-line fallback and distance budget', () => {
      expectSame(
        recommendRoutes({ pois: grid.pois(), request: { start: grid.center, minutes: 30 }, nowMs: now }),
        dart.gridStraight,
      );
      expectSame(
        recommendRoutes({ pois: grid.pois(), request: { start: grid.center, distanceM: 1500 }, graph, nowMs: now }),
        dart.gridDistance1500,
      );
    });
  });

  describe('real pack', () => {
    const root = new URL('../public/fallback/', import.meta.url);
    const ways = (JSON.parse(readFileSync(new URL('demo_ways.json', root), 'utf8')) as any[]).map(wayFromJson);
    const pois = parseOverpass(readFileSync(new URL('demo_overpass.json', root), 'utf8'));
    const demo = { lat: 40.7829, lng: -73.9654 };

    for (const minutes of [20, 30, 75]) {
      for (const seed of [0, 1, 2]) {
        it(`${minutes} min, seed ${seed}`, () => {
          const routes = planRoutes({ pois, ways, request: { start: demo, minutes, seed }, nowMs: now });
          expectSame(routes, dart.real[`${minutes}/${seed}`]);
        });
      }
    }

    it('route_json is byte-identical', () => {
      const r = { start: demo, minutes: 30, seed: 0 };
      const routes = planRoutes({ pois, ways, request: r, nowMs: now });
      expect(routes.map((o) => toRouteJson(o, r))).toEqual(dart.realRouteJson);
    });
  });
});

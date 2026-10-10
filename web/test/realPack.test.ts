import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOverpass } from '../src/routing/candidate';
import { distanceMeters } from '../src/routing/geo';
import { decodePolyline } from '../src/routing/polyline';
import { budgetM, planRoutes, type RouteRequest, toRouteJson, totalM } from '../src/routing/recommender';
import { WalkGraph } from '../src/routing/walkGraph';
import { wayFromJson } from '../src/routing/walkWay';

// Real OpenStreetMap data recorded around the demo location (web/public/fallback).
const root = new URL('../public/fallback/', import.meta.url);
const ways = (JSON.parse(readFileSync(new URL('demo_ways.json', root), 'utf8')) as any[]).map(wayFromJson);
const pois = parseOverpass(readFileSync(new URL('demo_overpass.json', root), 'utf8'));
const demo = { lat: 40.7829, lng: -73.9654 };

const inRange = (v: number, lo: number, hi: number) => {
  expect(v).toBeGreaterThanOrEqual(lo);
  expect(v).toBeLessThanOrEqual(hi);
};

describe('real pack', () => {
  it('graph builds quickly from a real pack and the start is on it', () => {
    const t = performance.now();
    const g = WalkGraph.fromWays(ways);
    expect(performance.now() - t).toBeLessThan(3000);
    expect(g.nodeCount).toBeGreaterThan(5000);
    expect(g.nearestNode(demo.lat, demo.lng)).not.toBeNull();
  });

  it('30 min loop on real streets: right length, back at the start, stored JSON small', () => {
    const r: RouteRequest = { start: demo, minutes: 30 };
    const t = performance.now();
    const opts = planRoutes({ pois, ways, request: r });
    expect(performance.now() - t).toBeLessThan(3000);
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(o.mode).toBe('street');
      inRange(totalM(o), 0.7 * budgetM(r), 1.1 * budgetM(r));
      inRange(o.picks.length, 3, 4);
      inRange(Math.trunc(o.durationS / 60), 20, 34);
      expect(o.points[0]).toEqual(demo);
      expect(o.points[o.points.length - 1]).toEqual(demo);
      for (const p of o.points) expect(distanceMeters(demo.lat, demo.lng, p.lat, p.lng)).toBeLessThan(1800);
      // Street routes have far more points than the straight start-stops-start line.
      expect(o.points.length).toBeGreaterThan(o.picks.length + 2);
      const json = toRouteJson(o, r);
      expect(json.length).toBeLessThan(20000);
      expect(decodePolyline(JSON.parse(json).polyline).length).toBe(o.points.length);
    }
  });

  it('a longer walk visits more stops but never exceeds 6', () => {
    const run = (minutes: number) => planRoutes({ pois, ways, request: { start: demo, minutes } });
    const short = run(20);
    const long = run(75);
    expect(long[0].picks.length).toBeGreaterThanOrEqual(short[0].picks.length);
    expect(long[0].picks.length).toBeLessThanOrEqual(6);
    expect(totalM(long[0])).toBeGreaterThan(totalM(short[0]));
  });
});

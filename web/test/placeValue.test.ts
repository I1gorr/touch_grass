import { describe, expect, it } from 'vitest';
import { categoryOf } from '../src/routing/candidate';
import type { PlaceHistory, PlaceStats } from '../src/routing/placeStats';
import { blendedValue, crowdValue, freshness, jitter, reasonFor, seededUnit } from '../src/routing/placeValue';
import { recommendRoutes } from '../src/routing/recommender';
import { WalkGraph } from '../src/routing/walkGraph';
import { Grid } from './grid';

const day = 24 * 60 * 60 * 1000;
const now = 100 * day;

const stats = (osmId: string, o: Partial<PlaceStats> = {}): PlaceStats => ({
  osmId,
  walks: 5,
  devices: 5,
  entries: 0,
  notes: 0,
  photos: 0,
  sharedNotes: [],
  ...o,
});

describe('place value', () => {
  it('no community data: the category weight is used unchanged', () => {
    expect(blendedValue(3, null)).toBe(3);
    expect(blendedValue(3, stats('x', { devices: 0 }))).toBe(3);
  });

  it('many memories pull the value up, empty visits pull it down, more people = more pull', () => {
    const loved = stats('x', { walks: 10, devices: 10, notes: 20, photos: 10 });
    const boring = stats('x', { walks: 10, devices: 10 });
    expect(crowdValue(loved)).toBeCloseTo(5, 9);
    expect(crowdValue(boring)).toBeCloseTo(1, 9);
    expect(blendedValue(3, loved)).toBeGreaterThan(4);
    expect(blendedValue(3, boring)).toBeLessThan(2);
    const one = stats('x', { walks: 1, devices: 1, notes: 3 });
    const ten = stats('x', { walks: 10, devices: 10, notes: 30 });
    expect(blendedValue(2, one) - 2).toBeLessThan(blendedValue(2, ten) - 2);
    expect(blendedValue(2, one)).toBeLessThan(3.0);
  });

  it('freshness: new places first, recent repeats last, never zero', () => {
    expect(freshness(null, now)).toBe(1);
    const h = (visits: number, ago: number): PlaceHistory => ({ visits, lastVisitedMs: now - ago * day });
    const longAgo = freshness(h(1, 90), now);
    const recent = freshness(h(1, 1), now);
    const often = freshness(h(30, 1), now);
    expect(longAgo).toBeLessThan(1);
    expect(recent).toBeLessThan(longAgo);
    expect(often).toBeGreaterThanOrEqual(0.15);
  });

  it('seeded random: deterministic, in range, varies by seed and place, smaller with more data', () => {
    expect(seededUnit(7, 'node/1')).toBe(seededUnit(7, 'node/1'));
    const us = Array.from({ length: 200 }, (_, s) => seededUnit(s, 'node/1'));
    expect(us.every((u) => u >= 0 && u < 1)).toBe(true);
    expect(new Set(us).size).toBeGreaterThan(150);
    expect(seededUnit(1, 'node/1')).not.toBe(seededUnit(1, 'node/2'));
    const spread0 = Array.from({ length: 200 }, (_, s) => jitter(s, 'node/1', null));
    const spread5 = Array.from({ length: 200 }, (_, s) => jitter(s, 'node/1', stats('node/1', { devices: 5 })));
    const range = (l: number[]) => Math.max(...l) - Math.min(...l);
    expect(range(spread0)).toBeGreaterThan(0.4);
    expect(range(spread5)).toBeLessThan(range(spread0) / 3);
  });

  it('reasons read well for both cases', () => {
    expect(reasonFor(null, null, now)).toBe('no community data yet; new to you');
    expect(
      reasonFor(stats('x', { devices: 1, notes: 1, photos: 0 }), { visits: 2, lastVisitedMs: now - 3 * day }, now),
    ).toBe('1 person visited, 1 note, 0 photos; you visited 2x, last 3 days ago');
  });
});

describe('recommender with community data, history and seed', () => {
  const grid = new Grid(21);
  const graph = WalkGraph.fromWays(grid.ways());
  const byName = Object.fromEntries(grid.pois().map((c) => [c.name, c.osmId]));
  const run = (
    o: { seed?: number; stats?: Record<string, PlaceStats>; history?: Record<string, PlaceHistory>; communityRadiusM?: number } = {},
  ) =>
    recommendRoutes({
      pois: grid.pois(),
      request: { start: grid.center, minutes: 30, seed: o.seed ?? 0, communityRadiusM: o.communityRadiusM },
      graph,
      stats: o.stats ?? {},
      history: o.history ?? {},
      nowMs: now,
    }).map((r) => r.picks.map((c) => c.name));

  it('same seed gives the same answer; different seeds rotate the options', () => {
    expect(run({ seed: 3 })).toEqual(run({ seed: 3 }));
    const tops = new Set(Array.from({ length: 10 }, (_, s) => run({ seed: s })[0].join('|')));
    expect(tops.size).toBeGreaterThan(1);
  });

  it('with no data at all you still get full routes (round robin + random fallback)', () => {
    const r = run();
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].length).toBeGreaterThanOrEqual(3);
    expect(r[0].length).toBeLessThanOrEqual(4);
  });

  const lovedPlace = () => {
    const base = run({ seed: 0 })[0];
    return ['Chapel E', 'Park F', 'Old Gate G', 'Garden D', 'Fountain A'].find((n) => !base.includes(n))!;
  };
  const loved = (name = lovedPlace()) => ({
    [byName[name]]: stats(byName[name], { walks: 12, devices: 12, notes: 30, photos: 12 }),
  });

  it('a place people love moves into the best route', () => {
    const name = lovedPlace();
    expect(run({ seed: 0 })[0]).not.toContain(name);
    expect(run({ seed: 0, stats: loved(name) })[0]).toContain(name);
  });

  it('a place people found empty is dropped from the best route', () => {
    // Every place is empty-rated in turn; at least one of the best route's picks must be replaceable
    // (a tiny map can force some picks), and a replaced pick must not stay.
    const base = run({ seed: 0 })[0];
    const dropped = base.filter((victim) => {
      const empty = { [byName[victim]]: stats(byName[victim], { walks: 12, devices: 12 }) };
      return !run({ seed: 0, stats: empty })[0].includes(victim);
    });
    expect(dropped.length).toBeGreaterThan(0);
  });

  it('only community data inside the chosen area counts', () => {
    // The loved place is hundreds of metres from the start: a 100 m area or 0 (off) ignores it.
    const name = lovedPlace();
    expect(run({ seed: 0, stats: loved(name), communityRadiusM: 100 })).toEqual(run({ seed: 0 }));
    expect(run({ seed: 0, stats: loved(name), communityRadiusM: 0 })).toEqual(run({ seed: 0 }));
    expect(run({ seed: 0, stats: loved(name), communityRadiusM: 2000 })[0]).toContain(name);
  });

  it('places you just visited are rotated out, not banned', () => {
    const base = run({ seed: 0 })[0];
    const visited = Object.fromEntries(base.map((n) => [byName[n], { visits: 1, lastVisitedMs: now - day }]));
    const next = run({ seed: 0, history: visited })[0];
    expect(new Set(next)).not.toEqual(new Set(base));
    expect(next.filter((n) => !base.includes(n)).length).toBeGreaterThan(0);
  });

  it('reasons are given per pick', () => {
    const opts = recommendRoutes({
      pois: grid.pois(),
      request: { start: grid.center, minutes: 30, seed: 0 },
      graph,
      stats: { [byName['Mural B']]: stats(byName['Mural B'], { devices: 3, notes: 4, photos: 1 }) },
      nowMs: now,
    });
    for (const o of opts) {
      expect(o.reasons.length).toBe(o.picks.length);
      expect(o.reasons.every((r) => r.endsWith('new to you'))).toBe(true);
    }
    const withMural = opts.find((o) => o.picks.some((c) => c.name === 'Mural B'))!;
    const i = withMural.picks.findIndex((c) => c.name === 'Mural B');
    expect(withMural.reasons[i].startsWith('3 people visited, 4 notes, 1 photo')).toBe(true);
    expect(categoryOf(withMural.picks[i])).toBe('tourism=artwork');
  });
});

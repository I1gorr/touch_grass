import { type Candidate, categoryOf, categoryWeight, filterCandidates } from './candidate';
import { distanceMeters, type LatLng } from './geo';
import { type PlaceCard, placeCardOf } from './placeCard';
import type { PlaceHistory, PlaceStats } from './placeStats';
import { placeValue } from './placeValue';
import { encodePolyline, simplifyIndices } from './polyline';
import { astar, dijkstra } from './router';
import { WalkGraph } from './walkGraph';
import type { WalkWay } from './walkWay';

/** Default walking pace, about 4.8 km/h. */
export const WALK_SPEED_MPS = 1.34;

/** What the person asked for: a walk of about `minutes` or `distanceM`, looping back to the start. */
export interface RouteRequest {
  start: LatLng;
  minutes?: number;
  distanceM?: number;
  speedMps?: number;
  /** How many ranked alternatives to return. */
  options?: number;
  /** Seed for the random nudge. Same seed = same recommendations; change it to rotate them. */
  seed?: number;
  /** Only community data from places within this many metres of the start is used. Null = whole area, 0 = none. */
  communityRadiusM?: number | null;
  /** Places the person chose to skip. They never appear in the results. */
  excludeOsmIds?: string[];
  /** Upper bound on stops. Default: about one per 600 m, between 3 and 6 (see `maxStopsFor`). */
  maxStops?: number;
}

/** Target loop length in metres. A distance wins over a time if both are given. */
export function budgetM(r: RouteRequest): number {
  if (r.distanceM != null) return r.distanceM;
  if (r.minutes == null) throw new Error('give minutes or distanceM');
  return r.minutes * 60 * (r.speedMps ?? WALK_SPEED_MPS);
}

/** One recommended loop: start -> picks in order -> start. */
export interface RouteOption {
  picks: Candidate[];
  /** Whole route, start to start. */
  points: LatLng[];
  /** Metres of each leg (`picks.length + 1` values). */
  legsM: number[];
  /** Index into `points` where each pick is reached. */
  stopPointIndex: number[];
  score: number;
  /** `street` (follows the downloaded walking network) or `straight` (no network: crow-flies x 1.3). */
  mode: 'street' | 'straight';
  durationS: number;
  /** Why each pick was chosen, one line per pick. */
  reasons: string[];
  /** What to show for each stop on the review screen (same order as picks). */
  cards: PlaceCard[];
}

export const totalM = (o: RouteOption): number => o.legsM.reduce((a, b) => a + b, 0);

export const withCards = (o: RouteOption, cards: PlaceCard[]): RouteOption => ({
  ...o,
  reasons: cards.map((c) => c.reason),
  cards,
});

/** The string stored in `walk.route_json` (kept under the 20,000-char sync limit). */
export function toRouteJson(o: RouteOption, r: RouteRequest): string {
  const skipped = [...(r.excludeOsmIds ?? [])].sort();
  return JSON.stringify({
    v: 1,
    mode: o.mode,
    polyline: encodePolyline(o.points),
    legs_m: o.legsM,
    total_m: totalM(o),
    duration_s: o.durationS,
    stop_point_index: o.stopPointIndex,
    request: {
      minutes: r.minutes ?? null,
      distance_m: r.distanceM ?? null,
      loop: true,
      ...(skipped.length > 0 ? { skipped } : {}),
    },
  });
}

const MAX_CANDIDATES = 20;
/** Longer walks get more stops: about one per 600 m, between 3 and 6. */
const maxStopsFor = (budget: number) => Math.min(6, Math.max(3, Math.round(budget / 600)));
const MIN_STOPS = 3;
const MAX_PER_CATEGORY = 2;
const MAX_SNAP_M = 300;
const STRAIGHT_DETOUR = 1.3;
const MAX_POLYLINE_CHARS = 15000;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Dart's `double.compareTo` on finite numbers. */
const numCmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

export interface RecommendInput {
  pois: Candidate[];
  request: RouteRequest;
  graph?: WalkGraph | null;
  stats?: Record<string, PlaceStats>;
  history?: Record<string, PlaceHistory>;
  hiddenNoteIds?: Set<string>;
  nowMs?: number;
}

/**
 * Recommends up to `request.options` loops, best first. Pure and deterministic, so it can run in a worker.
 * With a graph routes follow real paths; without one it falls back to straight lines.
 */
export function recommendRoutes(input: RecommendInput): RouteOption[] {
  const { pois, request, stats = {}, history = {}, nowMs = 0 } = input;
  const hiddenNoteIds = input.hiddenNoteIds ?? new Set<string>();
  const budget = budgetM(request);
  const lo = 0.7 * budget;
  const hi = 1.1 * budget;
  const maxStops = Math.min(maxStopsFor(budget), request.maxStops ?? Infinity);
  const start = request.start;
  const exclude = new Set(request.excludeOsmIds ?? []);
  const speed = request.speedMps ?? WALK_SPEED_MPS;

  // A loop out and back is at least twice the crow-flies distance to its farthest stop.
  const near = filterCandidates(pois).filter(
    (c) => !exclude.has(c.osmId) && distanceMeters(start.lat, start.lng, c.lat, c.lng) <= hi / 2,
  );

  // Community data only counts inside the area the person chose.
  const communityR = request.communityRadiusM ?? null;
  const statsFor = (c: Candidate): PlaceStats | undefined => {
    if (communityR != null && (communityR <= 0 || distanceMeters(start.lat, start.lng, c.lat, c.lng) > communityR)) {
      return undefined;
    }
    return stats[c.osmId];
  };

  // Value of a place: category weight blended with what people left there, rotated by this
  // person's history, plus a seeded random nudge.
  const value = new Map<string, number>();
  for (const c of near) {
    value.set(
      c.osmId,
      placeValue({
        base: categoryWeight(c),
        osmId: c.osmId,
        stats: statsFor(c),
        history: history[c.osmId],
        nowMs,
        seed: request.seed ?? 0,
      }),
    );
  }
  const shortScore = (c: Candidate) => value.get(c.osmId)! - distanceMeters(start.lat, start.lng, c.lat, c.lng) / 300;
  const ranked = [...near]
    .sort((a, b) => numCmp(shortScore(b), shortScore(a)) || cmp(a.osmId, b.osmId))
    .slice(0, MAX_CANDIDATES);

  // Snap to the network; fall back to straight lines if the start is not on it.
  let g: WalkGraph | null = input.graph ?? null;
  let startNode = -1;
  let mask: Uint8Array | undefined;
  if (g) {
    const snap = g.nearestNode(start.lat, start.lng, { maxSnapM: MAX_SNAP_M });
    if (!snap) {
      g = null;
    } else {
      startNode = snap.node;
      mask = g.reachableFrom(startNode);
    }
  }

  const cands: Candidate[] = [];
  const nodes: number[] = [];
  for (const c of ranked) {
    if (!g) {
      cands.push(c);
    } else {
      const snap = g.nearestNode(c.lat, c.lng, { mask, maxSnapM: MAX_SNAP_M });
      if (!snap) continue;
      cands.push(c);
      nodes.push(snap.node);
    }
  }
  if (cands.length === 0) return [];

  // d[i][j]: metres between points; index 0 is the start, i >= 1 is cands[i - 1].
  const n = cands.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  if (!g) {
    const pts: LatLng[] = [start, ...cands.map((c) => ({ lat: c.lat, lng: c.lng }))];
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        d[i][j] = i === j ? 0 : distanceMeters(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng) * STRAIGHT_DETOUR;
      }
    }
  } else {
    const all = [startNode, ...nodes];
    for (let i = 0; i <= n; i++) {
      const res = dijkstra(g, all[i], hi);
      for (let j = 0; j <= n; j++) d[i][j] = i === j ? 0 : res.len[all[j]];
    }
    for (let i = 0; i <= n; i++) {
      for (let j = i + 1; j <= n; j++) {
        const m = d[i][j] < d[j][i] ? d[i][j] : d[j][i];
        d[i][j] = d[j][i] = m;
      }
    }
  }

  const w = [0, ...cands.map((c) => value.get(c.osmId)!)];
  const cat = ['', ...cands.map(categoryOf)];
  const idOf = (s: number) => cands[s - 1].osmId;

  const loopLen = (t: number[]): number => {
    let sum = 0;
    let prev = 0;
    for (const s of t) {
      sum += d[prev][s];
      prev = s;
    }
    return sum + d[prev][0];
  };

  // Greedy insertion: best weight per extra metre, within the length cap.
  const fill = (tour: number[], capCategories: boolean): void => {
    let cur = loopLen(tour);
    while (tour.length < maxStops) {
      let bestC = -1;
      let bestP = -1;
      let bestRatio = -1;
      let bestAdded = 0;
      for (let c = 1; c <= n; c++) {
        if (tour.includes(c)) continue;
        if (capCategories && tour.filter((t) => cat[t] === cat[c]).length >= MAX_PER_CATEGORY) continue;
        for (let p = 0; p <= tour.length; p++) {
          const prev = p === 0 ? 0 : tour[p - 1];
          const next = p === tour.length ? 0 : tour[p];
          const added = d[prev][c] + d[c][next] - d[prev][next];
          if (!Number.isFinite(added) || cur + added > hi) continue;
          const ratio = w[c] / (added < 50 ? 50 : added);
          if (
            ratio > bestRatio + 1e-12 ||
            (Math.abs(ratio - bestRatio) <= 1e-12 && bestC !== -1 && cmp(idOf(c), idOf(bestC)) < 0)
          ) {
            bestRatio = ratio;
            bestC = c;
            bestP = p;
            bestAdded = added;
          }
        }
      }
      if (bestC === -1) break;
      tour.splice(bestP, 0, bestC);
      cur += bestAdded;
    }
  };

  // Exact best order: at most 6 stops, so at most 720 permutations.
  const bestOrder = (tour: number[]): number[] => {
    let best = tour;
    let bestLen = loopLen(tour);
    const permute = (rest: number[], acc: number[]): void => {
      if (rest.length === 0) {
        const l = loopLen(acc);
        if (l < bestLen - 1e-9) {
          best = [...acc];
          bestLen = l;
        }
        return;
      }
      for (let i = 0; i < rest.length; i++) {
        permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
      }
    };
    permute(tour, []);
    return best;
  };

  const buildTour = (anchor: number | null): number[] | null => {
    const tour: number[] = [];
    if (anchor !== null) {
      if (!(d[0][anchor] + d[anchor][0] <= hi)) return null;
      tour.push(anchor);
    }
    fill(tour, true);
    if (tour.length < MIN_STOPS) fill(tour, false);
    return tour.length === 0 ? null : bestOrder(tour);
  };

  // Different anchors give different-looking loops; dedupe by stop set.
  const seen = new Set<string>();
  const tours: number[][] = [];
  const anchors: (number | null)[] = [null];
  for (let i = 1; i <= n && i <= 8; i++) anchors.push(i);
  for (const anchor of anchors) {
    const t = buildTour(anchor);
    if (!t) continue;
    const key = t.map(idOf).sort(cmp).join('|');
    if (!seen.has(key)) {
      seen.add(key);
      tours.push(t);
    }
  }

  const scoreOf = (t: number[]): number => {
    const len = loopLen(t);
    const cats = new Set(t.map((s) => cat[s]));
    return t.reduce((a, s) => a + w[s], 0) + 0.5 * cats.size - (4 * Math.abs(len - budget)) / budget;
  };
  const tourCmp = (a: number[], b: number[]): number =>
    numCmp(scoreOf(b), scoreOf(a)) || cmp(a.map(idOf).join('|'), b.map(idOf).join('|'));

  // Prefer loops long enough to count as the walk that was asked for.
  const fitting = tours.filter((t) => loopLen(t) >= lo).sort(tourCmp);
  const short = tours.filter((t) => loopLen(t) < lo).sort(tourCmp);
  const chosen = [...fitting, ...short].slice(0, request.options ?? 3);

  const out: RouteOption[] = [];
  for (const t of chosen) {
    const opt = !g
      ? straightOption(request.start, speed, cands, t, d, scoreOf(t))
      : streetOption(request.start, speed, g, cands, nodes, startNode, t, scoreOf(t));
    if (!opt) continue;
    out.push(
      withCards(
        opt,
        t.map((s) =>
          placeCardOf(cands[s - 1], {
            stats: statsFor(cands[s - 1]),
            history: history[cands[s - 1].osmId],
            hiddenNoteIds,
            nowMs,
          }),
        ),
      ),
    );
  }
  return out;
}

function straightOption(
  start: LatLng,
  speed: number,
  cands: Candidate[],
  tour: number[],
  d: number[][],
  score: number,
): RouteOption {
  const picks = tour.map((s) => cands[s - 1]);
  const points: LatLng[] = [start, ...picks.map((c) => ({ lat: c.lat, lng: c.lng })), start];
  const legs: number[] = [];
  let prev = 0;
  for (const s of [...tour, 0]) {
    legs.push(roundHalfUp(d[prev][s]));
    prev = s;
  }
  const total = legs.reduce((a, b) => a + b, 0);
  return {
    picks,
    points,
    legsM: legs,
    stopPointIndex: picks.map((_, i) => i + 1),
    score,
    mode: 'straight',
    durationS: roundHalfUp(total / speed),
    reasons: [],
    cards: [],
  };
}

/** Distances and durations are never negative, so half-away-from-zero is half-up. */
const roundHalfUp = (v: number) => Math.round(v);

function streetOption(
  start: LatLng,
  speed: number,
  g: WalkGraph,
  cands: Candidate[],
  nodes: number[],
  startNode: number,
  tour: number[],
  score: number,
): RouteOption | null {
  const picks = tour.map((s) => cands[s - 1]);
  const stopNodes = tour.map((s) => nodes[s - 1]);
  const chain = [startNode, ...stopNodes, startNode];
  const points: LatLng[] = [{ lat: start.lat, lng: start.lng }];
  const legs: number[] = [];
  const stopIdx: number[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const p = astar(g, chain[i], chain[i + 1]);
    if (!p) return null;
    for (let k = i === 0 ? 0 : 1; k < p.nodes.length; k++) {
      points.push({ lat: g.lat[p.nodes[k]], lng: g.lng[p.nodes[k]] });
    }
    legs.push(roundHalfUp(p.lengthM));
    if (i < stopNodes.length) stopIdx.push(points.length - 1);
  }
  points.push({ lat: start.lat, lng: start.lng });

  // Shrink the polyline (keeping the stops) until its encoded form is small enough to store and sync.
  let tol = 3;
  const stopSet = new Set(stopIdx);
  let keepIdx = simplifyIndices(points, tol, stopSet);
  while (encodePolyline(keepIdx.map((i) => points[i])).length > MAX_POLYLINE_CHARS && tol < 200) {
    tol *= 2;
    keepIdx = simplifyIndices(points, tol, stopSet);
  }
  const remap = new Map(keepIdx.map((idx, k) => [idx, k]));
  const total = legs.reduce((a, b) => a + b, 0);
  return {
    picks,
    points: keepIdx.map((i) => points[i]),
    legsM: legs,
    stopPointIndex: stopIdx.map((i) => remap.get(i)!),
    score,
    mode: 'street',
    durationS: roundHalfUp(total / speed),
    reasons: [],
    cards: [],
  };
}

/** Everything `planRoutes` needs, in a form that can be sent to a Web Worker (structured-cloneable). */
export interface PlanJob {
  pois: Candidate[];
  ways: WalkWay[];
  request: RouteRequest;
  stats?: Record<string, PlaceStats>;
  history?: Record<string, PlaceHistory>;
  hiddenNoteIds?: string[];
  nowMs?: number;
}

/** Builds the walking graph (if there are ways) and recommends routes. Runs in a worker; graph building is the slow part. */
export function planRoutes(job: PlanJob): RouteOption[] {
  return recommendRoutes({
    pois: job.pois,
    request: job.request,
    graph: job.ways.length === 0 ? null : WalkGraph.fromWays(job.ways),
    stats: job.stats,
    history: job.history,
    hiddenNoteIds: new Set(job.hiddenNoteIds ?? []),
    nowMs: job.nowMs,
  });
}

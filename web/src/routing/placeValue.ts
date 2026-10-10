import type { PlaceHistory, PlaceStats } from './placeStats';

/**
 * How many "visits' worth" of belief the category weight is given against community data.
 * With no community data the category weight is used as is; each different person who
 * has been there shifts the value toward what they actually left behind.
 */
export const PRIOR_WEIGHT = 3;

const DAY = 24 * 60 * 60 * 1000;

/** Community value on the same 1..5 scale as category weights: memories (notes, photos) per visit. */
export function crowdValue(s: PlaceStats): number {
  const rate = (s.notes + 0.5 * s.photos) / (s.walks < 1 ? 1 : s.walks);
  return 1 + 4 * Math.min(1, rate / 1.5);
}

/** Shrinks the community value toward [base] when few people have been there. */
export function blendedValue(base: number, s?: PlaceStats | null): number {
  const n = s?.devices ?? 0;
  if (!s || n <= 0) return base;
  return (PRIOR_WEIGHT * base + n * crowdValue(s)) / (PRIOR_WEIGHT + n);
}

/** Round robin: places this person has not been to (or not lately) come first. Never excludes a place. */
export function freshness(h: PlaceHistory | undefined | null, nowMs: number): number {
  if (!h || h.visits <= 0) return 1;
  let f = 1 / (1 + 0.7 * h.visits);
  if (nowMs - h.lastVisitedMs < 14 * DAY) f *= 0.6;
  return Math.max(f, 0.15);
}

/** Deterministic pseudo-random number in [0, 1) from a seed and a place id (FNV-1a). */
export function seededUnit(seed: number, osmId: string): number {
  let h = 0x811c9dc5;
  // Dart iterates UTF-16 code units, as does charCodeAt.
  const s = `${seed}:${osmId}`;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0;
  return (h & 0xffffff) / 0x1000000;
}

/**
 * Seeded random nudge, bigger where we know less (explore places with little data).
 * +-30% with no community data, shrinking as more people have been there.
 */
export function jitter(seed: number, osmId: string, s?: PlaceStats | null): number {
  const amp = 0.3 / (1 + (s?.devices ?? 0));
  return 1 + amp * (seededUnit(seed, osmId) * 2 - 1);
}

/**
 * Final value of a place for ranking: blended community value, rotated by this person's history,
 * with a seeded random nudge.
 */
export function placeValue(o: {
  base: number;
  osmId: string;
  stats?: PlaceStats | null;
  history?: PlaceHistory | null;
  nowMs: number;
  seed?: number;
}): number {
  return blendedValue(o.base, o.stats) * freshness(o.history, o.nowMs) * jitter(o.seed ?? 0, o.osmId, o.stats);
}

/** One-line reason shown with a recommendation. */
export function reasonFor(s: PlaceStats | undefined | null, h: PlaceHistory | undefined | null, nowMs: number): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const crowd =
    !s || s.devices <= 0
      ? 'no community data yet'
      : `${plural(s.devices, 'person', 'people')} visited, ${plural(s.notes, 'note', 'notes')}, ${plural(s.photos, 'photo', 'photos')}`;
  const mine =
    !h || h.visits <= 0
      ? 'new to you'
      : `you visited ${h.visits}x, last ${Math.max(0, Math.trunc((nowMs - h.lastVisitedMs) / DAY))} days ago`;
  return `${crowd}; ${mine}`;
}

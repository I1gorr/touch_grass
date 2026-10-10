import type { Walk, WalkStatus } from '../models/types';

/*
 * Display text shared across screens, so wording and punctuation stay consistent: sentence case, “·” as
 * separator, “…” for work in progress, full stops only on full sentences.
 */

export const sentenceCase = (s: string): string => (s === '' ? s : s[0].toUpperCase() + s.slice(1));

export const walkStatusLabel = (s: WalkStatus): string =>
  ({ preparing: 'Preparing', ready: 'Ready', active: 'In progress', done: 'Done' })[s];

/** “Afternoon · overcast, 14°C”, or “Afternoon · weather unknown”. */
export function walkConditions(w: Pick<Walk, 'timeOfDay' | 'weatherSummary'>): string {
  const weather = w.weatherSummary.trim();
  const part = weather === '' || weather === 'unknown' ? 'weather unknown' : weather;
  return `${sentenceCase(w.timeOfDay)} · ${part}`;
}

/** Human label for an engine kind or mode name. */
export function engineLabel(kind: string): string {
  switch (kind) {
    case 'auto': return 'Automatic';
    case 'device': return 'On-device';
    case 'fallback': return 'Pre-written';
    case 'fake':
    case 'sample': return 'Sample';
    case 'unavailable': return 'Not downloaded';
    default: return sentenceCase(kind);
  }
}

export const distanceLabel = (meters: number): string =>
  meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;

export const durationLabel = (seconds: number): string => `${Math.round(seconds / 60)} min`;

/** “2.3 km · 31 min” from a walk's planned route, or null without one. */
export function routeSummary(w: Pick<Walk, 'routeJson'>): string | null {
  if (!w.routeJson) return null;
  try {
    const r = JSON.parse(w.routeJson) as { total_m?: unknown; duration_s?: unknown };
    if (typeof r.total_m !== 'number') return null;
    const parts = [distanceLabel(r.total_m)];
    if (typeof r.duration_s === 'number') parts.push(durationLabel(Math.trunc(r.duration_s)));
    return parts.join(' · ');
  } catch {
    return null;
  }
}

/** Human label for a data-track category such as `amenity=place_of_worship` (“Place of worship”) or `historic=*` (“Historic site”). */
export function categoryLabel(category: string): string {
  const i = category.indexOf('=');
  if (i < 0) return sentenceCase(category.replaceAll('_', ' '));
  const key = category.slice(0, i);
  const value = category.slice(i + 1);
  if (value === '*' || value === 'yes') {
    const known: Record<string, string> = { historic: 'Historic site', tourism: 'Sight', leisure: 'Leisure', natural: 'Nature' };
    return known[key] ?? sentenceCase(key.replaceAll('_', ' '));
  }
  return sentenceCase(value.replaceAll('_', ' '));
}

/** A data-track reason (“no community data yet; new to you”) as a sentence. */
export function reasonSentence(reason: string): string {
  const t = reason.trim();
  if (t === '') return t;
  const s = sentenceCase(t);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** “10 Oct 2026”, like Material's medium date. */
export const formatDate = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });

export const formatTime = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

export const formatBytes = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

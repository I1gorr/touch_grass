import type { Stop, StopFacts } from '../models/types';

export function timeOfDayFor(t: Date): string {
  const h = t.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

/** Most descriptive OSM tag first. */
const TAG_PRIORITY = [
  'historic', 'tourism', 'leisure', 'natural', 'amenity', 'man_made', 'memorial', 'artwork_type', 'shop', 'building',
];

/** "key=value" for the most descriptive OSM tag in `tagsJson`, or '' if none. */
export function tagTypeFrom(tagsJson: string): string {
  let tags: Record<string, unknown>;
  try {
    const parsed = JSON.parse(tagsJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    tags = parsed;
  } catch {
    return '';
  }
  for (const k of TAG_PRIORITY) {
    const v = tags[k];
    if (typeof v === 'string' && v !== '' && v !== 'yes') return `${k}=${v}`;
  }
  for (const k of TAG_PRIORITY) {
    if (tags[k] != null) return `${k}=${tags[k]}`;
  }
  return '';
}

export const factsFor = (stop: Stop, o: { timeOfDay: string; weatherSummary: string }): StopFacts => ({
  name: stop.name,
  tagType: tagTypeFrom(stop.tagsJson),
  timeOfDay: o.timeOfDay,
  weatherSummary: o.weatherSummary,
});

/** Identity of a real-world place across walks (stop row ids differ per walk). */
export const stopKey = (s: Stop): string => (s.osmId !== '' ? s.osmId : `${s.name}@${s.lat},${s.lng}`);

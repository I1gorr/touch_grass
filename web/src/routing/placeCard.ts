import type { Candidate } from './candidate';
import { categoryOf } from './candidate';
import type { CommunityNote, PlaceHistory, PlaceStats } from './placeStats';
import { reasonFor } from './placeValue';

/**
 * Everything the review screen shows about one stop of a recommended route:
 * what the place is, what people said, how often this person has been, and why it was picked.
 */
export interface PlaceCard {
  osmId: string;
  name: string;
  category: string;
  reason: string;
  /** Community counts (zero when nobody has been there). */
  walks: number;
  people: number;
  notes: number;
  photos: number;
  /** What people chose to share, newest first, with notes this person reported removed. */
  sharedNotes: CommunityNote[];
  /** This person's own past visits. */
  myVisits: number;
}

/** At most this many notes per card keep the review screen readable. */
export const MAX_NOTES = 3;

export function placeCardOf(
  c: Candidate,
  o: { stats?: PlaceStats; history?: PlaceHistory; hiddenNoteIds?: Set<string>; nowMs: number },
): PlaceCard {
  const hidden = o.hiddenNoteIds ?? new Set<string>();
  return {
    osmId: c.osmId,
    name: c.name,
    category: categoryOf(c),
    reason: reasonFor(o.stats, o.history, o.nowMs),
    walks: o.stats?.walks ?? 0,
    people: o.stats?.devices ?? 0,
    notes: o.stats?.notes ?? 0,
    photos: o.stats?.photos ?? 0,
    sharedNotes: (o.stats?.sharedNotes ?? []).filter((n) => !hidden.has(n.id)).slice(0, MAX_NOTES),
    myVisits: o.history?.visits ?? 0,
  };
}

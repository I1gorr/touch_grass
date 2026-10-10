import type { LatLng } from '../routing/geo';

/** A WGS84 point (same shape as the routing LatLng). */
export type Location = LatLng;

export type WalkStatus = 'preparing' | 'ready' | 'active' | 'done';
export const WALK_STATUSES: readonly WalkStatus[] = ['preparing', 'ready', 'active', 'done'];

/** Tolerant read: unknown or missing values fall back to `ready`. */
export const parseWalkStatus = (s: unknown): WalkStatus =>
  WALK_STATUSES.find((v) => v === s) ?? 'ready';

/** A `walk` row: one prepared quest. Times are ms since the epoch. */
export interface Walk {
  id: string;
  createdAt: number;
  startLat: number;
  startLng: number;
  timeOfDay: string;
  weatherSummary: string;
  status: WalkStatus;
  /** The planned street route as JSON (`total_m`, `duration_s`, `mode`, polyline...). Null for walks without one. */
  routeJson: string | null;
}

/** A place in a walk. `walkId` and `position` are filled in when a quest is saved. */
export interface Stop {
  id: string;
  walkId: string;
  position: number;
  osmId: string;
  name: string;
  lat: number;
  lng: number;
  tagsJson: string;
  blurb: string;
  prompt: string;
}

/**
 * A journal entry at a stop: a voice note (raw + cleaned transcript), the walk's photo, or both.
 * `rawTranscript` null = not transcribed yet (or photo only); '' = silence.
 */
export interface Entry {
  id: string;
  stopId: string;
  recordedAt: number;
  rawTranscript: string | null;
  cleanedText: string | null;
  /** True if the walk's photo belongs to this entry. Computed by the repository. */
  hasPhoto: boolean;
  /** The author chose to share this note with people nearby, as the snapshot `sharedText`. */
  shared: boolean;
  sharedText: string | null;
}

/** Longest note shared with the community. */
export const MAX_SHARED_CHARS = 280;

/** The single photo of a walk, stored locally. Never uploaded. */
export interface WalkPhoto {
  walkId: string;
  /** The entry (and so the stop) the photo was taken at. */
  entryId: string;
  /** 'image/jpeg' or 'image/png' (static only). */
  mime: string;
  bytes: Uint8Array;
  createdAt: number;
}

/** Which photo a walk has, without its bytes: lets screens skip reloading a multi-MB image. */
export interface PhotoStamp {
  entryId: string;
  createdAtMs: number;
  size: number;
}

export const samePhotoStamp = (a: PhotoStamp | null, b: PhotoStamp | null): boolean =>
  a === b || (!!a && !!b && a.entryId === b.entryId && a.createdAtMs === b.createdAtMs && a.size === b.size);

/** Structured facts the LLM is allowed to use. Nothing else goes into a prompt. */
export interface StopFacts {
  name: string;
  /** e.g. "amenity=bench", "historic=memorial" */
  tagType: string;
  /** e.g. "morning" */
  timeOfDay: string;
  /** e.g. "light rain, 12°C" */
  weatherSummary: string;
}

/** A walk with its stops (in route order) and each stop's entries. */
export interface WalkBundle {
  walk: Walk;
  stops: Stop[];
  entriesByStop: Record<string, Entry[]>;
}

/** Everything needed to create a `walk` row plus its `stop` rows. Stops are in route order. */
export interface PreparedQuest {
  walk: Walk;
  stops: Stop[];
}

export const newEntry = (e: Pick<Entry, 'id' | 'stopId' | 'recordedAt'> & Partial<Entry>): Entry => ({
  rawTranscript: null,
  cleanedText: null,
  hasPhoto: false,
  shared: false,
  sharedText: null,
  ...e,
});

export const newStop = (s: Pick<Stop, 'id' | 'osmId' | 'name' | 'lat' | 'lng'> & Partial<Stop>): Stop => ({
  walkId: '',
  position: 0,
  tagsJson: '{}',
  blurb: '',
  prompt: '',
  ...s,
});

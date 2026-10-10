/** One note a person chose to share about a place. Anonymous: no author, no device id. */
export interface CommunityNote {
  /** The entry id (needed to report it). */
  id: string;
  text: string;
  photo: boolean;
  at: number;
}

export const noteFromJson = (j: any): CommunityNote => ({
  id: j.id,
  text: j.text,
  photo: j.photo === true,
  at: Math.trunc(Number(j.at ?? 0)) || 0,
});

/**
 * Community data for one place (OSM id) in the user's chosen area: counts, plus the few notes
 * people chose to share. Never raw transcripts, authors or photos.
 */
export interface PlaceStats {
  osmId: string;
  /** Finished walks that stopped here. */
  walks: number;
  /** Different people who did. */
  devices: number;
  entries: number;
  /** Entries with spoken/written text. */
  notes: number;
  photos: number;
  /** What people chose to say here (newest first, a few). */
  sharedNotes: CommunityNote[];
}

export function statsFromJson(j: any): PlaceStats {
  const n = (v: unknown) => Math.trunc(Number(v ?? 0)) || 0;
  return {
    osmId: j.osm_id,
    walks: n(j.walks),
    devices: n(j.devices),
    entries: n(j.entries),
    notes: n(j.notes),
    photos: n(j.photos),
    sharedNotes: (j.shared_notes ?? []).map(noteFromJson),
  };
}

/** This person's own past visits to a place (from their finished walks). */
export interface PlaceHistory {
  visits: number;
  /** `walk.created_at` of the latest finished walk that stopped here. */
  lastVisitedMs: number;
}

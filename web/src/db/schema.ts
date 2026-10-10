import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { PlaceStats } from '../routing/placeStats';
import type { Candidate } from '../routing/candidate';
import type { WalkWayJson } from '../routing/walkWay';

/*
 * IndexedDB mirror of the SQLite schema (docs/DATA_SCHEMA.md, v6). Rows keep the snake_case column
 * names, so the sync payload is exactly what the server's validate.js expects.
 * A row needs uploading when COALESCE(updated_at, 1) > COALESCE(synced_at, 0).
 */

export interface WalkRow {
  id: string;
  created_at: number;
  start_lat: number;
  start_lng: number;
  time_of_day: string;
  weather_summary: string;
  status: string;
  route_json: string | null;
  updated_at: number | null;
  synced_at: number | null;
}

export interface StopRow {
  id: string;
  walk_id: string;
  position: number;
  osm_id: string;
  name: string;
  lat: number;
  lng: number;
  tags_json: string;
  blurb: string;
  prompt: string;
  updated_at: number | null;
  synced_at: number | null;
}

export interface EntryRow {
  id: string;
  stop_id: string;
  recorded_at: number;
  raw_transcript: string | null;
  cleaned_text: string | null;
  shared: 0 | 1;
  shared_text: string | null;
  updated_at: number | null;
  synced_at: number | null;
}

export interface PhotoRow {
  walk_id: string;
  entry_id: string;
  mime: string;
  data: Uint8Array;
  size: number;
  created_at: number;
}

/** Pack metadata (small, listed often). */
export interface PackManifest {
  v: 1;
  id: string;
  center_lat: number;
  center_lng: number;
  radius_m: number;
  created_at: number;
  poi_count: number;
  way_count: number;
  stats_at: number;
  community_radius_m: number | null;
}

export interface PackData {
  id: string;
  pois: Candidate[];
  ways: WalkWayJson[];
}

export interface PackStatsRow {
  id: string;
  stats: PlaceStats[];
}

/** A recorded note waiting for transcription: 16 kHz mono PCM. Deleted once the transcript is saved. */
export interface RecordingRow {
  id: string;
  samples: Float32Array;
  sampleRate: number;
  created_at: number;
}

export interface TgSchema extends DBSchema {
  walk: { key: string; value: WalkRow; indexes: { created_at: number; status: string } };
  stop: { key: string; value: StopRow; indexes: { walk_id: string } };
  entry: { key: string; value: EntryRow; indexes: { stop_id: string } };
  photo: { key: string; value: PhotoRow; indexes: { entry_id: string } };
  meta: { key: string; value: { key: string; value: string } };
  /** Small JSON documents (e.g. the report queue). */
  kv: { key: string; value: { key: string; value: unknown } };
  packs: { key: string; value: PackManifest };
  packData: { key: string; value: PackData };
  packStats: { key: string; value: PackStatsRow };
  recordings: { key: string; value: RecordingRow };
}

export type TgDb = IDBPDatabase<TgSchema>;

export const DB_NAME = 'touch_grass';
export const DB_VERSION = 1;

export function openTgDb(name = DB_NAME): Promise<TgDb> {
  return openDB<TgSchema>(name, DB_VERSION, {
    upgrade(db) {
      const walk = db.createObjectStore('walk', { keyPath: 'id' });
      walk.createIndex('created_at', 'created_at');
      walk.createIndex('status', 'status');
      db.createObjectStore('stop', { keyPath: 'id' }).createIndex('walk_id', 'walk_id');
      db.createObjectStore('entry', { keyPath: 'id' }).createIndex('stop_id', 'stop_id');
      db.createObjectStore('photo', { keyPath: 'walk_id' }).createIndex('entry_id', 'entry_id');
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('kv', { keyPath: 'key' });
      db.createObjectStore('packs', { keyPath: 'id' });
      db.createObjectStore('packData', { keyPath: 'id' });
      db.createObjectStore('packStats', { keyPath: 'id' });
      db.createObjectStore('recordings', { keyPath: 'id' });
    },
    blocked() {
      console.warn('[db] upgrade blocked by another open tab');
    },
  });
}

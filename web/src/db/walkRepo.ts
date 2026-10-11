import type { PlaceHistory } from '../routing/placeStats';
import {
  type Entry,
  MAX_SHARED_CHARS,
  type PhotoStamp,
  type PreparedQuest,
  type Stop,
  type Walk,
  type WalkBundle,
  type WalkPhoto,
  type WalkStatus,
  WALK_STATUSES,
  parseWalkStatus,
} from '../models/types';
import { DEVICE_ID_PATTERN, newId } from '../util/ids';
import { Emitter } from '../util/emitter';
import { type EntryRow, openTgDb, type PhotoRow, type StopRow, type TgDb, type WalkRow } from './schema';

/** Rows not yet uploaded, per table, in upload order (walk -> stop -> entry). */
export interface SyncBatch {
  walk: Record<string, unknown>[];
  stop: Record<string, unknown>[];
  entry: Record<string, unknown>[];
}

export const batchCount = (b: SyncBatch): number => b.walk.length + b.stop.length + b.entry.length;

export const SYNCED_TABLES = ['walk', 'stop', 'entry'] as const;
type SyncedTable = (typeof SYNCED_TABLES)[number];
const PENDING_DELETES_KEY = 'pending_walk_deletes';

/** A row needs uploading when `COALESCE(updated_at, 1) > COALESCE(synced_at, 0)`. */
const isPending = (r: { updated_at: number | null; synced_at: number | null }) => (r.updated_at ?? 1) > (r.synced_at ?? 0);

const walkToModel = (r: WalkRow): Walk => ({
  id: r.id,
  createdAt: r.created_at ?? 0,
  startLat: r.start_lat ?? 0,
  startLng: r.start_lng ?? 0,
  timeOfDay: r.time_of_day ?? '',
  weatherSummary: r.weather_summary ?? '',
  status: parseWalkStatus(r.status),
  routeJson: r.route_json ?? null,
});

const stopToModel = (r: StopRow): Stop => ({
  id: r.id,
  walkId: r.walk_id ?? '',
  position: r.position ?? 0,
  osmId: r.osm_id ?? '',
  name: r.name ?? '',
  lat: r.lat,
  lng: r.lng,
  tagsJson: r.tags_json ?? '{}',
  blurb: r.blurb ?? '',
  prompt: r.prompt ?? '',
});

const entryToModel = (r: EntryRow, hasPhoto: boolean): Entry => ({
  id: r.id,
  stopId: r.stop_id,
  recordedAt: r.recorded_at ?? 0,
  rawTranscript: r.raw_transcript ?? null,
  cleanedText: r.cleaned_text ?? null,
  hasPhoto,
  shared: r.shared === 1,
  sharedText: r.shared_text ?? null,
});

const photoToModel = (r: PhotoRow): WalkPhoto => ({
  walkId: r.walk_id,
  entryId: r.entry_id,
  mime: r.mime,
  bytes: r.data,
  createdAt: r.created_at ?? 0,
});

/**
 * All app reads and writes go through here (IndexedDB is the source of truth). Nothing in this class
 * touches the network, so a walk works in airplane mode. It is the web counterpart of both the app
 * track's `SqfliteWalkRepository` and the data track's `WalkRepository`, which shared one database.
 */
export class WalkRepo {
  private readonly emitter = new Emitter();
  private lastStamp: number;

  private constructor(
    readonly db: TgDb,
    lastStamp: number,
    private readonly nowMs: () => number,
  ) {
    this.lastStamp = lastStamp;
  }

  /** Opens the database. `name` and `nowMs` exist for tests. */
  static async open(opts: { name?: string; nowMs?: () => number } = {}): Promise<WalkRepo> {
    const db = await openTgDb(opts.name);
    let last = 0;
    for (const t of SYNCED_TABLES) {
      for (const r of await db.getAll(t)) {
        last = Math.max(last, r.updated_at ?? 0, r.synced_at ?? 0);
      }
    }
    return new WalkRepo(db, last, opts.nowMs ?? Date.now);
  }

  /**
   * Monotonic ms timestamp for `updated_at`. Never goes backwards, even if the phone clock does, so a
   * change can't look older than its last upload.
   */
  stamp(): number {
    const now = this.nowMs();
    this.lastStamp = now > this.lastStamp ? now : this.lastStamp + 1;
    return this.lastStamp;
  }

  /** Fires after every user-visible write, for UIs that re-query. */
  onChange(fn: () => void): () => void {
    return this.emitter.subscribe(fn);
  }

  /** Fires `onChange` listeners for writes made elsewhere on the same database. */
  notifyExternalChange(): void {
    this.emitter.emit();
  }

  // --- Walks and stops ---

  /** Stores the walk and its stops in one transaction (stops take their positions from list order). */
  async insertWalk(walk: Walk, stops: Stop[]): Promise<void> {
    const tx = this.db.transaction(['walk', 'stop'], 'readwrite');
    const t = this.stamp();
    await tx.objectStore('walk').put({
      id: walk.id,
      created_at: walk.createdAt,
      start_lat: walk.startLat,
      start_lng: walk.startLng,
      time_of_day: walk.timeOfDay,
      weather_summary: walk.weatherSummary,
      status: walk.status,
      route_json: walk.routeJson,
      updated_at: t,
      synced_at: null,
    });
    for (const [i, s] of stops.entries()) {
      await tx.objectStore('stop').put({
        id: s.id,
        walk_id: walk.id,
        position: i,
        osm_id: s.osmId,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        tags_json: s.tagsJson,
        blurb: s.blurb,
        prompt: s.prompt,
        updated_at: t,
        synced_at: null,
      });
    }
    await tx.done;
    this.emitter.emit();
  }

  /** Stores a prepared quest (route-aware: keeps `routeJson`). */
  saveQuest(q: PreparedQuest): Promise<void> {
    return this.insertWalk(q.walk, q.stops);
  }

  /** Sets the status without checking the order. Use `setStatus` for the forward-only rule. */
  async updateWalkStatus(walkId: string, status: WalkStatus): Promise<void> {
    const tx = this.db.transaction('walk', 'readwrite');
    const row = await tx.store.get(walkId);
    if (row) await tx.store.put({ ...row, status, updated_at: this.stamp() });
    await tx.done;
    this.emitter.emit();
  }

  /** Moves a walk forward (preparing -> ready -> active -> done). Going back throws. */
  async setStatus(walkId: string, status: WalkStatus): Promise<void> {
    const walk = await this.getWalk(walkId);
    if (!walk) throw new Error(`No walk ${walkId}`);
    if (WALK_STATUSES.indexOf(status) < WALK_STATUSES.indexOf(walk.status)) {
      throw new Error(`Walk status cannot go from ${walk.status} back to ${status}`);
    }
    await this.updateWalkStatus(walkId, status);
  }

  /** Permanently removes a walk and every local record belonging to it. */
  async deleteWalk(walkId: string): Promise<void> {
    const tx = this.db.transaction(['walk', 'stop', 'entry', 'photo', 'recordings'], 'readwrite');
    const stops = await tx.objectStore('stop').index('walk_id').getAll(walkId);
    const entries: EntryRow[] = [];
    for (const stop of stops) entries.push(...(await tx.objectStore('entry').index('stop_id').getAll(stop.id)));

    for (const entry of entries) {
      await tx.objectStore('entry').delete(entry.id);
      await tx.objectStore('recordings').delete(entry.id);
    }
    for (const stop of stops) await tx.objectStore('stop').delete(stop.id);
    await tx.objectStore('photo').delete(walkId);
    await tx.objectStore('walk').delete(walkId);
    await tx.done;
    this.emitter.emit();
  }

  /** Records a cloud deletion intent before local rows are removed. */
  async queueWalkDelete(walkId: string): Promise<void> {
    const tx = this.db.transaction('kv', 'readwrite');
    const row = await tx.store.get(PENDING_DELETES_KEY);
    const ids = Array.isArray(row?.value) ? row.value.filter((id): id is string => typeof id === 'string') : [];
    if (!ids.includes(walkId)) ids.push(walkId);
    await tx.store.put({ key: PENDING_DELETES_KEY, value: ids });
    await tx.done;
  }

  async pendingWalkDeletes(): Promise<string[]> {
    const row = await this.db.get('kv', PENDING_DELETES_KEY);
    return Array.isArray(row?.value) ? row.value.filter((id): id is string => typeof id === 'string') : [];
  }

  async markWalkDeleteSent(walkId: string): Promise<void> {
    const tx = this.db.transaction('kv', 'readwrite');
    const row = await tx.store.get(PENDING_DELETES_KEY);
    const ids = Array.isArray(row?.value) ? row.value.filter((id): id is string => typeof id === 'string' && id !== walkId) : [];
    if (ids.length === 0) await tx.store.delete(PENDING_DELETES_KEY);
    else await tx.store.put({ key: PENDING_DELETES_KEY, value: ids });
    await tx.done;
  }

  async getWalk(walkId: string): Promise<Walk | null> {
    const r = await this.db.get('walk', walkId);
    return r ? walkToModel(r) : null;
  }

  /** Newest first. */
  async listWalks(): Promise<Walk[]> {
    const rows = await this.db.getAllFromIndex('walk', 'created_at');
    return rows.reverse().map(walkToModel);
  }

  async stopsForWalk(walkId: string): Promise<Stop[]> {
    const rows = await this.db.getAllFromIndex('stop', 'walk_id', walkId);
    return rows.sort((a, b) => a.position - b.position).map(stopToModel);
  }

  async setBlurb(stopId: string, blurb: string): Promise<void> {
    const tx = this.db.transaction('stop', 'readwrite');
    const row = await tx.store.get(stopId);
    if (!row) {
      await tx.done; // nothing was written
      throw new Error(`No stop ${stopId}`);
    }
    await tx.store.put({ ...row, blurb, updated_at: this.stamp() });
    await tx.done;
    this.emitter.emit();
  }

  /** True while any walk is being walked. Sync is blocked in that state. */
  async hasActiveWalk(): Promise<boolean> {
    return (await this.db.countFromIndex('walk', 'status', 'active')) > 0;
  }

  /** This person's visits per place (OSM id), counting finished walks only. Used to rotate recommendations. */
  async placeHistory(): Promise<Record<string, PlaceHistory>> {
    const tx = this.db.transaction(['walk', 'stop'], 'readonly');
    const done = await tx.objectStore('walk').index('status').getAll('done');
    const out: Record<string, { walks: Set<string>; last: number }> = {};
    for (const w of done) {
      for (const s of await tx.objectStore('stop').index('walk_id').getAll(w.id)) {
        if (!s.osm_id) continue;
        const h = (out[s.osm_id] ??= { walks: new Set(), last: 0 });
        h.walks.add(w.id);
        h.last = Math.max(h.last, w.created_at ?? 0);
      }
    }
    return Object.fromEntries(Object.entries(out).map(([id, h]) => [id, { visits: h.walks.size, lastVisitedMs: h.last }]));
  }

  /** Walk, its stops in route order and each stop's entries by time. */
  async loadWalk(walkId: string): Promise<WalkBundle | null> {
    const walk = await this.getWalk(walkId);
    if (!walk) return null;
    const stops = await this.stopsForWalk(walkId);
    const entriesByStop: Record<string, Entry[]> = {};
    for (const s of stops) entriesByStop[s.id] = await this.entriesForStop(s.id);
    return { walk, stops, entriesByStop };
  }

  // --- Entries ---

  private async hasPhotoFor(entryId: string, db: Pick<TgDb, 'countFromIndex'> = this.db): Promise<boolean> {
    return (await db.countFromIndex('photo', 'entry_id', entryId)) > 0;
  }

  async insertEntry(e: Entry): Promise<void> {
    await this.db.put('entry', {
      id: e.id,
      stop_id: e.stopId,
      recorded_at: e.recordedAt,
      raw_transcript: e.rawTranscript,
      cleaned_text: e.cleanedText,
      shared: e.shared ? 1 : 0,
      shared_text: e.sharedText,
      updated_at: this.stamp(),
      synced_at: null,
    });
    this.emitter.emit();
  }

  /** Sets only the fields that are given (not undefined). Throws if the entry does not exist. */
  async updateEntry(entryId: string, fields: { rawTranscript?: string; cleanedText?: string }): Promise<void> {
    if (fields.rawTranscript === undefined && fields.cleanedText === undefined) return;
    await this.patchEntry(entryId, (r) => ({
      ...r,
      raw_transcript: fields.rawTranscript ?? r.raw_transcript,
      cleaned_text: fields.cleanedText ?? r.cleaned_text,
    }));
  }

  private async patchEntry(entryId: string, f: (r: EntryRow) => EntryRow): Promise<void> {
    const tx = this.db.transaction('entry', 'readwrite');
    const row = await tx.store.get(entryId);
    if (!row) {
      await tx.done; // nothing was written
      throw new Error(`entry ${entryId} not found`);
    }
    await tx.store.put({ ...f(row), updated_at: this.stamp() });
    await tx.done;
    this.emitter.emit();
  }

  async getEntry(entryId: string): Promise<Entry | null> {
    const r = await this.db.get('entry', entryId);
    return r ? entryToModel(r, await this.hasPhotoFor(entryId)) : null;
  }

  /** Oldest first. Entries carry `hasPhoto`. */
  async entriesForStop(stopId: string): Promise<Entry[]> {
    const rows = await this.db.getAllFromIndex('entry', 'stop_id', stopId);
    rows.sort((a, b) => a.recorded_at - b.recorded_at);
    return Promise.all(rows.map(async (r) => entryToModel(r, await this.hasPhotoFor(r.id))));
  }

  /** By stop position, then time. */
  async entriesForWalk(walkId: string): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const s of await this.stopsForWalk(walkId)) out.push(...(await this.entriesForStop(s.id)));
    return out;
  }

  /** Moves an entry to another stop (e.g. a photo-only entry when its photo is retaken elsewhere) and resets its time. */
  moveEntry(entryId: string, o: { stopId: string; recordedAt: number }): Promise<void> {
    return this.patchEntry(entryId, (r) => ({ ...r, stop_id: o.stopId, recorded_at: o.recordedAt }));
  }

  /**
   * Publishes a snapshot of the entry's cleaned text (or `text`) to people nearby. Opt-in, per entry.
   * The snapshot is trimmed to 280 chars, so editing the private note later changes nothing public.
   * Throws if there is nothing to share (transcripts are never shared).
   */
  async shareEntry(entryId: string, text?: string): Promise<void> {
    const row = await this.db.get('entry', entryId);
    if (!row) throw new Error(`No entry ${entryId}`);
    const source = (text ?? row.cleaned_text ?? '').trim();
    if (source === '') throw new Error('Nothing to share: the entry has no cleaned text yet');
    await this.patchEntry(entryId, (r) => ({ ...r, shared: 1, shared_text: source.slice(0, MAX_SHARED_CHARS) }));
  }

  /** Takes the note back. It disappears for others after the next sync and pack refresh. */
  unshareEntry(entryId: string): Promise<void> {
    return this.patchEntry(entryId, (r) => ({ ...r, shared: 0, shared_text: null }));
  }

  // --- Photos: local only, one per walk ---

  /**
   * Stores the walk's single photo, replacing any previous one. If `newEntry` is given it is inserted in
   * the same transaction, so a failed photo write never leaves an empty entry behind.
   */
  async putWalkPhoto(photo: WalkPhoto, o: { newEntry?: Entry } = {}): Promise<void> {
    const tx = this.db.transaction(['entry', 'photo'], 'readwrite');
    try {
      const entries = tx.objectStore('entry');
      const photos = tx.objectStore('photo');
      if (o.newEntry) {
        const e = o.newEntry;
        await entries.put({
          id: e.id,
          stop_id: e.stopId,
          recorded_at: e.recordedAt,
          raw_transcript: e.rawTranscript,
          cleaned_text: e.cleanedText,
          shared: e.shared ? 1 : 0,
          shared_text: e.sharedText,
          updated_at: this.stamp(),
          synced_at: null,
        });
      }
      const before = await photos.get(photo.walkId);
      await photos.put({
        walk_id: photo.walkId,
        entry_id: photo.entryId,
        mime: photo.mime,
        data: photo.bytes,
        size: photo.bytes.length,
        created_at: photo.createdAt,
      });
      // has_photo is synced with the entry, so both the new holder and a previous one are uploaded again.
      for (const id of new Set([photo.entryId, ...(before ? [before.entry_id] : [])])) {
        const row = await entries.get(id);
        if (row) await entries.put({ ...row, updated_at: this.stamp() });
      }
      await tx.done;
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      await tx.done.catch(() => undefined);
      throw e;
    }
    this.emitter.emit();
  }

  async walkPhoto(walkId: string): Promise<WalkPhoto | null> {
    const r = await this.db.get('photo', walkId);
    return r ? photoToModel(r) : null;
  }

  /** The stored photo's identity without reading its bytes into the UI (cheap change check). */
  async walkPhotoStamp(walkId: string): Promise<PhotoStamp | null> {
    const r = await this.db.get('photo', walkId);
    return r ? { entryId: r.entry_id, createdAtMs: r.created_at, size: r.size } : null;
  }

  // --- Install identity ---

  /** This install's sync device id, stored with the data it owns. */
  async deviceId(): Promise<string> {
    const tx = this.db.transaction('meta', 'readwrite');
    const existing = await tx.store.get('device_id');
    if (existing && DEVICE_ID_PATTERN.test(existing.value)) {
      await tx.done;
      return existing.value;
    }
    const id = newId();
    await tx.store.put({ key: 'device_id', value: id });
    await tx.done;
    return id;
  }

  // --- Debug view ---

  /** Raw rows per table, for the DB viewer. Photo bytes are summarised as `<N bytes>`. */
  async dumpTables(): Promise<Record<string, object[]>> {
    const photos = (await this.db.getAll('photo')).map(({ data: _data, ...r }) => ({ ...r, data: `<${r.size} bytes>` }));
    return {
      walk: await this.db.getAll('walk'),
      stop: await this.db.getAll('stop'),
      entry: await this.db.getAll('entry'),
      photo: photos,
    };
  }

  // --- Sync: walk/stop/entry rows only. Photos are never uploaded. ---

  /** Up to `limitPerTable` changed rows per table. Each row carries `updated_at`, the version that is uploaded. */
  async pendingChanges(limitPerTable = 200): Promise<SyncBatch> {
    const pending = async <T extends { updated_at: number | null; synced_at: number | null }>(table: SyncedTable) =>
      ((await this.db.getAll(table)) as unknown as T[])
        .filter(isPending)
        .sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0))
        .slice(0, limitPerTable);

    const strip = <T extends { synced_at: number | null }>({ synced_at: _s, ...rest }: T) => rest;
    const walk = (await pending<WalkRow>('walk')).map(strip);
    const stop = (await pending<StopRow>('stop')).map(strip);
    // Entries also carry has_photo (0/1) so the server can count photos without receiving the image.
    const entry = await Promise.all(
      (await pending<EntryRow>('entry')).map(async (r) => ({ ...strip(r), has_photo: (await this.hasPhotoFor(r.id)) ? 1 : 0 })),
    );
    return { walk, stop, entry };
  }

  /**
   * Marks exactly the uploaded versions as synced. Rows changed again after `pendingChanges` read them
   * stay pending. Deliberately does not emit a change: uploads aren't user-visible edits, and emitting
   * would re-trigger change-driven sync forever.
   */
  async markSynced(batch: SyncBatch): Promise<void> {
    const tx = this.db.transaction(['walk', 'stop', 'entry'], 'readwrite');
    for (const table of SYNCED_TABLES) {
      const store = tx.objectStore(table) as unknown as {
        get(k: string): Promise<{ synced_at: number | null } | undefined>;
        put(v: unknown): Promise<unknown>;
      };
      for (const r of batch[table] as { id: string; updated_at?: number | null }[]) {
        const row = await store.get(r.id);
        if (row) await store.put({ ...row, synced_at: r.updated_at ?? 1 });
      }
    }
    await tx.done;
  }

  async pendingCount(): Promise<number> {
    let n = 0;
    for (const t of SYNCED_TABLES) n += ((await this.db.getAll(t)) as { updated_at: number | null; synced_at: number | null }[]).filter(isPending).length;
    return n;
  }

  close(): void {
    this.emitter.clear();
    this.db.close();
  }
}

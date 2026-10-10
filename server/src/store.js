// Writes validated rows to MongoDB. Each SQLite row becomes one document
// with _id = row id, plus the owning deviceId and a server receive time.

export const COLLECTIONS = ['walks', 'stops', 'entries'];

const DUPLICATE_KEY = 11000;

/** Creates the indexes the app's queries need. Safe to call on every start. */
export async function ensureIndexes(db) {
  await Promise.all([
    db.collection('walks').createIndex({ deviceId: 1, created_at: -1 }),
    db.collection('stops').createIndex({ walk_id: 1, position: 1 }),
    db.collection('entries').createIndex({ stop_id: 1, recorded_at: 1 }),
    db.collection('stops').createIndex({ lat: 1, lng: 1 }), // /v1/places area lookup
    db.collection('reports').createIndex({ entryId: 1 }), // /v1/reports hiding
  ]);
}

/**
 * Upserts rows so that:
 *  - re-sending the same batch is harmless (idempotent);
 *  - an older version never overwrites a newer one (updated_at comparison),
 *    even if two requests arrive out of order;
 *  - a device can only write documents it created (deviceId in the filter).
 *
 * When the filter doesn't match because the stored copy is newer or belongs to
 * another device, the upsert tries to insert a second _id and MongoDB rejects
 * it with a duplicate-key error. Those are expected and counted as "skipped".
 */
export async function upsertRows(db, collection, deviceId, rows, now = new Date()) {
  if (rows.length === 0) return { written: 0, skipped: 0, foreign: 0 };
  const ops = rows.map(({ id, ...fields }) => ({
    updateOne: {
      filter: { _id: id, deviceId, updated_at: { $lt: fields.updated_at } },
      update: { $set: { ...fields, deviceId, receivedAt: now } },
      upsert: true,
    },
  }));
  let written;
  let missed = []; // ids whose filter didn't match (stale or foreign)
  try {
    const r = await db.collection(collection).bulkWrite(ops, { ordered: false });
    written = r.upsertedCount + r.modifiedCount;
  } catch (e) {
    // Driver v6 types writeErrors as "one or more"; normalize to an array.
    const errors = [].concat(e.writeErrors ?? []);
    const unexpected = errors.filter((w) => (w.code ?? w.err?.code) !== DUPLICATE_KEY);
    if (errors.length === 0 || unexpected.length > 0) throw e;
    const r = e.result;
    written = (r?.upsertedCount ?? 0) + (r?.modifiedCount ?? 0);
    missed = errors.map((w) => rows[w.index]?.id).filter(Boolean);
  }
  // Tell "another install owns this" apart from "a newer copy is stored":
  // the first means this device can never update the row, so it's reported.
  const foreign = missed.length
    ? await db.collection(collection).countDocuments({ _id: { $in: missed }, deviceId: { $ne: deviceId } })
    : 0;
  return { written, skipped: rows.length - written - foreign, foreign };
}

/** Upserts a validated payload in dependency order. */
export async function applySync(db, payload, now = new Date()) {
  const counts = {};
  for (const c of COLLECTIONS) {
    counts[c] = await upsertRows(db, c, payload.deviceId, payload[c], now);
  }
  return counts;
}

/** Totals over all collections, in the `{accepted, skipped}` shape the data
 *  track's SyncClient reads. Foreign rows count as skipped there. */
export function totals(counts) {
  let accepted = 0;
  let skipped = 0;
  for (const c of Object.values(counts)) {
    accepted += c.written;
    skipped += c.skipped + c.foreign;
  }
  return { accepted, skipped };
}

/** Data-track name for applySync; returns `{accepted, skipped}`. */
export async function saveSync(db, payload, now = () => new Date()) {
  return totals(await applySync(db, payload, now()));
}

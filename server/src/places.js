// Community stats: how many people walked past a place and left notes/photos there.
// Aggregates only. No transcripts or images ever leave this module; photos are
// known only as a has_photo flag (images stay on the phone).
import { hiddenEntryIds } from './reports.js';
import { ValidationError } from './validate.js';

export const MIN_RADIUS_M = 100;
export const MAX_RADIUS_M = 5000;
export const MAX_PLACES = 500;
const MAX_STOPS = 20000;
export const NOTES_PER_PLACE = 3;
const NOTES_PER_DEVICE = 1; // one voice per person per place, so a crowd reads like a crowd
const PER_DEVICE_CAP = 3; // one person cannot inflate a place by spamming entries
const CHUNK = 1000;

const fail = (m) => {
  throw new ValidationError(m);
};

/** Validates `?lat=&lng=&radius=` and returns numbers. */
export function parsePlacesQuery(q) {
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  const radiusM = Number(q.radius);
  if (q.lat === undefined || !Number.isFinite(lat) || lat < -90 || lat > 90) fail('lat must be a number in -90..90');
  if (q.lng === undefined || !Number.isFinite(lng) || lng < -180 || lng > 180) fail('lng must be a number in -180..180');
  if (q.radius === undefined || !Number.isFinite(radiusM) || radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) {
    fail(`radius must be ${MIN_RADIUS_M}..${MAX_RADIUS_M} metres`);
  }
  return { lat, lng, radiusM };
}

function haversineM(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

const chunks = (arr) => Array.from({ length: Math.ceil(arr.length / CHUNK) }, (_, i) => arr.slice(i * CHUNK, (i + 1) * CHUNK));
const hasText = (s) => typeof s === 'string' && s.trim() !== '';

/**
 * Per-place stats (keyed by OSM id) for stops inside the circle, counting only finished walks.
 * Places seen by fewer than `minDevices` different phones are left out.
 */
export async function placeStats(db, { lat, lng, radiusM }, { minDevices = 2, hideAfter } = {}) {
  const dLat = radiusM / 110540;
  const dLng = radiusM / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const stops = (
    await db
      .collection('stops')
      .find(
        { lat: { $gte: lat - dLat, $lte: lat + dLat }, lng: { $gte: lng - dLng, $lte: lng + dLng } },
        { projection: { osm_id: 1, walk_id: 1, deviceId: 1, lat: 1, lng: 1 }, limit: MAX_STOPS },
      )
      .toArray()
  ).filter((s) => s.osm_id && haversineM(lat, lng, s.lat, s.lng) <= radiusM);
  if (stops.length === 0) return { places: [] };

  // A prepared-but-never-walked quest is not a visit.
  const done = new Set();
  for (const ids of chunks([...new Set(stops.map((s) => s.walk_id))])) {
    const walks = await db.collection('walks').find({ _id: { $in: ids }, status: 'done' }, { projection: { _id: 1 } }).toArray();
    for (const w of walks) done.add(w._id);
  }

  const places = new Map(); // osm_id -> {walks:Set, devices:Set, stopIds:Set, perDevice:Map}
  const stopToPlace = new Map();
  for (const s of stops) {
    if (!done.has(s.walk_id)) continue;
    let p = places.get(s.osm_id);
    if (!p) places.set(s.osm_id, (p = { walks: new Set(), devices: new Set(), perDevice: new Map() }));
    p.walks.add(s.walk_id);
    p.devices.add(s.deviceId);
    stopToPlace.set(s._id, s.osm_id);
  }

  let entries = [];
  for (const ids of chunks([...stopToPlace.keys()])) {
    entries = entries.concat(
      await db
        .collection('entries')
        .find({ stop_id: { $in: ids } }, { projection: { stop_id: 1, deviceId: 1, raw_transcript: 1, cleaned_text: 1, has_photo: 1, shared: 1, shared_text: 1, recorded_at: 1 } })
        .toArray(),
    );
  }
  const hidden = await hiddenEntryIds(
    db,
    entries.filter((e) => e.shared === 1).map((e) => e._id),
    hideAfter,
  );
  for (const e of entries) {
    const p = places.get(stopToPlace.get(e.stop_id));
    if (!p) continue;
    // Only what the author chose to publish (a snapshot), never their private text or photo.
    if (e.shared === 1 && hasText(e.shared_text) && !hidden.has(e._id)) {
      (p.notes ??= []).push({ id: e._id, text: e.shared_text.trim(), photo: e.has_photo === 1, at: e.recorded_at ?? 0, deviceId: e.deviceId });
    }
    const c = p.perDevice.get(e.deviceId) ?? { entries: 0, notes: 0, photos: 0 };
    c.entries += 1;
    if (hasText(e.cleaned_text) || hasText(e.raw_transcript)) c.notes += 1;
    if (e.has_photo === 1) c.photos += 1;
    p.perDevice.set(e.deviceId, c);
  }

  const out = [];
  for (const [osm_id, p] of places) {
    if (p.devices.size < minDevices) continue;
    const sum = (k) => [...p.perDevice.values()].reduce((a, c) => a + Math.min(c[k], PER_DEVICE_CAP), 0);
    out.push({
      osm_id,
      walks: p.walks.size,
      devices: p.devices.size,
      entries: sum('entries'),
      notes: sum('notes'),
      photos: sum('photos'),
      shared_notes: pickNotes(p.notes ?? []),
    });
  }
  out.sort((a, b) => b.walks - a.walks || (a.osm_id < b.osm_id ? -1 : 1));
  return { places: out.slice(0, MAX_PLACES) };
}

/** Newest first, one per phone, at most NOTES_PER_PLACE. Strips the device id: authors stay anonymous. */
function pickNotes(notes) {
  const seen = new Map();
  const out = [];
  for (const n of [...notes].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))) {
    if ((seen.get(n.deviceId) ?? 0) >= NOTES_PER_DEVICE) continue;
    seen.set(n.deviceId, (seen.get(n.deviceId) ?? 0) + 1);
    out.push({ id: n.id, text: n.text, photo: n.photo, at: n.at });
    if (out.length === NOTES_PER_PLACE) break;
  }
  return out;
}

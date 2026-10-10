// "Report this note": hides shared notes that other people flag. Reports are never deleted; hiding is computed at read time.
import { ValidationError } from './validate.js';

export const HIDE_AFTER_DEFAULT = 3;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DEVICE_ID = /^[0-9a-f]{32}$/;
const DUPLICATE_KEY = 11000;

export const REASONS = ['inappropriate', 'wrong_place', 'private_info', 'spam', 'other'];

const fail = (m) => {
  throw new ValidationError(m);
};

/** `{deviceId, entryId, reason?}` -> clean object or ValidationError. */
export function validateReport(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) fail('body must be an object');
  if (typeof body.deviceId !== 'string' || !DEVICE_ID.test(body.deviceId)) fail('deviceId must be 32 lowercase hex chars');
  if (typeof body.entryId !== 'string' || !ID.test(body.entryId)) fail('entryId is invalid');
  const reason = body.reason ?? 'other';
  if (!REASONS.includes(reason)) fail(`reason must be one of ${REASONS.join(', ')}`);
  return { deviceId: body.deviceId, entryId: body.entryId, reason };
}

/** Records a report. Returns 'recorded', 'duplicate' or 'unknown_entry'. One report per phone per note. */
export async function saveReport(db, report, now = () => new Date()) {
  const entry = (await db.collection('entries').find({ _id: report.entryId }).toArray())[0];
  if (!entry) return 'unknown_entry';
  try {
    await db.collection('reports').insertOne({
      _id: `${report.entryId}:${report.deviceId}`,
      entryId: report.entryId,
      deviceId: report.deviceId,
      reason: report.reason,
      byAuthor: entry.deviceId === report.deviceId,
      at: now(),
    });
    return 'recorded';
  } catch (e) {
    if (e?.code === DUPLICATE_KEY) return 'duplicate';
    throw e;
  }
}

/** Ids (among `entryIds`) that must not be shown: reported by their author or by `hideAfter` different phones. */
export async function hiddenEntryIds(db, entryIds, hideAfter = HIDE_AFTER_DEFAULT) {
  const hidden = new Set();
  if (entryIds.length === 0) return hidden;
  const byEntry = new Map();
  for (let i = 0; i < entryIds.length; i += 1000) {
    const rows = await db.collection('reports').find({ entryId: { $in: entryIds.slice(i, i + 1000) } }).toArray();
    for (const r of rows) {
      const g = byEntry.get(r.entryId) ?? { devices: new Set(), author: false };
      g.devices.add(r.deviceId);
      g.author ||= r.byAuthor === true;
      byEntry.set(r.entryId, g);
    }
  }
  for (const [id, g] of byEntry) if (g.author || g.devices.size >= hideAfter) hidden.add(id);
  return hidden;
}

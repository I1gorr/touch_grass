import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applySync, upsertRows } from '../src/store.js';

const DEVICE = '0123456789abcdef0123456789abcdef';

/** Minimal stand-in for a mongodb Db: records bulkWrite calls, returns scripted results. */
function fakeDb(behaviour = () => ({ upsertedCount: 0, modifiedCount: 0, matchedCount: 0 }), owners = {}) {
  const calls = [];
  return {
    calls,
    collection: (name) => ({
      bulkWrite: async (ops, opts) => {
        calls.push({ name, ops, opts });
        return behaviour(name, ops);
      },
      // owners: _id -> deviceId of the stored document
      countDocuments: async ({ _id, deviceId }) =>
        _id.$in.filter((id) => owners[id] !== undefined && owners[id] !== deviceId.$ne).length,
    }),
  };
}

test('builds version-guarded, device-scoped upserts', async () => {
  const db = fakeDb(() => ({ upsertedCount: 1, modifiedCount: 0, matchedCount: 0 }));
  const now = new Date(0);
  const r = await upsertRows(db, 'walks', DEVICE, [{ id: 'w1', status: 'done', updated_at: 7 }], now);
  assert.deepEqual(r, { written: 1, skipped: 0, foreign: 0 });
  const op = db.calls[0].ops[0].updateOne;
  assert.deepEqual(op.filter, { _id: 'w1', deviceId: DEVICE, updated_at: { $lt: 7 } });
  assert.deepEqual(op.update.$set, { status: 'done', updated_at: 7, deviceId: DEVICE, receivedAt: now });
  assert.equal(op.upsert, true);
  assert.equal(db.calls[0].opts.ordered, false);
});

test('empty batch makes no DB call', async () => {
  const db = fakeDb();
  assert.deepEqual(await upsertRows(db, 'walks', DEVICE, []), { written: 0, skipped: 0, foreign: 0 });
  assert.equal(db.calls.length, 0);
});

test('duplicate-key errors (stale or foreign rows) are skipped, not failures', async () => {
  const db = fakeDb(() => {
    const e = new Error('E11000');
    e.writeErrors = { code: 11000, index: 1 }; // single object, as driver v6 may return
    e.result = { upsertedCount: 1, modifiedCount: 0 };
    throw e;
  });
  const r = await upsertRows(db, 'entries', DEVICE, [
    { id: 'a', updated_at: 2 },
    { id: 'b', updated_at: 1 },
  ]);
  assert.deepEqual(r, { written: 1, skipped: 1, foreign: 0 });
});

test('rows owned by another install are reported as foreign, not silently skipped', async () => {
  const OTHER = 'fedcba9876543210fedcba9876543210';
  const db = fakeDb(
    () => {
      const e = new Error('E11000');
      e.writeErrors = [
        { code: 11000, index: 0 }, // 'mine-stale': stored copy is newer, same device
        { code: 11000, index: 1 }, // 'theirs': belongs to another install
      ];
      e.result = { upsertedCount: 1, modifiedCount: 0 };
      throw e;
    },
    { 'mine-stale': DEVICE, theirs: OTHER },
  );
  const r = await upsertRows(db, 'entries', DEVICE, [
    { id: 'mine-stale', updated_at: 1 },
    { id: 'theirs', updated_at: 5 },
    { id: 'new', updated_at: 1 },
  ]);
  assert.deepEqual(r, { written: 1, skipped: 1, foreign: 1 });
});

test('any other write error propagates (so the app retries)', async () => {
  const db = fakeDb(() => {
    const e = new Error('boom');
    e.writeErrors = [{ code: 11000 }, { code: 121 }]; // 121 = document validation failure
    throw e;
  });
  await assert.rejects(upsertRows(db, 'entries', DEVICE, [{ id: 'a', updated_at: 1 }, { id: 'b', updated_at: 1 }]));
});

test('network errors propagate', async () => {
  const db = fakeDb(() => {
    throw new Error('connection reset');
  });
  await assert.rejects(upsertRows(db, 'walks', DEVICE, [{ id: 'a', updated_at: 1 }]), /connection reset/);
});

test('applySync writes walks, then stops, then entries', async () => {
  const db = fakeDb(() => ({ upsertedCount: 1, modifiedCount: 0, matchedCount: 0 }));
  const counts = await applySync(db, {
    deviceId: DEVICE,
    walks: [{ id: 'w', updated_at: 1 }],
    stops: [{ id: 's', walk_id: 'w', updated_at: 1 }],
    entries: [{ id: 'e', stop_id: 's', updated_at: 1 }],
  });
  assert.deepEqual(db.calls.map((c) => c.name), ['walks', 'stops', 'entries']);
  assert.equal(counts.entries.written, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { saveSync } from '../src/store.js';
import { validateSync } from '../src/validate.js';
import { createFakeDb } from './fake_db.js';

// Ported from the data track; adapted to this API: every /v1 call sends the API key.
const KEY = 'test-key-0123456789';
const authed = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), 'x-api-key': KEY } });


const deviceId = 'd'.repeat(32);
const other = 'e'.repeat(32);
const walk = (o = {}) => ({ id: 'w1', created_at: 1, start_lat: 40.1, start_lng: -73.9, time_of_day: 'night', weather_summary: 'clear', status: 'ready', updated_at: 5, ...o });
const stop = (o = {}) => ({ id: 'w1-0', walk_id: 'w1', position: 0, osm_id: 'node/1', name: 'A', lat: 1, lng: 2, tags_json: '{}', blurb: '', prompt: 'p', updated_at: 5, ...o });

const sync = (db, body) => saveSync(db, validateSync(body));

test('new rows are accepted, stored under _id with deviceId and receivedAt', async () => {
  const db = createFakeDb();
  const r = await sync(db, { deviceId, walks: [walk()], stops: [stop()] });
  assert.deepEqual(r, { accepted: 2, skipped: 0 });
  const doc = db.data.get('walks').get('w1');
  assert.equal(doc.deviceId, deviceId);
  assert.ok(doc.receivedAt instanceof Date);
  assert.equal('id' in doc, false);
  assert.equal(doc.status, 'ready');
});

test('re-sending the same batch is harmless (skipped, not errors)', async () => {
  const db = createFakeDb();
  await sync(db, { deviceId, walks: [walk()] });
  assert.deepEqual(await sync(db, { deviceId, walks: [walk()] }), { accepted: 0, skipped: 1 });
});

test('newer version overwrites; older version never does', async () => {
  const db = createFakeDb();
  await sync(db, { deviceId, walks: [walk({ updated_at: 5 })] });
  assert.deepEqual(await sync(db, { deviceId, walks: [walk({ updated_at: 9, status: 'done' })] }), { accepted: 1, skipped: 0 });
  assert.deepEqual(await sync(db, { deviceId, walks: [walk({ updated_at: 7, status: 'active' })] }), { accepted: 0, skipped: 1 });
  assert.equal(db.data.get('walks').get('w1').status, 'done');
});

test('another device cannot change a document it does not own', async () => {
  const db = createFakeDb();
  await sync(db, { deviceId, walks: [walk()] });
  assert.deepEqual(await sync(db, { deviceId: other, walks: [walk({ updated_at: 99, status: 'done' })] }), { accepted: 0, skipped: 1 });
  assert.equal(db.data.get('walks').get('w1').status, 'ready');
});

test('HTTP: POST /v1/sync, validation errors and healthz', async () => {
  const server = createApp({ apiKey: KEY, db: createFakeDb() }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, raw = false) =>
    authed(`${base}/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body) });
  try {
    assert.deepEqual(await (await authed(`${base}/healthz`)).json(), { ok: true });
    const ok = await post({ deviceId, walks: [walk()], stops: [stop()] });
    assert.equal(ok.status, 200);
    // The data track's SyncClient reads these two fields; the original reply shape is also present.
    const reply = await ok.json();
    assert.equal(reply.accepted, 2);
    assert.equal(reply.skipped, 0);
    assert.equal(reply.ok, true);
    assert.equal(reply.counts.walks.written, 1);
    assert.equal((await post({ deviceId: 'nope' })).status, 400);
    assert.equal((await post({ deviceId, walks: [walk({ id: { $gt: '' } })] })).status, 400);
    assert.equal((await post('{not json', true)).status, 400);
    const big = await post({ deviceId, stops: [stop({ blurb: 'x'.repeat(19000) })], pad: 'y'.repeat(2.5 * 1024 * 1024) });
    assert.equal(big.status, 413);
  } finally {
    server.close();
  }
});

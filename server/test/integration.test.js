// Guarantees for merging the data track into this API: old clients keep
// working, new fields and routes work, and no image data or paths are stored.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app.js';
import { createFakeDb } from './fake_db.js';

const KEY = 'test-key-0123456789';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
let db;
let server;
let base;

before(async () => {
  db = createFakeDb();
  await new Promise((r) => {
    server = createApp({ db, apiKey: KEY, log: { error: () => {} } }).listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const call = (path, { method = 'GET', body, key = KEY } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const walk = (id, o = {}) => ({ id, created_at: 1, start_lat: 40.78, start_lng: -73.96, status: 'done', updated_at: 5, ...o });
const stop = (walkId, o = {}) => ({ id: `${walkId}-0`, walk_id: walkId, position: 0, osm_id: 'node/9', name: 'Pond', lat: 40.781, lng: -73.961, updated_at: 5, ...o });

test('the original reply shape is unchanged; totals are added alongside', async () => {
  const r = await call('/v1/sync', { method: 'POST', body: { deviceId: A, walks: [walk('w1')] } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.counts.walks, { written: 1, skipped: 0, foreign: 0 });
  assert.deepEqual([body.accepted, body.skipped], [1, 0]);
});

test('rows from the current app (no new fields at all) are still accepted', async () => {
  const r = await call('/v1/sync', {
    method: 'POST',
    body: { deviceId: A, entries: [{ id: 'e-old', stop_id: 's', recorded_at: 1, raw_transcript: 'hi', updated_at: 1 }] },
  });
  assert.equal(r.status, 200);
  const doc = db.data.get('entries').get('e-old');
  assert.equal(doc.has_photo, null);
  assert.equal(doc.shared, null);
});

test('a photo path from a data-track client becomes has_photo; the path is never stored', async () => {
  await call('/v1/sync', {
    method: 'POST',
    body: {
      deviceId: A,
      entries: [
        { id: 'e-path', stop_id: 's', photo_path: '/data/user/0/app/photos/x.jpg', updated_at: 1 },
        { id: 'e-nopath', stop_id: 's', photo_path: null, updated_at: 1 },
      ],
    },
  });
  const withPath = db.data.get('entries').get('e-path');
  assert.equal(withPath.has_photo, 1);
  assert.equal('photo_path' in withPath, false);
  assert.equal(db.data.get('entries').get('e-nopath').has_photo, 0);
  assert.ok(!JSON.stringify([...db.data.get('entries').values()]).includes('/data/user'), 'no path anywhere');
});

test('has_photo sent directly wins over a stray photo_path', async () => {
  await call('/v1/sync', {
    method: 'POST',
    body: { deviceId: A, entries: [{ id: 'e-flag', stop_id: 's', has_photo: 0, photo_path: '/x.jpg', updated_at: 1 }] },
  });
  assert.equal(db.data.get('entries').get('e-flag').has_photo, 0);
});

test('new fields are validated: route_json stored, bad flags and long snippets rejected', async () => {
  const route = JSON.stringify({ v: 1, mode: 'street', polyline: 'abc', legs_m: [100] });
  assert.equal((await call('/v1/sync', { method: 'POST', body: { deviceId: A, walks: [walk('w-route', { route_json: route })] } })).status, 200);
  assert.equal(db.data.get('walks').get('w-route').route_json, route);
  for (const bad of [{ shared: 2 }, { has_photo: true }, { shared_text: 'x'.repeat(281) }, { photo_path: 42 }]) {
    const r = await call('/v1/sync', { method: 'POST', body: { deviceId: A, entries: [{ id: 'e-bad', stop_id: 's', updated_at: 1, ...bad }] } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

test('/v1/places and /v1/reports require the API key, like /v1/sync', async () => {
  for (const [path, method, body] of [
    ['/v1/places?lat=40.78&lng=-73.96&radius=1000', 'GET'],
    ['/v1/reports', 'POST', { deviceId: A, entryId: 'e-old' }],
    ['/v1/sync', 'POST', { deviceId: A }],
  ]) {
    assert.equal((await call(path, { method, body, key: 'wrong' })).status, 401, path);
    assert.equal((await call(path, { method, body, key: null })).status, 401, path);
  }
});

test('end to end: photos from both kinds of client are counted, shared notes stay anonymous', async () => {
  // Phone A: current app (has_photo flag, shares a note). Phone B: data-track app (photo path).
  await call('/v1/sync', {
    method: 'POST',
    body: {
      deviceId: A,
      walks: [walk('wa')],
      stops: [stop('wa')],
      entries: [{ id: 'ea', stop_id: 'wa-0', cleaned_text: 'Ducks!', has_photo: 1, shared: 1, shared_text: 'Ducks!', recorded_at: 9, updated_at: 5 }],
    },
  });
  await call('/v1/sync', {
    method: 'POST',
    body: {
      deviceId: B,
      walks: [walk('wb')],
      stops: [stop('wb')],
      entries: [{ id: 'eb', stop_id: 'wb-0', raw_transcript: 'quiet', photo_path: '/sdcard/p.jpg', updated_at: 5 }],
    },
  });
  const r = await call('/v1/places?lat=40.78&lng=-73.96&radius=1000');
  assert.equal(r.status, 200);
  const text = await r.text();
  const place = JSON.parse(text).places.find((p) => p.osm_id === 'node/9');
  assert.deepEqual([place.walks, place.devices, place.photos, place.notes], [2, 2, 2, 2]);
  assert.deepEqual(place.shared_notes, [{ id: 'ea', text: 'Ducks!', photo: true, at: 9 }]);
  assert.ok(!text.includes(A) && !text.includes('/sdcard'), 'no device ids or paths in the answer');

  // Reporting by its author hides the note at once.
  assert.equal((await call('/v1/reports', { method: 'POST', body: { deviceId: A, entryId: 'ea', reason: 'other' } })).status, 202);
  const after = JSON.parse(await (await call('/v1/places?lat=40.78&lng=-73.96&radius=1000')).text());
  assert.deepEqual(after.places.find((p) => p.osm_id === 'node/9').shared_notes, []);
});

test('still no image routes', async () => {
  for (const path of ['/v1/walks/w1/photo', '/v1/photos']) {
    assert.equal((await call(path, { method: 'PUT', body: {} })).status, 404, path);
  }
});

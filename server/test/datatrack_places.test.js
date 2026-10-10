import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { parsePlacesQuery, placeStats } from '../src/places.js';
import { saveReport, validateReport } from '../src/reports.js';
import { saveSync } from '../src/store.js';
import { validateSync } from '../src/validate.js';
import { createFakeDb } from './fake_db.js';

// Ported from the data track; adapted to this API: every /v1 call sends the API key.
const KEY = 'test-key-0123456789';
const authed = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), 'x-api-key': KEY } });


const dev = (c) => c.repeat(32);
const q = { lat: 40.78, lng: -73.96, radiusM: 1000 };

// One finished walk by `deviceId` that stops at the given places and leaves `entries`.
async function walkBy(db, deviceId, walkId, places, { status = 'done', entries = [] } = {}) {
  const walks = [{ id: walkId, created_at: 1, start_lat: 40.78, start_lng: -73.96, time_of_day: 'morning', weather_summary: 'x', status, updated_at: 5 }];
  const stops = places.map(([osm, lat, lng], i) => ({
    id: `${walkId}-${i}`, walk_id: walkId, position: i, osm_id: osm, name: osm, lat, lng, tags_json: '{}', blurb: '', prompt: 'p', updated_at: 5,
  }));
  await saveSync(db, validateSync({ deviceId, walks, stops, entries: entries.map((e, i) => ({ id: `${walkId}e${i}`, recorded_at: 1, updated_at: 5, raw_transcript: null, cleaned_text: null, photo_path: null, ...e })) }));
}

test('counts visits, notes and photos per place for finished walks only', async () => {
  const db = createFakeDb();
  const P = ['node/1', 40.781, -73.961];
  await walkBy(db, dev('a'), 'wa', [P], { entries: [{ stop_id: 'wa-0', cleaned_text: 'lovely' }, { stop_id: 'wa-0', photo_path: '/p.jpg' }] });
  await walkBy(db, dev('b'), 'wb', [P], { entries: [{ stop_id: 'wb-0', raw_transcript: 'quiet here' }] });
  await walkBy(db, dev('c'), 'wc', [P], { status: 'ready' }); // never walked
  const { places } = await placeStats(db, q);
  assert.deepEqual(places, [{ osm_id: 'node/1', walks: 2, devices: 2, entries: 3, notes: 2, photos: 1, shared_notes: [] }]);
});

test('whitespace-only transcripts are not notes; silence counts as an entry', async () => {
  const db = createFakeDb();
  const P = ['node/1', 40.781, -73.961];
  await walkBy(db, dev('a'), 'wa', [P], { entries: [{ stop_id: 'wa-0', raw_transcript: '   ' }, { stop_id: 'wa-0', raw_transcript: '' }] });
  await walkBy(db, dev('b'), 'wb', [P]);
  const [p] = (await placeStats(db, q)).places;
  assert.equal(p.entries, 2);
  assert.equal(p.notes, 0);
});

test('places seen by too few different phones are hidden', async () => {
  const db = createFakeDb();
  await walkBy(db, dev('a'), 'wa', [['node/1', 40.781, -73.961]]);
  await walkBy(db, dev('a'), 'wa2', [['node/1', 40.781, -73.961]]); // same phone twice
  assert.deepEqual((await placeStats(db, q)).places, []);
  assert.equal((await placeStats(db, q, { minDevices: 1 })).places.length, 1);
});

test('one phone cannot inflate a place: per-device cap of 3', async () => {
  const db = createFakeDb();
  const P = ['node/1', 40.781, -73.961];
  const spam = Array.from({ length: 10 }, () => ({ stop_id: 'wa-0', cleaned_text: 'spam' }));
  await walkBy(db, dev('a'), 'wa', [P], { entries: spam });
  await walkBy(db, dev('b'), 'wb', [P]);
  const [p] = (await placeStats(db, q)).places;
  assert.equal(p.notes, 3);
  assert.equal(p.entries, 3);
});

test('only places inside the circle are returned', async () => {
  const db = createFakeDb();
  const near = ['node/near', 40.781, -73.961];
  const far = ['node/far', 40.80, -73.96]; // ~2.2 km north
  await walkBy(db, dev('a'), 'wa', [near, far]);
  await walkBy(db, dev('b'), 'wb', [near, far]);
  assert.deepEqual((await placeStats(db, q)).places.map((p) => p.osm_id), ['node/near']);
  assert.deepEqual((await placeStats(db, { ...q, radiusM: 3000 })).places.map((p) => p.osm_id).sort(), ['node/far', 'node/near']);
});

test('query validation', () => {
  assert.deepEqual(parsePlacesQuery({ lat: '40.7', lng: '-73.9', radius: '1500' }), { lat: 40.7, lng: -73.9, radiusM: 1500 });
  for (const bad of [{}, { lat: 'x', lng: '1', radius: '500' }, { lat: '91', lng: '1', radius: '500' }, { lat: '1', lng: '181', radius: '500' },
    { lat: '1', lng: '1', radius: '50' }, { lat: '1', lng: '1', radius: '99999' }, { lat: '1', lng: '1' }]) {
    assert.throws(() => parsePlacesQuery(bad), /must be/);
  }
});

test('HTTP: GET /v1/places returns counts only, bad queries are 400', async () => {
  const db = createFakeDb();
  const P = ['node/1', 40.781, -73.961];
  await walkBy(db, dev('a'), 'wa', [P], { entries: [{ stop_id: 'wa-0', cleaned_text: 'secret memory', photo_path: '/home/me/p.jpg' }] });
  await walkBy(db, dev('b'), 'wb', [P]);
  const server = createApp({ apiKey: KEY, db }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authed(`${base}/v1/places?lat=40.78&lng=-73.96&radius=1000`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('secret memory') && !text.includes('/home/me') && !text.includes(dev('a')), 'no raw content or device ids');
    assert.equal(JSON.parse(text).places[0].notes, 1);
    assert.equal((await authed(`${base}/v1/places?lat=40.78&lng=-73.96`)).status, 400);
  } finally {
    server.close();
  }
});

// ---- shared notes + reports ----
const P1 = ['node/1', 40.781, -73.961];
const share = (stop, text, extra = {}) => ({ stop_id: stop, cleaned_text: `private: ${text}`, raw_transcript: `raw: ${text}`, shared: 1, shared_text: text, ...extra });
const names = (res) => res.places[0].shared_notes.map((n) => n.text);

test('only entries the author chose to share are published, and only the shared snapshot', async () => {
  const db = createFakeDb();
  await walkBy(db, dev('a'), 'wa', [P1], { entries: [share('wa-0', 'The fountain is lovely at dusk'), { stop_id: 'wa-0', cleaned_text: 'my private diary', raw_transcript: 'raw diary' }] });
  await walkBy(db, dev('b'), 'wb', [P1], { entries: [{ stop_id: 'wb-0', cleaned_text: 'also private' }] });
  const res = await placeStats(db, q);
  assert.deepEqual(names(res), ['The fountain is lovely at dusk']);
  const text = JSON.stringify(res);
  for (const secret of ['my private diary', 'raw diary', 'also private', 'private: ', dev('a'), dev('b')]) assert.ok(!text.includes(secret), secret);
  assert.equal(res.places[0].notes, 3, 'counts still include private entries');
});

test('notes are anonymous: id, text, photo flag and time only; photo path is never exposed', async () => {
  const db = createFakeDb();
  await walkBy(db, dev('a'), 'wa', [P1], { entries: [share('wa-0', 'nice view', { photo_path: '/home/me/secret.jpg', recorded_at: 77 })] });
  await walkBy(db, dev('b'), 'wb', [P1]);
  const [n] = (await placeStats(db, q)).places[0].shared_notes;
  assert.deepEqual(Object.keys(n).sort(), ['at', 'id', 'photo', 'text']);
  assert.equal(n.photo, true);
  assert.equal(n.at, 77);
  assert.ok(!JSON.stringify(n).includes('secret.jpg'));
});

test('unsharing removes the note after the next sync; an empty snapshot is never published', async () => {
  const db = createFakeDb();
  await walkBy(db, dev('a'), 'wa', [P1], { entries: [share('wa-0', 'hello')] });
  await walkBy(db, dev('b'), 'wb', [P1]);
  assert.deepEqual(names(await placeStats(db, q)), ['hello']);
  await saveSync(db, validateSync({ deviceId: dev('a'), entries: [{ id: 'wae0', stop_id: 'wa-0', recorded_at: 1, shared: 0, shared_text: null, updated_at: 9 }] }));
  assert.deepEqual((await placeStats(db, q)).places[0].shared_notes, []);
  await walkBy(db, dev('c'), 'wc', [P1], { entries: [share('wc-0', '   ')] });
  assert.deepEqual((await placeStats(db, q)).places[0].shared_notes, []);
});

test('newest first, at most 3 per place, one per phone', async () => {
  const db = createFakeDb();
  for (const [i, c] of ['a', 'b', 'c', 'd', 'e'].entries()) {
    await walkBy(db, dev(c), `w${c}`, [P1], { entries: [share(`w${c}-0`, `note ${c}`, { recorded_at: 100 + i })] });
  }
  await walkBy(db, dev('e'), 'we2', [P1], { entries: [share('we2-0', 'note e again', { recorded_at: 500 })] });
  assert.deepEqual(names(await placeStats(db, q)), ['note e again', 'note d', 'note c']);
});

test('shared notes respect the privacy floor and unfinished walks', async () => {
  const db = createFakeDb();
  await walkBy(db, dev('a'), 'wa', [P1], { entries: [share('wa-0', 'solo note')] });
  assert.deepEqual((await placeStats(db, q)).places, []);
  await walkBy(db, dev('b'), 'wb', [P1], { status: 'active', entries: [share('wb-0', 'in progress')] });
  assert.deepEqual((await placeStats(db, q)).places, []);
});

test('sync accepts shared/shared_text and rejects over-long snippets and bad flags', () => {
  const e = (o) => ({ id: 'e1', stop_id: 's1', recorded_at: 1, updated_at: 1, ...o });
  assert.equal(validateSync({ deviceId: dev('a'), entries: [e({ shared: 1, shared_text: 'x'.repeat(280) })] }).entries[0].shared, 1);
  assert.equal(validateSync({ deviceId: dev('a'), entries: [e({})] }).entries[0].shared, null);
  assert.throws(() => validateSync({ deviceId: dev('a'), entries: [e({ shared_text: 'x'.repeat(281) })] }), /shared_text/);
  assert.throws(() => validateSync({ deviceId: dev('a'), entries: [e({ shared: 2 })] }), /shared/);
  assert.throws(() => validateSync({ deviceId: dev('a'), entries: [e({ shared: true })] }), /shared/);
});

test('three different phones reporting a note hides it; duplicates count once', async () => {
  const db = createFakeDb();
  await walkBy(db, dev('a'), 'wa', [P1], { entries: [share('wa-0', 'rude note')] });
  await walkBy(db, dev('b'), 'wb', [P1]);
  const report = (c, reason) => saveReport(db, validateReport({ deviceId: dev(c), entryId: 'wae0', reason }));
  assert.equal(await report('b'), 'recorded');
  assert.equal(await report('b', 'spam'), 'duplicate');
  assert.equal(await report('c', 'inappropriate'), 'recorded');
  assert.deepEqual(names(await placeStats(db, q)), ['rude note'], 'two reporters: still visible');
  assert.equal(await report('d', 'private_info'), 'recorded');
  assert.deepEqual((await placeStats(db, q)).places[0].shared_notes, []);
});

test('the author reporting their own note hides it at once', async () => {
  const db = createFakeDb();
  await walkBy(db, dev('a'), 'wa', [P1], { entries: [share('wa-0', 'oops')] });
  await walkBy(db, dev('b'), 'wb', [P1]);
  await saveReport(db, validateReport({ deviceId: dev('a'), entryId: 'wae0' }));
  assert.deepEqual((await placeStats(db, q)).places[0].shared_notes, []);
});

test('report validation and unknown notes', async () => {
  assert.throws(() => validateReport({ deviceId: 'x', entryId: 'e' }), /deviceId/);
  assert.throws(() => validateReport({ deviceId: dev('a'), entryId: { $gt: '' } }), /entryId/);
  assert.throws(() => validateReport({ deviceId: dev('a'), entryId: 'e', reason: 'bogus' }), /reason/);
  assert.equal(await saveReport(createFakeDb(), validateReport({ deviceId: dev('a'), entryId: 'nope' })), 'unknown_entry');
});

test('HTTP: POST /v1/reports returns 202/404/400 and hides the note on the next /v1/places', async () => {
  const db = createFakeDb();
  await walkBy(db, dev('a'), 'wa', [P1], { entries: [share('wa-0', 'hello')] });
  await walkBy(db, dev('b'), 'wb', [P1]);
  const server = createApp({ apiKey: KEY, db, hideAfter: 2 }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => authed(`${base}/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const places = async () => (await (await authed(`${base}/v1/places?lat=40.78&lng=-73.96&radius=1000`)).json()).places[0].shared_notes;
    assert.equal((await places()).length, 1);
    assert.equal((await post({ deviceId: dev('b'), entryId: 'wae0', reason: 'spam' })).status, 202);
    assert.equal((await post({ deviceId: dev('b'), entryId: 'wae0' })).status, 202);
    assert.equal((await places()).length, 1);
    assert.equal((await post({ deviceId: dev('c'), entryId: 'wae0' })).status, 202);
    assert.equal((await places()).length, 0);
    assert.equal((await post({ deviceId: dev('c'), entryId: 'missing' })).status, 404);
    assert.equal((await post({ deviceId: 'bad', entryId: 'wae0' })).status, 400);
  } finally {
    server.close();
  }
});

// HTTP-level tests: real Express app on a random port, stub DB. No Atlas needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app.js';

const KEY = 'test-key-0123456789';
const DEVICE = '0123456789abcdef0123456789abcdef';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42isom')]);

const calls = { apply: [] };
let server;
let base;

before(async () => {
  const db = { command: async () => ({ ok: 1 }) };
  const app = createApp({
    db,
    apiKey: KEY,
    apply: async (_db, payload) => {
      calls.apply.push(payload);
      return { walks: { written: payload.walks.length, skipped: 0 } };
    },
    log: { error: () => {} },
  });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

const sync = (body, key = KEY) =>
  fetch(`${base}/v1/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('healthz pings the DB', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('sync: valid payload is applied', async () => {
  const r = await sync({ deviceId: DEVICE, walks: [{ id: 'w1', status: 'done', updated_at: 2 }] });
  assert.equal(r.status, 200);
  assert.equal(calls.apply.at(-1).walks[0].id, 'w1');
});

test('sync: wrong or missing API key → 401, nothing applied', async () => {
  const before = calls.apply.length;
  assert.equal((await sync({ deviceId: DEVICE }, 'wrong')).status, 401);
  assert.equal((await sync({ deviceId: DEVICE }, '')).status, 401);
  assert.equal(calls.apply.length, before);
});

test('sync: invalid payload → 400 with a reason', async () => {
  const r = await sync({ deviceId: 'nope' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /deviceId/);
});

test('sync: malformed JSON → 400', async () => {
  assert.equal((await sync('{not json')).status, 400);
});

test('no image upload route: photo PUT/POST → 404, nothing stored', async () => {
  const before = calls.apply.length;
  for (const method of ['PUT', 'POST']) {
    for (const path of ['/v1/walks/w1/photo', '/v1/photos', '/v1/videos', '/v1/walks/w1/video']) {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'image/jpeg', 'x-api-key': KEY },
        body: JPEG,
      });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
  }
  assert.equal(calls.apply.length, before);
});

test('image bytes posted to /v1/sync are rejected (not a JSON payload)', async () => {
  const before = calls.apply.length;
  for (const [type, body] of [['image/jpeg', JPEG], ['video/mp4', MP4]]) {
    const r = await fetch(`${base}/v1/sync`, { method: 'POST', headers: { 'content-type': type, 'x-api-key': KEY }, body });
    assert.equal(r.status, 400, type);
  }
  assert.equal(calls.apply.length, before);
});

test('photo fields smuggled into sync rows are stripped before storage', async () => {
  const r = await sync({
    deviceId: DEVICE,
    entries: [
      {
        id: 'e1',
        stop_id: 's1',
        recorded_at: 1,
        photo_path: '/data/user/0/app/photos/x.jpg',
        photo: JPEG.toString('base64'),
        data: { $binary: 'AAAA' },
        updated_at: 2,
      },
    ],
  });
  assert.equal(r.status, 200);
  const entry = calls.apply.at(-1).entries[0];
  for (const field of ['photo_path', 'photo', 'data']) assert.equal(entry[field], undefined, field);
});

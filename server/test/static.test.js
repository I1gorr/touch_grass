// Serving the built web app from the API server: assets, deep links, caching, and the API staying untouched.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app.js';

const KEY = 'test-key-0123456789';
let server;
let base;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Touch Grass</title>');
  writeFileSync(join(dir, 'sw.js'), '// service worker');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Touch Grass"}');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'assets', 'ort-abc123.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  const app = createApp({ db: { command: async () => ({ ok: 1 }) }, apiKey: KEY, staticDir: dir, log: { error: () => {} } });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('the app is served at the root, never cached without revalidation', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Touch Grass/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
});

test('the service worker and manifest are revalidated, so updates arrive', async () => {
  assert.equal((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(`${base}/manifest.webmanifest`)).headers.get('cache-control'), 'no-cache');
});

test('content-hashed assets are cached for a year, with the right types', async () => {
  const js = await fetch(`${base}/assets/index-abc123.js`);
  assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/assets/ort-abc123.wasm`)).headers.get('content-type'), 'application/wasm');
});

test('a reload on a deep link gets the app, but a missing file is a real 404', async () => {
  const deep = await fetch(`${base}/walk/abc123`);
  assert.equal(deep.status, 200);
  assert.match(await deep.text(), /Touch Grass/);
  assert.equal((await fetch(`${base}/assets/missing-123.js`)).status, 404);
  assert.equal((await fetch(`${base}/nope.png`)).status, 404);
});

test('the API is untouched: JSON 404 for unknown API paths, key still required, health still works', async () => {
  const unknown = await fetch(`${base}/v1/nothing`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'not found' });
  assert.equal((await fetch(`${base}/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
});

test('refuses to start with a folder that is not a built web app', () => {
  assert.throws(() => createApp({ db: {}, apiKey: KEY, staticDir: tmpdir() }), /no index\.html/);
});

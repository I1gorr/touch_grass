// CORS: allow-listed web origins can call the API from a browser; everyone else gets no CORS headers.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app.js';
import { cors, parseAllowedOrigins } from '../src/cors.js';

const KEY = 'test-key-0123456789';
const DEVICE = '0123456789abcdef0123456789abcdef';
const APP = 'https://touch-grass.example.com';

let server;
let base;
let applied = 0;

before(async () => {
  const app = createApp({
    db: { command: async () => ({ ok: 1 }) },
    apiKey: KEY,
    apply: async () => (applied++, { walks: { written: 0, skipped: 0 } }),
    log: { error: () => {} },
    allowedOrigins: parseAllowedOrigins(`${APP}/, http://localhost:5173`),
  });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const preflight = (origin) =>
  fetch(`${base}/v1/sync`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-api-key' },
  });

test('parseAllowedOrigins trims, drops trailing slashes and empty entries', () => {
  assert.deepEqual(parseAllowedOrigins(' https://a.b/ , ,http://c:1 '), ['https://a.b', 'http://c:1']);
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
});

test('preflight from an allowed origin: 204 with the CORS headers, and no API key needed', async () => {
  const r = await preflight(APP);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), APP);
  assert.match(r.headers.get('access-control-allow-headers'), /x-api-key/i);
  assert.match(r.headers.get('access-control-allow-methods'), /POST/);
  assert.match(r.headers.get('vary') ?? '', /Origin/i);
  assert.equal(applied, 0, 'a preflight never reaches the API');
});

test('preflight from another site gets no CORS headers, so the browser blocks the call', async () => {
  const r = await preflight('https://evil.example.com');
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal(r.headers.get('access-control-allow-methods'), null);
});

test('the real request from an allowed origin carries the header; the key is still required', async () => {
  const ok = await fetch(`${base}/v1/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, origin: APP },
    body: JSON.stringify({ deviceId: DEVICE }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), APP);
  const denied = await fetch(`${base}/v1/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'wrong', origin: APP },
    body: '{}',
  });
  assert.equal(denied.status, 401, 'CORS is not authentication');
  assert.equal(denied.headers.get('access-control-allow-origin'), APP, 'the browser can read the error');
});

test('a localhost dev origin is allowed when listed', async () => {
  assert.equal((await preflight('http://localhost:5173')).headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('requests without an Origin (the old Android app, curl) are unaffected', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('wildcard allows any origin (and does not vary on it)', async () => {
  const handler = cors(['*']);
  const headers = {};
  const res = { set: (k, v) => (typeof k === 'object' ? Object.assign(headers, k) : (headers[k] = v)), vary: () => assert.fail('no Vary for *'), status: () => res, end: () => {} };
  let nexted = false;
  handler({ method: 'GET', get: (h) => (h === 'origin' ? 'https://anything.example' : undefined) }, res, () => (nexted = true));
  assert.equal(headers['Access-Control-Allow-Origin'], '*');
  assert.ok(nexted);
});

test('with no allowed origins configured, CORS is off', async () => {
  const handler = cors([]);
  const headers = {};
  const res = { set: (k, v) => (headers[k] = v), vary: () => {}, status: () => res, end: () => {} };
  handler({ method: 'GET', get: (h) => (h === 'origin' ? APP : undefined) }, res, () => {});
  assert.deepEqual(headers, {});
});

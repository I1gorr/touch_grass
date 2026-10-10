import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LIMITS, ValidationError, validatePayload, validateRow } from '../src/validate.js';

const DEVICE = '0123456789abcdef0123456789abcdef';
const walk = { id: 'w1', created_at: 1, start_lat: 51.5, start_lng: -0.1, time_of_day: 'morning', weather_summary: 'dry', status: 'ready', updated_at: 5 };

test('accepts a valid payload and keeps only known fields', () => {
  const p = validatePayload({
    deviceId: DEVICE,
    walks: [{ ...walk, injected: '$where' }],
    stops: [{ id: 'w1-0', walk_id: 'w1', position: 0, name: 'Bench', lat: 1, lng: 2, tags_json: '{}', updated_at: 5 }],
    entries: [{ id: 'e1', stop_id: 'w1-0', recorded_at: 9, raw_transcript: null, updated_at: 6 }],
  });
  assert.equal(p.walks[0].injected, undefined);
  assert.equal(p.entries[0].raw_transcript, null);
  assert.equal(p.stops.length, 1);
});

test('missing collections default to empty', () => {
  const p = validatePayload({ deviceId: DEVICE });
  assert.deepEqual([p.walks, p.stops, p.entries], [[], [], []]);
});

test('rows from before change tracking (null updated_at) get version 1', () => {
  assert.equal(validateRow('walks', { ...walk, updated_at: null }).updated_at, 1);
});

for (const [name, body] of [
  ['non-object body', [1, 2]],
  ['missing deviceId', { walks: [] }],
  ['bad deviceId', { deviceId: 'ABC' }],
  ['collection not an array', { deviceId: DEVICE, walks: {} }],
  ['row not an object', { deviceId: DEVICE, walks: ['x'] }],
  ['missing id', { deviceId: DEVICE, walks: [{ ...walk, id: undefined }] }],
  ['operator in id', { deviceId: DEVICE, walks: [{ ...walk, id: { $gt: '' } }] }],
  ['id with path chars', { deviceId: DEVICE, walks: [{ ...walk, id: '../x' }] }],
  ['NaN coordinate', { deviceId: DEVICE, walks: [{ ...walk, start_lat: NaN }] }],
  ['string coordinate', { deviceId: DEVICE, walks: [{ ...walk, start_lat: '51.5' }] }],
  ['float timestamp', { deviceId: DEVICE, walks: [{ ...walk, created_at: 1.5 }] }],
  ['unknown status', { deviceId: DEVICE, walks: [{ ...walk, status: 'deleted' }] }],
  ['stop without walk_id', { deviceId: DEVICE, stops: [{ id: 's', name: 'x' }] }],
  ['huge string', { deviceId: DEVICE, entries: [{ id: 'e', stop_id: 's', raw_transcript: 'x'.repeat(LIMITS.maxStringLength + 1) }] }],
]) {
  test(`rejects: ${name}`, () => {
    assert.throws(() => validatePayload(body), ValidationError);
  });
}

test('rejects too many rows across collections', () => {
  const half = Math.ceil(LIMITS.maxRowsPerRequest / 2) + 1;
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ ...walk, id: `w${i}` }));
  assert.throws(
    () => validatePayload({ deviceId: DEVICE, walks: rows(half), stops: rows(half).map((w) => ({ id: w.id, walk_id: 'w' })) }),
    /too many rows/,
  );
});

test('entries never keep photo fields (images stay on the phone)', () => {
  const [e] = validatePayload({
    deviceId: DEVICE,
    entries: [{ id: 'e', stop_id: 's', photo_path: '/p/x.jpg', photo: 'base64…', updated_at: 1 }],
  }).entries;
  assert.equal('photo_path' in e, false);
  assert.equal('photo' in e, false);
});

# Touch Grass sync API → MongoDB Atlas

The phone keeps everything in SQLite, including photos, so walks work offline. When it's online it POSTs new or
changed walk/stop/entry rows (text only) here, and this service upserts them into Atlas. **Atlas credentials live only on this server**;
the app only knows this API's URL and key.

```
phone (SQLite, source of truth) ──HTTPS, x-api-key──▶ this API ──mongodb driver──▶ Atlas
```

## Setup
1. In Atlas: create a cluster, then a **database user with readWrite on `touch_grass` only**.
   Add this server's IP under Network Access.
2. `cp .env.example .env` and fill in `MONGODB_URI` and `API_KEY` (16+ random chars).
3. `npm install`, then `node --env-file=.env src/index.js` (Node ≥ 20.6; or export the vars yourself).
4. `curl localhost:8080/healthz` should return `{"ok":true}`.

<<<<<<< HEAD

## Web app: CORS and hosting

The web app in `../web` can use this server two ways.

- **Same origin (simplest).** Build the web app (`cd ../web && npm run build`) and start this server with
  `STATIC_DIR=../web/dist`. It serves the app, the service worker (never cached without revalidation) and the hashed assets
  (cached for a year), and falls back to `index.html` for page reloads. The API is untouched. No CORS is needed.
  Put the server behind HTTPS: the microphone, camera and offline mode need it.
- **Different origin.** Set `ALLOWED_ORIGINS=https://your-app-origin` (comma-separated, no trailing slash). Those origins
  get CORS headers and preflight answers; every other origin gets none, so browsers block it. With nothing set, CORS is off
  and only same-origin pages and non-browser clients (curl) can call the API. `*` allows any site; use it for
  testing only. CORS is not authentication: the `x-api-key` is still required.

Note that the key the web app sends ships inside the web bundle, so anyone who opens the app can read it. That is acceptable
for a private beta; before a public release the API needs per-user authentication.
=======
Run the app against it:
```
flutter run --dart-define=SYNC_URL=https://your-host --dart-define=SYNC_API_KEY=<same key>
```
The URL can also be changed under Settings → Cloud backup; the key is build-time only.
For the Android emulator talking to a laptop, use `http://10.0.2.2:8080`. Plain http is accepted only for
localhost/LAN, and Android also needs `android:usesCleartextTraffic="true"` for that debug build.
>>>>>>> 63bdaa2 (p1p2 with data layer)

## API
| Method | Path | |
|---|---|---|
| GET | `/healthz` | pings Atlas: 200 or 503 |
| POST | `/v1/sync` | header `x-api-key`; body `{deviceId, walks[], stops[], entries[]}` (rows as in SQLite) |
| GET | `/v1/places?lat=&lng=&radius=` | header `x-api-key`; community counts and opt-in shared notes for an area (100–5000 m) |
| POST | `/v1/reports` | header `x-api-key`; body `{deviceId, entryId, reason?}`; 202 recorded, 404 unknown note |

**Merged from the data track** (`/home/aardo/Touch grass`), without changing existing behaviour:
- `/v1/sync` also accepts `walks.route_json`, `entries.has_photo` (0/1), `entries.shared` (0/1) and
  `entries.shared_text` (≤ 280 chars). All optional: clients that don't send them are unaffected.
- A legacy `entries.photo_path` is turned into `has_photo` and dropped; no path or image is ever stored.
- The reply keeps `{ok, counts}` and adds the totals `accepted` and `skipped`, which the data track's client reads.
- `/v1/places` and `/v1/reports` need the same API key as `/v1/sync`.
- Env: `MIN_DEVICES` (default 2) hides places seen by fewer phones; `HIDE_AFTER` (default 3) reports hide a note.

**No images.** Photos stay in the phone's SQLite database and never reach this API or Atlas. There is no
photo or media route (404), non-JSON bodies on `/v1/sync` are rejected (400), and any `photo_path` or other
image field in a row is dropped by the allow-list.

Responses: 200 `{ok, counts}` where each collection reports `written`, `skipped` (a newer copy is stored) and
`foreign` (owned by another install; the app surfaces these), 400 invalid payload, 401 bad key (the app pauses auto-sync),
413 too large, 5xx (the app retries later).

## Data model in Atlas
Collections `walks`, `stops` and `entries`. One document per SQLite row, `_id` = row id. Fields are the same
snake_case columns, plus `deviceId` and `receivedAt`.

Write rules (`src/store.js`):
- **Idempotent**: re-sending a batch is harmless.
- **No stale overwrites**: a write applies only if its `updated_at` is newer than the stored one.
- **Device-scoped**: a device can't overwrite another device's documents.

## Tests
`npm test` uses Node's built-in runner. It covers validation and write logic with a stub DB, with no Atlas needed.

## Not done yet
- Photos are not backed up (by design): they exist only on the phone.
- Deletes: the app doesn't delete rows today, so there's nothing to sync. Add tombstones if that changes.
- The shared API key identifies *the app*, not a user. Add real auth (e.g. sign-in → per-user token) before
  any public release, and put a rate limiter in front.

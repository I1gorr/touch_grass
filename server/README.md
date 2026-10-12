# Touch Grass sync API

This Render-ready Express service receives the small text/metadata rows produced by the web PWA and stores them in MongoDB Atlas. The browser keeps the local IndexedDB copy as its source of truth.

```text
PWA IndexedDB ── HTTPS + x-api-key ──▶ Express API ── MongoDB driver ──▶ MongoDB Atlas
```

Photos, audio recordings, and raw image bytes are never sent to this service.

## Local setup

1. In MongoDB Atlas, create a database user with `readWrite` access to the `touch_grass` database.
2. Add the server's network location under Atlas Network Access. For testing, Atlas's temporary `0.0.0.0/0` rule works but is less restrictive.
3. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

4. Set `MONGODB_URI` and a matching `API_KEY` of at least 16 characters.
5. Start the service:

   ```bash
   npm install
   node --env-file=.env src/index.js
   ```

6. Check it:

   ```bash
   curl http://localhost:8080/healthz
   ```

Expected response:

```json
{"ok":true}
```

## Render deployment

Create a Render Web Service for this `server/` directory:

```text
Build command: npm install
Start command: npm start
```

Set these Render environment variables:

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Atlas connection string |
| `MONGODB_DB` | Database name; normally `touch_grass` |
| `API_KEY` | Shared API key used by the PWA |
| `ALLOWED_ORIGINS` | Exact static-site origin, for example `https://prairie.onrender.com` |
| `PORT` | Usually supplied by Render; the app defaults to `8080` locally |

`ALLOWED_ORIGINS` must contain the exact PWA origin with no trailing slash. Without it, browser requests from a separate Render Static Site are blocked by CORS before they reach the API.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Pings Atlas and returns service health |
| `POST` | `/v1/sync` | Upserts device-owned walks, stops, and journal metadata |
| `POST` | `/v1/delete-walk` | Deletes one device-owned journey tree and its reports |
| `GET` | `/v1/places?lat=&lng=&radius=` | Returns privacy-filtered community counts and shared notes |
| `POST` | `/v1/reports` | Records a report against a shared note |

Protected routes require the `x-api-key` header. The delete endpoint accepts `{deviceId, walkId}` and removes the matching walk, stops, entries, and reports. It is safe when the journey was never uploaded: the server simply has nothing to remove.

## Automatic sync behavior

The PWA syncs automatically after local changes, when connectivity returns, and on a periodic timer. It does not expose a manual sync control in Settings. If the network is unavailable, local rows remain pending and retry later. Journey deletion is local-first and leaves a durable deletion request so an Atlas copy can be removed later.

## Atlas data model

The service stores separate MongoDB documents in `walks`, `stops`, and `entries`, one document per local row. Documents contain `_id`, `deviceId`, `receivedAt`, and the allow-listed row fields. Reports are stored separately.

- `walks`: quest status, start point, conditions, and compact route JSON.
- `stops`: stop name, coordinates, tags, blurb, and prompt.
- `entries`: raw transcript, cleaned text, timestamp, sharing flags, and a photo-present flag.
- `reports`: report metadata for shared notes.

Images, audio, file paths, and EXIF data are not stored in Atlas. The `deviceId` prevents one installation from overwriting another installation's records.

## Tests

```bash
npm test
```

The Node test suite uses an in-memory stub database and does not require a live Atlas cluster.

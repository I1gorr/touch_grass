# Touch Grass

Touch Grass is an installable offline-first PWA for short, reflective walks. It prepares a street-routed quest while the user is online, then lets them walk, record voice notes, take a photo, and continue without a connection.

The deployed product is split into two services:

```text
Android/Chrome PWA ── HTTPS + x-api-key ──▶ Render sync API ── MongoDB driver ──▶ MongoDB Atlas
       │                                      │
       └── IndexedDB: walks, notes, photos, models, map packs
```

## What is built

- Street-based loop quests from cached OpenStreetMap data.
- Offline route packs after the area has been downloaded once.
- Voice notes recorded locally and transcribed on-device with Whisper.
- Optional on-device Gemma 3 1B cleanup for punctuation, capitalization, and filler removal.
- A formatted/raw journal toggle, with timestamps stored separately from model output.
- Local-first deletion of incomplete or completed journeys.
- Automatic cloud sync with MongoDB Atlas when the browser is online.
- Device-scoped Atlas records; photos and audio recordings never leave the device.
- Green, mobile-first interface with no database viewer or mini-map in the user-facing UI.

## Repository map

| Area | Purpose |
|---|---|
| [`web/`](web/README.md) | Deployed PWA, routing, IndexedDB, on-device models, journal UI |
| [`server/`](server/README.md) | Render-ready Express API and MongoDB Atlas integration |
| [`lib/datatrack/`](lib/datatrack/tracks/data/README.md) | Legacy/reference Dart routing and data-track implementation |
| [`INTEGRATE.md`](INTEGRATE.md) | Dart integration notes retained for the original app track |

## Local development

```bash
cd web
npm install
npm run dev
```

The development server uses HTTPS because microphone, camera, service workers, and offline storage require a secure context. For the API:

```bash
cd server
npm install
node --env-file=.env src/index.js
```

## Deployment overview

The current deployment uses:

1. A Render Web Service for `server/`.
2. A Render Static Site for the built `web/` application.
3. A free MongoDB Atlas cluster for cloud backup.

The web build receives `VITE_SYNC_URL` and `VITE_SYNC_API_KEY` at build time. The API receives `MONGODB_URI`, `MONGODB_DB`, `API_KEY`, and `ALLOWED_ORIGINS` at runtime. See the service-specific READMEs for the exact settings.

## Tests

```bash
cd web && npm run typecheck && npm test && npm run build
cd server && npm test
```

The web suite uses fake IndexedDB and does not require network access. The server suite uses a stub database and does not require an Atlas account.

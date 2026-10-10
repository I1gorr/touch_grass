<<<<<<< HEAD
# Touch Grass

Offline walk-quest app: an installable PWA for Android (Chrome → "Add to Home screen") that plans street-routed walk
loops, records voice notes, and transcribes them on the phone.

- Web app, deployment, on-device models, tests: [`web/README.md`](web/README.md)
- Cloud backup API (also serves the web app and answers browser calls): [`server/README.md`](server/README.md)
- **New to the project? Start with [`docs/WEB_HANDOFF.md`](docs/WEB_HANDOFF.md)** (what was built, why, architecture, what is verified, what to do next)
- Data schema (SQLite + Atlas) and why: [`docs/DATA_SCHEMA.md`](docs/DATA_SCHEMA.md)

Quick start: `cd web && npm install && npm run dev`.

Tests: `cd web && npm test` (web app), `cd server && npm test` (sync API).
=======
# Touch Grass: data layer

The database, cloud backup and routing code of the Touch Grass walk-quest app (Flutter). The screens, recording
and language-model code are not part of this repository.

```
phone (SQLite, source of truth) ──HTTPS, x-api-key──▶ server/ ──mongodb driver──▶ MongoDB Atlas
```

| | Where |
|---|---|
| **Setup**: opens the database and starts the backup | `lib/database.dart` (`AppDatabase.open`) |
| **SQLite**: schema and migrations, walks/stops/entries, photos as BLOBs | `lib/db/`, `lib/models/` |
| **SQLite (data track)**: saved quests with their route, place history, shared notes | `lib/datatrack/db/`, `lib/datatrack/models/` |
| **Backup to MongoDB**: change tracking and upload | `lib/sync/` |
| **MongoDB**: sync API and Atlas store | `server/` (see `server/README.md`) |
| **Street routing** (walk graph, A*, route recommender) | `lib/datatrack/routing/` |
| **Map packs and places** (Overpass, offline packs, bundled Central Park pack) | `lib/datatrack/tracks/data/`, `assets/fallback/` |
| **Route variety** (short/medium/long rotation from walk history) | `lib/services/route_planner.dart` |
| Data schema (SQLite + Atlas) and why | `docs/DATA_SCHEMA.md`, `docs/datatrack/DATA_SCHEMA.md` |

## Setup
Step-by-step guide for plugging this into an app: **`INTEGRATE.md`**.

```dart
final db = await AppDatabase.open(config: SyncConfig.fromEnvironment());
await db.repo.insertWalk(walk, stops);     // changes are uploaded in the background
await db.close();
```
Backup is off unless a sync URL is given at build time:
```
flutter run --dart-define=SYNC_URL=https://your-host --dart-define=SYNC_API_KEY=<server API_KEY>
```
Server setup (Atlas user, `.env`, `npm install`): `server/README.md`.

## Tests
```bash
flutter analyze
flutter test                 # SQLite, sync, routing, map packs
cd server && npm test        # sync API (no Atlas needed)
```
Map scripts: `dart run scripts/datatrack/smoke_route.dart`, `dart run scripts/datatrack/record_pack.dart`.
>>>>>>> 63bdaa2 (p1p2 with data layer)

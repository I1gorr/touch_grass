# Integrating the Touch Grass data layer

How to plug the database, cloud backup and routing into a Flutter app. Everything here is plain Dart classes. There is
no UI, so you call them from your own screens. For what each piece is, see `README.md`.

```
your app ──▶ AppDatabase.repo / .routes (SQLite on the phone, the source of truth)
                │  changes
                ▼
             AppDatabase.sync ──HTTPS, x-api-key──▶ server/ ──▶ MongoDB Atlas
your app ──▶ RouteService (street routing on offline map packs) ──▶ PreparedQuest ──▶ .routes.saveQuest
```

---

## 1. Add the dependency

From another Flutter project:
```yaml
dependencies:
  touch_grass:
    path: ../touch_grass        # or a git: url
```
Then `flutter pub get`. Imports are `package:touch_grass/...`.

**Bundled demo map.** `loadBundledPack()` reads `assets/fallback/*.json` through `rootBundle`. A host app loads a
package's assets under `packages/touch_grass/...`, so when you use this as a dependency, copy `assets/fallback/` into
your app and list it under `flutter: assets:`. Otherwise `loadBundledPack()` returns `null`. It doesn't throw, but
there is no offline fallback map.

**Android.** `sqflite` and `path_provider` are standard plugins with no extra setup. For a debug build that talks to a
plain-http server on your laptop, add `android:usesCleartextTraffic="true"` to that build's manifest (see §6).

---

## 2. Open the database once at startup

```dart
import 'package:touch_grass/database.dart';

late final AppDatabase db;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  db = await AppDatabase.open(config: SyncConfig.fromEnvironment());
  runApp(const MyApp());
}
```
- One `AppDatabase` per app. It opens `<databases>/touch_grass.db` and runs any missing migrations.
- `db.repo` is the main `WalkRepository`: walks, stops, entries (voice notes) and the walk photo.
- `db.routes` (data track) works on the **same file**: saved quests with their street route, place history, sharing.
  Both writers share one version clock, so the backup always sees the latest edit.
- `db.sync` is `null` unless a sync URL is configured (§5).
- Call `await db.close()` on shutdown. It waits for an upload that's still running.

---

## 3. Store walks, stops, entries and photos

```dart
import 'package:touch_grass/interfaces/types.dart';
import 'package:touch_grass/models/entry.dart';
import 'package:touch_grass/models/walk.dart';
import 'package:touch_grass/models/walk_photo.dart';
import 'package:touch_grass/util/ids.dart';

final walkId = newId();
await db.repo.insertWalk(
  Walk(id: walkId, createdAt: DateTime.now(), startLat: 40.78, startLng: -73.97,
       timeOfDay: 'morning', weatherSummary: 'mild'),
  [Stop(id: '$walkId-0', osmId: 'node/1', name: 'Bench', lat: 40.781, lng: -73.971, tagsJson: '{}')],
);
await db.repo.updateWalkStatus(walkId, WalkStatus.active);

final entry = Entry(id: newId(), stopId: '$walkId-0', recordedAt: DateTime.now(), rawTranscript: 'Nice view');
await db.repo.insertEntry(entry);
await db.repo.updateEntry(entry.id, cleanedText: 'Nice view.');

// One photo per walk, stored as a BLOB. Static JPEG/PNG only; it never leaves the phone.
await db.repo.putWalkPhoto(WalkPhoto(walkId: walkId, entryId: entry.id, mime: 'image/jpeg',
    bytes: jpegBytes, createdAt: DateTime.now()));

final walks = await db.repo.listWalks();               // newest first
final notes = await db.repo.entriesForWalk(walkId);    // oldest first, each has hasPhoto
```
- **Re-render on change:** listen to `db.repo.changes`. It fires after every write.
- **Writes through `db.routes`:** after you call `saveQuest`, `setStatus` or `shareEntry` on it, call
  `db.repo.notifyExternalChange()` so your screens and the backup notice the change.
- **Check photo bytes first:** use `sniffImageType(bytes)` from `util/image_type.dart` before storing. It returns the
  MIME type, or `null` for anything that isn't a static JPEG/PNG.
- **Tests:** `MemoryWalkRepository` implements the same `WalkRepository` interface without SQLite.

---

## 4. Plan a walk on real streets (works offline)

```dart
import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:touch_grass/datatrack/routing/route_recommender.dart';
import 'package:touch_grass/datatrack/tracks/data/bundled_pack.dart';
import 'package:touch_grass/datatrack/tracks/data/offline_pack_store.dart';
import 'package:touch_grass/datatrack/tracks/data/overpass_client.dart';
import 'package:touch_grass/datatrack/tracks/data/pack_downloader.dart';
import 'package:touch_grass/datatrack/tracks/data/place_stats_client.dart';
import 'package:touch_grass/datatrack/tracks/data/report_queue.dart';
import 'package:touch_grass/datatrack/tracks/data/route_service.dart';
import 'package:touch_grass/datatrack/tracks/data/weather_client.dart';

final support = await getApplicationSupportDirectory();
final store = OfflinePackStore(support);
final routes = RouteService(
  packs: store,
  downloader: PackDownloader(                    // null = never use the network
    overpass: OverpassClient(),
    store: store,
    placeStats: PlaceStatsClient(baseUrl: Uri.parse(syncUrl), apiKey: syncApiKey), // optional community counts
  ),
  weather: WeatherService(),
  bundledPack: loadBundledPack,                  // Central Park demo map (see §1)
  placeHistory: db.routes.placeHistory,          // rotates places you've already visited
  reportQueue: ReportQueue(File('${support.path}/reports.json')),
);

final req = RouteRequest(start: here, minutes: 30);   // here: a Location; or distanceM: 2000
final options = await routes.recommend(req);           // 2-3 loops, best first
final pick = options.first;
// pick.option: points (polyline), totalM, durationS, mode ('street' | 'straight'), reasons, cards (notes per stop)

final again = await routes.recalculate(req, skip: {'node/123'}); // never uses the network
await db.routes.saveQuest(pick.quest);           // walk + stops + route_json into SQLite
db.repo.notifyExternalChange();
```
- **Where the map comes from, in order:** a downloaded pack that covers the start, then a fresh download (if online),
  then the bundled pack, then any pack that contains the start. If there is none, it throws `NoPackException`. Show
  "connect to download a map".
- **Draw a saved walk:** `renderWalkJson((await db.routes.loadWalk(id))!)` returns the walk, its stops and entries,
  and `path.points`. It needs no network. For a "pick a route" screen, use `previewJson(options)` from
  `render_preview.dart`.
- **Refresh old maps when the phone is back online:**
  `PackRefresher(store: store, downloader: downloader).refreshStale()`.
- **Without street data:** `lib/services/route_planner.dart` (`RoutePlanner.plan`) picks and orders stops in straight
  lines from a list of places. It uses `RouteHistory.load(db.repo)` to rotate between short, medium and long walks.

---

## 5. Turn on the backup to MongoDB

1. Run the server: `server/README.md` covers the Atlas user, `.env` with `MONGODB_URI` and `API_KEY`,
   `npm install` and `node --env-file=.env src/index.js`. Check it with `curl <host>/healthz`, which should return
   `{"ok":true}`.
2. Build the app with the same key:
   ```
   flutter run --dart-define=SYNC_URL=https://your-host --dart-define=SYNC_API_KEY=<server API_KEY>
   ```
   Or pass `SyncConfig(url: ..., apiKey: ...)` to `AppDatabase.open` yourself. Run a user-typed URL through
   `SyncConfig.normalizeSyncUrl` first. It returns `null` for an invalid URL or plain http to a non-local host.

What happens next is automatic. A sync runs 5 s after a change, every 5 min, and whenever you call
`db.sync!.syncNow()`. Nothing is uploaded while a walk is `active`.

```dart
final s = db.sync;
if (s != null) {
  s.addListener(() => setState(() {}));    // SyncService is a ChangeNotifier
  // s.pending, s.lastSuccess, s.lastError, s.paused (wrong API key), s.refused, s.waitingForWalk
  final r = await s.syncNow();             // e.g. after a walk is finished; r.ok, r.uploaded
}
```
- **Text only:** rows go up without images. Photos stay in SQLite and only a `has_photo` flag is uploaded.
- **Failures:** if a sync fails, nothing is lost. Rows stay pending and are retried. A 401 (wrong key) pauses
  automatic sync until `syncNow()` is called.
- **Your own backend:** `AppDatabase.open(transport: myTransport)` replaces the HTTP client. Implement
  `SyncTransport.push`.

---

## 6. Local development

| From | Server URL |
|---|---|
| Desktop / iOS simulator | `http://localhost:8080` |
| Android emulator | `http://10.0.2.2:8080` |
| Phone on the same Wi-Fi | `http://192.168.x.y:8080` |

Plain http is only accepted for these hosts; anything on the internet needs https.

---

## 7. Changing the schema

Append SQL for the next version to `migrations` in `lib/db/schema.dart`. Don't edit `createStatements`, which is
the v1 baseline. Fresh installs run v1 plus every migration, and existing installs run only the ones they're missing.
New synced columns also need to be allowed by `server/src/validate.js`. The column reference is
`docs/DATA_SCHEMA.md`.

---

## 8. Check it still works

```bash
flutter analyze && flutter test       # SQLite, sync, routing, map packs (no device needed)
cd server && npm test                 # sync API with a stub DB (no Atlas needed)
```
In your own tests, open the real SQLite database on the desktop with `sqflite_common_ffi`:
```dart
sqfliteFfiInit();
final repo = await SqfliteWalkRepository.open(factory: databaseFactoryFfi, path: inMemoryDatabasePath);
final db = await AppDatabase.open(repo: repo);
```

# Data track: places, routing and map packs

Turns a GPS location into a `walk` plus 3-4 walkable `stop`s (schema: `docs/DATA_SCHEMA.md`). Online it queries Overpass; offline it uses the cache, then a bundled fallback dataset. It never touches SQLite, the LLM or the UI; `lib/db` stores what it produces.

## Walk lifecycle
1. **Prepare (online)**: `QuestPreparer.prepare(loc)` -> `PreparedQuest(walk, stops)` -> `WalkRepository.saveQuest` -> `AppDatabase.sync?.syncNow()` (first backup, `lib/database.dart`).
2. **Walk (offline)**: `setStatus(active)`. Everything is read from SQLite: `renderWalkJson(await repo.loadWalk(id))`. The app's `SyncService` skips every run while a walk is active (`walkInProgress: routes.hasActiveWalk`), so nothing touches the network.
3. **Finish**: `setStatus(done)` -> `sync.syncNow()` uploads the status change and all entries. If offline it just stays pending for later.

## Offline route recommendation
"Walk about 30 min (or 2 km) from here" -> ranked loops on real paths, computed on the phone.
```dart
final store = OfflinePackStore(await getApplicationSupportDirectory());
final service = RouteService(
  packs: store,
  downloader: PackDownloader(overpass: OverpassClient(), store: store,
      placeStats: PlaceStatsClient(baseUrl: serverUrl)),   // null = never use the network
  weather: WeatherService(), isOnline: isOnlineNow, bundledPack: loadBundledPack,
  placeHistory: repo.placeHistory,                                          // your own past visits (SQLite)
);
final routes = await service.recommend(RouteRequest(start: here, minutes: 30));   // 2-3 RecommendedRoute
await repo.saveQuest(routes.first.quest);      // the one the person picks
await db.sync?.syncNow();
```
- **Pack** (`offline_pack*.dart`, `pack_downloader.dart`): POIs + walkable OSM ways around the start, sized by `packRadiusFor(budget)`, saved as gzip files. Downloading needs internet; using a pack never does.
- **Routing** (`lib/routing/`): `WalkGraph` (ways joined at shared nodes, footpaths preferred over busy roads) + A*/Dijkstra. `recommendRoutes` picks stops by value per extra metre within 0.7-1.1x of the budget, orders them exactly, returns up to 3 options. Without a graph it falls back to straight lines (`mode: "straight"`).
- **What decides a stop's value** (`lib/routing/place_value.dart`): category weight, blended with community data (notes + photos per visit, trusted more as more different people have been there), times a rotation factor for places *you* already visited (round robin: new places first, never banned), times a seeded random nudge that is bigger where data is thin. No data at all = category weight + round robin + random. `RouteRequest.communityRadiusM` is the area the user trusts (null = whole pack, 0 = off); `seed` defaults to the day number so suggestions rotate daily. Each option carries `reasons` (one line per stop).
- **Community notes** (`RouteOption.cards`, `previewJson`): every recommended stop has a `PlaceCard` with the notes people chose to share, counts, your own visits and a reason. The review screen shows them and the person picks: **keep** (`repo.saveQuest(route.quest)`), **skip a place** and **recalculate** (`service.recalculate(request, skip: {osmId}, reroll: false)`), or **reroll** for a fresh set (`reroll: true`). Recalculating never uses the network. Skipped places are remembered in `route_json.request.skipped`.
- **Sharing** is opt-in per entry: `repo.shareEntry(id)` publishes a snapshot (≤ 280 chars of the *cleaned* text), `repo.unshareEntry(id)` takes it back. Readers can report a note: `ReportQueue.report(noteId)` hides it for them at once (the server side is `POST /v1/reports`).
- **Community data** comes from `GET /v1/places` (counts + shared notes, privacy floor of 2 phones), is downloaded into the pack (`PlaceStatsClient`, `PackDownloader`) and refreshed weekly by `PackRefresher`. Failure never blocks a download or a walk.
- **Budget**: `minutes * 60 * 1.34 m/s` (about 4.8 km/h) or an explicit distance; 3-6 stops depending on length. Walk time is length / speed (steps and hills are not modelled).
- **Updates**: `PackRefresher` refreshes packs older than 30 days when online. A failed refresh keeps the old pack.
- Check: `dart run scripts/datatrack/smoke_route.dart [lat lng minutes]`, then again with `--offline` (no HTTP). Refresh the bundled demo network with `dart run scripts/datatrack/record_pack.dart`.

## Render JSON (`render_json.dart`)
```json
{"walk": {"id","created_at","start_lat","start_lng","time_of_day","weather_summary","status"},
 "stops": [{"id","walk_id","position","osm_id","name","lat","lng","tags_json","blurb","prompt",
            "tags": {…parsed tags_json…}, "entries": [{"id","stop_id","recorded_at","raw_transcript","cleaned_text","photo_path"}]}],
 "path": {"points": [{"lat","lng"}…], "legs_m": […], "total_m": 0}}
```
`path` is the planned street route decoded from `walk.route_json` (adds `duration_s`, `mode`, `stop_point_index`). Walks without one fall back to straight lines start -> stops (`route_path.dart`). Either way no network is needed.

## Usage (paste in PRs)
```dart
final dir = await getApplicationCacheDirectory();           // path_provider
final builder = RealQuestBuilder(overpass: OverpassClient(), cache: CacheStore(dir));
final preparer = QuestPreparer(builder: builder, weather: WeatherService());
final quest = await preparer.prepare(kDemoLocation);        // online prep step
await repo.saveQuest(quest);                                // walk + stops -> SQLite
await db.sync?.syncNow();                                   // first backup, still online
final json = renderWalkJson((await repo.loadWalk(quest.walk.id))!);   // UI input, no network
```
Use `const FakeQuestBuilder()` instead of `RealQuestBuilder` for `--fake-*` / UI work.

## Contract
- `QuestBuilder.build(Location) -> Future<List<Stop>>` (lib/interfaces/quest_builder.dart). Always returns 3-4 stops; never throws on network failure.
- `Stop.id` is `<walkId>-<position>` and `Stop.position` is 0-based route order (set by `QuestPreparer`).
- `Stop.blurb` is empty (Llm fills it). `Stop.prompt` is set from `prompts.dart` (tag type -> question).
- `Stop.tagsJson` is a JSON object of OSM tags (facts for the Llm: name + category).
- `RealQuestBuilder.lastSource` ("cache" | "network" | "fallback") and `lastCandidateCount` are for debug / the Gate 1 check.

## Pipeline
cache (`<cacheDir>/overpass/<lat>_<lng>_<radius>.json`) -> Overpass (3 mirrors) -> widen radius 1200 m to 2500 m if < 6 candidates -> fallback asset (`assets/fallback/demo_overpass.json`)
then: drop wikidata/wikipedia-tagged, nameless, duplicate names -> score (category weight minus distance) -> pick 3-4 with max 2 per category -> nearest-neighbour order.

## Checks
- `flutter test` (routing, map pack, db and sync tests); `cd server && npm test`
- `dart run scripts/datatrack/smoke_data.dart [lat lng]` (live Overpass + Open-Meteo, prints Gate 1 PASS/FAIL)

## Swapping the demo area
Edit `kDemoLocation` in `demo_location.dart`, run the smoke script, and replace `assets/fallback/demo_overpass.json` (and `scripts/fixtures/overpass_live_central_park.json`) with a fresh Overpass response for the new coords. The query is in `OverpassClient.buildQuery`.

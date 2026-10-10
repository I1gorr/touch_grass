# Touch Grass: complete handoff guide

> **One document for everything.** It is written so that a person, or an AI assistant (Claude Code, GitHub Copilot, Cursor, ChatGPT), can pick the project up with no other context: what the product is, what was built and why, how every part works, how to run and test it, what is proven and what is **not**, and what to do next.
>
> Facts here were checked against the code and against test runs on **2026-10-10**. Anything not verified says so explicitly (see [§12](#12-what-is-not-verified)).

---

## Table of contents

1. [The project in one minute](#1-the-project-in-one-minute)
2. [Quick start](#2-quick-start)
3. [Background and decisions](#3-background-and-decisions)
4. [What the app does (user view)](#4-what-the-app-does-user-view)
5. [Architecture](#5-architecture)
6. [Rules that must not be broken](#6-rules-that-must-not-be-broken)
7. [Data model, storage and sync](#7-data-model-storage-and-sync)
8. [Module reference](#8-module-reference)
9. [The route planner, explained](#9-the-route-planner-explained)
10. [On-device speech and language models](#10-on-device-speech-and-language-models)
11. [Offline behaviour and the service worker](#11-offline-behaviour-and-the-service-worker)
12. [What is NOT verified](#12-what-is-not-verified)
13. [Testing](#13-testing)
14. [Configuration reference](#14-configuration-reference)
15. [The sync server](#15-the-sync-server)
16. [Deployment, step by step](#16-deployment-step-by-step)
17. [Backlog: what to do next](#17-backlog-what-to-do-next)
18. [Recipes: how to change things](#18-recipes-how-to-change-things)
19. [Troubleshooting and FAQ](#19-troubleshooting-and-faq)
20. [Bugs found along the way](#20-bugs-found-along-the-way)
21. [Working with an AI assistant](#21-working-with-an-ai-assistant)
22. [Repository state and housekeeping](#22-repository-state-and-housekeeping)
23. [Glossary](#23-glossary)

---

## 1. The project in one minute

**Touch Grass** is a walking-journal app. You choose a roughly 30-minute loop on real streets, visit 3 to 6 interesting places (fountains, viewpoints, artwork, historic spots), speak a short note at each, take one photo per walk, and keep it all as a journal. It is designed to work **offline**.

It started as a **Flutter Android app**. It has now been **rewritten as a web app (a PWA)** in `web/`. A PWA is a website that can be installed to the phone's home screen from Chrome ("Add to Home screen") and keeps working with no network.

Key facts:

- **Voice notes are turned into text on the phone**, using the Whisper speech model running inside the browser. Audio is never uploaded.
- A **language model (Gemma) is optional**. It writes the short description of each stop and tidies the notes. It only works on browsers with **WebGPU**; without it the app uses pre-written text and simple rule-based cleanup. **Speech never depends on the language model.**
- An optional **cloud backup** uses the existing Node.js server in `server/` (MongoDB Atlas).
- The original Flutter code has been **removed**. The route planner is still tested against the Dart planner's recorded output (`web/test/fixtures/dart_parity.json`, frozen).

**Status on 2026-10-10:**

| Area | State |
|---|---|
| Feature port from Flutter | Complete |
| Unit and integration tests (`web/`) | 314 passing in 19 files |
| Server tests (`server/`) | 79 passing |
| Real-browser test scripts | 4 pass (smoke, PWA/offline, on-device speech x2); a 5th (language model) can only check the "no WebGPU" message on the test machine |
| Run on a physical Android phone | **Never** |
| Gemma run inside a browser | **Never** (no WebGPU on the test machine) |
| Committed to git | **No** (see [§22](#22-repository-state-and-housekeeping)) |

---

## 2. Quick start

```sh
cd web
npm install
npm test                 # 314 tests, about 2 seconds, no network needed
npm run typecheck
npm run dev              # https://localhost:5173  (self-signed certificate; accept the warning)
```

Open the `Network:` URL that Vite prints on a phone connected to the same Wi-Fi to try it on a real device. Microphone, camera and the service worker only work in a **secure context**, which is why dev and preview use HTTPS.

```sh
npm run build            # type-check + production build into web/dist/
npm run preview          # serve dist/ over https
npm run preview:http     # serve dist/ over http://127.0.0.1:4174 (needed for service-worker tests)
```

Server (optional, only needed for backup and community notes):

```sh
cd server
npm install
npm test                                      # 79 tests, no database needed
cp .env.example .env                          # then set MONGODB_URI and API_KEY (16+ characters)
STATIC_DIR=../web/dist npm start              # API + the built web app on one origin
```

**A good first session:** run `npm test` and `npm run dev`, walk through the app with the **Sample** settings (Settings > "Sample places and weather" on, "Simulated microphone and camera" on), then read [§5](#5-architecture) and [§12](#12-what-is-not-verified).

---

## 3. Background and decisions

### Where the project came from

The Flutter app was built by several people on separate "tracks": an app track (screens, ML bridge) and a data track (street routing, offline maps, community notes) that were merged. It targeted Android only and depended on things that do not exist on the web: `dart:io` files, `sqflite`, `path_provider`, `Isolate.run`, and a native Android bridge to `whisper.cpp` and `llama.cpp`.

The request was: *"instead of making a Flutter app we want to make it an Android web app."*

### Decisions (and why)

| Decision | Choice | Why |
|---|---|---|
| Flutter app vs web | **Rewrite as a TypeScript PWA** (Vite), not Flutter-web | Smaller, faster, installable. About 15 Flutter files would have needed abstractions for APIs that do not exist on web. |
| Speech and language models | **On-device, in the browser** (transformers.js: Whisper and Gemma) | Privacy and offline use. The alternatives offered (browser Web Speech API, a server proxy) were declined. |
| Flutter code | **Removed** after the port | It was the specification; the TypeScript route planner is still tested for identical output against its recorded results. |
| Sync server | **Kept**; gained CORS and optional hosting of the web app | The `/v1/sync`, `/v1/places` and `/v1/reports` API is unchanged, so old and new clients coexist. |
| UI framework | **None** (a roughly 100-line DOM helper) | The screens are small. Fewer dependencies, and easy for people and AI tools to read. |
| Storage | **IndexedDB** with the same table and column names as the SQLite schema | The sync payload is identical to what the server already validates. |
| Fake transcripts | **Removed** from the default path | The Flutter app substituted canned text when no model existed. The web app keeps the recording and waits (or lets the person type the note). |

### What changed on the way (not in the original plan)

- Gemma **1B** became the recommended language model (270M often made things up).
- Gemma now requires WebGPU, so Settings blocks the download without it.
- A "type it instead" fallback and an in-place "download the speech model" button were added so the journal always works.
- "Use my location", CORS for the server, and static hosting from the server were added.

---

## 4. What the app does (user view)

Screens, in the order a person meets them. The hash router uses URLs like `#/walk/<id>`, so the phone's Back button works.

| Screen | Route | What happens |
|---|---|---|
| **Home** | `#/` | "New quest" card (area, **Prepare quest**, **Use my location**), a banner if voice notes need the speech model, and the list of past walks with status chips. A sync icon appears when backup is on. |
| **Route review** | `#/routes` | 2 or 3 loop options as chips (distance and minutes). Each stop shows its category, the reason it was chosen, community counts and shared notes (which can be reported). Buttons: **Skip** a place, **Other options**, **Start this walk**. |
| **Walk** | `#/walk/:id` | One stop at a time: name, description, a prompt question, your notes. A big record button, a photo button, previous and next, **Finish**. |
| **Journal** | `#/journal/:id` | Read-only: the photo, then each stop with its notes. A switch per note shares the cleaned text with people nearby. Toggle raw and cleaned text. |
| **Settings** | `#/settings` | What is in use now, **on-device models** (download, remove, progress), engine modes, sample mode, area, walk length, community radius, vary routes, max stops, sync address. |
| **Database** | `#/db` | Raw rows of the walk, stop, entry and photo stores (debug view). |

### Typical flow

1. **Prepare quest.** The app finds a map for the area (bundled demo map for Central Park, or a downloaded pack) and proposes loops.
2. Pick a loop and **Start this walk.** Stop descriptions are written (language model, or pre-written text).
3. At each stop, tap the mic and speak. The note appears at once and turns into text on the phone.
4. Take one photo for the whole walk (taking another asks before replacing).
5. **Finish.** Read the journal. Optionally share a note.
6. If backup is on, rows upload when online and no walk is active.

### Permissions the app uses

| Permission | Why | Notes |
|---|---|---|
| Microphone | Voice notes | The stream is kept after the permission prompt and released when recording stops (so the browser's recording indicator turns off). |
| Camera | The walk photo | Via a file input with `capture="environment"`; no camera permission prompt of its own. |
| Location | "Use my location" | One-off, rough position is fine. Optional. |
| Persistent storage | Keep walks and recordings | `navigator.storage.persist()` is requested; the browser may still decline. |
| Wake lock | Keep the screen on while recording | Browsers cut microphone capture when the screen locks. |

---

## 5. Architecture

```
┌──────────────────────────────── the phone's browser (the PWA) ────────────────────────────────┐
│                                                                                                │
│  screens/ (DOM)  ──►  services/  ──►  data/        ──►  db/  (IndexedDB)                       │
│  home, walk,          appServices      routeService       walkRepo, packStore, recordings     │
│  journal,             walkController   packDownloader                                          │
│  settings, ...        entryPipeline    overpass, weather ───────────────► the internet (opt.)  │
│                       onlineTasks                                                              │
│                          │                                                                     │
│                          ├──► routing/  street graph + recommender ── runs in  planWorker      │
│                          ├──► media/    microphone -> 16 kHz audio; camera -> JPEG             │
│                          ├──► sync/     backup ───────────────────────────► server/ (Node)     │
│                          └──► ml/       speech + language models ── runs in  mlWorker          │
│                                         transformers.js + ONNX runtime (self-hosted)           │
│                                                                                                │
│  service worker (generated by vite-plugin-pwa): caches the app + demo map for offline use      │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### The life of a walk

1. **Plan.** `screens/routeReview.ts` calls `data/routeService.ts`, which picks an offline map pack in this order: a downloaded pack that covers the walk, then download one (if online and not in sample mode), then the **bundled Central Park demo**, then any pack that contains the start. `routing/recommender.ts` (in a Web Worker) chooses 2 or 3 loops. Community notes, your visit history and a daily seed influence which places are chosen ([§9](#9-the-route-planner-explained)).
2. **Start.** For each stop the language model writes a short description from facts only (name, type, time of day, weather). Rejected or missing answers fall back to pre-written text. `walkRepo.saveQuest` stores the walk and stops.
3. **Walk.** `services/walkController.ts` holds the state of one walk (current stop, notes, photo, busy flags). Recording uses `media/recorder.ts`; the photo uses `media/camera.ts`.
4. **Note processing.** `services/entryPipeline.ts` runs: store audio, create the entry row, transcribe, save the transcript, **then** delete the audio, clean up the text, save it. States: `transcribing`, `cleaning`, `waiting` (no speech model yet), `failed`.
5. **Journal.** `screens/journal.ts` re-reads data whenever the repository or pipeline changes (cleanup may still be finishing).
6. **Backup.** `sync/syncService.ts` uploads walk, stop and entry **rows** (never photos or audio) when online and no walk is active.

### State machines

**Walk status** (forward-only through `repo.setStatus`; `updateWalkStatus` does not check order):

```
preparing -> ready -> active -> done
```
`walkController.load()` moves `ready` to `active`; `finish()` sets `done`.

**Entry job state** (in memory, per entry; the database only stores the transcript fields):

```
(none) --submitRecording--> transcribing --> cleaning --> (none)
                                 |              |
                                 |              +--(save error)--> failed --retry--> cleaning
                                 +--(model not on phone)--> waiting --download/retry--> transcribing
                                 +--(other error)---------> failed --retry--> transcribing
failed | waiting --"type it instead" (submitText)--> cleaning --> (none)
```

An entry's `rawTranscript` is `null` until transcription is saved (`''` means silence). `cleanedText` is `null` until cleanup is saved. A transcript that is already saved is never transcribed again.

---

## 6. Rules that must not be broken

Each rule has a test that fails if it is broken. Read these before changing `entryPipeline`, `walkRepo`, `syncService`, `ml/` or the service worker.

1. **A recording is never lost.** Audio is stored in IndexedDB *before* its entry row exists and deleted only *after* the transcript is saved. If saving fails, the audio stays and the entry shows Retry. Unfinished recordings resume on the next start (`recoverPending`). Tests: `test/pipeline.test.ts`.
2. **A walk never touches the network.** Sync, report sending and map refresh are skipped while any walk is `active` (`repo.hasActiveWalk`, used by `SyncService.walkInProgress` and `OnlineTasks`). Tests: `test/sync.test.ts`, `test/appServices.test.ts`.
3. **Photos and audio never leave the phone.** Only rows sync. The entry row carries a 0/1 `has_photo` flag, never image data or a path. Test: "photos stay on the phone" in `test/sync.test.ts`.
4. **One photo per walk**, static JPEG or PNG only, at most 8 MB, validated from the file's bytes (`util/imageType.ts`), never from its name. Photos from the camera are re-encoded to JPEG at most 2048 px wide, which also removes EXIF (no GPS position or device name).
5. **`updated_at` only goes up** (`walkRepo.stamp()`), even if the phone clock goes backwards. A row changed while it was uploading stays pending, because `markSynced` records exactly the version that was sent. `markSynced` does **not** fire change events (that would re-trigger sync forever).
6. **Speech must not depend on the language model.** They load, run and fail separately in the worker (`ml/runtime.ts`). Tested with a deliberately failing language model, with memory tight and loose (`test/speechResilience.test.ts`).
7. **No model download starts on its own.** Models are 40 to 900 MB. A download starts only from an explicit button (`ml/modelManager.ts`, `screens/speechSetup.ts`, Settings). When no download was requested, the worker's `fetch` allows only this site's own files (`ml/transformersLoader.ts`).
8. **Every language-model answer is checked** by `ml/guards.ts` before use; rejected answers are replaced by pre-written text or rule-based cleanup. Never bypass this.
9. **Everything works offline once installed.** Do not load the ONNX runtime, fonts or scripts from a CDN.
10. **Updates never reload the page mid-walk.** `registerType: 'prompt'`, no `skipWaiting`; a new version waits until the app is closed and reopened.
11. **The TypeScript route planner must behave exactly like the Dart one** (`test/parity.test.ts`).
12. **The community only sees opt-in snapshots.** A note is shared only when the person turns the switch on, as a trimmed copy of the *cleaned* text (at most 280 characters). Editing the private note later changes nothing public. Transcripts are never shared.

---

## 7. Data model, storage and sync

### IndexedDB (`web/src/db/schema.ts`)

Database name `touch_grass`, **version 1**. Rows keep the **snake_case column names of the SQLite schema** so the sync payload is exactly what the server validates.

| Store | Key | Indexes | Contents |
|---|---|---|---|
| `walk` | `id` | `created_at`, `status` | One prepared walk. |
| `stop` | `id` (`<walkId>-<position>`) | `walk_id` | The places of a walk, in route order. |
| `entry` | `id` | `stop_id` | A note and/or the photo holder at a stop. |
| `photo` | `walk_id` | `entry_id` | The walk's single photo (bytes, mime, size). Never synced. |
| `meta` | `key` | | Install facts. Holds `device_id`. |
| `kv` | `key` | | Small JSON documents. Holds `reports` (the report queue). |
| `packs` | `id` | | Offline-map-pack manifests (small; listed often). |
| `packData` | `id` | | Pack points of interest and ways (large). |
| `packStats` | `id` | | Community counts for a pack. |
| `recordings` | `id` (= entry id) | | Audio waiting for transcription (`Float32Array`, 16 kHz). |

**Columns**

- `walk`: `id, created_at, start_lat, start_lng, time_of_day, weather_summary, status ('preparing'|'ready'|'active'|'done'), route_json, updated_at, synced_at`
- `stop`: `id, walk_id, position, osm_id, name, lat, lng, tags_json, blurb, prompt, updated_at, synced_at`
- `entry`: `id, stop_id, recorded_at, raw_transcript, cleaned_text, shared (0|1), shared_text, updated_at, synced_at`
- `photo`: `walk_id, entry_id, mime, data, size, created_at`

`route_json` is a string: `{v:1, mode:'street'|'straight', polyline, legs_m[], total_m, duration_s, stop_point_index[], request:{minutes, distance_m, loop, skipped?}}`. The polyline uses Google's encoded format at 1e-5 degrees and is shrunk until it is under 15,000 characters (the server accepts strings up to 20,000).

**Change tracking.** A row needs uploading when `COALESCE(updated_at, 1) > COALESCE(synced_at, 0)`. Every write stamps `updated_at` from `walkRepo.stamp()`.

**Recordings** are in the database, not memory, so a crash or closed tab keeps them.

**Settings** are in `localStorage` under `touch_grass.settings`; the list of downloaded models is under `touch_grass.models`. Both are wrapped in try/catch so private-mode or blocked storage never breaks the app. Clearing site data deletes **everything** (walks, recordings, downloaded models), so turn on cloud backup if the journal matters.

> **Gotcha: changing the database.** The `upgrade` callback in `openTgDb` creates all stores unconditionally and is only correct for version 1. To add a store or index later, bump `DB_VERSION` and guard each change with `if (oldVersion < N)`, otherwise existing phones will crash on open.

### What syncs

`POST /v1/sync` body: `{ deviceId, walks[], stops[], entries[] }`. Batches are up to 200 rows per table.

- **walk:** `id, created_at, start_lat, start_lng, time_of_day, weather_summary, status, route_json, updated_at`
- **stop:** `id, walk_id, position, osm_id, name, lat, lng, tags_json, blurb, prompt, updated_at`
- **entry:** `id, stop_id, recorded_at, raw_transcript, cleaned_text, shared, shared_text, has_photo, updated_at`

`synced_at` is stripped before upload. The server drops any field not on its allow-list.

> **Privacy detail worth knowing:** the **backup** includes the raw and cleaned *text* of every note (so the owner can restore it). It never includes audio or photos. What *other people* can read is only the opt-in `shared_text`, and only for places seen by at least `MIN_DEVICES` (default 2) different phones.

### Sync behaviour (`sync/syncService.ts`)

- Attempts: 5 seconds after a local change (debounced), every 5 minutes, and on demand (**Sync now**, coming back online).
- A permanent failure (HTTP 4xx other than 408 and 429, for example a wrong API key) **pauses** automatic retries until **Sync now** is pressed. Network errors and 5xx retry later.
- Concurrent `syncNow()` calls share one run; a request arriving mid-run triggers **one follow-up pass** so a change made while uploading is not left waiting for the next timer.
- Rows the server reports as `foreign` (owned by another install) are counted in `sync.refused` and shown in Settings; they are marked done because this install can never write them.
- A cap of 50 batches per run prevents loops if a store never clears its pending rows.

### Offline map packs

- A pack is an area: points of interest plus the walkable street network (OpenStreetMap, via Overpass), optionally with community counts.
- **Size:** radius = `max(800, min(4000, ceil(budget/2 * 1.15)))` metres for a loop of `budget` metres; a walk needs the pack to cover `budget/2 * 1.1` metres from the start.
- Saved in **one transaction** (manifest, data, stats), so a crash or failed refresh never leaves half a pack or destroys the old one. A bigger pack deletes smaller packs it fully contains.
- **Refresh:** map data after 30 days, community data after 7 days, when online and not walking. A failed refresh keeps the old pack.
- The **bundled demo pack** (Central Park, radius 1500 m) ships in `web/public/fallback/` (`demo_ways.json` about 1 MB, `demo_overpass.json` about 78 KB). The parity and real-pack tests read it from there.

---

## 8. Module reference

Everything below is under `web/src/`.

### `routing/`: pure functions, no browser APIs
| File | Purpose |
|---|---|
| `geo.ts` | `LatLng`, haversine `distanceMeters`, `roundHalfAway` (matches Dart's rounding). |
| `walkWay.ts` | A walkable OSM way; `parseWays` drops motorways, `foot=no`, private access, broken geometry. |
| `walkGraph.ts` | Builds the street graph from ways (ways sharing an OSM node connect). `highwayFactor` makes quiet footpaths cheaper than busy roads; `nearestNode` uses a grid; `reachableFrom` finds the connected part. |
| `router.ts` | Binary-heap A* (`astar`) and Dijkstra (`dijkstra`). |
| `candidate.ts` | Place type, Overpass parsing, `filterCandidates`, `categoryWeight`. |
| `placeValue.ts` | How valuable a place is: category weight blended with community data, rotated by your history, with a seeded random nudge. |
| `placeStats.ts`, `placeCard.ts` | Community counts and what the review screen shows per stop. |
| `polyline.ts` | Encode/decode polylines; Douglas-Peucker simplification that keeps stops. |
| `recommender.ts` | The loop recommender (see [§9](#9-the-route-planner-explained)); `RouteRequest`, `RouteOption`, `toRouteJson`, `planRoutes`. |
| `planWorker.ts`, `planClient.ts` | Runs `planRoutes` in a Web Worker; falls back to the main thread where workers are unavailable. |

### `data/`: map packs, network clients, route service
| File | Purpose |
|---|---|
| `offlinePack.ts`, `packStore.ts` | Pack types, ids, coverage maths; IndexedDB store. |
| `packDownloader.ts` | `PackDownloader` (fetch places and ways, optional community stats, save) and `PackRefresher`. |
| `overpass.ts` | Overpass queries and a client that tries each mirror in turn. **No `User-Agent` header** (browsers forbid it). |
| `weather.ts` | Open-Meteo "clear, 18°C"; returns `unknown` on any failure. |
| `placeStatsClient.ts` | `GET /v1/places` (radius clamped to 100 to 5000 m). |
| `reports.ts` | `ReportQueue` (a reported note is hidden at once, even offline) and `ReportClient` (sends when online). |
| `bundledPack.ts` | Loads the demo pack from the app's own files. |
| `routeService.ts` | "Where should I walk?": pack selection, planning, weather, builds walk and stops. `recalculate` skips places or rerolls without the network. |
| `prompts.ts` | The fixed question per place category. |
| `http.ts` | `fetchWithTimeout`. |

### `db/`
| File | Purpose |
|---|---|
| `schema.ts` | Store definitions (above). |
| `walkRepo.ts` | All reads and writes, place history, sharing, photo, device id, sync bookkeeping (`pendingChanges`, `markSynced`, `pendingCount`). Transactions where the Dart code used them (for example saving a photo with its new entry). |
| `recordingStore.ts` | Audio waiting for transcription. |

### `sync/`, `media/`, `services/`
| File | Purpose |
|---|---|
| `sync/syncService.ts`, `sync/transport.ts` | Backup scheduling and the HTTP transport (`SyncException` with `isPermanent`). |
| `media/recorder.ts` | `MicRecorder` (getUserMedia, AudioWorklet with a ScriptProcessor fallback, resampled to 16 kHz mono, 5-minute cap) and `FakeRecorder`. |
| `media/camera.ts` | `CameraPhotoCapture` (file input, canvas, JPEG), `validatePhoto`, `FakePhotoCapture`. |
| `media/audio.ts` | `resample` (box filter), `concatChunks`, `encodeWav`. |
| `services/appServices.ts` | Builds everything from the settings; `refreshEngines()`, `dispose()`, `kinds` (what Settings shows). |
| `services/walkController.ts` | UI-free state for one walk; contains the photo-placement rules. |
| `services/entryPipeline.ts` | The note pipeline ([§5](#5-architecture)); `submitRecording`, `submitText`, `recoverPending`, `retry`, `drain`. |
| `services/onlineTasks.ts` | When the connection returns: sync, send reports, refresh packs (never during a walk). |
| `services/wakeLock.ts`, `services/location.ts` | Screen wake lock; one-off geolocation with plain-language errors. |

### `ml/`: see [§10](#10-on-device-speech-and-language-models)

### `screens/`, `ui/`, `config/`, `util/`
| File | Purpose |
|---|---|
| `screens/*.ts` | One file per screen. `context.ts` holds the current services. `speechSetup.ts` has the shared "download the speech model" card and "type a note" action. |
| `ui/dom.ts` | `h()` element builder and `reactive()` (re-renders on `update()`, at most once per frame; the first render runs in a microtask). |
| `ui/components.ts` | App bar, buttons, chips, cards, switches, selects, dialogs, toasts, photo viewer, journal entry card, "type your note" dialog. |
| `ui/icons.ts` | Inline SVG icons (no icon font). |
| `ui/copy.ts` | All wording helpers (sentence case, "·" separators, "…" for work in progress). |
| `ui/theme.css` | Palette: green `#2F6B3F`, tint `#EDF5EC`, line `#E2E8E0`, ink `#1F2A22`, recording red `#C6463A`. Atkinson Hyperlegible font bundled. Light only. |
| `config/config.ts` | `AppConfig`, validation, `VITE_*` parsing, `ConfigStore`. |
| `util/` | `ids.ts` (32 hex ids), `emitter.ts`, `imageType.ts`, `stopFacts.ts`. |
| `router.ts`, `app.ts`, `main.ts` | Hash router; app start and `reconfigure`; entry point and service-worker registration. |

---

## 9. The route planner, explained

`routing/recommender.ts` is a port of the original Dart `route_recommender` (removed) and gives identical results. In plain steps:

1. **Budget.** A walk of M minutes is `M * 60 * 1.34` metres (walking speed 1.34 m/s). The loop may be between `0.7 x` and `1.1 x` the budget.
2. **Candidates.** Keep places that have a name, have no `wikipedia`/`wikidata` tags (famous places are skipped on purpose), have a unique name, are not skipped by the person, and are within `1.1 x budget / 2` of the start (a loop out and back is at least twice the distance to its farthest stop).
3. **Value of a place** = category weight (artwork and viewpoint 5, fountain and historic 4, garden, park and place of worship 3, attraction 2, anything else 1) **blended** with what the community left there (`PRIOR_WEIGHT` 3: with no community data the category weight is used as is; each different person shifts it toward notes and photos per visit), **times** a freshness factor from your own history (new places first; visited in the last 14 days counts less; never below 0.15), **times** a seeded random nudge (up to plus or minus 30%, smaller where more people have been).
4. **Shortlist.** Rank by `value - distance/300 m`, keep the best 20.
5. **Snap to the street graph** (within 300 m, and only to the part of the network connected to the start). If the start is not on the network the planner falls back to straight lines (crow-flies x 1.3).
6. **Distance matrix** between start and candidates using Dijkstra limited to the budget.
7. **Build tours** by greedy insertion: repeatedly add the place with the best value per extra metre while staying within the length cap. At most 2 places per category (relaxed if fewer than 3 stops result). Maximum stops is one per 600 m, between 3 and 6, and also capped by the "Max stops" setting. The best visiting order is found **exactly** (at most 720 permutations).
8. **Alternatives.** Start from no anchor and from each of the first 8 candidates; drop duplicates (same set of stops).
9. **Score** a tour = sum of place values `+ 0.5 x number of distinct categories - 4 x |length - budget| / budget`. Tours at least `0.7 x` budget long rank before shorter ones. Take the top 3.
10. **Street route.** For each leg run A* on the graph, join the points, then simplify the polyline with Douglas-Peucker (tolerance 3 m, doubling until the encoded string fits 15,000 characters) while keeping the stop positions.

Street costs: footway, path, pedestrian, track 1.0; cycleway, residential, living street 1.05; unclassified 1.1; service 1.15; tertiary 1.2; steps and secondary 1.5; primary 1.7; others 1.3. Costs are always at least 1, so straight-line distance stays a valid A* heuristic.

**Same seed gives the same answer.** The default seed is the **day number**, so recommendations rotate day by day. **Other options** adds 1 to the seed. Settings > "Vary routes" off pins the seed to 0 (the same places every time, for scripted demos).

**Parity testing.** The Dart planner was run on 15 scenarios (a synthetic street grid and the real Central Park data, several seeds, community data, history, straight-line fallback, distance budgets) and its output was recorded in `web/test/fixtures/dart_parity.json` (frozen; the generator was removed with the Flutter app). `test/parity.test.ts` asserts the TypeScript output is identical: stops, leg lengths, scores (to 9 decimals), encoded polylines and byte-identical `route_json`.

---

## 10. On-device speech and language models

### The model catalog (`ml/models.ts`)

| Purpose | Model | Download | Runs on | Notes |
|---|---|---|---|---|
| Speech to text | `onnx-community/whisper-base.en` (q8) | about 80 MB | WebAssembly | **Default.** Needed for voice notes. |
| Speech to text | `onnx-community/whisper-tiny.en` (q8) | about 43 MB | WebAssembly | For slow phones; also the automatic fallback. |
| Language model | `onnx-community/gemma-3-1b-it-ONNX` (q4) | about 880 MB | **WebGPU only** | **Recommended.** Optional. |
| Language model | `onnx-community/gemma-3-270m-it-ONNX` (q4) | about 345 MB | **WebGPU only** | Often makes things up; answers are usually rejected. |

The first model also downloads the ONNX runtime (about 7 MB over the wire, 27 MB on disk), served from the app's own origin.

### How it is wired

```
 screens / services  ──►  LlmTasks / Stt (interfaces)  ──►  engines.ts (WebStt, WebLlm)
                                                              │  MlClient (request/response + progress)
                                                              ▼
                                         mlWorker (browser background thread)
                                           MlRuntime  ──►  transformersLoader.ts ──► transformers.js + ONNX runtime
```

- **`runtime.ts`** owns the loaded models. Requests run **one at a time**. A model is loaded on first use and reused. If a model **throws while running**, it is dropped and loaded fresh next time. In **exclusive mode** (phones with under about 6 GB RAM, `navigator.deviceMemory < 6`) only one model is in memory at a time; the other reloads from the cache when needed.
- **`engines.ts`**: `WebStt` tries the chosen Whisper model, then any **other Whisper model already downloaded** if the first fails to load or run (for example out of memory). `WebLlm` picks `cleanupMaxTokens` (256) for cleanup prompts and `blurbMaxTokens` (96) otherwise. `UnavailableStt` stands in when no speech model is on the phone.
- **`factory.ts`** chooses engines from the settings. `auto` means on-device **only if downloaded**; otherwise pre-written text (language) and "notes wait" (speech). `fake` modes exist for tests and the Sample setting only.
- **`modelManager.ts`**: `download()` (with progress, concurrent calls share one download, the model is released after the check to free memory), `remove()` (also deletes the cached files), status.
- **`capabilities.ts`**: `hasWebGpu()`; Settings uses it to block the language-model download.

### Why Whisper always works but Gemma might not

- Whisper runs on **WebAssembly**, available in every modern browser. We tested it with no WebGPU, fully offline, on real speech.
- Gemma's 4-bit weights use an operator (`GatherBlockQuantized`) the WebAssembly backend does not implement, so it **needs WebGPU**. It ran in Node (a different runtime) but **has never run in a browser**.
- Because the two are separate, a Gemma failure cannot affect speech.

### What happens with and without models

| Situation | Voice note | Stop description | Cleanup |
|---|---|---|---|
| Speech model downloaded | Transcribed on-device | | |
| No speech model | **Saved and waiting.** A card offers "Download speech model" right there; "Type it instead" works on any waiting or failed note | | |
| Language model downloaded and answers pass the checks | | Written by Gemma | Cleaned by Gemma |
| No language model, no WebGPU, or an answer is rejected | | Pre-written text (`public/fallback/blurbs.json`) | `ruleBasedCleanup` (removes fillers like "um", repeated words, fixes capitals and punctuation) |

### The guards (`ml/guards.ts`)

Real Gemma 3 270M output observed in testing (Node):

- Asked to **clean** `um so the light here is really nice and uh the the bench is still wet from the rain`, it returned the **prompt itself**: `...is still wet from the rain.\nEND TRANSCRIPT\nReply with the cleaned text only.`
- Asked for a **blurb** about "Bethesda Fountain", it invented details, used markdown and ended with `**[Your Address]**`.

Gemma 3 1B returned usable answers (for example "The light here is really nice. The bench is still wet from the rain."). The guards reject:

- **Cleanup** that echoes the prompt, adds more than 10% new words, or drops more than 30% of the spoken content words.
- **Blurbs and questions** that contain markdown, placeholders like `[...]`, more than one paragraph, too many words or sentences, **numbers or capitalised names that are not in the stop's facts**.
- A stop's own name is masked before checking, so "The Church of St. Matthew & St. Timothy" is not mistaken for several sentences (regression test in `test/guards.test.ts`).

### Library gotchas (`@huggingface/transformers` 4.x)

- It fetches the ONNX runtime from jsdelivr by default. We point `onnx.wasm.wasmPaths` at self-hosted files imported with `?url`, so offline works.
- `local_files_only: true` is **rejected** when `allowLocalModels=false`, and `allowRemoteModels=false` also breaks reading its cache. Our solution: replace `env.fetch` with a version that allows only same-origin requests unless a download was requested.
- Interrupted downloads **restart from zero**.
- Files live in Cache Storage (`transformers-cache`). We track "downloaded" ourselves in localStorage, because listing the cache is expensive. If the browser evicts the files, loading fails as "not available" and the person can download again.
- Multi-threaded WebAssembly needs cross-origin isolation (COOP/COEP headers), which static hosts do not send, so inference is **single-threaded**. In our desktop test (headless Chromium, Whisper tiny) a 14-second note took about 2 seconds. **Real phones were not measured.**
- `transformersLoader.ts` always uses the `.asyncify` ONNX build. The library itself picks a different build for Safari below version 26 without WebGPU.

### Measured results (desktop headless Chromium, no WebGPU)

- Whisper tiny, downloaded through Settings, then **offline**: transcribed the 11-second JFK clip correctly.
- Whisper **base** (the default), downloaded from the walk screen, then offline: "And so my fellow America asked not what your country can do for you, asked what you can do for your country." (One small error: "America" for "Americans".)
- Download took about 50 to 105 seconds on the test connection.

---

## 11. Offline behaviour and the service worker

`vite-plugin-pwa` generates `sw.js` (Workbox `generateSW`). Settings in `web/vite.config.ts`:

- `registerType: 'prompt'` with no `skipWaiting`: an update waits until the app is closed and reopened, and shows a toast ("A new version is ready"). It never interrupts a walk.
- `clientsClaim: true`: the very first visit already works offline.
- `globPatterns` include fonts (`ttf`) so the app looks right offline. About **21 files, about 2 MB** are precached: the app shell, scripts, both workers, fonts, icons, manifest and the demo map data.
- `maximumFileSizeToCacheInBytes` is 5 MB, so the **27 MB ONNX runtime is not precached**. It is cached by transformers.js into `transformers-cache` the first time a model is downloaded. That is why on-device speech works offline *only after a model has been downloaded once*.

What works offline: opening the app, planning walks on the bundled or already-downloaded maps, walking, recording, photos, journal, Settings, and (once downloaded) on-device speech. What needs a connection: the first load, downloading a new map area, weather, community notes, backup, and downloading models.

Manifest (`web/public/manifest.webmanifest`): name "Touch Grass", `display: standalone`, theme `#2F6B3F`, background `#FAFCF9`, 192 and 512 px icons plus a maskable icon. Chrome's own installability check passes (`npm run e2e:pwa`).

**Testing caveat:** Chromium will not register a service worker on a self-signed HTTPS origin, so automated PWA tests use `npm run preview:http` (`http://127.0.0.1:4174`, which counts as secure).

---

## 12. What is NOT verified

Be honest with yourself and with anyone you share this with.

1. **No physical Android phone.** Everything ran in headless desktop Chromium. Unknown: real speed and memory, the install prompt, permission prompts, wake-lock behaviour, battery, small screens beyond a 360x640 emulation.
2. **Gemma in a browser.** Never run (no WebGPU on the test machine). Only its output checks (using real Node output) and the "no WebGPU" path are tested.
3. **Downloading a new map area from a browser, end to end.** The app was only run on the bundled Central Park map. By hand we found that `overpass-api.de` is reachable from a browser with CORS allowed, **but it often answers 504 (busy)** and returned data on only 1 of 6 tries. The three mirror servers in `data/overpass.ts` **failed from a browser** (blocked or errored), so the app effectively depends on one flaky server. The street-network query is large (60-second timeout). **This is the most likely real-world failure.**
4. **Syncing to a real server and MongoDB from the browser.** Tested against fakes and the server's own tests; never live. The same applies to `/v1/places` and `/v1/reports`.
5. **Open-Meteo** works from a browser (checked once, CORS `*`); no automated test calls it.
6. **iOS and Safari** are not targets and are untested.
7. **Screens have no unit tests**; they are covered only by the browser scripts. No accessibility audit. All text is English.
8. **Hosting under a sub-path** (`vite build --base=/x/`) is untested.
9. **Whisper on slow or low-memory phones**: the automatic fallback to the tiny model is unit-tested with fake models, not on a real low-memory device.

---

## 13. Testing

### Commands

```sh
cd web
npm test                 # Vitest: 314 tests in 19 files, about 2 s, no network
npm run typecheck
npm run e2e              # real Chromium: home -> plan -> walk -> record -> photo -> journal -> reload
npm run e2e:pwa          # needs preview:http; manifest, installability, offline cache, offline reload
npm run e2e:speech       # needs preview:http and SPEECH_WAV; Whisper base, waiting note, typed note, offline speech
npm run e2e:models       # needs preview:http and SPEECH_WAV; Whisper tiny from Settings, offline speech
npm run e2e:llm          # needs a WebGPU browser; otherwise only checks the "no WebGPU" message
cd ../server && npm test # 79 tests
```

`SPEECH_WAV` is any 16-bit PCM English speech file (16 kHz mono is best). The e2e scripts drive the system Chromium (`CHROMIUM=/path` to change it), use Chromium's fake microphone, and write screenshots to `web/shots/` (git-ignored). Look at them.

### What each Vitest file covers

| File | Covers |
|---|---|
| `routing.test.ts`, `placeValue.test.ts`, `realPack.test.ts` | Polylines, graph, A*, Dijkstra, recommender behaviour, place value, the real Central Park pack. |
| `parity.test.ts` | Identical output to the Dart planner (15 scenarios). |
| `walkRepo.test.ts` | Walks, stops, entries, photos, sharing, history, sync bookkeeping, device id. |
| `dataTrack.test.ts` | Packs, Overpass client, downloader, refresher, community stats, route service, reports, weather, bundled pack. |
| `sync.test.ts` | Change tracking, failure handling, scheduling (fake timers), photos stay local, HTTP transport. |
| `config.test.ts` | Settings validation, env parsing, storage failures. |
| `ml.test.ts`, `guards.test.ts` | Prompts, tasks, fallbacks, fakes, content guards (including the real Gemma failures). |
| `mlRuntime.test.ts` | The worker runtime, client, download manager, adapters, factory. |
| `speechResilience.test.ts` | Gemma failing never affects speech, model fallback, crash recovery, typed notes. |
| `pipeline.test.ts`, `walkController.test.ts`, `media.test.ts` | The note pipeline, the walk session rules (photo placement, recording edge cases), resampling and photo validation. |
| `appServices.test.ts` | Whole-app integration with fakes: plan, walk, sync, online events, waiting then downloading a speech model. |
| `location.test.ts`, `capabilities.test.ts`, `util.test.ts` | Geolocation errors, WebGPU check, ids, image sniffing, stop facts. |

**Helpers:** `test/helpers.ts` (`mockFetch` that honours abort signals), `test/stack.ts` (repository + pipeline + fake recorder and cameras on a fresh in-memory IndexedDB), `test/grid.ts` (synthetic street grid).

**Test lessons:** use real in-memory storage objects (a `null` storage silently ignores writes and made a test pass for the wrong reason); fake only the timer functions you need (faking `setImmediate` freezes `fake-indexeddb`).

---

## 14. Configuration reference

### Build-time (`web/.env.local`, all optional)

| Variable | Meaning |
|---|---|
| `VITE_SYNC_URL` | Sync server address (https; plain http only for localhost, 127.0.0.1, 10.0.2.2, 192.168.*). Empty = no backup. |
| `VITE_SYNC_API_KEY` | Key for the sync server. **Ships inside the web bundle**; anyone who opens the app can read it. |
| `VITE_FAKE_QUEST=true` | Only the bundled Central Park map; nothing downloaded. |
| `VITE_FAKE_DEVICES=true` | Simulated microphone and camera. |
| `VITE_ML_MODE` | `auto` (default), `device`, `fallback`, `fake` (language model). `VITE_FAKE_ML=true` is shorthand for `fake`. |
| `VITE_STT_MODE` | `auto`, `device`, `fake` (speech). `VITE_FAKE_STT=true` is shorthand. |
| `VITE_DEMO_COORDS=lat,lng` | Starting area. |
| `VITE_MAX_STOPS` | 1 to 20. |
| `VITE_ROUTE_VARIETY` | `false` pins the seed (same places every time). |
| `VITE_PROMPTS_URL` | Optional JSON file overriding the language-model prompts (`blurb`, `question`, `cleanup`). Without it the app never requests a prompts file. |

### Runtime (Settings screen; saved in localStorage; wins over build-time defaults)

`llmMode`, `sttMode`, `fakeQuest`, `fakeDevices`, `demoCoords`, `maxStops` (1 to 20), `walkMinutes` (15, 30, 45, 60, 90), `communityRadiusM` (0 = off, 500, 1000, 2000, 5000), `routeVariety`, `syncUrl`, `llmModel`, `sttModel`. Invalid or unknown values are ignored, so settings from older or newer builds never break startup. The API key is never saved to settings.

### Server environment (`server/.env`)

| Variable | Meaning |
|---|---|
| `MONGODB_URI`, `MONGODB_DB` | Atlas connection and database name (default `touch_grass`). |
| `API_KEY` | Shared secret, at least 16 characters; the app sends it as `x-api-key`. |
| `PORT` | Default 8080. |
| `MIN_DEVICES` | Default 2: places seen by fewer phones are hidden from community results (privacy floor). |
| `HIDE_AFTER` | Default 3: this many reports hide a note. |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the API (no trailing slash), or `*`. Empty = no CORS headers. |
| `STATIC_DIR` | Folder of the built web app to serve from the same server (for example `../web/dist`). |

---

## 15. The sync server

`server/` is a small Express app (Node 18+) that writes to MongoDB Atlas. See `server/README.md` for setup. The API contract:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Pings the database. |
| `POST /v1/sync` | `x-api-key` | Body `{deviceId, walks[], stops[], entries[]}`. Reply `{ok, counts, accepted, skipped}` where each collection reports `written`, `skipped` (a newer copy exists) and `foreign` (another install owns it). 400 invalid payload, 401 bad key, 413 too large. |
| `GET /v1/places?lat&lng&radius` | `x-api-key` | Per-place counts and opt-in shared notes for an area. Never raw rows, transcripts or photos. Places seen by fewer than `MIN_DEVICES` phones are left out. |
| `POST /v1/reports` | `x-api-key` | `{deviceId, entryId, reason}`. 202 recorded, 404 unknown note. Notes are hidden at read time once the author or `HIDE_AFTER` phones reported them. |

**Validation** (`src/validate.js`): an allow-list per collection; unknown fields are dropped; at most 1000 rows per request; strings up to 20,000 characters; `shared_text` up to 280. **Write rules** (`src/store.js`): idempotent, no stale overwrites (a write applies only if `updated_at` is newer), device-scoped (a device cannot overwrite another's documents).

**Added for the web app** (existing behaviour unchanged):

- `src/cors.js`: opt-in CORS. Allowed origins get the headers; a preflight is answered with 204 before the key check; other origins get none. CORS is not authentication.
- `src/static.js`: optional hosting of `web/dist`. `index.html`, `sw.js` and the manifest are `no-cache`; `assets/*` are cached for a year (hashed names); page reloads on deep links fall back to `index.html`; API paths and missing files stay real 404s.

**Security:** the key the web app sends is in the JS bundle. Acceptable for a private beta; add per-user authentication before a public release.

---

## 16. Deployment, step by step

**Option A: one server for everything (recommended).**

1. Build the web app: `cd web && npm install && npm run build`.
2. Configure the server: `cd ../server && npm install`, copy `.env.example` to `.env`, set `MONGODB_URI`, `API_KEY`, and `STATIC_DIR=../web/dist`.
3. Run it behind **HTTPS** (most hosts provide this): `npm start`. The microphone, camera and offline mode need HTTPS.
4. On the web build, set `VITE_SYNC_URL` to the server's address and `VITE_SYNC_API_KEY` to the same key **before** step 1 (or let people type the address in Settings; the key is build-time only).
5. Open the site in Chrome on Android and choose **Add to Home screen**.

**Option B: static host plus separate API.** Host `web/dist` on any HTTPS static host. Set `ALLOWED_ORIGINS=https://your-app-origin` on the server.

**Static host checklist:** HTTPS; `.wasm` served as `application/wasm`; do not cache `index.html`, `sw.js` or `manifest.webmanifest`; cache `assets/*` for a long time; for a sub-folder build use `npx vite build --base=/touch-grass/` (untested).

**Updating:** deploy the new build. Phones with the app installed fetch it in the background and apply it the next time the app is closed and reopened.

---

## 17. Backlog: what to do next

In rough priority order.

1. **Test on a real Android phone** (Chrome). Install it, record a note, download Whisper on Wi-Fi, switch to airplane mode, take a walk. Record speed, memory and any permission problems. Everything else depends on this.
2. **Make map downloads reliable.** Add retries with backoff and longer timeouts to `data/overpass.ts`. Consider a small proxy endpoint on your own server that calls Overpass and returns the same JSON (this also fixes mirror CORS and lets you cache by area). Show a clear "map server busy, try again" message in `routeReview.ts`.
3. **Run the whole system against a real server and Atlas**, including `STATIC_DIR`. Verify sync, community notes and reports from a phone.
4. **Test Gemma on a WebGPU device** (recent Chrome on a capable phone, or a desktop with a GPU): run `npm run e2e:llm` there. Tune `guards.ts` against real outputs. Consider removing the 270M option.
5. **Per-user authentication** for the sync API instead of a shared key in the bundle.
6. **Resumable model downloads** (own downloader using HTTP ranges into Cache Storage) so a dropped connection does not restart 80 MB.
7. **Show the route on a map.** Neither app does. The data exists (`walk.route_json` polyline and `stop_point_index`).
8. **Speech quality:** try Whisper `small` as an option; enable multi-threading by sending COOP/COEP headers from `server/src/static.js`.
9. **Screen-level tests**, an accessibility pass, and translations.
10. **Safari support:** pick the right ONNX runtime build per browser in `transformersLoader.ts`.
11. **Retire the parity test** (`test/parity.test.ts` and `web/test/fixtures/dart_parity.json`) once the planner is meant to diverge from the Dart original. The Dart source is gone, so the fixture cannot be regenerated.

---

## 18. Recipes: how to change things

**Add a setting.** Add the field to `AppConfig` and `DEFAULT_CONFIG` in `config/config.ts`; add it to `configToJson` and `configFromJson` (with validation); add a row in `screens/settings.ts` using `selectRow` or `switchRow`; use it via `services.config`. Extend `test/config.test.ts`.

**Add a screen.** Create `screens/foo.ts` exporting a function that returns `{ el, dispose }`. Use `h()`, `reactive()` and `appBar()`. Register the route in `ROUTES` in `app.ts`. Subscribe to `repo.onChange` (and unsubscribe in `dispose`).

**Add a downloadable model.** Add an entry to `STT_MODELS` or `LLM_MODELS` in `ml/models.ts` (id, label, approximate size, `dtype`). Check the repository's file listing on Hugging Face for the real size. If it is a language model, check it runs on WebGPU and update `ml/guards.ts` if its failure modes differ.

**Change the route planner.** The Dart original is gone and the parity fixture is frozen, so any behavioural change to `routing/recommender.ts` will fail `test/parity.test.ts`. If you intend to diverge, update or remove that test deliberately and say why.

**Add a database store or field.** Bump `DB_VERSION` in `db/schema.ts` and guard changes in `upgrade` with `oldVersion` checks. If it syncs, also update the server's allow-list in `server/src/validate.js`, the sync payload in `walkRepo.pendingChanges`, and `docs` here.

**Change the wording.** Edit `ui/copy.ts` or the specific screen. Keep sentence case, "·" separators and "…" for work in progress.

**Add a network call.** Take an injectable `fetch` (see `data/weather.ts`), use `fetchWithTimeout`, never block the walk (rule 2), and test it with `mockFetch` from `test/helpers.ts`, including the offline case.

**Add a language-model task.** Add the task type in `ml/types.ts`, a template in `ml/prompts.ts`, a guard in `ml/guards.ts`, a fallback in `fallbackLlm.ts`, and handling in `llmTasks.ts`. Test the guard with real bad outputs.

---

## 19. Troubleshooting and FAQ

| Problem | Likely cause and fix |
|---|---|
| Microphone or camera does nothing | Needs HTTPS (or `localhost`). Check the browser's site permissions. |
| "Waiting for the speech model" never ends | The speech model is not downloaded. Use the card's **Download** button (or Settings). If the download fails, check the connection and retry. |
| Download shows an error | The model host (huggingface.co) was unreachable, or the connection dropped (downloads restart from zero). Retry on a stable connection. |
| Language-model section says "no WebGPU" | Expected on browsers without WebGPU. The app uses pre-written text. Nothing to fix. |
| "There's no offline map for this area yet" | The area is not Central Park and no map was downloaded. Connect once so the app can download it. If that fails repeatedly, the Overpass server is busy (backlog item 2). |
| App not working offline | Open it once online first so the service worker installs. Check that you are not in a private window. For models, they must be downloaded once. |
| Service worker will not register in tests | Self-signed HTTPS. Use `npm run preview:http`. |
| Phone cannot reach the dev server | Use the `Network:` URL and accept the certificate warning; both devices on the same Wi-Fi. |
| Notes missing after clearing browser data | Site data deletion removes the database. Enable cloud backup to protect the journal. |
| `Cannot access 'x' before initialization` in a screen | Do not call helpers that are defined later during the synchronous part of a screen function; `reactive()` renders in a microtask for this reason. |
| A test passes but proves nothing | Check that storage fakes really store (see §13 lessons). |
| Sync icon shows "not backed up yet" | The server is unreachable or the key is wrong (a 401 pauses automatic retries; press **Sync now** after fixing). |

**FAQ**

*Why not use the browser's built-in speech recognition?* It needs a connection and sends audio to a vendor, and Android browsers often cannot run it while the microphone is also in use. It remains a possible future fallback.

*Why is Gemma optional?* It needs WebGPU, is large, and small versions make things up. The pre-written fallback is plain but always correct.

*Can it work on iPhone?* Not a target and untested.

*Where is the user's data?* In IndexedDB in their browser. Nothing leaves the phone unless backup is on, and then only rows (never audio or photos).

---

## 20. Bugs found along the way

Recorded so nobody repeats them.

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot access 'v' before initialization` on load | `reactive()` rendered synchronously, before the screen function finished defining helpers | First render is a microtask (`ui/dom.ts`) |
| Model download hung, then failed | The library fetched the ONNX runtime from a CDN | Self-hosted `?url` imports (`transformersLoader.ts`) |
| "local models are disabled but local_files_only..." | Library option conflict | Same-origin-only `env.fetch` |
| Fonts wrong offline | `.ttf` not in the service-worker precache | Added to `globPatterns` |
| Not offline on the very first visit | The service worker did not control the page that registered it | `clientsClaim: true` |
| A missing prompts file produced an error offline | The app always requested `prompts.json` | Only requested when `VITE_PROMPTS_URL` is set |
| Self-signed HTTPS cannot register a service worker | Chromium rule | `npm run preview:http` for automated tests |
| Good blurb rejected for "Church of St. Matthew" | "St." read as a sentence end | `maskFacts()` in `guards.ts` |
| A change made mid-upload waited for the next timer | Concurrent `syncNow` shared one run | A request during a run triggers one follow-up pass |
| Gemma 270M download then "could not create a session" | Its 4-bit weights need WebGPU | Settings blocks the download without WebGPU |
| Tests passing for the wrong reason | `DownloadedModels(null)` stores nothing, so `mark()` did nothing | Tests use real in-memory storage and assert the marks took |
| Fake-timer tests hung | Faking `setImmediate` froze `fake-indexeddb` | Only fake the four timer functions |
| Bottom buttons overlapped the record button on a 360 px phone | Layout arithmetic | Smaller record button and padding; checked with a measured overlap test |
| `pkill -f pattern` killed the shell running it | The command line contained the pattern | `pkill -f "[p]attern"` or kill by PID |
| Python `audioop` import failed | Removed in Python 3.13 | Plain-Python resampling |

---

## 21. Working with an AI assistant

This section is the instruction sheet for tools like Claude Code, Copilot and Cursor. **If you use one, tell it to read this whole file first.** If your tool supports a project instruction file (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`), put one line in it: *"Read `docs/WEB_HANDOFF.md` before doing anything."*

### Start every session with

> Read `docs/WEB_HANDOFF.md` and `web/README.md`. Then run `cd web && npm test && npm run typecheck` and `cd ../server && npm test` so we know the baseline (314 and 79 tests should pass).

### Rules for the assistant

1. Obey the twelve rules in [§6](#6-rules-that-must-not-be-broken). If a change would touch one, say so and add a test that proves it still holds.
2. Add tests with every change. Use `test/helpers.ts` and `test/stack.ts`. Do not loosen a failing test without understanding why; never make a test pass by weakening what it checks.
3. For UI work, **prove it in a real browser**: `cd web && npm run build && npm run preview:http`, then `npm run e2e:pwa` and `npm run e2e`, and look at the screenshots in `web/shots/`.
4. Do **not**: add a model download that starts automatically; send photos or audio anywhere; let a language-model answer bypass `ml/guards.ts`; load anything from a CDN; make speech depend on the language model; commit secrets or `.env` files.
5. Report honestly what was **not** verified (for example: no physical phone, no WebGPU, no real server).
6. Keep the code style: TypeScript strict; no UI framework (DOM via `h()`); I/O modules take an injectable `fetch` or storage; wording lives in `ui/copy.ts`; comments explain *why*, not what.

### Prompt starters

- "Add a map screen that draws `walk.route_json` and the stops (backlog 7). No heavy dependencies; works offline; add a browser test."
- "Make Overpass downloads reliable (backlog 2): retries with backoff, longer timeouts, a clear busy message, and tests using `mockFetch` including 504s."
- "Write Playwright tests for the Settings screen: apply changes, reset to defaults, download and remove a model (use a fake loader)."
- "Audit the accessibility of `web/src/screens/*` (labels, focus order, contrast, touch targets of at least 44 px) and fix what you find."
- "Explain how `entryPipeline.ts` guarantees a recording is never lost, then write a test that tries to break it."
- "I have a phone with WebGPU. Walk me through running `npm run e2e:llm` and tuning `guards.ts` from the real outputs."

---

## 22. Repository state and housekeeping

- **Nothing is committed.** In this folder `git status` shows the project as untracked, and the surrounding git repository (`/home/igorr/Projects`) belongs to an **unrelated project** (`optima`) that also shows many deleted files. **Do not commit from there.** Create a separate repository for `touch_grass` (`git init` inside it) before sharing, for example on GitHub.
- **Do not share:** `web/node_modules`, `web/dist`, `server/node_modules`, `web/shots`, `.env` files. (`web/.gitignore`, `server/.gitignore` and the root `.gitignore` already cover these.)
- **Do share:** `web/public/fallback/*` (the bundled demo map, about 1 MB) and `web/test/fixtures/dart_parity.json` (the frozen Dart reference output).
- **Other things you may see:** `../Touch grass/` (an older, data-track-only Flutter project) and `touch_grass.zip` (a snapshot). Neither is needed.
- **Fallback data:** `web/public/fallback/*` is now the only copy; the parity and real-pack tests read it directly.

### Where things are (top level)

```
touch_grass/
  web/                  the web app (PWA)  <- the active app
    src/                routing, data, db, sync, media, ml, services, screens, ui, config, util
    test/               Vitest tests (+ fixtures/dart_parity.json)
    e2e/                real-browser scripts: smoke, pwa, speech, models, llm
    public/             manifest, icons, fonts, fallback/ (demo map + pre-written text)
    README.md           shorter, web-specific notes
  server/               Node sync API (+ CORS, optional static hosting) and its tests
  docs/WEB_HANDOFF.md   this file
```

---

## 23. Glossary

- **PWA**: a website that can be installed to the home screen and work offline (a manifest plus a service worker).
- **Service worker**: a script the browser runs in the background that serves cached files when offline.
- **Pack (offline map pack)**: downloaded OpenStreetMap data (places and walkable ways) for an area, stored in IndexedDB.
- **OpenStreetMap / Overpass**: the free map database and the public API used to query it.
- **Stop, walk, entry, quest**: a place on a route; a prepared walk; one note or photo at a stop; a prepared walk before it is started.
- **Community notes**: short notes other people chose to share about a place, fetched with the pack from `/v1/places`.
- **Worker (Web Worker)**: a browser background thread. `planWorker` plans routes; `mlWorker` runs the models, so the screen never freezes.
- **WebAssembly (WASM)**: lets a browser run compiled code at near-native speed on the CPU. Whisper uses it.
- **WebGPU**: lets a browser use the phone's graphics chip for computation. Gemma needs it.
- **ONNX / transformers.js**: the model file format, and the library that runs such models in the browser.
- **Whisper**: OpenAI's speech-to-text model. **Gemma**: Google's small language model.
- **Quantised (q4, q8)**: models stored with fewer bits per number to shrink the download.
- **Guards**: the checks in `ml/guards.ts` that reject bad language-model answers.
- **Parity test**: compares the TypeScript planner's output with the Dart planner's recorded output.
- **IndexedDB**: the browser's built-in database, where all walks, notes, photos and recordings live.
- **COOP/COEP**: HTTP headers that enable multi-threaded WebAssembly; static hosts usually do not send them.
- **CORS**: the browser rule that blocks one website calling another's API unless the API allows it.

# Touch Grass — web app (PWA)

Touch Grass as an installable web app for Android (Chrome → "Add to Home screen"). It plans a walk loop on real streets, visit a few places, record a voice note at each, take one photo, and keep it
all as a journal. It works with no network once opened, and speech-to-text runs **on the phone** (your voice is never
uploaded).

The routing code was ported from the original Flutter app (since removed) and is checked against its recorded output
(see [Parity with the original planner](#parity-with-the-original-planner)).

## Run it

```sh
cd web
npm install
npm run dev            # https://localhost:5173 (self-signed certificate)
```

Microphone, camera and the service worker need a *secure context*, so dev and preview serve **HTTPS** with a
self-signed certificate. To try it on a phone on the same Wi-Fi, open the `Network:` address Vite prints and accept
the certificate warning.

```sh
npm run build          # type-check + production build into dist/
npm run preview        # serve dist/ over https (phone testing)
npm run preview:http   # serve dist/ over http://127.0.0.1:4174 (needed by the PWA/e2e tests, see below)
```

### Settings you can bake in at build time

Copy-paste into a `.env.local` (all optional):

| Variable | Meaning |
|---|---|
| `VITE_SYNC_URL` | Sync server address (https). Empty = no cloud backup. |
| `VITE_SYNC_API_KEY` | Key for the sync server. **It ships inside the web bundle**, so anyone who opens the app can read it. Fine for a private beta; for a public release the server needs per-user auth. |
| `VITE_FAKE_QUEST=true` | Only the bundled Central Park map; nothing downloaded. |
| `VITE_FAKE_DEVICES=true` | Simulated microphone and camera (desk testing). |
| `VITE_ML_MODE`, `VITE_STT_MODE` | `auto` (default), `device`, `fallback` / `fake`. |
| `VITE_DEMO_COORDS=lat,lng` | Starting area. |
| `VITE_MAX_STOPS`, `VITE_ROUTE_VARIETY` | Cap the number of stops / vary routes between plans. |
| `VITE_PROMPTS_URL` | Optional JSON file overriding the language-model prompts. |

People can change most of these in the app's Settings; theirs win over the build-time defaults.

## Deploy

It is a static site: put `dist/` on any host that serves **HTTPS**. Requirements:

- HTTPS (the host usually provides it). Without it there is no microphone, camera or offline mode.
- `.wasm` served as `application/wasm` (all common hosts do).
- Don't cache `index.html`, `sw.js` or `manifest.webmanifest`; do cache `assets/*` for a long time (hashed names).
- Hosting in a sub-folder? Build with `npx vite build --base=/touch-grass/`.

**Easiest: let the sync server host it.** Build the web app, then start the server with `STATIC_DIR=../web/dist`
(`server/README.md`). The app and the API share one origin, so there is no CORS and no mixed-content problem, and the
server already sets the right cache headers. If the app lives on a *different* origin than the server, set
`ALLOWED_ORIGINS=https://your-app-origin` on the server instead.

An update is installed when the app is closed and reopened (it never reloads in the middle of a walk).

## How it works

```
src/
  routing/    street graph, A*/Dijkstra, route recommender, place value (port of the original Dart planner)
  data/       offline map packs (IndexedDB), Overpass, weather, community stats, reports, route service
  db/         IndexedDB schema (mirrors SQLite v6) and the walk repository
  sync/       cloud backup (/v1/sync API)
  media/      microphone (Web Audio, 16 kHz mono) and camera (<input capture>, JPEG, EXIF removed)
  ml/         on-device speech + language models, in a Web Worker
  services/   walk controller, entry pipeline, app wiring, online tasks, wake lock, location
  screens/    home, route review, walk, journal, settings, database viewer
  ui/         DOM helpers, components, icons, theme.css (green palette)
```

- **Storage** is IndexedDB. Walks, stops, entries and the photo live in the same tables as the SQLite schema (same
  column names, so the sync payload is identical). The app asks the browser to keep this data
  (`navigator.storage.persist()`), but clearing site data deletes it, so turn on cloud backup if the journal matters.
- **Recordings** are stored *before* the entry is created and deleted only *after* the transcript is saved, so a
  crash or a closed tab never loses a note. Unfinished notes resume on the next start.
- **Photos** are re-encoded to a JPEG at most 2048 px wide, which also strips the EXIF block (no GPS position or device
  name in the stored picture). One photo per walk, never uploaded.
- **Routing** runs in a Web Worker; the demo map (Central Park) ships with the app, other areas download from
  OpenStreetMap once and are kept for offline use.
- **While recording** the screen stays on (Wake Lock): browsers cut microphone capture when the screen locks.

### On-device models

Settings → *On-device models*. Nothing is downloaded until you press **Download**.

| | Model | Download | Notes |
|---|---|---|---|
| Speech to text | Whisper base (English) | ~80 MB | The default. Needed for voice notes. Runs on WebAssembly. |
| | Whisper tiny (English) | ~43 MB | For slow phones. |
| Language model (optional) | Gemma 3 1B | ~880 MB | Recommended; writes stop text and tidies notes. **Needs WebGPU** (recent Android Chrome on a capable phone). |
| | Gemma 3 270M | ~345 MB | Not recommended: see below. |

The first model also downloads the ONNX runtime (~7 MB on the wire, served from this app's own origin). Models are
kept in the browser's Cache Storage and work offline afterwards. An interrupted download starts again from the
beginning (a limitation of the library), so use Wi-Fi.

**The language model only runs on WebGPU.** Its 4-bit weights use an operator the WebAssembly backend doesn't implement (we saw
`Could not find an implementation for GatherBlockQuantized`), so on a browser without WebGPU Settings explains that and offers no
download, rather than letting someone spend ~880 MB on something that can't run. The speech model runs on WebAssembly everywhere.
**The language model has not been run in a browser yet**: the machine used for testing has no WebGPU, so only its output
checks (against real Gemma answers from Node) and the "no WebGPU" path are verified.

What happens without models: voice notes are **saved and wait** (you'll see "Waiting for the speech model"), and turn
into text as soon as the speech model is downloaded. Stop descriptions and note cleanup fall back to **pre-written
text and rule-based cleanup** — plain, but always correct. There is no fake transcription outside the "Sample" test mode.

**Small language models get things wrong, so every answer is checked** (`src/ml/guards.ts`) before it is used.
In our tests Gemma 270M, asked to clean a transcript, returned the prompt itself (`END TRANSCRIPT / Reply with the
cleaned text only`), and asked for a blurb it invented details and left a `[Your Address]` placeholder. Both are now
rejected: a cleaned note must use (almost) only the spoken words and keep (almost) all of them; a blurb must be one short
paragraph with no markdown, placeholders, or numbers and names that aren't in the stop's facts. Rejected answers are
replaced by the pre-written text. Gemma 1B produced usable answers in the same tests.

Performance and memory: phones with less than ~6 GB of RAM keep one model in memory at a time (the other is reloaded
from the cache when needed). Multi-threaded WebAssembly needs cross-origin isolation (`COOP`/`COEP` headers), which
a plain static host doesn't send, so inference uses one thread. In our desktop test (headless Chromium, Whisper tiny) a 14 s
note took about 2 s to transcribe; **we have not measured real phones yet**, so expect it to be slower there.

## Tests

```sh
npm test               # ~300 unit and integration tests (Vitest, fake IndexedDB): fast, no network
npm run typecheck
npm run preview        # (or preview:http), then in another terminal:
npm run e2e            # real Chromium at phone size: home → plan → walk → record → photo → journal
npm run e2e:pwa        # needs preview:http. Manifest, installability, offline cache, reload with no network
npm run e2e:models     # ~50 MB download. Real speech → on-device transcript, with the network switched off
npm run e2e:llm        # needs a browser with WebGPU (skips with a note otherwise); large download
```

The e2e scripts drive the system Chromium (`CHROMIUM=/path/to/chromium` to change it) with Chromium's fake microphone and
camera, and take screenshots into `shots/` (ignored by git). `e2e:models` needs `SPEECH_WAV=/path/to.wav`
(16-bit PCM speech).

### Parity with the original planner

`test/parity.test.ts` compares the TypeScript route planner with the recorded output of the original Dart planner
(`test/fixtures/dart_parity.json`, 15 scenarios: street grid and the real Central Park data, several seeds, community
notes, history, straight-line fallback): same stops, leg lengths, scores, encoded polylines and byte-identical
`route_json`. The Dart source is gone, so the fixture is frozen. If you intentionally change the planner, update or
remove that test and say why.

## Known limitations

- Interrupted model downloads restart from zero.
- The sync API key is visible to anyone who can open the app (see above).
- The first load needs a connection to cache the app; after that everything but map downloads and backup works offline.
- Clearing the browser's site data deletes walks, recordings and downloaded models.
- Gemma 1B is large (about 860 MB of weights, plus working memory): we have not tested it on phones, and on a low-memory phone
  the browser may close the tab. The app works fully without it.

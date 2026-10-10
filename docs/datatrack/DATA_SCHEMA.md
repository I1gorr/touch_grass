# Data schema

Two stores, same three record types, same field names.

| Store | Where | Role |
|---|---|---|
| SQLite | phone | **Source of truth.** Every read and write goes here. Works offline. |
| MongoDB Atlas | cloud, via `server/` | **Backup copy.** Rows are uploaded when the phone is online. The app never reads rows back; its only read is `GET /v1/places`, which returns per-place counts (see below). |

```
walk 1───* stop 1───* entry
```

**Why two stores:** the walk must work in airplane mode, so the phone needs its own database.
Atlas is only a backup and isn't needed for any feature, so a failed sync never blocks the user.

---

## SQLite (`lib/db/schema.dart`)

### `walk`: one prepared quest
| Column | Type | Format |
|---|---|---|
| `id` | TEXT PK | 32 random hex chars |
| `created_at` | INTEGER | ms since epoch |
| `start_lat`, `start_lng` | REAL | valid WGS84 |
| `time_of_day` | TEXT | `morning` \| `afternoon` \| `evening` \| `night` |
| `weather_summary` | TEXT | free text, `unknown` if offline |
| `status` | TEXT | `preparing` \| `ready` \| `active` \| `done` |
| `route_json` | TEXT NULL | planned street route (schema v3), see below. NULL = no stored route |

`route_json` is a JSON object string:
`{"v":1,"mode":"street"|"straight","polyline":"<encoded, 1e-5 deg>","legs_m":[...],"total_m":2342,"duration_s":1748,"stop_point_index":[i,...],"request":{"minutes":30,"distance_m":null,"loop":true}}`.
`legs_m` has one value per leg (start → stop 1 → … → start); `stop_point_index` says where in the decoded polyline each stop is reached. Kept under 15,000 chars so it fits the 20,000-char sync limit.

### `stop`: one place in a walk, in route order
| Column | Type | Format |
|---|---|---|
| `id` | TEXT PK | `<walkId>-<position>` |
| `walk_id` | TEXT | → `walk.id` |
| `position` | INTEGER | 0-based route order |
| `osm_id` | TEXT | e.g. `node/123` |
| `name` | TEXT | non-blank |
| `lat`, `lng` | REAL | valid WGS84 |
| `tags_json` | TEXT | JSON object string, e.g. `{"amenity":"bench"}` |
| `blurb`, `prompt` | TEXT | written at prepare time |

### `entry`: a voice note and/or photo at a stop
| Column | Type | Format |
|---|---|---|
| `id` | TEXT PK | 32 random hex chars |
| `stop_id` | TEXT | → `stop.id` |
| `recorded_at` | INTEGER | ms since epoch |
| `raw_transcript` | TEXT NULL | NULL = not transcribed yet / photo-only; `''` = silence |
| `cleaned_text` | TEXT NULL | NULL until cleanup finishes |
| `photo_path` | TEXT NULL | absolute path in app storage |
| `shared` | INTEGER NULL | schema v4. `1` = the author chose to share this note with people nearby. NULL/`0` = private (default) |
| `shared_text` | TEXT NULL | schema v4. Snapshot of the cleaned text that is public (≤ 280 chars). Raw transcripts are never shared |

### Sync columns (schema v2, all three tables)
| Column | Type | Meaning |
|---|---|---|
| `updated_at` | INTEGER NULL | version stamp, set on every write. NULL = row from v1 |
| `synced_at` | INTEGER NULL | the `updated_at` value last uploaded |

A row needs uploading when `COALESCE(updated_at, 1) > COALESCE(synced_at, 0)`.

### Offline packs (files, not tables)
The downloaded area used to recommend routes lives in files under `<cache>/packs/<id>/` (`manifest.json`, `pois.json`,
`ways.json.gz`), not in SQLite, and is never synced. It holds the places of interest plus the OSM walking network, so routes
can be planned with no internet. Packs are re-downloaded when older than 30 days and the phone is online.

### Indexes
`stop(walk_id, position)` and `entry(stop_id, recorded_at)`: these match the app's only list queries
(stops of a walk in order, entries of a stop by time).

### Why it looks like this
| Decision | Reason |
|---|---|
| Random hex ids, not autoincrement | Rows are created offline on many phones and merged in Atlas; random ids never collide and need no server round trip. |
| Stop id = `<walkId>-<position>` | The same real place (same `osm_id`) appears in many walks; each appearance needs its own row. `osm_id` keeps the link to the real place (used for route rotation). |
| Times as ms-epoch INTEGER | SQLite has no date type; integers sort correctly and are timezone-proof. |
| `tags_json` as a string | OSM tags are open-ended key/value pairs; the app only reads them to build LLM facts, so there's no point in a table. |
| `raw_transcript` and `cleaned_text` both kept | The raw text is what the person actually said; cleanup is an LLM edit. The user can toggle between them, and the raw text is the record of truth if cleanup goes wrong. |
| Raw transcript saved before the WAV is deleted | Audio is the only copy until then. NULL vs `''` tells "not done yet" apart from "silence". |
| Photo as a path, not a BLOB | Keeps the DB small and fast; images stay as normal files. |
| `entry` row created before transcription | The entry appears in the UI immediately; transcription fills it in. Also lets an interrupted recording (`recordings/<entryId>.wav`) be matched back to its row after a crash. |
| No FOREIGN KEY / NOT NULL / CHECK | Rules live in one place (the app's write path: `QuestRules`, enums, repository). Reads are tolerant (unknown status → `ready`), so old or odd rows never crash the app. |
| `updated_at` is monotonic, not wall-clock | If the phone clock jumps back, a new edit must still look newer than its last upload. |
| Sync marks the *uploaded version* as synced, not "now" | An edit made while an upload is in flight stays pending instead of being lost. |
| Route stored on the walk (`route_json`) | The screen can draw the walk without loading the pack (which may have been refreshed or evicted since). One text column, like `tags_json`: the app only reads it whole. |
| Pack in files, not tables | The street network is tens of thousands of nodes of read-only, replaceable data; files swap atomically on refresh and keep the DB small and fast to sync. |
| Schema changes via `migrations` map | Phones upgrade in place without losing walks; an older build refuses to open a newer DB rather than corrupting it. |

---

## MongoDB Atlas (`server/src/validate.js`, `server/src/store.js`)

Database `touch_grass`, collections **`walks`**, **`stops`** and **`entries`**: one document per SQLite row.

```js
{
  _id: "<SQLite id>",
  ...same snake_case fields as SQLite (minus synced_at)...,
  updated_at: 1791580004211,   // version from the phone
  deviceId: "<32 hex>",         // added by server: owning install
  receivedAt: ISODate(...)      // added by server
}
```

### Indexes
| Collection | Index | For |
|---|---|---|
| `walks` | `{deviceId: 1, created_at: -1}` | a device's walks, newest first |
| `stops` | `{walk_id: 1, position: 1}` | a walk's stops in order |
| `entries` | `{stop_id: 1, recorded_at: 1}` | a stop's entries by time |

### Community (`GET /v1/places?lat=&lng=&radius=`)
Read path for recommendations: how many people walked past each place, plus the few notes they **chose to share**, for an area
the user picks (`radius` 100–5000 m). Counts include every entry; `shared_notes` contains only entries with `shared = 1`
and a non-empty `shared_text`, anonymous (no device id, author, raw transcript or photo path):
`{"places":[{"osm_id":"node/123","walks":12,"devices":9,"entries":20,"notes":14,"photos":5,"shared_notes":[{"id":"<entry id>","text":"Bring bread for the ducks","photo":false,"at":1791580004211}]}]}`.
| Rule | Detail |
|---|---|
| Counted | stops in the circle whose walk is `done`; `walks` = distinct walks, `devices` = distinct phones, `notes` = entries with text, `photos` = entries with a photo |
| Privacy floor | places seen by fewer than `MIN_DEVICES` (default 2) different phones are omitted |
| Spam cap | one phone contributes at most 3 entries, notes or photos per place; at most 1 shared note per phone per place, 3 per place, newest first |
| Unsharing | the author sets `shared = 0` and syncs; the note leaves the answer at once and the phones' packs at their next weekly refresh |
| Limits | ≤ 500 places per answer; bad `lat`/`lng`/`radius` → 400 |
The phone fetches this only while downloading or refreshing an offline pack (stats are refreshed weekly) and stores it in the
pack's `places.json`, so recommending needs no internet. Indexes: `stops {lat, lng}` (area lookup).

### Reporting a note (`POST /v1/reports`)
Body `{deviceId, entryId, reason?}` (`inappropriate`, `wrong_place`, `private_info`, `spam`, `other`). One report per phone per
note (`reports` collection, `_id = entryId:deviceId`, never deleted). Answers `202` (recorded or already reported), `404` (no such
note), `400` (invalid). A note is hidden from `/v1/places` when reported by its author, or by `HIDE_AFTER` (default 3) different
phones. The reporting phone hides the note immediately and queues the report (`ReportQueue`) until it is online.

### What the API accepts (`POST /v1/sync`)
| Rule | Detail |
|---|---|
| Body | `{deviceId, walks[], stops[], entries[]}`; missing arrays = empty |
| `deviceId` | exactly 32 lowercase hex |
| `route_json` | string ≤ 20,000 chars or null (like any string field) |
| `id`, `walk_id`, `stop_id` | required, `^[A-Za-z0-9_-]{1,100}$` |
| Integers | safe integers or null |
| Coordinates | finite numbers (no NaN/Infinity, no strings) |
| Strings | ≤ 20,000 chars |
| `status` | the four enum values |
| Limits | ≤ 1,000 rows per request, ≤ 2 MB body |
| Unknown fields | dropped |
| `updated_at: null` | treated as version 1 |

Any violation rejects the whole request with **400**.

### Write rule
```
filter: { _id, deviceId, updated_at: { $lt: incoming.updated_at } }
update: { $set: fields },  upsert: true
```
A duplicate-key error means the stored copy is newer or belongs to another device. Those are counted as *skipped*, not as errors.

### Why it looks like this
| Decision | Reason |
|---|---|
| Same field names as SQLite | No mapping layer to keep in sync; a row is readable in both stores. |
| `_id` = SQLite id | Upsert by id makes re-sending a batch harmless (the phone retries after timeouts). |
| `updated_at` guard in the filter | Two uploads can arrive out of order; an older version must never overwrite a newer one. |
| `deviceId` in the filter | A device can only change documents it created. |
| Sharing is opt-in, per entry, as a snapshot | Voice notes are personal. Only what the author explicitly publishes leaves their private record; editing the private note later never changes what others read. |
| Notes in the pack, not fetched live | The walker decides keep/skip/recalculate offline, so the notes must already be on the phone. |
| Anonymous notes + report/hide | Community trust without identities; any reader can flag, and enough flags (or the author) remove a note. |
| Crowd data as counts, in the pack | Recommendations must work offline, and other people's notes are private. Aggregates downloaded with the pack give both. |
| Blend, don't switch | Value = category weight shrunk toward what people left (more different people = more pull), times a rotation factor for places you visited, times a small seeded random nudge that is larger where data is thin. With no data it degrades to round robin + random variety. |
| Phone talks to an API, never to Atlas | Atlas credentials stay on the server; Device Sync and the Data API are end-of-life (Sept 2025). |
| Allow-list validation in the API | Blocks query injection (`{$gt: ""}` as an id), junk fields and oversized payloads before they reach the DB. |
| Three collections, not one nested walk document | Entries keep arriving after a walk is uploaded; flat rows let each one upsert independently, with no rewrite of a growing document. |

---

## Known gaps
| Gap | Impact | Fix when needed |
|---|---|---|
| Validation only in the API | Direct writes to Atlas (scripts, Compass) bypass it | Add `$jsonSchema` validators to the collections |
| No foreign keys in either store | An orphan entry/stop is possible in theory (nothing deletes today) | Add FKs + cascade, or tombstones when deletes exist |
| Times are integers in Atlas | Need `$toDate` for charts and date queries | Add BSON Date copies on the server |
| `tags_json` is a string in Atlas | Can't query by tag directly | Parse into a sub-document on the server |
| `/v1/places` and `/v1/reports` have no auth or rate limit | Anyone can read shared notes in an area and file reports; report spam by many fake devices could hide good notes | Add an API key / per-device token and rate limiting |
| No automatic moderation | Offensive or private info in a shared note is removed only by reports | Profanity/PII filter before publishing, admin review |
| Shared photos | Notes can say a photo exists, but photos are not shared | Object storage (see `photo_path`) |
| `photo_path` is phone-local | Photos aren't in the cloud | Object storage (S3/GCS) + upload endpoint |
| `walk.status = preparing` is never written | Harmless | Remove or use it when preparation becomes resumable |

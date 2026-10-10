# Data schema

Two stores. Images live only in the first.

| Store | Where | Holds | Role |
|---|---|---|---|
| SQLite | phone | walks, stops, entries **and photos** | **Source of truth.** Every read and write goes here. Works offline. |
| MongoDB Atlas | cloud, via `server/` | walks, stops, entries (text only) | **Backup copy** of the rows. Never stores images. Never read by the app. |

```
walk 1───* stop 1───* entry
walk 1───0..1 photo ───1 entry        (photo: SQLite only)
```

**Why two stores:** the walk must work in airplane mode, so the phone needs its own database.
Atlas only backs up the rows and isn't needed for any feature, so a failed sync never blocks the user.

**Why photos stay on the phone:** product rule. Photos are personal, and keeping them in SQLite means one
store for everything the app shows. The cloud holds no image data and no phone file paths.

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

### Data track columns (schema v6)
| Table | Column | Meaning |
|---|---|---|
| `walk` | `route_json` | planned street route (encoded polyline, legs, `total_m`, `duration_s`, `mode`), written when a route is kept |
| `entry` | `shared` | 1 = the author shared this note with people nearby (opt-in) |
| `entry` | `shared_text` | the public snapshot of the cleaned text, ≤ 280 chars |

These are written only through the data track's repository (`saveQuest`, `shareEntry`, `unshareEntry`).

### `entry`: a voice note at a stop (and maybe the walk's photo)
| Column | Type | Format |
|---|---|---|
| `id` | TEXT PK | 32 random hex chars |
| `stop_id` | TEXT | → `stop.id` |
| `recorded_at` | INTEGER | ms since epoch |
| `raw_transcript` | TEXT NULL | NULL = not transcribed yet / photo-only; `''` = silence |
| `cleaned_text` | TEXT NULL | NULL until cleanup finishes |
| `photo_path` | TEXT NULL | **legacy, always NULL.** Kept for the guide schema; pre-v4 files are imported into `photo` and the column is cleared |

### `photo`: the walk's single photo (schema v4), never synced
| Column | Type | Format |
|---|---|---|
| `walk_id` | TEXT PK | → `walk.id`. The primary key means **one photo per walk** |
| `entry_id` | TEXT NOT NULL | → `entry.id`: where (which stop) it was taken |
| `mime` | TEXT NOT NULL | `image/jpeg` \| `image/png` |
| `data` | BLOB NOT NULL | the image, ≤ 8 MB, **static** JPEG/PNG only |
| `size` | INTEGER NOT NULL | bytes |
| `created_at` | INTEGER NOT NULL | ms since epoch |

`Entry.hasPhoto` in the app is computed from this table (`EXISTS … WHERE photo.entry_id = entry.id`); it is not a column.

### `meta`: install-level facts (schema v5), never synced
| Column | Type | Meaning |
|---|---|---|
| `key` | TEXT PK | e.g. `device_id` |
| `value` | TEXT NOT NULL | |

The sync device id lives here, with the data it owns, so the two can't drift apart. Losing a separate id
file used to make every later upload silently "skipped" by the server.

### Sync columns (schema v2, on `walk`, `stop`, `entry` only)
| Column | Type | Meaning |
|---|---|---|
| `updated_at` | INTEGER NULL | version stamp, set on every write. NULL = row from v1 |
| `synced_at` | INTEGER NULL | the `updated_at` value last uploaded |

A row needs uploading when `COALESCE(updated_at, 1) > COALESCE(synced_at, 0)`. `photo` has no sync columns.

### Indexes
`stop(walk_id, position)`, `entry(stop_id, recorded_at)`, `photo(entry_id)`: these match the app's only queries
(stops of a walk in order, entries of a stop by time, "does this entry hold the photo").

### Schema versions
| Version | Change |
|---|---|
| 1 | guide schema: `walk`, `stop`, `entry` |
| 2 | `updated_at` / `synced_at` for cloud sync |
| 3 | `photo_sync` (photo upload bookkeeping). **Superseded** |
| 4 | `photo` table (BLOBs); `photo_sync` dropped; legacy photo files imported on open |
| 5 | `meta` key/value table; holds the sync `device_id` (adopted once from the old `device_id` file) |
| 6 | **Merge with the data track.** Adds `walk.route_json`, `entry.shared`, `entry.shared_text`, and makes a database from either track's history match. Each change checks first (`reconcileTracks`) |

The data track numbered its own changes 2–4 differently (v3 `route_json`, v4 sharing), so v6 inspects the
database instead of trusting the number. A phone on either app upgrades to the same layout. See
[`MERGE.md`](MERGE.md).

### Why it looks like this
| Decision | Reason |
|---|---|
| Random hex ids, not autoincrement | Rows are created offline on many phones and merged in Atlas; random ids never collide and need no server round trip. |
| Stop id = `<walkId>-<position>` | The same real place (same `osm_id`) appears in many walks; each appearance needs its own row. `osm_id` keeps the link to the real place (used for route rotation). |
| Times as ms-epoch INTEGER | SQLite has no date type; integers sort correctly and are timezone-proof. |
| `tags_json` as a string | OSM tags are open-ended; the app only reads them to build LLM facts. |
| `raw_transcript` and `cleaned_text` both kept | The raw text is what the person actually said; cleanup is an LLM edit. The user can toggle between them, and the raw text is the record of truth if cleanup goes wrong. |
| Raw transcript saved before the WAV is deleted | Audio is the only copy until then. NULL vs `''` tells "not done yet" apart from "silence". |
| `entry` row created before transcription | The entry appears in the UI immediately, and an interrupted recording (`recordings/<entryId>.wav`) can be matched back to its row after a crash. |
| **Photos as BLOBs in SQLite** | Product rule: images stay on the phone, in the database. One store, one backup file, no loose image files to leak or orphan. At most 8 MB per walk keeps the DB manageable. |
| **Separate `photo` table, not a column on `entry`** | Keeps multi-MB BLOBs out of every entry query and out of the sync path entirely; `walk_id` as primary key enforces one photo per walk in the database itself. |
| Static JPEG/PNG only | Product rule. The camera uses `pickImage` only. Every photo is checked by its bytes (not its name) before storing; PNGs are scanned for animation (`acTL`) chunks. GIF, WebP, video, animated PNG and anything over 8 MB is refused. |
| Replace = overwrite the row | "Replace photo" swaps the bytes for the same entry; no old file to delete. |
| `photo_path` kept but unused | Part of the guide's schema; removing a column needs a table rebuild in SQLite for no benefit. |
| No FOREIGN KEY / NOT NULL / CHECK on the guide tables | Rules live in one place (the app's write path: `QuestRules`, enums, repository). Reads are tolerant (unknown status → `ready`), so old or odd rows never crash the app. |
| `updated_at` is monotonic, not wall-clock | If the phone clock jumps back, a new edit must still look newer than its last upload. |
| Sync marks the *uploaded version* as synced, not "now" | An edit made while an upload is in flight stays pending instead of being lost. |
| Schema changes via `migrations` map | Phones upgrade in place without losing walks; an older build refuses to open a newer DB rather than corrupting it. |

---

## MongoDB Atlas (`server/src/validate.js`, `server/src/store.js`)

Database `touch_grass`, collections **`walks`**, **`stops`** and **`entries`**: one document per SQLite row.
**No image data is stored.**

```js
{
  _id: "<SQLite id>",
  ...same snake_case fields as SQLite (minus synced_at and photo_path)...,
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

### New fields from the data track (all optional)
| Collection | Field | Meaning |
|---|---|---|
| `walks` | `route_json` | planned street route, JSON text (≤ 20,000 chars) |
| `entries` | `has_photo` | 0/1: whether the note has a photo. The image and its path stay on the phone. A legacy `photo_path` is converted to this and dropped |
| `entries` | `shared` | 0/1: the author chose to share the note with people nearby |
| `entries` | `shared_text` | the public snapshot of the cleaned text, ≤ 280 chars |

Community routes (same API key): `GET /v1/places` returns per-place counts plus opt-in shared notes, which are
anonymous, only from finished walks, and only for places seen by at least `MIN_DEVICES` phones. `POST /v1/reports`
lets anyone flag a note; it's hidden when its author reports it or `HIDE_AFTER` phones do (collection `reports`,
`_id = entryId:deviceId`). Extra indexes: `stops {lat, lng}`, `reports {entryId}`.

### What the API accepts (`POST /v1/sync`)
| Rule | Detail |
|---|---|
| Body | JSON `{deviceId, walks[], stops[], entries[]}`; missing arrays = empty. Non-JSON bodies (images, video…) → 400 |
| `deviceId` | exactly 32 lowercase hex |
| `id`, `walk_id`, `stop_id` | required, `^[A-Za-z0-9_-]{1,100}$` |
| Integers | safe integers or null |
| Coordinates | finite numbers (no NaN/Infinity, no strings) |
| Strings | ≤ 20,000 chars |
| `status` | the four enum values |
| Limits | ≤ 1,000 rows per request, ≤ 2 MB body |
| Unknown fields | dropped, **including `photo_path` or any smuggled image field** |
| `updated_at: null` | treated as version 1 |

There is no photo or media route: anything else returns 404. The phone also strips `photo_path` before
sending, so it's removed on both sides.

### Write rule
```
filter: { _id, deviceId, updated_at: { $lt: incoming.updated_at } }
update: { $set: fields },  upsert: true
```
A duplicate-key error means the stored copy is newer (*skipped*, harmless) or belongs to another install
(*foreign*). Foreign rows are counted separately in the reply (`counts.<collection>.foreign`), and the app shows
them in Settings instead of treating them as backed up.

### Why it looks like this
| Decision | Reason |
|---|---|
| Same field names as SQLite | No mapping layer to keep in sync; a row is readable in both stores. |
| `_id` = SQLite id | Upsert by id makes re-sending a batch harmless (the phone retries after timeouts). |
| `updated_at` guard in the filter | Two uploads can arrive out of order; an older version must never overwrite a newer one. |
| `deviceId` in the filter | A device can only change documents it created. |
| Phone talks to an API, never to Atlas | Atlas credentials stay on the server; Device Sync and the Data API are end-of-life (Sept 2025). |
| Allow-list validation in the API | Blocks query injection (`{$gt: ""}` as an id), junk fields, oversized payloads, and image data. |
| Three flat collections, not one nested walk document | Entries keep arriving after a walk is uploaded; flat rows upsert independently. |

---

## Known gaps
| Gap | Impact | Fix when needed |
|---|---|---|
| Photos exist only on the phone | Lose or reset the phone and its photos are gone; the cloud backup can't restore them | Product decision; if it changes, add an image store (not Atlas documents) |
| Atlas doesn't know which entry had a photo | Cloud data can't show "photo taken here" | Sync a `has_photo` boolean (no image data) if wanted |
| Validation only in the API | Direct writes to Atlas (scripts, Compass) bypass it | Add `$jsonSchema` validators |
| No foreign keys | Orphans possible in theory (nothing deletes today) | FKs + cascade, or tombstones when deletes exist |
| Times are integers in Atlas | Need `$toDate` for charts and date queries | Add BSON Date copies on the server |
| `tags_json` is a string in Atlas | Can't query by tag directly | Parse into a sub-document on the server |
| Legacy photo files left on disk after the v4 import | A little wasted space on dev phones | One-off cleanup of `<app docs>/photos/` |

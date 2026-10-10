import 'package:sqflite/sqflite.dart';

/// SQLite schema from the dev guide, shared by both tracks (app and data).
///
/// To change it: append the SQL for version N+1 to [migrations] (keep
/// [createStatements] as the v1 baseline). Fresh installs run v1 + every
/// migration; existing installs run only the ones they are missing.
const Map<int, List<String>> migrations = {
  // v2: change tracking for cloud sync. A row needs uploading when
  // updated_at > synced_at; NULL updated_at (rows from v1) counts as changed.
  2: [
    'ALTER TABLE walk ADD COLUMN updated_at INTEGER',
    'ALTER TABLE walk ADD COLUMN synced_at INTEGER',
    'ALTER TABLE stop ADD COLUMN updated_at INTEGER',
    'ALTER TABLE stop ADD COLUMN synced_at INTEGER',
    'ALTER TABLE entry ADD COLUMN updated_at INTEGER',
    'ALTER TABLE entry ADD COLUMN synced_at INTEGER',
  ],
  // v3: local bookkeeping for photo backup (one photo per walk). Never synced.
  // status: 'uploaded' | 'rejected' (server refused it; don't retry).
  3: ['CREATE TABLE photo_sync (walk_id TEXT PRIMARY KEY, photo_path TEXT, status TEXT, version INTEGER)'],
  // v4: photos live in SQLite (one per walk, static JPEG/PNG BLOB) and are
  // never uploaded. Files referenced by the legacy entry.photo_path column are
  // imported by SqfliteWalkRepository on open. Upload bookkeeping is dropped.
  4: [
    'CREATE TABLE photo (walk_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, mime TEXT NOT NULL, '
        'data BLOB NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE INDEX idx_photo_entry ON photo(entry_id)',
    'DROP TABLE IF EXISTS photo_sync',
  ],
  // v5: small key/value table for install-level facts. The sync device id
  // lives here (not in a separate file) so it can't be lost while the data
  // it owns survives.
  5: ['CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'],
};

/// Tables uploaded by SyncService, in dependency order.
const syncedTables = ['walk', 'stop', 'entry'];

/// SQL condition selecting rows not yet uploaded.
const pendingSyncWhere = 'COALESCE(updated_at, 1) > COALESCE(synced_at, 0)';

/// Steps that need to inspect the database first (run after that version's SQL).
final Map<int, Future<void> Function(DatabaseExecutor db)> programmaticMigrations = {6: reconcileTracks};

int get schemaVersion => {...migrations.keys, ...programmaticMigrations.keys}.reduce((a, b) => a > b ? a : b);

/// v6: one database for both tracks. The app track's chain (v2 sync columns,
/// v3–v4 photos, v5 meta) and the data track's chain (v2 sync columns,
/// v3 `walk.route_json`, v4 `entry.shared`/`shared_text`) used the same version
/// numbers for different changes, so this step makes a database from either
/// chain match the union. Every change checks first, so it is safe on any of them.
Future<void> reconcileTracks(DatabaseExecutor db) async {
  Future<Set<String>> columns(String table) async => {
    for (final r in await db.rawQuery('PRAGMA table_info($table)')) r['name'] as String,
  };
  Future<void> addColumn(String table, String column, String type) async {
    if (!(await columns(table)).contains(column)) await db.execute('ALTER TABLE $table ADD COLUMN $column $type');
  }

  for (final t in syncedTables) {
    await addColumn(t, 'updated_at', 'INTEGER');
    await addColumn(t, 'synced_at', 'INTEGER');
  }
  // Data track: planned street route, opt-in sharing.
  await addColumn('walk', 'route_json', 'TEXT');
  await addColumn('entry', 'shared', 'INTEGER');
  await addColumn('entry', 'shared_text', 'TEXT');
  // App track: photos in SQLite, install facts, list indexes.
  await db.execute(
    'CREATE TABLE IF NOT EXISTS photo (walk_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, '
    'mime TEXT NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL)',
  );
  await db.execute('CREATE INDEX IF NOT EXISTS idx_photo_entry ON photo(entry_id)');
  await db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await db.execute('DROP TABLE IF EXISTS photo_sync');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_stop_walk ON stop(walk_id, position)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_entry_stop ON entry(stop_id, recorded_at)');
}

const createStatements = [
  '''
CREATE TABLE walk (
  id TEXT PRIMARY KEY,
  created_at INTEGER,
  start_lat REAL,
  start_lng REAL,
  time_of_day TEXT,
  weather_summary TEXT,
  status TEXT
)''',
  '''
CREATE TABLE stop (
  id TEXT PRIMARY KEY,
  walk_id TEXT,
  position INTEGER,
  osm_id TEXT,
  name TEXT,
  lat REAL,
  lng REAL,
  tags_json TEXT,
  blurb TEXT,
  prompt TEXT
)''',
  '''
CREATE TABLE entry (
  id TEXT PRIMARY KEY,
  stop_id TEXT,
  recorded_at INTEGER,
  raw_transcript TEXT,
  cleaned_text TEXT,
  photo_path TEXT
)''',
  'CREATE INDEX idx_stop_walk ON stop(walk_id, position)',
  'CREATE INDEX idx_entry_stop ON entry(stop_id, recorded_at)',
];

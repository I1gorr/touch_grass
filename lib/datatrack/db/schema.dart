import 'package:sqflite/sqflite.dart';

/// Current schema version. Add a `migrations` entry for every bump.
const int kDbVersion = 4;

/// Tables that carry the sync columns.
const List<String> kTables = ['walk', 'stop', 'entry'];

// No FOREIGN KEY / NOT NULL / CHECK on purpose: rules live in the write path and
// reads are tolerant (see docs/DATA_SCHEMA.md).
const List<String> _v1 = [
  '''CREATE TABLE walk (
    id TEXT PRIMARY KEY,
    created_at INTEGER,
    start_lat REAL,
    start_lng REAL,
    time_of_day TEXT,
    weather_summary TEXT,
    status TEXT
  )''',
  '''CREATE TABLE stop (
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
  '''CREATE TABLE entry (
    id TEXT PRIMARY KEY,
    stop_id TEXT,
    recorded_at INTEGER,
    raw_transcript TEXT,
    cleaned_text TEXT,
    photo_path TEXT
  )''',
  'CREATE INDEX stop_walk_position ON stop(walk_id, position)',
  'CREATE INDEX entry_stop_recorded ON entry(stop_id, recorded_at)',
];

/// version -> statements that upgrade from `version - 1`.
final Map<int, List<String>> migrations = {
  2: [
    for (final t in kTables) ...[
      'ALTER TABLE $t ADD COLUMN updated_at INTEGER',
      'ALTER TABLE $t ADD COLUMN synced_at INTEGER',
    ],
  ],
  // Street route of the walk (encoded polyline + legs + times) so it renders without the offline pack.
  3: ['ALTER TABLE walk ADD COLUMN route_json TEXT'],
  // Community sharing is opt-in per entry. `shared_text` is the snapshot others can read (<= 280 chars).
  4: [
    'ALTER TABLE entry ADD COLUMN shared INTEGER',
    'ALTER TABLE entry ADD COLUMN shared_text TEXT',
  ],
};

Future<void> _run(Database db, List<String> statements) async {
  for (final s in statements) {
    await db.execute(s);
  }
}

Future<void> onCreate(Database db, int version) async {
  await _run(db, _v1);
  for (var v = 2; v <= version; v++) {
    await _run(db, migrations[v] ?? const []);
  }
}

Future<void> onUpgrade(Database db, int oldVersion, int newVersion) async {
  for (var v = oldVersion + 1; v <= newVersion; v++) {
    await _run(db, migrations[v] ?? const []);
  }
}

/// An older build must not open (and corrupt) a newer database.
Future<void> onDowngrade(Database db, int oldVersion, int newVersion) async {
  throw StateError('Database is schema v$oldVersion but this build only supports v$newVersion');
}

/// Opens the app database; pass a different [factory] (e.g. ffi) in tests.
Future<Database> openAppDatabase(String path, {DatabaseFactory? factory, int version = kDbVersion}) {
  return (factory ?? databaseFactory).openDatabase(
    path,
    options: OpenDatabaseOptions(
      version: version,
      onCreate: onCreate,
      onUpgrade: onUpgrade,
      onDowngrade: onDowngrade,
    ),
  );
}

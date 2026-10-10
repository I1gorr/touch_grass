import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import '../interfaces/types.dart';
import '../models/entry.dart';
import '../models/walk.dart';
import '../models/walk_photo.dart';
import '../sync/sync_store.dart';
import '../util/ids.dart';
import '../util/image_type.dart';
import 'schema.dart';
import 'walk_repository.dart';

class SqfliteWalkRepository implements WalkRepository, SyncableStore {
  final Database db;
  final _changes = StreamController<void>.broadcast();
  int _lastStamp;

  SqfliteWalkRepository._(this.db, this._lastStamp);

  /// Monotonic ms timestamp for updated_at. Never goes backwards, even if the
  /// phone clock does, so a change can't look older than its last upload.
  /// The shared version clock for other writers on this database (the data
  /// track's WalkRepository takes it as `nowMs`), so every writer stamps rows
  /// from one monotonic counter.
  int stamp() => _stamp();

  int _stamp() {
    final now = DateTime.now().millisecondsSinceEpoch;
    _lastStamp = now > _lastStamp ? now : _lastStamp + 1;
    return _lastStamp;
  }

  /// [factory] lets tests pass databaseFactoryFfi; [path] may be
  /// inMemoryDatabasePath. Defaults to `<databases>/touch_grass.db`.
  /// [extraMigrations] is for tests; real changes go in schema.dart.
  static Future<SqfliteWalkRepository> open({
    DatabaseFactory? factory,
    String? path,
    Map<int, List<String>>? extraMigrations,
  }) async {
    final f = factory ?? databaseFactory;
    final dbPath = path ?? p.join(await f.getDatabasesPath(), 'touch_grass.db');
    final clash =
        extraMigrations?.keys
            .where((v) => migrations.containsKey(v) || programmaticMigrations.containsKey(v))
            .toList() ??
        const [];
    if (clash.isNotEmpty) throw ArgumentError('extraMigrations reuse real schema versions $clash');
    final steps = {...migrations, ...?extraMigrations};
    final version = {...steps.keys, ...programmaticMigrations.keys}.reduce((a, b) => a > b ? a : b);

    Future<void> migrate(Database db, int from, int to) async {
      for (var v = from + 1; v <= to; v++) {
        for (final sql in steps[v] ?? const <String>[]) {
          await db.execute(sql);
        }
        await programmaticMigrations[v]?.call(db);
      }
    }

    final db = await f.openDatabase(
      dbPath,
      options: OpenDatabaseOptions(
        version: version,
        onCreate: (db, v) async {
          for (final s in createStatements) {
            await db.execute(s);
          }
          await migrate(db, 1, v);
        },
        onUpgrade: migrate,
        onDowngrade: (db, from, to) =>
            throw StateError('Database is v$from but this build only knows v$to; refusing to downgrade.'),
      ),
    );
    var last = 0;
    for (final t in syncedTables) {
      final r = await db.rawQuery('SELECT MAX(MAX(COALESCE(updated_at, 0), COALESCE(synced_at, 0))) AS m FROM $t');
      final m = (r.first['m'] as num?)?.toInt() ?? 0;
      if (m > last) last = m;
    }
    final repo = SqfliteWalkRepository._(db, last);
    await repo._importLegacyPhotoFiles();
    return repo;
  }

  /// Before v4, photos were files referenced by entry.photo_path. Move each
  /// walk's newest one into the photo table (one per walk). A row's path is
  /// cleared only once its outcome is final (imported, superseded by a newer
  /// photo, file gone, or not a still JPEG/PNG ≤ 8 MB). A read error keeps
  /// the path so the next launch retries. Files are left on disk.
  Future<void> _importLegacyPhotoFiles() async {
    final rows = await db.rawQuery('''
      SELECT e.id AS entry_id, e.photo_path AS path, s.walk_id AS walk_id, COALESCE(e.recorded_at, 0) AS at
      FROM entry e JOIN stop s ON s.id = e.stop_id
      WHERE e.photo_path IS NOT NULL
      ORDER BY COALESCE(e.updated_at, 0) DESC''');
    for (final r in rows) {
      final entryId = r['entry_id'] as String;
      final walkId = r['walk_id'] as String;
      final file = File(r['path'] as String);
      Future<void> settle() => db.update('entry', {'photo_path': null}, where: 'id = ?', whereArgs: [entryId]);

      if (await walkPhotoStamp(walkId) != null) {
        await settle(); // superseded: the walk already has its (newer) photo
        continue;
      }
      if (!await file.exists()) {
        await settle();
        continue;
      }
      final Uint8List bytes;
      try {
        bytes = await file.readAsBytes();
      } catch (e) {
        continue; // possibly temporary: keep the path and retry next launch
      }
      final mime = sniffImageType(bytes);
      if (mime != null && bytes.length <= maxPhotoBytes) {
        await db.insert(
          'photo',
          WalkPhoto(
            walkId: walkId,
            entryId: entryId,
            mime: mime,
            bytes: bytes,
            createdAt: DateTime.fromMillisecondsSinceEpoch((r['at'] as num).toInt()),
          ).toMap(),
        );
      }
      await settle();
    }
  }

  /// Entry columns plus a computed has_photo flag.
  static const _entrySelect =
      'SELECT e.*, EXISTS(SELECT 1 FROM photo p WHERE p.entry_id = e.id) AS has_photo FROM entry e';

  void _changed() => _changes.add(null);

  @override
  Stream<void> get changes => _changes.stream;

  @override
  void notifyExternalChange() => _changed();

  @override
  Future<void> insertWalk(Walk walk, List<Stop> stops) async {
    await db.transaction((txn) async {
      final t = _stamp();
      await txn.insert('walk', {...walk.toMap(), 'updated_at': t}, conflictAlgorithm: ConflictAlgorithm.replace);
      for (var i = 0; i < stops.length; i++) {
        await txn.insert('stop', {
          ...stopToRow(stops[i], walk.id, i),
          'updated_at': t,
        }, conflictAlgorithm: ConflictAlgorithm.replace);
      }
    });
    _changed();
  }

  @override
  Future<void> updateWalkStatus(String walkId, WalkStatus status) async {
    await db.update('walk', {'status': status.name, 'updated_at': _stamp()}, where: 'id = ?', whereArgs: [walkId]);
    _changed();
  }

  @override
  Future<Walk?> getWalk(String walkId) async {
    final rows = await db.query('walk', where: 'id = ?', whereArgs: [walkId]);
    return rows.isEmpty ? null : Walk.fromMap(rows.first);
  }

  @override
  Future<List<Walk>> listWalks() async =>
      (await db.query('walk', orderBy: 'created_at DESC')).map(Walk.fromMap).toList();

  @override
  Future<List<Stop>> stopsForWalk(String walkId) async => (await db.query(
    'stop',
    where: 'walk_id = ?',
    whereArgs: [walkId],
    orderBy: 'position',
  )).map(stopFromRow).toList();

  @override
  Future<void> insertEntry(Entry entry) async {
    await db.insert('entry', {...entry.toMap(), 'updated_at': _stamp()}, conflictAlgorithm: ConflictAlgorithm.replace);
    _changed();
  }

  @override
  Future<void> updateEntry(String entryId, {String? rawTranscript, String? cleanedText}) async {
    final values = <String, Object?>{'raw_transcript': ?rawTranscript, 'cleaned_text': ?cleanedText};
    if (values.isEmpty) return;
    values['updated_at'] = _stamp();
    final n = await db.update('entry', values, where: 'id = ?', whereArgs: [entryId]);
    if (n == 0) throw StateError('entry $entryId not found');
    _changed();
  }

  @override
  Future<Entry?> getEntry(String entryId) async {
    final rows = await db.rawQuery('$_entrySelect WHERE e.id = ?', [entryId]);
    return rows.isEmpty ? null : Entry.fromMap(rows.first);
  }

  @override
  Future<List<Entry>> entriesForStop(String stopId) async => (await db.rawQuery(
    '$_entrySelect WHERE e.stop_id = ? ORDER BY e.recorded_at',
    [stopId],
  )).map(Entry.fromMap).toList();

  @override
  Future<List<Entry>> entriesForWalk(String walkId) async => (await db.rawQuery(
    '$_entrySelect JOIN stop s ON s.id = e.stop_id WHERE s.walk_id = ? ORDER BY s.position, e.recorded_at',
    [walkId],
  )).map(Entry.fromMap).toList();

  // --- Photos: local only, one per walk ---

  @override
  Future<void> moveEntry(String entryId, {required String stopId, required DateTime recordedAt}) async {
    final n = await db.update(
      'entry',
      {'stop_id': stopId, 'recorded_at': recordedAt.millisecondsSinceEpoch, 'updated_at': _stamp()},
      where: 'id = ?',
      whereArgs: [entryId],
    );
    if (n == 0) throw StateError('entry $entryId not found');
    _changed();
  }

  @override
  Future<void> putWalkPhoto(WalkPhoto photo, {Entry? newEntry}) async {
    await db.transaction((txn) async {
      if (newEntry != null) {
        await txn.insert('entry', {
          ...newEntry.toMap(),
          'updated_at': _stamp(),
        }, conflictAlgorithm: ConflictAlgorithm.replace);
      }
      final before = await txn.query('photo', columns: ['entry_id'], where: 'walk_id = ?', whereArgs: [photo.walkId]);
      await txn.insert('photo', photo.toMap(), conflictAlgorithm: ConflictAlgorithm.replace);
      // has_photo is synced with the entry, so both the new holder and a
      // previous one must be uploaded again.
      final touched = {photo.entryId, if (before.isNotEmpty) before.first['entry_id'] as String};
      for (final id in touched) {
        await txn.update('entry', {'updated_at': _stamp()}, where: 'id = ?', whereArgs: [id]);
      }
    });
    _changed();
  }

  @override
  Future<PhotoStamp?> walkPhotoStamp(String walkId) async {
    final rows = await db.query(
      'photo',
      columns: ['entry_id', 'created_at', 'size'],
      where: 'walk_id = ?',
      whereArgs: [walkId],
    );
    if (rows.isEmpty) return null;
    final r = rows.first;
    return PhotoStamp(r['entry_id'] as String, (r['created_at'] as num).toInt(), (r['size'] as num).toInt());
  }

  // --- Install identity ---

  /// This install's sync device id, stored with the data it owns. Adopts the
  /// legacy `device_id` file once ([legacyId]) so existing cloud rows stay
  /// writable after upgrading; otherwise generates a new random id.
  @override
  Future<String> deviceId({Future<String?> Function()? legacyId}) async {
    final rows = await db.query('meta', where: 'key = ?', whereArgs: ['device_id']);
    if (rows.isNotEmpty) return rows.first['value'] as String;
    final adopted = legacyId == null ? null : await legacyId();
    final id = adopted != null && RegExp(r'^[0-9a-f]{32}$').hasMatch(adopted) ? adopted : newId();
    await db.insert('meta', {'key': 'device_id', 'value': id}, conflictAlgorithm: ConflictAlgorithm.ignore);
    // Re-read in case of a concurrent first call.
    return (await db.query('meta', where: 'key = ?', whereArgs: ['device_id'])).first['value'] as String;
  }

  @override
  Future<WalkPhoto?> walkPhoto(String walkId) async {
    final rows = await db.query('photo', where: 'walk_id = ?', whereArgs: [walkId]);
    return rows.isEmpty ? null : WalkPhoto.fromMap(rows.first);
  }

  @override
  Future<Map<String, List<Map<String, Object?>>>> dumpTables() async => {
    for (final t in const ['walk', 'stop', 'entry']) t: await db.query(t),
    'photo': await db.rawQuery(
      "SELECT walk_id, entry_id, mime, '<' || size || ' bytes>' AS data, size, created_at FROM photo",
    ),
  };

  // --- SyncableStore: walk/stop/entry rows only. Photos are never uploaded. ---

  @override
  Future<SyncBatch> pendingChanges({int limitPerTable = 200}) async => SyncBatch({
    for (final t in syncedTables)
      t: [
        for (final r in await _pendingRows(t, limitPerTable))
          {...r}
            ..remove('synced_at')
            ..remove('photo_path'), // legacy column; no image data or device paths leave the phone
      ],
  });

  /// Entries also carry `has_photo` (0/1), so the server can count photos for
  /// community stats without ever receiving the image or a path.
  Future<List<Map<String, Object?>>> _pendingRows(String table, int limit) => table == 'entry'
      ? db.rawQuery(
          'SELECT e.*, EXISTS(SELECT 1 FROM photo p WHERE p.entry_id = e.id) AS has_photo '
          'FROM entry e WHERE $pendingSyncWhere ORDER BY updated_at LIMIT ?',
          [limit],
        )
      : db.query(table, where: pendingSyncWhere, orderBy: 'updated_at', limit: limit);

  /// Deliberately does not emit [changes]: uploads aren't user-visible edits,
  /// and emitting would re-trigger change-driven sync forever.
  @override
  Future<void> markSynced(SyncBatch batch) async {
    await db.transaction((txn) async {
      for (final e in batch.rows.entries) {
        for (final r in e.value) {
          final version = (r['updated_at'] as num?)?.toInt() ?? 1;
          await txn.update(e.key, {'synced_at': version}, where: 'id = ?', whereArgs: [r['id']]);
        }
      }
    });
  }

  @override
  Future<int> pendingCount() async {
    var n = 0;
    for (final t in syncedTables) {
      n += Sqflite.firstIntValue(await db.rawQuery('SELECT COUNT(*) FROM $t WHERE $pendingSyncWhere')) ?? 0;
    }
    return n;
  }

  @override
  Future<void> close() async {
    await _changes.close();
    await db.close();
  }
}

// One database for both tracks: databases from either track's history upgrade
// to the merged schema, and both tracks' repositories work on the same file.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:touch_grass/datatrack/db/schema.dart' as dt_schema;
import 'package:touch_grass/datatrack/db/walk_repository.dart' as dt;
import 'package:touch_grass/datatrack/models/walk.dart' as dt;
import 'package:touch_grass/datatrack/tracks/data/quest_preparer.dart';
import 'package:touch_grass/db/schema.dart';
import 'package:touch_grass/db/sqflite_walk_repository.dart';
import 'package:touch_grass/interfaces/types.dart';
import 'package:touch_grass/models/entry.dart';
import 'package:touch_grass/models/walk.dart';
import 'package:touch_grass/models/walk_photo.dart';

import '../helpers/fakes.dart' show pngBytes;

void main() {
  sqfliteFfiInit();
  late Directory tmp;
  setUp(() async => tmp = await Directory.systemTemp.createTemp('tg-merge'));
  tearDown(() => tmp.delete(recursive: true));

  Future<Set<String>> columns(Database db, String table) async => {
    for (final r in await db.rawQuery('PRAGMA table_info($table)')) r['name'] as String,
  };
  Future<Set<String>> tables(Database db) async => {
    for (final r in await db.rawQuery("SELECT name FROM sqlite_master WHERE type = 'table'")) r['name'] as String,
  };

  PreparedQuest quest(String walkId) => PreparedQuest(
    dt.Walk(
      id: walkId,
      createdAt: DateTime(2026, 10, 1).millisecondsSinceEpoch,
      startLat: 40.78,
      startLng: -73.96,
      timeOfDay: 'morning',
      routeJson: '{"v":1,"mode":"street","polyline":"_p~iF~ps|U","legs_m":[300,300],"total_m":600}',
    ),
    [
      for (var i = 0; i < 2; i++)
        Stop(
          id: '$walkId-$i',
          walkId: walkId,
          position: i,
          osmId: 'node/$i',
          name: 'Place $i',
          lat: 40.78 + i / 1000,
          lng: -73.96,
          tagsJson: '{"leisure":"park"}',
          prompt: 'What do you see?',
        ),
    ],
  );

  test('a data-track database (their v4) upgrades into the merged schema with its data intact', () async {
    final path = '${tmp.path}/theirs.db';
    final photo = File('${tmp.path}/p.png')..writeAsBytesSync(pngBytes());
    final theirsDb = await dt_schema.openAppDatabase(path, factory: databaseFactoryFfi);
    expect(await theirsDb.getVersion(), 4);
    final theirs = dt.WalkRepository(theirsDb);
    await theirs.saveQuest(quest('w1'));
    final e = await theirs.createEntry(stopId: 'w1-0', photoPath: photo.path);
    await theirs.setCleanedText(e.id, 'Lovely pond.');
    await theirs.shareEntry(e.id);
    await theirsDb.close();

    final repo = await SqfliteWalkRepository.open(factory: databaseFactoryFfi, path: path);
    expect(await repo.db.getVersion(), schemaVersion);
    expect(await tables(repo.db), containsAll(['walk', 'stop', 'entry', 'photo', 'meta']));
    expect(await columns(repo.db, 'walk'), contains('route_json'));
    expect(await columns(repo.db, 'entry'), containsAll(['shared', 'shared_text', 'photo_path']));

    // Our side reads their rows.
    final walk = (await repo.getWalk('w1'))!;
    expect(walk.startLat, 40.78);
    expect((await repo.stopsForWalk('w1')).map((s) => s.name), ['Place 0', 'Place 1']);
    final entry = (await repo.entriesForStop('w1-0')).single;
    expect(entry.cleanedText, 'Lovely pond.');
    expect(entry.hasPhoto, isTrue, reason: 'their photo file was imported into SQLite');
    expect((await repo.walkPhoto('w1'))!.bytes, pngBytes());

    // Their side still works on the upgraded database.
    final theirsAgain = dt.WalkRepository(repo.db, nowMs: repo.stamp);
    final bundle = (await theirsAgain.loadWalk('w1'))!;
    expect(bundle.walk.routeJson, contains('"mode":"street"'));
    expect(bundle.entriesOf('w1-0').single.shared, isTrue);
    expect(bundle.entriesOf('w1-0').single.sharedText, 'Lovely pond.');
    await repo.close();
  });

  test('an app-track database (our v5) gains the data track columns, data intact', () async {
    final path = '${tmp.path}/ours.db';
    final v5 = await databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 5,
        onCreate: (db, _) async {
          for (final s in createStatements) {
            await db.execute(s);
          }
          for (var v = 2; v <= 5; v++) {
            for (final s in migrations[v]!) {
              await db.execute(s);
            }
          }
        },
      ),
    );
    await v5.insert('walk', {'id': 'w', 'created_at': 1, 'start_lat': 1.0, 'start_lng': 2.0, 'status': 'done'});
    await v5.insert('meta', {'key': 'device_id', 'value': 'ab' * 16});
    await v5.close();

    final repo = await SqfliteWalkRepository.open(factory: databaseFactoryFfi, path: path);
    expect(await columns(repo.db, 'walk'), contains('route_json'));
    expect(await columns(repo.db, 'entry'), containsAll(['shared', 'shared_text']));
    expect((await repo.getWalk('w'))!.status, WalkStatus.done);
    expect(await repo.deviceId(), 'ab' * 16, reason: 'install identity survives the upgrade');
    await repo.close();
  });

  test('the reconcile step is safe to run again', () async {
    final repo = await SqfliteWalkRepository.open(factory: databaseFactoryFfi, path: '${tmp.path}/x.db');
    await reconcileTracks(repo.db);
    await reconcileTracks(repo.db);
    expect(await columns(repo.db, 'walk'), contains('route_json'));
    await repo.close();
  });

  group('both repositories on one database', () {
    late SqfliteWalkRepository repo;
    late dt.WalkRepository theirs;
    setUp(() async {
      repo = await SqfliteWalkRepository.open(factory: databaseFactoryFfi, path: '${tmp.path}/one.db');
      theirs = dt.WalkRepository(repo.db, nowMs: repo.stamp);
    });
    tearDown(() => repo.close());

    test('a quest saved by the data track is a normal walk for the app track', () async {
      await theirs.saveQuest(quest('w'));
      final walks = await repo.listWalks();
      expect(walks.single.id, 'w');
      expect(walks.single.status, WalkStatus.ready);
      expect((await repo.stopsForWalk('w')).first.prompt, 'What do you see?');

      // Notes and the photo recorded through the app track show up for the data track.
      await repo.insertEntry(Entry(id: 'e', stopId: 'w-0', recordedAt: DateTime(2026), rawTranscript: 'hi'));
      await repo.putWalkPhoto(
        WalkPhoto(
          walkId: 'w',
          entryId: 'e',
          mime: 'image/png',
          bytes: Uint8List.fromList(pngBytes()),
          createdAt: DateTime(2026),
        ),
      );
      expect((await theirs.loadWalk('w'))!.entriesOf('w-0').single.rawTranscript, 'hi');
    });

    test('finished walks feed the data track’s place rotation', () async {
      await theirs.saveQuest(quest('w'));
      await repo.updateWalkStatus('w', WalkStatus.done);
      final history = await theirs.placeHistory();
      expect(history['node/0']!.visits, 1);
    });

    test('uploads carry the data track fields; no photo path or bytes', () async {
      await theirs.saveQuest(quest('w'));
      await repo.insertEntry(Entry(id: 'e', stopId: 'w-0', recordedAt: DateTime(2026), cleanedText: 'Ducks.'));
      await theirs.shareEntry('e');
      final batch = await repo.pendingChanges();
      expect(batch.rows['walk']!.single['route_json'], contains('street'));
      final entry = batch.rows['entry']!.single;
      expect([entry['shared'], entry['shared_text'], entry['has_photo']], [1, 'Ducks.', 0]);
      expect(entry.containsKey('photo_path'), isFalse);
    });

    test('both writers share one version clock: every edit is newer than the last', () async {
      await theirs.saveQuest(quest('w'));
      Future<int> version() async =>
          (await repo.db.query('walk', columns: ['updated_at'], where: 'id = ?', whereArgs: ['w'])).single['updated_at']
              as int;
      final v1 = await version();
      await repo.updateWalkStatus('w', WalkStatus.active);
      final v2 = await version();
      await theirs.setStatus('w', dt.WalkStatus.done);
      final v3 = await version();
      expect(v2, greaterThan(v1));
      expect(v3, greaterThan(v2));
    });

    test('an active walk is visible to both (the data track blocks network during it)', () async {
      await theirs.saveQuest(quest('w'));
      expect(await theirs.hasActiveWalk(), isFalse);
      await repo.updateWalkStatus('w', WalkStatus.active);
      expect(await theirs.hasActiveWalk(), isTrue);
    });
  });
}

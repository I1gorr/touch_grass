import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:touch_grass/datatrack/db/schema.dart';
import 'package:touch_grass/datatrack/db/sync_queue.dart';
import 'package:touch_grass/datatrack/db/walk_repository.dart';
import 'package:touch_grass/datatrack/models/walk.dart';
import 'package:touch_grass/datatrack/tracks/data/demo_location.dart';
import 'package:touch_grass/datatrack/tracks/data/fake_quest_builder.dart';
import 'package:touch_grass/datatrack/tracks/data/quest_preparer.dart';
import 'package:touch_grass/datatrack/tracks/data/render_json.dart';
import 'package:touch_grass/datatrack/tracks/data/weather_client.dart';

Future<PreparedQuest> prepared() => QuestPreparer(
      builder: const FakeQuestBuilder(),
      weather: WeatherService(client: MockClient((_) async => http.Response('x', 500))),
      clock: () => DateTime(2026, 1, 1, 8),
    ).prepare(kDemoLocation);

void main() {
  sqfliteFfiInit();
  late Database db;
  late WalkRepository repo;
  var clockMs = 1000;

  setUp(() async {
    clockMs = 1000;
    db = await openAppDatabase(inMemoryDatabasePath, factory: databaseFactoryFfi);
    repo = WalkRepository(db, nowMs: () => clockMs);
  });
  tearDown(() => db.close());

  test('saveQuest stores walk and ordered stops; loadWalk reads them back', () async {
    final q = await prepared();
    await repo.saveQuest(q);
    final b = (await repo.loadWalk(q.walk.id))!;
    expect(b.walk.status, WalkStatus.ready);
    expect(b.walk.weatherSummary, 'unknown');
    expect(b.stops.map((s) => s.position), [0, 1, 2]);
    expect(b.stops.map((s) => s.id), q.stops.map((s) => s.id));
    expect(renderWalkJson(b)['stops'], hasLength(3));
  });

  test('entry: NULL vs empty transcript, cleaned text and photo', () async {
    final q = await prepared();
    await repo.saveQuest(q);
    final e = await repo.createEntry(stopId: q.stops.first.id);
    var got = (await repo.loadWalk(q.walk.id))!.entriesOf(q.stops.first.id).single;
    expect(got.rawTranscript, isNull);
    await repo.setRawTranscript(e.id, '');
    await repo.setCleanedText(e.id, 'Clean.');
    await repo.setPhotoPath(e.id, '/p.jpg');
    got = (await repo.loadWalk(q.walk.id))!.entriesOf(q.stops.first.id).single;
    expect(got.rawTranscript, '');
    expect(got.cleanedText, 'Clean.');
    expect(got.photoPath, '/p.jpg');
  });

  test('status only moves forward; unknown status reads as ready', () async {
    final q = await prepared();
    await repo.saveQuest(q);
    await repo.setStatus(q.walk.id, WalkStatus.active);
    expect(await repo.hasActiveWalk(), isTrue);
    expect(() => repo.setStatus(q.walk.id, WalkStatus.ready), throwsStateError);
    await repo.setStatus(q.walk.id, WalkStatus.done);
    expect(await repo.hasActiveWalk(), isFalse);
    await db.update('walk', {'status': 'weird'}, where: 'id = ?', whereArgs: [q.walk.id]);
    expect((await repo.getWalk(q.walk.id))!.status, WalkStatus.ready);
  });

  test('updated_at stays monotonic when the clock jumps back', () async {
    final q = await prepared();
    clockMs = 5000;
    await repo.saveQuest(q);
    clockMs = 10; // clock jumps back
    await repo.setStatus(q.walk.id, WalkStatus.active);
    final row = (await db.query('walk')).single;
    expect(row['updated_at'], 5001);
  });

  test('pending / markSynced: uploaded version only, edits in flight stay pending', () async {
    final q = await prepared();
    await repo.saveQuest(q);
    final queue = SyncQueue(db);
    var p = await queue.pending();
    expect(p.walks, hasLength(1));
    expect(p.stops, hasLength(3));
    expect(p.walks.single.containsKey('synced_at'), isFalse);
    expect(await queue.pendingCount(), 4);

    final uploaded = p.walks.single['updated_at'] as int;
    clockMs = 2000;
    await repo.setStatus(q.walk.id, WalkStatus.active); // edit while "upload in flight"
    await queue.markSynced('walk', q.walk.id, uploaded);
    p = await queue.pending();
    expect(p.walks, hasLength(1), reason: 'newer edit must stay pending');
    for (final s in q.stops) {
      await queue.markSynced('stop', s.id, 1000);
    }
    expect((await queue.pending()).stops, isEmpty);
  });

  test('v1 rows (NULL updated_at) count as pending and sync as version 1', () async {
    await db.close();
    final factory = databaseFactoryFfi;
    final path = '${Directory.systemTemp.path}/tg_v1_${DateTime.now().microsecondsSinceEpoch}.db';
    final v1 = await factory.openDatabase(path,
        options: OpenDatabaseOptions(version: 1, onCreate: (d, v) async {
          for (final s in [
            'CREATE TABLE walk (id TEXT PRIMARY KEY, created_at INTEGER, start_lat REAL, start_lng REAL, time_of_day TEXT, weather_summary TEXT, status TEXT)',
            'CREATE TABLE stop (id TEXT PRIMARY KEY, walk_id TEXT, position INTEGER, osm_id TEXT, name TEXT, lat REAL, lng REAL, tags_json TEXT, blurb TEXT, prompt TEXT)',
            'CREATE TABLE entry (id TEXT PRIMARY KEY, stop_id TEXT, recorded_at INTEGER, raw_transcript TEXT, cleaned_text TEXT, photo_path TEXT)',
          ]) {
            await d.execute(s);
          }
        }));
    await v1.insert('walk', {'id': 'w1', 'created_at': 1, 'start_lat': 1.0, 'start_lng': 2.0, 'time_of_day': 'night', 'status': 'done'});
    await v1.close();
    db = await openAppDatabase(path, factory: factory); // upgrades v1 -> v2 in place
    final queue = SyncQueue(db);
    final p = await queue.pending();
    expect(p.walks.single['updated_at'], isNull);
    await queue.markSynced('walk', 'w1', p.walks.single['updated_at'] as int?);
    expect(await queue.pendingCount(), 0);
    await db.close();
    await expectLater(openAppDatabase(path, factory: factory, version: 1), throwsA(anything)); // downgrade refused
    db = await openAppDatabase(path, factory: factory);
  });

  test('schema v2 -> v3 adds walk.route_json without touching existing rows', () async {
    await db.close();
    final path = '${Directory.systemTemp.path}/tg_v2_${DateTime.now().microsecondsSinceEpoch}.db';
    final v2 = await databaseFactoryFfi.openDatabase(path,
        options: OpenDatabaseOptions(version: 2, onCreate: (d, v) async {
          await onCreate(d, 2);
        }));
    await v2.insert('walk', {'id': 'w2', 'created_at': 1, 'start_lat': 1.0, 'start_lng': 2.0, 'time_of_day': 'night', 'status': 'done', 'updated_at': 7});
    await v2.close();
    db = await openAppDatabase(path, factory: databaseFactoryFfi);
    repo = WalkRepository(db);
    final w = (await repo.getWalk('w2'))!;
    expect(w.status, WalkStatus.done);
    expect(w.routeJson, isNull);
    await db.update('walk', {'route_json': '{"v":1}'}, where: 'id = ?', whereArgs: ['w2']);
    expect((await repo.getWalk('w2'))!.routeJson, '{"v":1}');
  });
}

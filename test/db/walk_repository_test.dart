import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:touch_grass/db/memory_walk_repository.dart';
import 'package:touch_grass/db/schema.dart';
import 'package:touch_grass/db/sqflite_walk_repository.dart';
import 'package:touch_grass/db/walk_repository.dart';
import 'package:touch_grass/interfaces/types.dart';
import 'package:touch_grass/models/entry.dart';
import 'package:touch_grass/models/walk.dart';
import 'package:touch_grass/models/walk_photo.dart';

import '../helpers/fakes.dart' show pngBytes, stop;

/// Same contract tests against both implementations, so the in-memory repo
/// used in other tests can't drift from the real one.
WalkPhoto photo(String walkId, String entryId, List<int> bytes, {String mime = 'image/jpeg'}) => WalkPhoto(
    walkId: walkId, entryId: entryId, mime: mime, bytes: Uint8List.fromList(bytes), createdAt: DateTime(2026));

void main() {
  sqfliteFfiInit();
  final impls = <String, Future<WalkRepository> Function()>{
    'memory': () async => MemoryWalkRepository(),
    'sqflite': () => SqfliteWalkRepository.open(factory: databaseFactoryFfi, path: inMemoryDatabasePath),
  };

  for (final impl in impls.entries) {
    group(impl.key, () {
      late WalkRepository repo;
      setUp(() async => repo = await impl.value());
      tearDown(() => repo.close());

      Walk walk(String id, int t) => Walk(
            id: id,
            createdAt: DateTime.fromMillisecondsSinceEpoch(t),
            startLat: 1,
            startLng: 2,
            timeOfDay: 'morning',
            weatherSummary: 'sunny',
          );
      Stop stop(String id) =>
          Stop(id: id, osmId: 'node/$id', name: 'Stop $id', lat: 1, lng: 2, tagsJson: '{}', blurb: 'b', prompt: 'p');

      test('walks and stops round-trip in order', () async {
        await repo.insertWalk(walk('w1', 1000), [stop('a'), stop('b'), stop('c')]);
        await repo.insertWalk(walk('w2', 2000), [stop('d')]);

        expect((await repo.listWalks()).map((w) => w.id), ['w2', 'w1']);
        expect((await repo.stopsForWalk('w1')).map((s) => s.id), ['a', 'b', 'c']);
        expect((await repo.stopsForWalk('w1')).first.blurb, 'b');

        await repo.updateWalkStatus('w1', WalkStatus.done);
        expect((await repo.getWalk('w1'))!.status, WalkStatus.done);
      });

      test('entries: partial updates keep other fields', () async {
        await repo.insertWalk(walk('w1', 1000), [stop('a'), stop('b')]);
        await repo.insertEntry(Entry(id: 'e1', stopId: 'a', recordedAt: DateTime.fromMillisecondsSinceEpoch(5)));
        await repo.insertEntry(Entry(id: 'e2', stopId: 'b', recordedAt: DateTime.fromMillisecondsSinceEpoch(6)));

        await repo.updateEntry('e1', rawTranscript: 'raw');
        await repo.updateEntry('e1', cleanedText: 'Clean.');

        final e = (await repo.getEntry('e1'))!;
        expect([e.rawTranscript, e.cleanedText, e.hasPhoto], ['raw', 'Clean.', false]);
        expect((await repo.entriesForStop('a')).single.id, 'e1');
        expect((await repo.entriesForWalk('w1')).map((e) => e.id), ['e1', 'e2']);
        expect(() => repo.updateEntry('missing', rawTranscript: 'x'), throwsStateError);
      });

      test('changes stream fires on writes', () async {
        var n = 0;
        final sub = repo.changes.listen((_) => n++);
        await repo.insertWalk(walk('w1', 1), [stop('a')]);
        await repo.insertEntry(Entry(id: 'e1', stopId: 'a', recordedAt: DateTime.now()));
        await Future<void>.delayed(Duration.zero);
        expect(n, 2);
        await sub.cancel();
      });

      test('dumpTables exposes all tables; photo bytes are summarised, not dumped', () async {
        await repo.insertWalk(walk('w1', 1), [stop('a')]);
        await repo.insertEntry(Entry(id: 'e1', stopId: 'a', recordedAt: DateTime(2026)));
        await repo.putWalkPhoto(photo('w1', 'e1', [1, 2, 3]));
        final d = await repo.dumpTables();
        expect(d.keys, containsAll(['walk', 'stop', 'entry', 'photo']));
        expect(d['stop']!.single['walk_id'], 'w1');
        expect(d['photo']!.single['data'], '<3 bytes>');
      });

      group('photos (local only, one per walk)', () {
        setUp(() async {
          await repo.insertWalk(walk('w1', 1), [stop('a'), stop('b')]);
          await repo.insertEntry(Entry(id: 'e1', stopId: 'a', recordedAt: DateTime(2026)));
          await repo.insertEntry(Entry(id: 'e2', stopId: 'b', recordedAt: DateTime(2026)));
        });

        test('bytes round-trip exactly', () async {
          final bytes = List.generate(1000, (i) => i % 256);
          await repo.putWalkPhoto(photo('w1', 'e1', bytes, mime: 'image/png'));
          final p = (await repo.walkPhoto('w1'))!;
          expect([p.entryId, p.mime], ['e1', 'image/png']);
          expect(p.bytes, bytes);
        });

        test('a walk has at most one photo: putting again replaces it', () async {
          await repo.putWalkPhoto(photo('w1', 'e1', [1]));
          await repo.putWalkPhoto(photo('w1', 'e2', [2, 2]));
          final p = (await repo.walkPhoto('w1'))!;
          expect([
            p.entryId,
            p.bytes
          ], [
            'e2',
            [2, 2]
          ]);
          expect((await repo.dumpTables())['photo'], hasLength(1));
        });

        test('entries report hasPhoto for the photo holder only', () async {
          await repo.putWalkPhoto(photo('w1', 'e2', [9]));
          final byId = {for (final e in await repo.entriesForWalk('w1')) e.id: e.hasPhoto};
          expect(byId, {'e1': false, 'e2': true});
          expect((await repo.getEntry('e2'))!.hasPhoto, isTrue);
          expect((await repo.entriesForStop('b')).single.hasPhoto, isTrue);
        });

        test('no photo → null; photos are per walk', () async {
          expect(await repo.walkPhoto('w1'), isNull);
          expect(await repo.walkPhoto('nope'), isNull);
        });

        test('storing a photo notifies listeners', () async {
          var n = 0;
          final sub = repo.changes.listen((_) => n++);
          await repo.putWalkPhoto(photo('w1', 'e1', [1]));
          await Future<void>.delayed(Duration.zero);
          expect(n, 1);
          await sub.cancel();
        });
      });
    });
  }

  group('sqflite only', () {
    late Directory tmp;
    setUp(() async => tmp = await Directory.systemTemp.createTemp('tg-repo'));
    tearDown(() => tmp.delete(recursive: true));

    test('upgrade imports legacy photo files into SQLite and clears photo_path', () async {
      final path = '${tmp.path}/legacy.db';
      final png = File('${tmp.path}/old.png')..writeAsBytesSync(pngBytes());
      final gif = File('${tmp.path}/anim.gif')..writeAsBytesSync('GIF89a'.codeUnits);
      // A v3 database (before photos moved into SQLite), photos as file paths.
      final v3 = await databaseFactoryFfi.openDatabase(path,
          options: OpenDatabaseOptions(
            version: 3,
            onCreate: (db, _) async {
              for (final s in createStatements) {
                await db.execute(s);
              }
              for (final v in [2, 3]) {
                for (final s in migrations[v]!) {
                  await db.execute(s);
                }
              }
            },
          ));
      for (final w in ['w1', 'w2', 'w3']) {
        await v3.insert('walk', {'id': w, 'created_at': 0, 'status': 'done'});
        await v3.insert('stop', {'id': '$w-0', 'walk_id': w, 'position': 0, 'lat': 0, 'lng': 0});
      }
      await v3
          .insert('entry', {'id': 'e1', 'stop_id': 'w1-0', 'recorded_at': 5, 'photo_path': png.path, 'updated_at': 9});
      await v3
          .insert('entry', {'id': 'e2', 'stop_id': 'w2-0', 'recorded_at': 5, 'photo_path': gif.path, 'updated_at': 9});
      await v3.insert('entry', {'id': 'e3', 'stop_id': 'w3-0', 'recorded_at': 5, 'photo_path': '${tmp.path}/gone.jpg'});
      await v3.close();

      final repo = await SqfliteWalkRepository.open(factory: databaseFactoryFfi, path: path);
      final imported = (await repo.walkPhoto('w1'))!;
      expect([imported.entryId, imported.mime], ['e1', 'image/png']);
      expect(imported.bytes, pngBytes());
      expect(await repo.walkPhoto('w2'), isNull, reason: 'GIF is not a static JPEG/PNG');
      expect(await repo.walkPhoto('w3'), isNull, reason: 'missing file');
      final paths = await repo.db.rawQuery('SELECT photo_path FROM entry WHERE photo_path IS NOT NULL');
      expect(paths, isEmpty, reason: 'legacy column cleared');
      expect(await repo.db.rawQuery("SELECT name FROM sqlite_master WHERE name = 'photo_sync'"), isEmpty);
      await repo.close();
    });

    test('photos are never offered for upload; entry rows carry no photo_path', () async {
      final repo = await SqfliteWalkRepository.open(factory: databaseFactoryFfi, path: '${tmp.path}/s.db');
      await repo.insertWalk(
          Walk(id: 'w', createdAt: DateTime(2026), startLat: 0, startLng: 0, timeOfDay: '', weatherSummary: ''),
          [stop('w-0')]);
      await repo.insertEntry(Entry(id: 'e', stopId: 'w-0', recordedAt: DateTime(2026)));
      await repo.putWalkPhoto(photo('w', 'e', pngBytes()));
      final batch = await repo.pendingChanges();
      expect(batch.rows.keys, unorderedEquals(['walk', 'stop', 'entry']));
      expect(batch.rows['entry']!.single.containsKey('photo_path'), isFalse);
      expect(batch.rows.values.expand((r) => r).expand((r) => r.values).whereType<Uint8List>(), isEmpty);
      await repo.close();
    });
  });
}

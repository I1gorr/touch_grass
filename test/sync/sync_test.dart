import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:touch_grass/database.dart';
import 'package:touch_grass/db/schema.dart';
import 'package:touch_grass/db/sqflite_walk_repository.dart';
import 'package:touch_grass/models/entry.dart';
import 'package:touch_grass/models/walk.dart';
import 'package:touch_grass/models/walk_photo.dart';
import 'package:touch_grass/sync/device_id.dart';
import 'package:touch_grass/sync/sync_service.dart';
import 'package:touch_grass/sync/sync_store.dart';
import 'package:touch_grass/sync/sync_transport.dart';
import 'package:touch_grass/util/image_type.dart';

import '../helpers/fakes.dart';

const device = '0123456789abcdef0123456789abcdef';

/// Records pushes; can be told to fail or to run a hook mid-push.
class FakeTransport implements SyncTransport {
  final pushes = <SyncBatch>[];
  Object? failWith;
  Future<void> Function()? duringPush;

  /// Rows the "server" reports as owned by another install, per push.
  int refuse = 0;
  bool closed = false;

  int get rowsPushed => pushes.fold(0, (n, b) => n + b.count);

  @override
  Future<int> push(String deviceId, SyncBatch batch) async {
    expect(deviceId, device);
    if (failWith != null) throw failWith!;
    await duringPush?.call();
    pushes.add(batch);
    return refuse;
  }

  @override
  Future<void> close() async => closed = true;
}

void main() {
  sqfliteFfiInit();
  late Directory tmp;
  late SqfliteWalkRepository repo;
  late FakeTransport transport;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('tg-sync');
    repo = await SqfliteWalkRepository.open(factory: databaseFactoryFfi, path: '${tmp.path}/db.sqlite');
    transport = FakeTransport();
  });
  tearDown(() async {
    await repo.close();
    await tmp.delete(recursive: true);
  });

  Walk walk(String id) =>
      Walk(id: id, createdAt: DateTime(2026), startLat: 1, startLng: 2, timeOfDay: 'am', weatherSummary: '');
  Future<void> seed() => repo.insertWalk(walk('w'), [stop('w-0'), stop('w-1')]);
  SyncService service({int batchSize = 200}) =>
      SyncService(store: repo, transport: transport, deviceId: device, batchSize: batchSize);

  group('change tracking', () {
    test('new rows are pending; a sync uploads them once', () async {
      await seed();
      expect(await repo.pendingCount(), 3);
      final s = service();
      final r = await s.syncNow();
      expect([r.ok, r.uploaded], [true, 3]);
      expect(await repo.pendingCount(), 0);
      expect((await s.syncNow()).uploaded, 0);
      expect(transport.pushes, hasLength(1));
    });

    test('edits after a sync make the row pending again', () async {
      await seed();
      await service().syncNow();
      await repo.updateWalkStatus('w', WalkStatus.done);
      final pending = await repo.pendingChanges();
      expect(pending.rows['walk']!.single['status'], 'done');
      expect(pending.rows['stop'], isEmpty);
    });

    test('uploaded rows never include local bookkeeping', () async {
      await seed();
      final b = await repo.pendingChanges();
      expect(b.rows['walk']!.single.containsKey('synced_at'), isFalse);
      expect(b.rows['walk']!.single['updated_at'], isA<int>());
    });

    test('a row edited while its upload is in flight stays pending', () async {
      await seed();
      await repo.insertEntry(Entry(id: 'e', stopId: 'w-0', recordedAt: DateTime(2026)));
      transport.duringPush = () => repo.updateEntry('e', rawTranscript: 'late edit');
      await service().syncNow();
      final again = await repo.pendingChanges();
      expect(again.rows['entry']!.single['raw_transcript'], 'late edit');
    });

    test('updated_at is strictly increasing even within one millisecond', () async {
      await repo.insertWalk(walk('a'), []);
      await repo.insertWalk(walk('b'), []);
      final rows = (await repo.pendingChanges()).rows['walk']!;
      expect(rows[1]['updated_at'] as int, greaterThan(rows[0]['updated_at'] as int));
    });

    test('upgrading a v1 database marks existing data for upload', () async {
      await repo.close();
      final path = '${tmp.path}/v1.sqlite';
      final v1 = await databaseFactoryFfi.openDatabase(path,
          options: OpenDatabaseOptions(
            version: 1,
            onCreate: (db, _) async {
              for (final s in createStatements) {
                await db.execute(s);
              }
            },
          ));
      await v1.insert('walk', walk('old').toMap());
      await v1.close();

      repo = await SqfliteWalkRepository.open(factory: databaseFactoryFfi, path: path);
      expect(await repo.db.getVersion(), schemaVersion);
      final b = await repo.pendingChanges();
      expect(b.rows['walk']!.single['id'], 'old');
      await service().syncNow();
      expect(await repo.pendingCount(), 0);
    });

    test('markSynced does not fire the changes stream (no sync loop)', () async {
      await seed();
      var events = 0;
      final sub = repo.changes.listen((_) => events++);
      await service().syncNow();
      await Future<void>.delayed(Duration.zero);
      expect(events, 0);
      await sub.cancel();
    });
  });

  group('failure handling', () {
    test('offline → nothing lost, error recorded, next attempt uploads', () async {
      await seed();
      final s = service();
      transport.failWith = const SyncException('timed out (offline?)');
      final r = await s.syncNow();
      expect(r.ok, isFalse);
      expect(s.lastError, isA<SyncException>());
      expect(s.pending, 3);
      expect(s.paused, isFalse, reason: 'network errors are retried automatically');

      transport.failWith = null;
      expect((await s.syncNow()).uploaded, 3);
      expect(s.lastError, isNull);
      expect(s.pending, 0);
    });

    test('wrong API key (401) pauses auto-sync until a manual retry', () async {
      await seed();
      final s = service();
      transport.failWith = const SyncException('invalid api key', status: 401);
      await s.syncNow(manual: false);
      expect(s.paused, isTrue);

      transport.failWith = null;
      await s.syncNow();
      expect(s.paused, isFalse);
      expect(s.pending, 0);
    });

    test('server errors (5xx, 429) are retryable, not permanent', () {
      expect(const SyncException('x', status: 500).isPermanent, isFalse);
      expect(const SyncException('x', status: 429).isPermanent, isFalse);
      expect(const SyncException('x', status: 400).isPermanent, isTrue);
      expect(const SyncException('x').isPermanent, isFalse);
    });

    test('failure mid-way keeps earlier batches synced', () async {
      for (var i = 0; i < 5; i++) {
        await repo.insertWalk(walk('w$i'), []);
      }
      var n = 0;
      transport.duringPush = () async {
        if (++n == 2) throw const SyncException('dropped');
      };
      final r = await service(batchSize: 2).syncNow();
      expect(r.uploaded, 2);
      expect(await repo.pendingCount(), 3);
    });

    test('concurrent syncNow calls share one run', () async {
      await seed();
      final gate = Completer<void>();
      transport.duringPush = () => gate.future;
      final s = service();
      final a = s.syncNow();
      final b = s.syncNow();
      expect(s.running, isTrue);
      gate.complete();
      await Future.wait([a, b]);
      expect(transport.pushes, hasLength(1));
      expect(s.running, isFalse);
    });

    test('rows owned by another install are surfaced, not silently marked synced', () async {
      await seed();
      transport.refuse = 2;
      final s = service();
      final r = await s.syncNow();
      expect(r.ok, isTrue, reason: 'they can never succeed from here, so no retry loop');
      expect(s.refused, 2);
      expect(await repo.pendingCount(), 0);
    });

    test('close waits for the upload in flight, then releases an owned transport', () async {
      await seed();
      final gate = Completer<void>();
      transport.duringPush = () => gate.future;
      final s = service();
      final run = s.syncNow();
      var closedDone = false;
      final closing = s.close().then((_) => closedDone = true);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(closedDone, isFalse, reason: 'must not close under a running upload');
      gate.complete();
      await run;
      await closing;
      expect(transport.closed, isTrue);
    });

    test('a transport supplied from outside is not closed', () async {
      final s = SyncService(store: repo, transport: transport, deviceId: device, ownsTransport: false);
      await s.close();
      expect(transport.closed, isFalse);
    });

    test('a store that never clears is capped, not an infinite loop', () async {
      final s = SyncService(store: _StuckStore(), transport: transport, deviceId: device, maxBatchesPerRun: 3);
      await s.syncNow();
      expect(transport.pushes, hasLength(3));
    });
  });

  group('photos stay on the phone', () {
    test('a walk with a photo syncs its rows, never the image', () async {
      await repo.insertWalk(walk('w'), [stop('w-0')]);
      await repo.insertEntry(Entry(id: 'e', stopId: 'w-0', recordedAt: DateTime(2026)));
      await repo.putWalkPhoto(WalkPhoto(
          walkId: 'w',
          entryId: 'e',
          mime: 'image/png',
          bytes: Uint8List.fromList(pngBytes()),
          createdAt: DateTime(2026)));
      expect(await repo.pendingCount(), 3, reason: 'walk + stop + entry; the photo is not a sync item');

      await service().syncNow();
      final sent = transport.pushes.single.rows;
      expect(sent.keys, unorderedEquals(['walk', 'stop', 'entry']));
      final values = sent.values.expand((rows) => rows).expand((r) => r.values);
      expect(values.whereType<List<int>>(), isEmpty, reason: 'no bytes of any kind');
      expect(sent['entry']!.single.containsKey('photo_path'), isFalse);
      expect(await repo.pendingCount(), 0);
    });

    test('taking or replacing a photo re-uploads only the has_photo flag, never the image', () async {
      await seed();
      await repo.insertEntry(Entry(id: 'e1', stopId: 'w-0', recordedAt: DateTime(2026)));
      await repo.insertEntry(Entry(id: 'e2', stopId: 'w-1', recordedAt: DateTime(2026)));
      await service().syncNow();
      expect(await repo.pendingCount(), 0);

      Future<Map<String, Object?>> flags() async {
        final rows = (await repo.pendingChanges()).rows['entry']!;
        return {for (final r in rows) r['id'] as String: r['has_photo']};
      }

      await repo.putWalkPhoto(WalkPhoto(
          walkId: 'w',
          entryId: 'e1',
          mime: 'image/jpeg',
          bytes: Uint8List.fromList([0xFF, 0xD8, 0xFF]),
          createdAt: DateTime(2026)));
      expect(await flags(), {'e1': 1});
      await service().syncNow();

      // Replace at another entry: both entries change, the flag moves.
      await repo.putWalkPhoto(WalkPhoto(
          walkId: 'w',
          entryId: 'e2',
          mime: 'image/jpeg',
          bytes: Uint8List.fromList([0xFF, 0xD8, 0xFF]),
          createdAt: DateTime(2026)));
      expect(await flags(), {'e1': 0, 'e2': 1});
      await service().syncNow();
      final sent = transport.pushes.last.rows['entry']!;
      expect(sent.expand((r) => r.values).whereType<List<int>>(), isEmpty, reason: 'no image bytes');
      expect(sent.every((r) => !r.containsKey('photo_path')), isTrue);
    });
  });

  group('HTTP transport', () {
    test('posts JSON with the API key to /v1/sync', () async {
      late http.Request seen;
      final t = HttpSyncTransport(
        baseUrl: 'https://sync.example.com/',
        apiKey: 'k' * 20,
        client: MockClient((req) async {
          seen = req;
          return http.Response('{"ok":true}', 200);
        }),
      );
      await t.push(
          device,
          const SyncBatch({
            'walk': [
              {'id': 'w'}
            ],
            'stop': [],
            'entry': []
          }));
      expect(seen.url.toString(), 'https://sync.example.com/v1/sync');
      expect(seen.headers['x-api-key'], 'k' * 20);
      final body = jsonDecode(seen.body) as Map;
      expect(body['deviceId'], device);
      expect(body['walks'], [
        {'id': 'w'}
      ]);
      expect(body['entries'], isEmpty);
    });

    test('reads the server’s count of rows owned by another install', () async {
      final t = HttpSyncTransport(
        baseUrl: 'https://x.test',
        apiKey: 'k',
        client: MockClient((_) async => http.Response(
            '{"ok":true,"counts":{"walks":{"written":1,"skipped":0,"foreign":2},"entries":{"written":0,"skipped":0,"foreign":1}}}',
            200)),
      );
      expect(await t.push(device, const SyncBatch({})), 3);
    });

    test('maps HTTP errors and network failures to SyncException', () async {
      HttpSyncTransport with_(Future<http.Response> Function(http.Request) f) =>
          HttpSyncTransport(baseUrl: 'https://x.test', apiKey: 'k', client: MockClient(f));
      const b = SyncBatch({});
      await expectLater(with_((_) async => http.Response('{"error":"invalid api key"}', 401)).push(device, b),
          throwsA(isA<SyncException>().having((e) => e.isPermanent, 'permanent', isTrue)));
      await expectLater(with_((_) async => http.Response('', 503)).push(device, b),
          throwsA(isA<SyncException>().having((e) => e.status, 'status', 503)));
      await expectLater(with_((_) async => throw const SocketException('no route')).push(device, b),
          throwsA(isA<SyncException>().having((e) => e.status, 'status', isNull)));
    });

    test('times out instead of hanging when the network stalls', () async {
      final t = HttpSyncTransport(
        baseUrl: 'https://x.test',
        apiKey: 'k',
        timeout: const Duration(milliseconds: 50),
        client: MockClient((_) => Completer<http.Response>().future),
      );
      await expectLater(t.push(device, const SyncBatch({})), throwsA(isA<SyncException>()));
    });
  });

  group('image sniffing: static JPEG/PNG only (mirrors server/src/photo.js)', () {
    const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    List<int> chunk(String type, [int len = 0]) => [
          (len >> 24) & 0xFF,
          (len >> 16) & 0xFF,
          (len >> 8) & 0xFF,
          len & 0xFF,
          ...type.codeUnits,
          ...List.filled(len + 4, 0)
        ];
    Uint8List bytes(List<int> b) => Uint8List.fromList(b);

    test('JPEG and static PNG accepted', () {
      expect(sniffImageType(bytes([0xFF, 0xD8, 0xFF, 0xE0])), 'image/jpeg');
      expect(sniffImageType(bytes([...sig, ...chunk('IHDR', 13), ...chunk('IDAT', 4), ...chunk('IEND')])), 'image/png');
    });

    test('animated PNG (APNG) and malformed PNG refused', () {
      final apng = bytes([...sig, ...chunk('IHDR', 13), ...chunk('acTL', 8), ...chunk('IDAT', 4), ...chunk('IEND')]);
      expect(pngKind(apng), PngKind.animated);
      expect(sniffImageType(apng), isNull);
      expect(sniffImageType(bytes([...sig, ...chunk('IHDR', 13)])), isNull, reason: 'no image data');
      expect(sniffImageType(bytes(sig)), isNull, reason: 'signature only');
    });

    test('GIF, WebP and every video container refused', () {
      final cases = {
        'gif': 'GIF89a'.codeUnits,
        'webp': [...'RIFF'.codeUnits, 1, 2, 3, 4, ...'WEBPVP8 '.codeUnits],
        'mp4': [0, 0, 0, 0x18, ...'ftypmp42'.codeUnits],
        'mov': [0, 0, 0, 0x14, ...'ftypqt  '.codeUnits],
        'webm': [0x1A, 0x45, 0xDF, 0xA3],
        'avi': [...'RIFF'.codeUnits, 1, 2, 3, 4, ...'AVI '.codeUnits],
        'empty': <int>[],
      };
      cases.forEach((name, b) => expect(sniffImageType(bytes(b)), isNull, reason: name));
    });
  });

  group('config', () {
    test('sync URL validation', () {
      expect(SyncConfig.normalizeSyncUrl(''), '');
      expect(SyncConfig.normalizeSyncUrl(' https://a.b/ '), 'https://a.b');
      expect(SyncConfig.normalizeSyncUrl('http://10.0.2.2:8080'), 'http://10.0.2.2:8080');
      expect(SyncConfig.normalizeSyncUrl('http://evil.example.com'), isNull, reason: 'no plain http to the internet');
      expect(SyncConfig.normalizeSyncUrl('ftp://a.b'), isNull);
      expect(SyncConfig.normalizeSyncUrl('not a url'), isNull);
    });

    test('AppDatabase starts sync only when configured, and closes cleanly', () async {
      final off = await AppDatabase.open(repo: repo);
      expect(off.sync, isNull);
      final on = await AppDatabase.open(repo: repo, transport: transport);
      expect(on.sync, isNotNull);
      expect(on.sync!.deviceId, await repo.deviceId(), reason: 'uploads under the id stored in the database');
      await on.sync!.close();
      expect(transport.closed, isFalse, reason: 'a transport supplied from outside is not closed');
    });

    test('device id lives in the database: stable across reopen, survives losing the old file', () async {
      final a = await repo.deviceId();
      expect(a, matches(RegExp(r'^[0-9a-f]{32}$')));
      expect(await repo.deviceId(), a);
      await repo.close();
      repo = await SqfliteWalkRepository.open(factory: databaseFactoryFfi, path: '${tmp.path}/db.sqlite');
      expect(await repo.deviceId(legacyId: () async => 'f' * 32), a, reason: 'stored id wins over any legacy file');
    });

    test('upgrading adopts the legacy device_id file once, so cloud rows stay writable', () async {
      final legacy = File('${tmp.path}/device_id')..writeAsStringSync('ab' * 16);
      expect(await repo.deviceId(legacyId: () => DeviceId.readLegacy(file: legacy)), 'ab' * 16);
      legacy.deleteSync(); // e.g. app support dir cleared later
      expect(await repo.deviceId(legacyId: () => DeviceId.readLegacy(file: legacy)), 'ab' * 16);
    });

    test('a corrupt or missing legacy file is ignored, never adopted', () async {
      final legacy = File('${tmp.path}/device_id')..writeAsStringSync('garbage');
      expect(await DeviceId.readLegacy(file: legacy), isNull);
      expect(await DeviceId.readLegacy(file: File('${tmp.path}/nope')), isNull);
      final id = await repo.deviceId(legacyId: () => DeviceId.readLegacy(file: legacy));
      expect(id, isNot('garbage'));
      expect(id, matches(RegExp(r'^[0-9a-f]{32}$')));
    });
  });
}

class _StuckStore implements SyncableStore {
  @override
  Future<String> deviceId({Future<String?> Function()? legacyId}) async => device;

  @override
  Future<SyncBatch> pendingChanges({int limitPerTable = 200}) async => const SyncBatch({
        'walk': [
          {'id': 'x', 'updated_at': 1}
        ],
      });

  @override
  Future<void> markSynced(SyncBatch batch) async {}

  @override
  Future<int> pendingCount() async => 1;
}

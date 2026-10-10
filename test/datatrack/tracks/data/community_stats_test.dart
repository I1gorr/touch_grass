import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:touch_grass/datatrack/db/schema.dart';
import 'package:touch_grass/datatrack/interfaces/types.dart';
import 'package:touch_grass/datatrack/db/walk_repository.dart';
import 'package:touch_grass/datatrack/models/place_stats.dart';
import 'package:touch_grass/datatrack/models/walk.dart';
import 'package:touch_grass/datatrack/routing/route_recommender.dart';
import 'package:touch_grass/datatrack/tracks/data/offline_pack.dart';
import 'package:touch_grass/datatrack/tracks/data/offline_pack_store.dart';
import 'package:touch_grass/datatrack/tracks/data/overpass_client.dart';
import 'package:touch_grass/datatrack/tracks/data/pack_downloader.dart';
import 'package:touch_grass/datatrack/tracks/data/pack_refresher.dart';
import 'package:touch_grass/datatrack/tracks/data/place_stats_client.dart';
import 'package:touch_grass/datatrack/tracks/data/quest_preparer.dart';
import 'package:touch_grass/datatrack/tracks/data/route_service.dart';

import '../../routing/grid.dart';

final grid = Grid(21);
PlaceStats ps(String id, {int devices = 4, int notes = 6, int photos = 2}) =>
    PlaceStats(osmId: id, walks: devices, devices: devices, entries: notes + photos, notes: notes, photos: photos);

void main() {
  sqfliteFfiInit();
  late Directory tmp;
  late OfflinePackStore store;
  var statsCalls = 0;
  var serverUp = true;
  Uri? lastStatsUri;

  PlaceStatsClient statsClient() => PlaceStatsClient(
        baseUrl: Uri.parse('http://server.test'),
        client: MockClient((req) async {
          statsCalls++;
          lastStatsUri = req.url;
          if (!serverUp) throw const SocketException('down');
          return http.Response(jsonEncode({'places': [ps('node/3').toJson()]}), 200);
        }),
      );
  OverpassClient overpass() => OverpassClient(
        client: MockClient((req) async =>
            http.Response(req.body.contains('out+geom') ? grid.overpassWaysBody() : grid.overpassPoisBody(), 200)),
        endpoints: [Uri.parse('http://x/')],
      );
  PackDownloader downloader({DateTime? now}) => PackDownloader(
      overpass: overpass(), store: store, placeStats: statsClient(), clock: () => now ?? DateTime(2026, 3, 1));

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('tg_stats');
    store = OfflinePackStore(tmp);
    statsCalls = 0;
    serverUp = true;
    lastStatsUri = null;
  });
  tearDown(() => tmp.deleteSync(recursive: true));

  test('client asks for the chosen area and parses counts', () async {
    final list = await statsClient().fetch(grid.center, 1500);
    expect(list.single.osmId, 'node/3');
    expect(list.single.notes, 6);
    expect(lastStatsUri!.path, '/v1/places');
    expect(lastStatsUri!.queryParameters['radius'], '1500');
    await statsClient().fetch(grid.center, 99999);
    expect(lastStatsUri!.queryParameters['radius'], '5000');
  });

  test('download stores community data for the user-chosen area inside the pack', () async {
    final p = await downloader().download(grid.center, 1500, communityRadiusM: 800);
    expect(lastStatsUri!.queryParameters['radius'], '800');
    final back = (await store.load(p.id))!;
    expect(back.stats['node/3']!.notes, 6);
    expect(back.statsAt, DateTime(2026, 3, 1).millisecondsSinceEpoch);
    expect(back.communityRadiusM, 800);
  });

  test('community radius 0 means do not ask the server at all', () async {
    final p = await downloader().download(grid.center, 1500, communityRadiusM: 0);
    expect(statsCalls, 0);
    expect((await store.load(p.id))!.stats, isEmpty);
  });

  test('server down: the pack still downloads, and old community data is kept', () async {
    final first = await downloader().download(grid.center, 1500);
    serverUp = false;
    final again = await downloader(now: DateTime(2026, 4, 1)).download(grid.center, 1500);
    expect(again.stats.keys, ['node/3']);
    expect(again.statsAt, 0, reason: 'not refreshed');
    expect((await store.load(first.id))!.stats['node/3'], isNotNull);
  });

  test('packs from before community data existed still load (no stats)', () async {
    final p = await downloader().download(grid.center, 1500);
    File('${tmp.path}/packs/${p.id}/places.json').deleteSync();
    final m = jsonDecode(File('${tmp.path}/packs/${p.id}/manifest.json').readAsStringSync()) as Map<String, dynamic>
      ..remove('stats_at')
      ..remove('community_radius_m');
    File('${tmp.path}/packs/${p.id}/manifest.json').writeAsStringSync(jsonEncode(m));
    final back = (await store.load(p.id))!;
    expect(back.stats, isEmpty);
    expect(back.statsAt, 0);
  });

  test('refresher updates community data weekly without re-downloading the map', () async {
    final created = DateTime(2026, 3, 1);
    await downloader(now: created).download(grid.center, 1500);
    statsCalls = 0;
    var mapCalls = 0;
    final counting = PackDownloader(
      overpass: OverpassClient(
        client: MockClient((req) async {
          mapCalls++;
          return http.Response('{}', 200);
        }),
        endpoints: [Uri.parse('http://x/')],
      ),
      store: store,
      placeStats: statsClient(),
      clock: () => created.add(const Duration(days: 8)),
    );
    final refresher = PackRefresher(store: store, downloader: counting, clock: () => created.add(const Duration(days: 8)));
    expect(await refresher.refreshStale(), 1);
    expect(mapCalls, 0, reason: 'streets are only 8 days old');
    expect(statsCalls, 1);
    final info = (await store.list()).single;
    expect(info.statsAt, created.add(const Duration(days: 8)).millisecondsSinceEpoch);
    expect(info.createdAt, created.millisecondsSinceEpoch);
    expect((await store.load(info.id))!.ways, isNotEmpty);
    expect(await refresher.refreshStale(), 0, reason: 'fresh now');

    serverUp = false;
    final later = PackRefresher(
        store: store, downloader: counting, clock: () => created.add(const Duration(days: 20)));
    expect(await later.refreshStale(), 0, reason: 'failure keeps what we have');
    expect((await store.load(info.id))!.stats['node/3'], isNotNull);
  });

  test('placeHistory counts only finished walks, per place', () async {
    final db = await openAppDatabase(inMemoryDatabasePath, factory: databaseFactoryFfi);
    addTearDown(db.close);
    var t = 1000;
    final repo = WalkRepository(db, nowMs: () => t);
    Future<void> walk(WalkStatus end, int created) async {
      final q = await QuestPreparerForTest.make(created);
      await repo.saveQuest(q);
      if (end.index >= WalkStatus.active.index) await repo.setStatus(q.walk.id, WalkStatus.active);
      if (end == WalkStatus.done) await repo.setStatus(q.walk.id, WalkStatus.done);
    }

    await walk(WalkStatus.done, 5000);
    await walk(WalkStatus.done, 9000);
    await walk(WalkStatus.ready, 12000); // prepared, never walked
    final h = await repo.placeHistory();
    expect(h['node/1']!.visits, 2);
    expect(h['node/1']!.lastVisitedMs, 9000);
  });

  test('RouteService feeds pack community data, history and a daily seed into the plan', () async {
    final pack = OfflinePack(
      id: 'p',
      centerLat: grid.center.lat,
      centerLng: grid.center.lng,
      radiusM: 2500,
      createdAt: 1,
      pois: grid.pois(),
      ways: grid.ways(),
      stats: {'node/3': ps('node/3')},
      statsAt: 1,
    );
    await store.save(pack);
    PlanJob? seen;
    final service = RouteService(
      packs: store,
      placeHistory: () async => {'node/9': const PlaceHistory(2, 5)},
      planner: (job) async {
        seen = job;
        return planRoutes(job);
      },
      clock: () => DateTime.utc(2026, 1, 10, 9),
    );
    final routes = await service.recommend(RouteRequest(start: grid.center, minutes: 30));
    expect(routes, isNotEmpty);
    expect(seen!.stats.keys, ['node/3']);
    expect(seen!.history['node/9']!.visits, 2);
    expect(seen!.request.seed, DateTime.utc(2026, 1, 10).millisecondsSinceEpoch ~/ Duration.millisecondsPerDay);
    expect(seen!.nowMs, DateTime.utc(2026, 1, 10, 9).millisecondsSinceEpoch);

    await service.recommend(RouteRequest(start: grid.center, minutes: 30, seed: 42));
    expect(seen!.request.seed, 42, reason: 'an explicit seed wins');
  });
}

/// Builds a one-stop quest whose stop is `node/1` so history can be counted.
class QuestPreparerForTest {
  static Future<PreparedQuest> make(int createdAt) async {
    final id = '${createdAt.toRadixString(16).padLeft(8, '0')}${'0' * 24}';
    final walk = Walk(id: id, createdAt: createdAt, startLat: grid.center.lat, startLng: grid.center.lng, timeOfDay: 'morning');
    return PreparedQuest(walk, [
      Stop(id: '$id-0', walkId: id, position: 0, osmId: 'node/1', name: 'Spot', lat: grid.center.lat, lng: grid.center.lng, tagsJson: '{}'),
    ]);
  }
}

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:touch_grass/datatrack/db/schema.dart';
import 'package:touch_grass/datatrack/db/walk_repository.dart';
import 'package:touch_grass/datatrack/models/walk.dart';
import 'package:touch_grass/datatrack/models/walk_bundle.dart';
import 'package:touch_grass/datatrack/routing/route_recommender.dart';
import 'package:touch_grass/datatrack/tracks/data/offline_pack.dart';
import 'package:touch_grass/datatrack/tracks/data/offline_pack_store.dart';
import 'package:touch_grass/datatrack/tracks/data/overpass_client.dart';
import 'package:touch_grass/datatrack/tracks/data/pack_downloader.dart';
import 'package:touch_grass/datatrack/tracks/data/render_json.dart';
import 'package:touch_grass/datatrack/tracks/data/route_service.dart';
import 'package:touch_grass/datatrack/tracks/data/weather_client.dart';

import '../../routing/grid.dart';

final grid = Grid(21);

OfflinePack fullPack({int radius = 2500}) => OfflinePack(
      id: OfflinePack.idFor(grid.center, radius),
      centerLat: grid.center.lat,
      centerLng: grid.center.lng,
      radiusM: radius,
      createdAt: 1,
      pois: grid.pois(),
      ways: grid.ways(),
    );

void main() {
  sqfliteFfiInit();
  late Directory tmp;
  late OfflinePackStore store;
  var overpassCalls = 0;
  var weatherCalls = 0;

  OverpassClient overpass({bool fail = false}) => OverpassClient(
        client: MockClient((req) async {
          overpassCalls++;
          if (fail) throw const SocketException('offline');
          return http.Response(req.body.contains('out+geom') ? grid.overpassWaysBody() : grid.overpassPoisBody(), 200);
        }),
        endpoints: [Uri.parse('http://x/')],
      );

  RouteService service({bool online = true, bool withBundled = false, bool noDownloader = false}) => RouteService(
        packs: store,
        downloader: noDownloader ? null : PackDownloader(overpass: overpass(fail: !online), store: store),
        weather: WeatherService(client: MockClient((_) async {
          weatherCalls++;
          return http.Response('{"current":{"temperature_2m":12.2,"weather_code":0}}', 200);
        })),
        isOnline: () async => online,
        bundledPack: withBundled ? () async => fullPack(radius: 1500) : null,
        planner: (job) async => planRoutes(job),
        clock: () => DateTime(2026, 1, 1, 9),
      );

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('tg_route');
    store = OfflinePackStore(tmp);
    overpassCalls = 0;
    weatherCalls = 0;
  });
  tearDown(() => tmp.deleteSync(recursive: true));

  final req = RouteRequest(start: grid.center, minutes: 30);

  test('with a downloaded pack, recommending makes no network call at all', () async {
    await store.save(fullPack());
    final routes = await service(online: false, noDownloader: true).recommend(req);
    expect(routes, isNotEmpty);
    expect(overpassCalls, 0);
    expect(weatherCalls, 0);
    final q = routes.first.quest;
    expect(q.walk.id, hasLength(32));
    expect(q.walk.weatherSummary, 'unknown');
    expect(q.walk.timeOfDay, 'morning');
    expect(q.stops.map((s) => s.id), [for (var i = 0; i < q.stops.length; i++) '${q.walk.id}-$i']);
    expect(q.stops.every((s) => s.prompt.isNotEmpty && s.walkId == q.walk.id), isTrue);
    expect(routes.map((r) => r.quest.walk.id).toSet().length, routes.length);
  });

  test('no pack + online: downloads one for this walk, saves it, then works offline', () async {
    final first = await service().recommend(req);
    expect(first, isNotEmpty);
    expect(overpassCalls, 2); // pois + ways
    expect(first.first.quest.walk.weatherSummary, 'clear, 12°C');
    final info = (await store.list()).single;
    expect(info.radiusM, packRadiusFor(req.budgetM));

    overpassCalls = 0;
    final again = await service(online: false).recommend(req);
    expect(again.map((r) => r.option.picks.map((c) => c.osmId).toList()),
        first.map((r) => r.option.picks.map((c) => c.osmId).toList()));
    expect(overpassCalls, 0);
  });

  test('no pack + offline: bundled demo pack, else a clear error', () async {
    expect((await service(online: false, withBundled: true).recommend(req)), isNotEmpty);
    expect(weatherCalls, 0, reason: 'offline: do not wait on weather');
    await expectLater(service(online: false).recommend(req), throwsA(isA<NoPackException>()));
  });

  test('a pack that holds the start but is too small is used when offline', () async {
    await store.save(fullPack(radius: 900));
    final routes = await service(online: false).recommend(req);
    expect(routes, isNotEmpty);
    for (final r in routes) {
      expect(r.option.picks.any((c) => c.name == 'Far Statue H'), isFalse);
    }
  });

  test('end to end: recommend offline -> save -> render from SQLite', () async {
    await store.save(fullPack());
    final route = (await service(online: false).recommend(req)).first;

    final db = await openAppDatabase(inMemoryDatabasePath, factory: databaseFactoryFfi);
    addTearDown(db.close);
    final repo = WalkRepository(db);
    await repo.saveQuest(route.quest);

    final bundle = (await repo.loadWalk(route.quest.walk.id))!;
    expect(bundle.walk.routeJson, route.quest.walk.routeJson);
    final json = renderWalkJson(bundle);
    expect((json['walk'] as Map).containsKey('route_json'), isFalse);
    final path = json['path'] as Map;
    expect(path['mode'], 'street');
    expect((path['points'] as List).length, route.option.points.length);
    expect(path['total_m'], route.option.totalM);
    expect(path['duration_s'], route.option.durationS);
    expect((path['stop_point_index'] as List).length, route.quest.stops.length);
    final first = (path['points'] as List).first as Map;
    expect(first['lat'], closeTo(grid.center.lat, 1e-5));

    expect((await repo.getWalk(route.quest.walk.id))!.status, WalkStatus.ready);
  });

  test('render JSON falls back to straight lines for walks without or with a broken route', () async {
    await store.save(fullPack());
    final q = (await service(online: false).recommend(req)).first.quest;
    final plain = Walk(
        id: q.walk.id, createdAt: 1, startLat: q.walk.startLat, startLng: q.walk.startLng, timeOfDay: 'morning');
    final broken = Walk(
        id: q.walk.id, createdAt: 1, startLat: q.walk.startLat, startLng: q.walk.startLng, timeOfDay: 'morning', routeJson: '{nope');
    for (final w in [plain, broken]) {
      final json = renderWalkJson(WalkBundle(w, q.stops, const {}));
      expect((json['path'] as Map).containsKey('mode'), isFalse);
      expect(((json['path'] as Map)['points'] as List).length, q.stops.length + 1);
    }
  });
}

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:touch_grass/datatrack/interfaces/types.dart';
import 'package:touch_grass/datatrack/tracks/data/offline_pack.dart';
import 'package:touch_grass/datatrack/tracks/data/offline_pack_store.dart';
import 'package:touch_grass/datatrack/tracks/data/overpass_client.dart';
import 'package:touch_grass/datatrack/tracks/data/pack_downloader.dart';
import 'package:touch_grass/datatrack/tracks/data/pack_refresher.dart';

import '../../routing/grid.dart';

final grid = Grid(21);

OverpassClient overpass({bool fail = false, List<String>? log}) => OverpassClient(
      client: MockClient((req) async {
        log?.add(req.body.contains('out+geom') || req.body.contains('out%20geom') ? 'ways' : 'pois');
        if (fail) return http.Response('busy', 504);
        return http.Response(req.body.contains('out+geom') ? grid.overpassWaysBody() : grid.overpassPoisBody(), 200);
      }),
      endpoints: [Uri.parse('http://x/')],
    );

OfflinePack packAt(Location c, int radius, {int createdAt = 1000}) => OfflinePack(
      id: OfflinePack.idFor(c, radius),
      centerLat: c.lat,
      centerLng: c.lng,
      radiusM: radius,
      createdAt: createdAt,
      pois: grid.pois(),
      ways: grid.ways().take(10).toList(),
    );

void main() {
  late Directory tmp;
  late OfflinePackStore store;
  setUp(() {
    tmp = Directory.systemTemp.createTempSync('tg_packs');
    store = OfflinePackStore(tmp);
  });
  tearDown(() => tmp.deleteSync(recursive: true));

  test('radius and reach scale with the walk and are clamped', () {
    expect(packRadiusFor(500), 800);
    expect(packRadiusFor(2400), 1380);
    expect(packRadiusFor(50000), 4000);
    expect(reachFor(2400), closeTo(1320, 1));
  });

  test('store round-trips pois and ways (gzip) and lists metadata', () async {
    final p = packAt(grid.center, 1500);
    await store.save(p);
    final back = (await store.load(p.id))!;
    expect(back.pois.map((c) => c.osmId), p.pois.map((c) => c.osmId));
    expect(back.pois.first.tags, p.pois.first.tags);
    expect(back.ways.length, 10);
    expect(back.ways.first.coords, p.ways.first.coords);
    final info = (await store.list()).single;
    expect(info.radiusM, 1500);
    expect(File('${tmp.path}/packs/${p.id}/ways.json.gz').existsSync(), isTrue);
  });

  test('findCovering needs the whole reach inside; findContaining only the start', () async {
    await store.save(packAt(grid.center, 1500));
    expect(await store.findCovering(grid.center, 1000), isNotNull);
    expect(await store.findCovering(grid.center, 2000), isNull);
    final edge = Location(grid.center.lat + 0.012, grid.center.lng); // ~1.3 km north
    expect(await store.findCovering(edge, 500), isNull);
    expect(await store.findContaining(edge), isNotNull);
    expect(await store.findContaining(const Location(50, 8)), isNull);
  });

  test('a bigger pack evicts the smaller packs it contains', () async {
    await store.save(packAt(grid.center, 800));
    await store.save(packAt(grid.center, 2000));
    expect((await store.list()).map((i) => i.radiusM), [2000]);
  });

  test('incomplete or corrupt packs are ignored', () async {
    Directory('${tmp.path}/packs/broken').createSync(recursive: true);
    Directory('${tmp.path}/packs/.tmp-half').createSync(recursive: true);
    final p = packAt(grid.center, 1500);
    await store.save(p);
    File('${tmp.path}/packs/${p.id}/ways.json.gz').writeAsBytesSync([1, 2, 3]);
    expect((await store.list()).length, 1);
    expect(await store.load(p.id), isNull);
    expect(await store.findCovering(grid.center, 100), isNull);
  });

  test('downloader fetches pois and ways and saves a pack', () async {
    final log = <String>[];
    final d = PackDownloader(overpass: overpass(log: log), store: store, clock: () => DateTime(2026, 1, 1));
    final p = await d.download(grid.center, 1200);
    expect(log, ['pois', 'ways']);
    expect(p.pois.length, 8);
    expect(p.ways, isNotEmpty);
    expect(p.createdAt, DateTime(2026, 1, 1).millisecondsSinceEpoch);
    expect((await store.load(p.id))!.ways.length, p.ways.length);
  });

  test('a failed download writes nothing and keeps the existing pack', () async {
    final old = packAt(grid.center, 1200, createdAt: 5);
    await store.save(old);
    final d = PackDownloader(overpass: overpass(fail: true), store: store);
    await expectLater(d.download(grid.center, 1200), throwsException);
    final back = (await store.load(old.id))!;
    expect(back.createdAt, 5);
    expect(Directory('${tmp.path}/packs').listSync().whereType<Directory>().length, 1);
  });

  test('refresher updates only stale packs and survives failures', () async {
    final now = DateTime(2026, 3, 1);
    await store.save(packAt(grid.center, 1200, createdAt: DateTime(2026, 1, 1).millisecondsSinceEpoch)); // 59 days old
    final ok = PackRefresher(
        store: store, downloader: PackDownloader(overpass: overpass(), store: store, clock: () => now), clock: () => now);
    expect(await ok.refreshStale(), 1);
    expect((await store.list()).single.createdAt, now.millisecondsSinceEpoch);
    expect(await ok.refreshStale(), 0, reason: 'fresh pack is left alone');

    final later = now.add(const Duration(days: 40));
    final broken = PackRefresher(
        store: store, downloader: PackDownloader(overpass: overpass(fail: true), store: store), clock: () => later);
    expect(await broken.refreshStale(), 0);
    expect((await store.list()).single.createdAt, now.millisecondsSinceEpoch, reason: 'old pack kept');
  });
}

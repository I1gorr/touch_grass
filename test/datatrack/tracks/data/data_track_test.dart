import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:touch_grass/datatrack/interfaces/types.dart';
import 'package:touch_grass/datatrack/tracks/data/cache_store.dart';
import 'package:touch_grass/datatrack/tracks/data/candidate.dart';
import 'package:touch_grass/datatrack/tracks/data/candidate_filter.dart';
import 'package:touch_grass/datatrack/tracks/data/candidate_scorer.dart';
import 'package:touch_grass/datatrack/tracks/data/demo_location.dart';
import 'package:touch_grass/datatrack/tracks/data/fake_quest_builder.dart';
import 'package:touch_grass/datatrack/tracks/data/overpass_client.dart';
import 'package:touch_grass/datatrack/tracks/data/quest_builder_impl.dart';
import 'package:touch_grass/datatrack/tracks/data/quest_preparer.dart';
import 'package:touch_grass/datatrack/tracks/data/route_orderer.dart';
import 'package:touch_grass/datatrack/tracks/data/weather_client.dart';

final fixture = File('scripts/fixtures/overpass_demo.json').readAsStringSync();
final liveFixture = File('scripts/fixtures/overpass_live_central_park.json').readAsStringSync();

OverpassClient okClient() => OverpassClient(
      client: MockClient((_) async => http.Response(fixture, 200)),
      endpoints: [Uri.parse('http://x/')],
    );

OverpassClient failingClient() => OverpassClient(
      client: MockClient((_) async => http.Response('busy', 504)),
      endpoints: [Uri.parse('http://x/')],
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory tmp;
  setUp(() => tmp = Directory.systemTemp.createTempSync('tg_cache'));
  tearDown(() => tmp.deleteSync(recursive: true));

  test('fake builder returns 3-4 stops', () async {
    final s = await const FakeQuestBuilder().build(kDemoLocation);
    expect(s.length, inInclusiveRange(3, 4));
  });

  test('parse + filter drops wiki, nameless and duplicates; leaves >= 6', () {
    final all = parseOverpass(fixture);
    expect(all.length, 12);
    final f = filterCandidates(all);
    expect(f.any((c) => c.tags.containsKey('wikidata') || c.tags.containsKey('wikipedia')), isFalse);
    expect(f.any((c) => c.name.isEmpty), isFalse);
    expect(f.where((c) => c.name == 'Quiet Fountain').length, 1);
    expect(f.length, greaterThanOrEqualTo(6));
  });

  test('scoring is deterministic and variety rule holds', () {
    final f = filterCandidates(parseOverpass(fixture));
    final a = pickVaried(scoreCandidates(f, kDemoLocation));
    final b = pickVaried(scoreCandidates(f.reversed.toList(), kDemoLocation));
    expect(a.map((c) => c.osmId), b.map((c) => c.osmId));
    final counts = <String, int>{};
    for (final c in a) {
      counts[c.category] = (counts[c.category] ?? 0) + 1;
    }
    expect(counts.values.every((n) => n <= 2), isTrue);
  });

  test('nearest-neighbour: first stop is closest to start', () {
    final f = filterCandidates(parseOverpass(fixture));
    final o = orderNearestNeighbour(kDemoLocation, f);
    final d = f.map((c) => distanceMeters(kDemoLocation.lat, kDemoLocation.lng, c.lat, c.lng)).reduce((a, b) => a < b ? a : b);
    expect(distanceMeters(kDemoLocation.lat, kDemoLocation.lng, o.first.lat, o.first.lng), closeTo(d, 0.001));
    expect(o.length, f.length);
  });

  test('cache store round-trips', () async {
    final c = CacheStore(tmp);
    expect(await c.read('k'), isNull);
    await c.write('k', 'hello');
    expect(await c.read('k'), 'hello');
  });

  test('RealQuestBuilder: network -> 3-4 stops, writes cache; then cache offline', () async {
    final cache = CacheStore(tmp);
    final b = RealQuestBuilder(overpass: okClient(), cache: cache, loadFallback: () async => fixture);
    final stops = await b.build(kDemoLocation);
    expect(stops.length, inInclusiveRange(3, 4));
    expect(stops.every((s) => s.prompt.isNotEmpty && s.name.isNotEmpty), isTrue);
    expect(jsonDecode(stops.first.tagsJson), isA<Map>());
    expect(b.lastSource, 'network');
    final key = CacheStore.areaKey(kDemoLocation, 1200);
    expect(File('${tmp.path}/overpass/$key.json').existsSync(), isTrue);

    final offline = RealQuestBuilder(overpass: failingClient(), cache: cache, loadFallback: () async => fixture);
    final again = await offline.build(kDemoLocation);
    expect(offline.lastSource, 'cache');
    expect(again.map((s) => s.osmId), stops.map((s) => s.osmId));
  });

  test('RealQuestBuilder: no network, no cache -> fallback', () async {
    final b = RealQuestBuilder(overpass: failingClient(), cache: CacheStore(tmp), loadFallback: () async => fixture);
    final stops = await b.build(kDemoLocation);
    expect(b.lastSource, 'fallback');
    expect(stops.length, inInclusiveRange(3, 4));
  });

  test('weather summary and failure fallback', () async {
    final ok = WeatherService(
        client: MockClient((_) async => http.Response('{"current":{"temperature_2m":17.6,"weather_code":0}}', 200)));
    expect(await ok.snapshot(kDemoLocation), 'clear, 18°C');
    final bad = WeatherService(client: MockClient((_) async => http.Response('x', 500)));
    expect(await bad.snapshot(kDemoLocation), 'unknown');
  });

  test('overpass query contains coords and radius', () {
    final q = OverpassClient.buildQuery(const Location(1.5, 2.5), radius: 900);
    expect(q, contains('around:900,1.5,2.5'));
  });

  Candidate cand(String id, String name, Map<String, String> tags, [double lat = 40.78, double lng = -73.96]) =>
      Candidate(osmId: id, name: name, lat: lat, lng: lng, tags: tags);

  test('variety cap is relaxed so we still get 3 stops from one category', () {
    final cs = [for (var i = 0; i < 5; i++) cand('node/$i', 'Park $i', {'leisure': 'park'}, 40.78 + i * 0.001)];
    final picks = pickVaried(scoreCandidates(cs, kDemoLocation));
    expect(picks.length, 3);
  });

  test('wiki variants are filtered, incl. name:wikipedia-style keys', () {
    final f = filterCandidates([
      cand('node/1', 'A', {'historic': 'x', 'brand:wikidata': 'Q1'}),
      cand('node/2', 'B', {'historic': 'x', 'subject:wikipedia': 'en:B'}),
      cand('node/3', 'C', {'historic': 'x'}),
    ]);
    expect(f.map((c) => c.name), ['C']);
  });

  test('way elements use center coordinates; elements without coords are skipped', () {
    final cs = parseOverpass(jsonEncode({
      'elements': [
        {'type': 'way', 'id': 9, 'center': {'lat': 1.0, 'lon': 2.0}, 'tags': {'name': 'W'}},
        {'type': 'way', 'id': 10, 'tags': {'name': 'NoCoords'}},
      ]
    }));
    expect(cs.length, 1);
    expect(cs.single.lat, 1.0);
    expect(cs.single.osmId, 'way/9');
  });

  test('corrupt cache is ignored and refetched', () async {
    final cache = CacheStore(tmp);
    await cache.write(CacheStore.areaKey(kDemoLocation, 1200), 'not json');
    final b = RealQuestBuilder(overpass: okClient(), cache: cache, loadFallback: () async => fixture);
    final stops = await b.build(kDemoLocation);
    expect(b.lastSource, 'network');
    expect(stops.length, inInclusiveRange(3, 4));
  });

  test('sparse area widens the radius once', () async {
    final radii = <String>[];
    final sparse = jsonEncode({
      'elements': [
        {'type': 'node', 'id': 1, 'lat': 40.78, 'lon': -73.96, 'tags': {'name': 'Only One', 'tourism': 'artwork'}}
      ]
    });
    final client = OverpassClient(
      client: MockClient((req) async {
        final wide = req.body.contains('around%3A2500');
        radii.add(wide ? 'wide' : 'narrow');
        return http.Response(wide ? fixture : sparse, 200);
      }),
      endpoints: [Uri.parse('http://x/')],
    );
    final b = RealQuestBuilder(overpass: client, cache: CacheStore(tmp), loadFallback: () async => fixture);
    final stops = await b.build(kDemoLocation);
    expect(radii, ['narrow', 'wide']);
    expect(b.lastCandidateCount, greaterThanOrEqualTo(6));
    expect(stops.length, inInclusiveRange(3, 4));
  });

  test('area too sparse even after widening tops up from fallback', () async {
    final sparse = jsonEncode({'elements': []});
    final client = OverpassClient(
      client: MockClient((_) async => http.Response(sparse, 200)),
      endpoints: [Uri.parse('http://x/')],
    );
    final b = RealQuestBuilder(overpass: client, cache: CacheStore(tmp), loadFallback: () async => fixture);
    final stops = await b.build(kDemoLocation);
    expect(stops.length, inInclusiveRange(3, 4));
    expect(b.lastSource, 'fallback');
  });

  test('stops are in walking order and ids are unique', () async {
    final b = RealQuestBuilder(overpass: okClient(), cache: CacheStore(tmp), loadFallback: () async => fixture);
    final stops = await b.build(kDemoLocation);
    expect(stops.map((s) => s.id).toSet().length, stops.length);
    final dists = [for (final s in stops) distanceMeters(kDemoLocation.lat, kDemoLocation.lng, s.lat, s.lng)];
    expect(dists.first, dists.reduce((a, b) => a < b ? a : b));
  });

  test('timeOfDayFor buckets', () {
    expect(timeOfDayFor(DateTime(2026, 1, 1, 7)), 'morning');
    expect(timeOfDayFor(DateTime(2026, 1, 1, 13)), 'afternoon');
    expect(timeOfDayFor(DateTime(2026, 1, 1, 19)), 'evening');
    expect(timeOfDayFor(DateTime(2026, 1, 1, 2)), 'night');
  });

  test('QuestPreparer combines stops, weather and time of day', () async {
    final weather = WeatherService(
        client: MockClient((_) async => http.Response('{"current":{"temperature_2m":10.2,"weather_code":61}}', 200)));
    final p = QuestPreparer(
        builder: const FakeQuestBuilder(), weather: weather, clock: () => DateTime(2026, 1, 1, 8));
    final q = await p.prepare(kDemoLocation);
    expect(q.stops.length, 3);
    expect(q.weatherSummary, 'rainy, 10°C');
    expect(q.timeOfDay, 'morning');
  });

  test('weather codes map to words', () {
    expect(WeatherService.describeCode(45), 'foggy');
    expect(WeatherService.describeCode(73), 'snowy');
    expect(WeatherService.describeCode(95), 'stormy');
  });

  test('real Overpass recording: parses, filters, yields >= 6 and a 3-4 stop quest', () async {
    final all = parseOverpass(liveFixture);
    final f = filterCandidates(all);
    expect(all, isNotEmpty);
    expect(f.length, greaterThanOrEqualTo(6));
    expect(f.every((c) => c.tags.keys.every((k) => !(k.contains('wikidata') || k.contains('wikipedia')))), isTrue);
    final b = RealQuestBuilder(
      overpass: OverpassClient(
        client: MockClient((_) async => http.Response(liveFixture, 200)),
        endpoints: [Uri.parse('http://x/')],
      ),
      cache: CacheStore(tmp),
      loadFallback: () async => liveFixture,
    );
    final stops = await b.build(kDemoLocation);
    expect(stops.length, inInclusiveRange(3, 4));
    for (final s in stops) {
      expect(distanceMeters(kDemoLocation.lat, kDemoLocation.lng, s.lat, s.lng), lessThan(1500));
    }
  });

  test('bundled fallback asset is valid and usable', () {
    final f = filterCandidates(parseOverpass(File('assets/fallback/demo_overpass.json').readAsStringSync()));
    expect(f.length, greaterThanOrEqualTo(6));
  });

  test('default fallback loader reads the asset via rootBundle (offline, no cache)', () async {
    final b = RealQuestBuilder(overpass: failingClient(), cache: CacheStore(tmp));
    final stops = await b.build(kDemoLocation);
    expect(b.lastSource, 'fallback');
    expect(stops.length, inInclusiveRange(3, 4));
  });
}

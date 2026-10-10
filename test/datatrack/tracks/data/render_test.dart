import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:touch_grass/datatrack/models/entry.dart';
import 'package:touch_grass/datatrack/models/walk_bundle.dart';
import 'package:touch_grass/datatrack/tracks/data/demo_location.dart';
import 'package:touch_grass/datatrack/tracks/data/fake_quest_builder.dart';
import 'package:touch_grass/datatrack/tracks/data/quest_preparer.dart';
import 'package:touch_grass/datatrack/tracks/data/render_json.dart';
import 'package:touch_grass/datatrack/tracks/data/route_path.dart';
import 'package:touch_grass/datatrack/tracks/data/weather_client.dart';

QuestPreparer preparer() => QuestPreparer(
      builder: const FakeQuestBuilder(),
      weather: WeatherService(
          client: MockClient((_) async => http.Response('{"current":{"temperature_2m":10.2,"weather_code":61}}', 200))),
      clock: () => DateTime(2026, 1, 1, 8),
      idGenerator: () => 'a' * 32,
    );

void main() {
  test('prepare builds a ready walk and renumbers stops as <walkId>-<position>', () async {
    final q = await preparer().prepare(kDemoLocation);
    expect(q.walk.id, 'a' * 32);
    expect(q.walk.status.name, 'ready');
    expect(q.walk.startLat, kDemoLocation.lat);
    expect(q.walk.createdAt, DateTime(2026, 1, 1, 8).millisecondsSinceEpoch);
    expect(q.stops.map((s) => s.id), ['${'a' * 32}-0', '${'a' * 32}-1', '${'a' * 32}-2']);
    expect(q.stops.map((s) => s.position), [0, 1, 2]);
    expect(q.stops.every((s) => s.walkId == q.walk.id), isTrue);
  });

  test('route path: start then stops, legs sum to total', () async {
    final q = await preparer().prepare(kDemoLocation);
    final p = buildRoutePath(q.walk.startLat, q.walk.startLng, q.stops);
    expect(p.points.length, q.stops.length + 1);
    expect(p.legsM.length, q.stops.length);
    expect(p.totalM, p.legsM.reduce((a, b) => a + b));
    expect(p.points.first.lat, kDemoLocation.lat);
    expect(p.points.last.lat, q.stops.last.lat);
  });

  test('render JSON uses schema field names and includes tags, entries and path', () async {
    final q = await preparer().prepare(kDemoLocation);
    final entry = Entry(id: 'e' * 32, stopId: q.stops.first.id, recordedAt: 5, rawTranscript: '');
    final bundle = WalkBundle(q.walk, q.stops, {q.stops.first.id: [entry]});
    final j = jsonDecode(renderWalkJsonString(bundle)) as Map<String, dynamic>;
    expect(j.keys, ['walk', 'stops', 'path']);
    expect((j['walk'] as Map).keys, containsAll(['id', 'created_at', 'start_lat', 'start_lng', 'time_of_day', 'weather_summary', 'status']));
    final stops = j['stops'] as List;
    expect(stops.length, 3);
    expect((stops.first as Map)['tags'], {'amenity': 'fountain'});
    expect((stops.first as Map)['entries'].single['raw_transcript'], '');
    expect((stops.first as Map)['entries'].single['cleaned_text'], isNull);
    expect(stops.map((s) => (s as Map)['position']), [0, 1, 2]);
    expect(j['path']['points'].length, 4);
    expect(j.toString().contains('updated_at'), isFalse);
  });
}

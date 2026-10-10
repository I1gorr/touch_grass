// ignore_for_file: avoid_print
// Live smoke test for the data track (hits real Overpass + Open-Meteo).
// Usage: dart run scripts/smoke_data.dart [lat] [lng]
import 'dart:io';

import 'package:touch_grass/datatrack/models/entry.dart';
import 'package:touch_grass/datatrack/models/ids.dart';
import 'package:touch_grass/datatrack/models/walk.dart';
import 'package:touch_grass/datatrack/models/walk_bundle.dart';
import 'package:touch_grass/datatrack/tracks/data/quest_preparer.dart';
import 'package:touch_grass/datatrack/tracks/data/render_json.dart';

import 'package:touch_grass/datatrack/interfaces/types.dart';
import 'package:touch_grass/datatrack/tracks/data/candidate.dart';
import 'package:touch_grass/datatrack/tracks/data/candidate_filter.dart';
import 'package:touch_grass/datatrack/tracks/data/candidate_scorer.dart';
import 'package:touch_grass/datatrack/tracks/data/demo_location.dart';
import 'package:touch_grass/datatrack/tracks/data/overpass_client.dart';
import 'package:touch_grass/datatrack/tracks/data/prompts.dart';
import 'package:touch_grass/datatrack/tracks/data/route_orderer.dart';
import 'package:touch_grass/datatrack/tracks/data/weather_client.dart';

Future<void> main(List<String> args) async {
  final loc = args.length >= 2
      ? Location(double.parse(args[0]), double.parse(args[1]))
      : kDemoLocation;
  print('Location: ${loc.lat}, ${loc.lng}');

  final weather = await WeatherService().snapshot(loc);
  print('Weather: $weather');

  try {
    final body = await OverpassClient().fetchRaw(loc);
    final all = parseOverpass(body);
    final filtered = filterCandidates(all);
    print('Overpass: ${all.length} raw, ${filtered.length} after filtering '
        '(Gate 1 needs >= 6): ${filtered.length >= 6 ? "PASS" : "FAIL"}');
    final picks = orderNearestNeighbour(loc, pickVaried(scoreCandidates(filtered, loc)));
    for (final c in picks) {
      final d = distanceMeters(loc.lat, loc.lng, c.lat, c.lng).round();
      print('  - ${c.name} [${c.category}] ${d}m  "${promptForCandidate(c)}"');
    }

    // Same shape the app renders offline from SQLite.
    final now = DateTime.now();
    final walk = Walk(
      id: newId(),
      createdAt: now.millisecondsSinceEpoch,
      startLat: loc.lat,
      startLng: loc.lng,
      timeOfDay: timeOfDayFor(now),
      weatherSummary: weather,
    );
    final stops = [
      for (final (i, c) in picks.indexed)
        c.toStop(stopIdFor(walk.id, i), prompt: promptForCandidate(c)).copyWith(walkId: walk.id, position: i),
    ];
    print('Render JSON:');
    print(renderWalkJsonString(WalkBundle(walk, stops, <String, List<Entry>>{}), pretty: true));
  } catch (e) {
    print('Overpass unavailable ($e) -> app would use the cache/fallback dataset.');
    exitCode = 2;
  }
}

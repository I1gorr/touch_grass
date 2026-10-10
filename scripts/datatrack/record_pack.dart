// ignore_for_file: avoid_print
// Records the walking network for the demo area into assets/fallback/demo_ways.json
// (the bundled offline pack). Needs internet.
// Usage: dart run scripts/record_pack.dart [lat lng radius]
import 'dart:convert';
import 'dart:io';

import 'package:touch_grass/datatrack/interfaces/types.dart';
import 'package:touch_grass/datatrack/routing/walk_way.dart';
import 'package:touch_grass/datatrack/tracks/data/demo_location.dart';
import 'package:touch_grass/datatrack/tracks/data/overpass_client.dart';

Future<void> main(List<String> args) async {
  final loc = args.length >= 2 ? Location(double.parse(args[0]), double.parse(args[1])) : kDemoLocation;
  final radius = args.length >= 3 ? int.parse(args[2]) : 1500;
  print('Fetching walkable ways within ${radius}m of ${loc.lat}, ${loc.lng} ...');
  final body = await OverpassClient().fetchQuery(
    OverpassClient.buildWaysQuery(loc, radius: radius),
    timeout: const Duration(seconds: 90),
  );
  final ways = parseWays(body);
  final out = File('assets/fallback/demo_ways.json');
  await out.writeAsString(jsonEncode([for (final w in ways) w.toJson()]));
  print('Wrote ${ways.length} ways (${(await out.length()) ~/ 1024} KiB) to ${out.path}');
}

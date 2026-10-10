// ignore_for_file: avoid_print
// Live check of offline route recommendation.
//   dart run scripts/smoke_route.dart [lat lng minutes]            # downloads a pack if none is saved
//   dart run scripts/smoke_route.dart [lat lng minutes] --offline  # uses the saved pack, makes no HTTP at all
import 'dart:io';

import 'package:touch_grass/datatrack/interfaces/types.dart';
import 'package:touch_grass/datatrack/routing/route_recommender.dart';
import 'package:touch_grass/datatrack/tracks/data/demo_location.dart';
import 'package:touch_grass/datatrack/tracks/data/offline_pack.dart';
import 'package:touch_grass/datatrack/tracks/data/offline_pack_store.dart';
import 'package:touch_grass/datatrack/tracks/data/overpass_client.dart';
import 'package:touch_grass/datatrack/tracks/data/pack_downloader.dart';

Future<void> main(List<String> argv) async {
  final offline = argv.contains('--offline');
  final args = argv.where((a) => !a.startsWith('--')).toList();
  final loc = args.length >= 2 ? Location(double.parse(args[0]), double.parse(args[1])) : kDemoLocation;
  final minutes = args.length >= 3 ? int.parse(args[2]) : 30;
  final request = RouteRequest(start: loc, minutes: minutes);
  final store = OfflinePackStore(Directory('.dart_tool/smoke_cache'));

  var pack = await store.findCovering(loc, reachFor(request.budgetM));
  if (pack == null && !offline) {
    final radius = packRadiusFor(request.budgetM);
    print('No saved pack: downloading ${radius}m around ${loc.lat}, ${loc.lng} ...');
    pack = await PackDownloader(overpass: OverpassClient(), store: store, waysTimeout: const Duration(seconds: 90))
        .download(loc, radius);
  }
  pack ??= await store.findContaining(loc);
  if (pack == null) {
    print('OFFLINE and no saved pack covers this location. Run once without --offline.');
    exitCode = 2;
    return;
  }
  print('Pack ${pack.id}: ${pack.pois.length} places, ${pack.ways.length} ways (${offline ? "offline, no HTTP" : "online"})');

  final sw = Stopwatch()..start();
  final options = planRoutes(PlanJob(pack.pois, pack.ways, request));
  print('Planned ${options.length} routes for ~$minutes min (${request.budgetM.round()} m) in ${sw.elapsedMilliseconds} ms');
  for (final (i, o) in options.indexed) {
    print('${i + 1}. ${o.mode}: ${(o.totalM / 1000).toStringAsFixed(2)} km, ${(o.durationS / 60).round()} min, '
        '${o.points.length} points, route_json ${o.toRouteJson(request).length} chars');
    print('   ${o.picks.map((c) => c.name).join(' > ')}');
  }
  if (options.isEmpty) exitCode = 3;
}

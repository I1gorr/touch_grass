import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:touch_grass/datatrack/routing/polyline.dart';
import 'package:touch_grass/datatrack/routing/route_recommender.dart';
import 'package:touch_grass/datatrack/routing/walk_graph.dart';
import 'package:touch_grass/datatrack/routing/walk_way.dart';
import 'package:touch_grass/datatrack/tracks/data/candidate.dart';
import 'package:touch_grass/datatrack/tracks/data/demo_location.dart';

// Real OpenStreetMap data recorded around the demo location (assets/fallback).
final ways = [
  for (final j in jsonDecode(File('assets/fallback/demo_ways.json').readAsStringSync()) as List)
    WalkWay.fromJson(j as Map<String, dynamic>),
];
final pois = parseOverpass(File('assets/fallback/demo_overpass.json').readAsStringSync());

void main() {
  test('graph builds quickly from a real pack and the start is on it', () {
    final sw = Stopwatch()..start();
    final g = WalkGraph.fromWays(ways);
    expect(sw.elapsed.inSeconds, lessThan(3));
    expect(g.nodeCount, greaterThan(5000));
    expect(g.nearestNode(kDemoLocation.lat, kDemoLocation.lng), isNotNull);
  });

  test('30 min loop on real streets: right length, back at the start, stored JSON small', () {
    final g = WalkGraph.fromWays(ways);
    final r = RouteRequest(start: kDemoLocation, minutes: 30);
    final sw = Stopwatch()..start();
    final opts = recommendRoutes(pois: pois, request: r, graph: g);
    expect(sw.elapsed.inSeconds, lessThan(3));
    expect(opts, isNotEmpty);
    for (final o in opts) {
      expect(o.mode, 'street');
      expect(o.totalM, inInclusiveRange(0.7 * r.budgetM, 1.1 * r.budgetM));
      expect(o.picks.length, inInclusiveRange(3, 4));
      expect(o.durationS ~/ 60, inInclusiveRange(20, 34));
      expect(o.points.first, (lat: kDemoLocation.lat, lng: kDemoLocation.lng));
      expect(o.points.last, (lat: kDemoLocation.lat, lng: kDemoLocation.lng));
      for (final p in o.points) {
        expect(distanceMeters(kDemoLocation.lat, kDemoLocation.lng, p.lat, p.lng), lessThan(1800));
      }
      // Street routes have far more points than the straight start-stops-start line.
      expect(o.points.length, greaterThan(o.picks.length + 2));
      final json = o.toRouteJson(r);
      expect(json.length, lessThan(20000));
      expect(decodePolyline((jsonDecode(json) as Map)['polyline'] as String).length, o.points.length);
    }
  });

  test('a longer walk visits more stops but never exceeds 6', () {
    final g = WalkGraph.fromWays(ways);
    final short = recommendRoutes(pois: pois, request: RouteRequest(start: kDemoLocation, minutes: 20), graph: g);
    final long = recommendRoutes(pois: pois, request: RouteRequest(start: kDemoLocation, minutes: 75), graph: g);
    expect(long.first.picks.length, greaterThanOrEqualTo(short.first.picks.length));
    expect(long.first.picks.length, lessThanOrEqualTo(6));
    expect(long.first.totalM, greaterThan(short.first.totalM));
  });

  test('planRoutesInIsolate gives the same answer as running inline', () async {
    final job = PlanJob(pois, ways, RouteRequest(start: kDemoLocation, minutes: 30));
    final inline = planRoutes(job);
    final isolated = await planRoutesInIsolate(job);
    expect(isolated.map((o) => o.picks.map((c) => c.osmId).toList()), inline.map((o) => o.picks.map((c) => c.osmId).toList()));
    expect(isolated.first.totalM, inline.first.totalM);
  });
}

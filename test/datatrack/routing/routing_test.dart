import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:touch_grass/datatrack/interfaces/types.dart';
import 'package:touch_grass/datatrack/routing/latlng.dart';
import 'package:touch_grass/datatrack/routing/polyline.dart';
import 'package:touch_grass/datatrack/routing/route_recommender.dart';
import 'package:touch_grass/datatrack/routing/router.dart';
import 'package:touch_grass/datatrack/routing/walk_graph.dart';
import 'package:touch_grass/datatrack/routing/walk_way.dart';
import 'package:touch_grass/datatrack/tracks/data/candidate.dart';

import 'grid.dart';

void main() {
  final grid = Grid(21);
  late WalkGraph graph;
  setUp(() => graph = WalkGraph.fromWays(grid.ways()));

  group('polyline', () {
    test('round-trips to 1e-5 degrees', () {
      final pts = <LatLng>[(lat: 40.7829, lng: -73.9654), (lat: 40.78301, lng: -73.96612), (lat: -33.8688, lng: 151.2093)];
      final back = decodePolyline(encodePolyline(pts));
      for (var i = 0; i < pts.length; i++) {
        expect(back[i].lat, closeTo(pts[i].lat, 1e-5));
        expect(back[i].lng, closeTo(pts[i].lng, 1e-5));
      }
    });

    test('simplify drops collinear points but keeps required indices', () {
      final pts = [for (var i = 0; i < 20; i++) (lat: 40.0 + i * 0.0001, lng: -73.0)];
      expect(simplifyIndices(pts, 2), [0, 19]);
      expect(simplifyIndices(pts, 2, keep: {7}), [0, 7, 19]);
    });
  });

  group('graph + router', () {
    test('nearest node snaps within range, rejects far points', () {
      final s = graph.nearestNode(grid.latAt(10) + 0.0001, grid.lngAt(10))!;
      expect(s.distM, lessThan(15));
      expect(graph.nearestNode(41.0, -73.9654), isNull);
    });

    test('A* finds the Manhattan distance on a grid and matches Dijkstra', () {
      final a = graph.nearestNode(grid.latAt(2), grid.lngAt(2))!.node;
      final b = graph.nearestNode(grid.latAt(12), grid.lngAt(7))!.node;
      final p = astar(graph, a, b)!;
      expect(p.lengthM, closeTo(15 * 100, 15));
      final dj = dijkstra(graph, a);
      expect(dj.cost[b], closeTo(p.cost, 1e-6));
      expect(dj.len[b], closeTo(p.lengthM, 1e-6));
    });

    test('routes around a wall and prefers footpaths over a busy road of equal length', () {
      final wall = WalkGraph.fromWays(grid.ways(skip: (r1, c1, r2, c2) => c1 == 10 && c2 == 11 && r1 < 20));
      final a = wall.nearestNode(grid.latAt(10), grid.lngAt(8))!.node;
      final b = wall.nearestNode(grid.latAt(10), grid.lngAt(12))!.node;
      expect(astar(wall, a, b)!.lengthM, greaterThan(1500)); // must detour via row 20
      final busy = WalkGraph.fromWays(grid.ways(highway: 'primary'));
      final x = busy.nearestNode(grid.latAt(10), grid.lngAt(8))!.node;
      final y = busy.nearestNode(grid.latAt(10), grid.lngAt(12))!.node;
      expect(astar(busy, x, y)!.cost, closeTo(astar(busy, x, y)!.lengthM * 1.7, 1e-6));
    });

    test('islands are excluded by the reachability mask', () {
      final ways = [
        ...grid.ways(),
        const WalkWay(999999, 'footway', [9000001, 9000002], [40.9, -73.9, 40.9005, -73.9]),
      ];
      final g = WalkGraph.fromWays(ways);
      final start = g.nearestNode(grid.latAt(10), grid.lngAt(10))!.node;
      final mask = g.reachableFrom(start);
      expect(g.nearestNode(40.9, -73.9, mask: mask), isNull);
      expect(g.nearestNode(40.9, -73.9), isNotNull);
      expect(astar(g, start, g.nearestNode(40.9, -73.9)!.node), isNull);
    });

    test('parseWays keeps walkable highways and drops motorways, foot=no and private', () {
      const body = '''{"elements":[
        {"type":"way","id":1,"nodes":[1,2],"geometry":[{"lat":1,"lon":2},{"lat":1.001,"lon":2}],"tags":{"highway":"footway"}},
        {"type":"way","id":2,"nodes":[2,3],"geometry":[{"lat":1,"lon":2},{"lat":1.001,"lon":2}],"tags":{"highway":"motorway"}},
        {"type":"way","id":3,"nodes":[2,3],"geometry":[{"lat":1,"lon":2},{"lat":1.001,"lon":2}],"tags":{"highway":"service","access":"private"}},
        {"type":"way","id":4,"nodes":[2,3],"geometry":[{"lat":1,"lon":2},{"lat":1.001,"lon":2}],"tags":{"highway":"residential","foot":"no"}},
        {"type":"way","id":5,"nodes":[2,3],"tags":{"highway":"path"}},
        {"type":"node","id":6,"lat":1,"lon":2}]}''';
      final ways = parseWays(body);
      expect(ways.map((w) => w.id), [1]);
      expect(WalkWay.fromJson(ways.single.toJson()).coords, ways.single.coords);
    });
  });

  group('recommender', () {
    RouteRequest req({int? minutes = 30, int? distanceM}) =>
        RouteRequest(start: grid.center, minutes: minutes, distanceM: distanceM);

    test('30 min loop: starts and ends at the start, fits the budget, 3-4 stops', () {
      final r = req();
      final opts = recommendRoutes(pois: grid.pois(), request: r, graph: graph);
      expect(opts, isNotEmpty);
      expect(opts.length, lessThanOrEqualTo(3));
      for (final o in opts) {
        expect(o.mode, 'street');
        expect(o.picks.length, inInclusiveRange(3, 4));
        expect(o.totalM, inInclusiveRange(0.7 * r.budgetM, 1.1 * r.budgetM));
        expect(o.points.first.lat, grid.center.lat);
        expect(o.points.last.lat, grid.center.lat);
        expect(o.legsM.length, o.picks.length + 1);
        expect(o.stopPointIndex.length, o.picks.length);
        for (var i = 0; i < o.picks.length; i++) {
          final p = o.points[o.stopPointIndex[i]];
          expect(distanceMeters(p.lat, p.lng, o.picks[i].lat, o.picks[i].lng), lessThan(60));
        }
        expect(o.durationS, closeTo(o.totalM / r.speedMps, 1));
      }
    });

    test('options differ, are ranked best first, and results are deterministic', () {
      final a = recommendRoutes(pois: grid.pois(), request: req(), graph: graph);
      final b = recommendRoutes(pois: grid.pois().reversed.toList(), request: req(), graph: graph);
      expect(a.map((o) => o.picks.map((c) => c.osmId).toList()), b.map((o) => o.picks.map((c) => c.osmId).toList()));
      expect(a.map((o) => ([...o.picks.map((c) => c.osmId)]..sort()).join()).toSet().length, a.length);
      for (var i = 1; i < a.length; i++) {
        expect(a[i - 1].score, greaterThanOrEqualTo(a[i].score));
      }
    });

    test('distance input drives the length; at most 2 stops per category', () {
      final r = req(minutes: null, distanceM: 1500);
      for (final o in recommendRoutes(pois: grid.pois(), request: r, graph: graph)) {
        expect(o.totalM, inInclusiveRange(1050, 1650));
        final counts = <String, int>{};
        for (final c in o.picks) {
          counts[c.category] = (counts[c.category] ?? 0) + 1;
        }
        expect(counts.values.every((n) => n <= 2), isTrue);
      }
    });

    test('a longer walk time never gives a shorter best route', () {
      final short = recommendRoutes(pois: grid.pois(), request: req(minutes: 15), graph: graph);
      final long = recommendRoutes(pois: grid.pois(), request: req(minutes: 45), graph: graph);
      expect(short, isNotEmpty);
      expect(long, isNotEmpty);
      expect(long.first.totalM, greaterThan(short.first.totalM));
    });

    test('far-away places are not picked for a short walk', () {
      for (final o in recommendRoutes(pois: grid.pois(), request: req(minutes: 20), graph: graph)) {
        expect(o.picks.any((c) => c.name == 'Far Statue H'), isFalse);
      }
    });

    test('without a graph it falls back to straight-line legs', () {
      final opts = recommendRoutes(pois: grid.pois(), request: req());
      expect(opts, isNotEmpty);
      expect(opts.first.mode, 'straight');
      expect(opts.first.points.length, opts.first.picks.length + 2);
    });

    test('a start far from the network finds nothing within reach', () {
      final r = RouteRequest(start: const Location(40.79, -73.9), minutes: 30);
      final far = [grid.poi('Near Start', 10, 10, {'amenity': 'fountain'})];
      expect(recommendRoutes(pois: far, request: r, graph: graph), isEmpty); // POI out of reach of that start
    });

    test('nothing nearby gives an empty list', () {
      expect(recommendRoutes(pois: const [], request: req(), graph: graph), isEmpty);
    });

    test('route_json fits the sync limit and decodes back', () {
      final big = Grid(120, spacingM: 20); // dense geometry
      final g = WalkGraph.fromWays(big.ways());
      final r = RouteRequest(start: big.center, distanceM: 4000);
      final opts = recommendRoutes(pois: big.pois(), request: r, graph: g);
      for (final o in opts) {
        final s = o.toRouteJson(r);
        expect(s.length, lessThan(20000));
        expect(decodePolyline((jsonDecodeMap(s)['polyline'] as String)).length, o.points.length);
      }
    });
  });
}

Map<String, dynamic> jsonDecodeMap(String s) => jsonDecode(s) as Map<String, dynamic>;

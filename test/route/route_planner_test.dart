import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:touch_grass/db/memory_walk_repository.dart';
import 'package:touch_grass/interfaces/types.dart';
import 'package:touch_grass/models/walk.dart';
import 'package:touch_grass/services/route_planner.dart';
import 'package:touch_grass/util/geo.dart';

import '../helpers/fake_places.dart';
import '../helpers/fakes.dart';

const start = Location(51.5313, -0.1570);

Future<List<Stop>> pool([int n = 12]) => FakeQuestBuilder(latency: Duration.zero, count: n).build(start);

/// Plans [walks] walks in a row, feeding each result back as history.
Future<List<RoutePlan>> simulate(int seed, {int walks = 30, List<Stop>? places}) async {
  final p = places ?? await pool();
  final planner = RoutePlanner(random: Random(seed));
  final recent = <PastRoute>[];
  final out = <RoutePlan>[];
  for (var w = 0; w < walks; w++) {
    final plan = planner.plan(
      start: start,
      pool: p,
      history: RouteHistory(List.of(recent.take(planner.historySize)), w),
      minStops: 1,
      maxStops: 6,
    );
    out.add(plan);
    recent.insert(0, PastRoute(plan.stops.map(stopKey).toSet(), plan.lengthMeters));
  }
  return out;
}

void main() {
  group('distance: shuffled round robin', () {
    for (final seed in [1, 2, 3, 4, 5]) {
      test('seed $seed: every cycle of 3 walks covers short, medium and long', () async {
        final names = (await simulate(seed)).map((p) => p.band!.name).toList();
        for (var i = 0; i + 3 <= names.length; i += 3) {
          expect(names.sublist(i, i + 3).toSet(), {'short', 'medium', 'long'}, reason: 'cycle ${i ~/ 3}: $names');
        }
      });
    }

    test('never the same distance band twice in a row (incl. across cycles)', () async {
      for (final seed in [1, 2, 3, 4, 5]) {
        final names = (await simulate(seed)).map((p) => p.band!.name).toList();
        for (var i = 1; i < names.length; i++) {
          expect(names[i], isNot(names[i - 1]), reason: 'seed $seed: $names');
        }
      }
    });

    test('cycle order is randomised, not a fixed rotation', () async {
      final names = (await simulate(7)).map((p) => p.band!.name[0]).join();
      final orders = {for (var i = 0; i + 3 <= names.length; i += 3) names.substring(i, i + 3)};
      expect(orders.length, greaterThan(1), reason: names);
    });

    test('long routes really are longer than short ones', () async {
      final plans = await simulate(3);
      double avg(String band) {
        final l = plans.where((p) => p.band!.name == band).map((p) => p.lengthMeters);
        return l.reduce((a, b) => a + b) / l.length;
      }

      expect(avg('short'), lessThan(avg('medium')));
      expect(avg('medium'), lessThan(avg('long')));
    });

    test('band thresholds are stable for the same area', () async {
      final p = await pool();
      RouteBand bandFor(int seed) => RoutePlanner(random: Random(seed))
          .plan(start: start, pool: p, history: RouteHistory.empty, minStops: 1, maxStops: 6)
          .band!;
      final bands = [for (var s = 0; s < 10; s++) bandFor(s)];
      final edgesByName = <String, Set<String>>{};
      for (final b in bands) {
        (edgesByName[b.name] ??= {}).add('${b.minMeters}-${b.maxMeters}');
      }
      expect(edgesByName.values.every((e) => e.length == 1), isTrue, reason: '$edgesByName');
    });
  });

  group('places: rotation', () {
    test('over 30 walks (nearly) every candidate place gets visited', () async {
      final union = <String>{};
      for (final seed in [1, 2, 3]) {
        final visited = <String>{};
        for (final p in await simulate(seed)) {
          visited.addAll(p.stops.map(stopKey));
        }
        expect(visited.length, greaterThanOrEqualTo(10), reason: 'seed $seed visited $visited');
        union.addAll(visited);
      }
      expect(union, hasLength(12));
    });

    test('consecutive walks are not the same set of places', () async {
      final plans = await simulate(2);
      for (var i = 1; i < plans.length; i++) {
        expect(plans[i].stops.map(stopKey).toSet(), isNot(plans[i - 1].stops.map(stopKey).toSet()));
      }
    });

    test('different users (seeds) get different walks', () async {
      final a = (await simulate(10, walks: 3)).map((p) => p.stops.map(stopKey).join()).toList();
      final b = (await simulate(11, walks: 3)).map((p) => p.stops.map(stopKey).join()).toList();
      expect(a, isNot(b));
    });

    test('same seed + same history → same route (reproducible for bug reports)', () async {
      final a = (await simulate(42, walks: 5)).map((p) => p.stops.map(stopKey).join()).toList();
      final b = (await simulate(42, walks: 5)).map((p) => p.stops.map(stopKey).join()).toList();
      expect(a, b);
    });
  });

  group('route shape and limits', () {
    test('respects stop limits and prefers ≥ 3 stops', () async {
      for (final p in await simulate(4)) {
        expect(p.stops.length, inInclusiveRange(3, 6));
        expect(p.lengthMeters, lessThanOrEqualTo(5000));
      }
    });

    test('route is ordered nearest-neighbour (from one end of the loop)', () async {
      final plan = (await simulate(5, walks: 1)).single;
      // Either direction of the loop is allowed; one of them must be NN from start.
      bool isNN(List<Stop> s) {
        var at = start;
        final left = List.of(s);
        for (final next in s) {
          final best =
              left.reduce((a, b) => distanceMeters(at, locationOf(a)) <= distanceMeters(at, locationOf(b)) ? a : b);
          if (stopKey(best) != stopKey(next)) return false;
          left.remove(next);
          at = locationOf(next);
        }
        return true;
      }

      expect(isNN(plan.stops) || isNN(plan.stops.reversed.toList()), isTrue);
    });
  });

  group('edge cases', () {
    test('empty pool throws', () {
      expect(
        () => RoutePlanner().plan(start: start, pool: const [], history: RouteHistory.empty, minStops: 1, maxStops: 6),
        throwsStateError,
      );
    });

    test('tiny pool (2 places) → uses both, no crash', () async {
      final plan = RoutePlanner(random: Random(1))
          .plan(start: start, pool: await pool(2), history: RouteHistory.empty, minStops: 1, maxStops: 6);
      expect(plan.stops, hasLength(2));
    });

    test('all places clustered together → single "local" band, still varies places', () async {
      final cluster = [for (var i = 0; i < 8; i++) stop('c$i', lat: start.lat + i * 0.00001, lng: start.lng)];
      final plans = await simulate(1, walks: 6, places: cluster);
      expect(plans.map((p) => p.band!.name).toSet(), {'local'});
      expect(plans.map((p) => p.stops.map(stopKey).toSet().join()).toSet().length, greaterThan(1));
    });

    test('everything too far away → shortest route instead of failing', () {
      final far = [for (var i = 0; i < 4; i++) stop('f$i', lat: start.lat + 0.05 + i * 0.01)]; // 5–9 km away
      final plan = RoutePlanner(random: Random(1))
          .plan(start: start, pool: far, history: RouteHistory.empty, minStops: 1, maxStops: 6);
      expect(plan.band, isNull);
      expect(plan.stops, isNotEmpty);
    });

    test('history with walks from elsewhere does not break band choice', () async {
      const weird = RouteHistory([
        PastRoute({'node/x'}, 99999),
        PastRoute({}, 0)
      ], 2);
      final plan = RoutePlanner(random: Random(1))
          .plan(start: start, pool: await pool(), history: weird, minStops: 1, maxStops: 6);
      expect(plan.band, isNotNull);
    });

    test('fixed km bands are honoured when configured', () async {
      final planner = RoutePlanner(random: Random(1), fixedBands: const [
        RouteBand('easy', 0, 2500),
        RouteBand('hard', 2500, 5000),
      ]);
      final plan =
          planner.plan(start: start, pool: await pool(), history: RouteHistory.empty, minStops: 1, maxStops: 6);
      expect(plan.band!.contains(plan.lengthMeters), isTrue);
    });
  });

  test('end to end: history loaded from the DB rotates bands across real walks', () async {
    final repo = MemoryWalkRepository();
    final planner = RoutePlanner(random: Random(3));
    final places = await pool();
    var t = DateTime(2026, 10, 1);
    final picked = <String>[];
    for (var w = 0; w < 6; w++) {
      final plan = planner.plan(
        start: start,
        pool: places,
        history: await RouteHistory.load(repo, limit: planner.historySize),
        minStops: 1,
        maxStops: 6,
      );
      picked.add(plan.band!.name);
      t = t.add(const Duration(hours: 1)); // distinct created_at for ordering
      await repo.insertWalk(
        Walk(id: 'w$w', createdAt: t, startLat: start.lat, startLng: start.lng, timeOfDay: 'morning', weatherSummary: ''),
        [for (var i = 0; i < plan.stops.length; i++) plan.stops[i].copyWith(id: 'w$w-$i')],
      );
    }
    expect(picked.sublist(0, 3).toSet(), {'short', 'medium', 'long'}, reason: '$picked');
    expect(picked.sublist(3, 6).toSet(), {'short', 'medium', 'long'}, reason: '$picked');
  });
}

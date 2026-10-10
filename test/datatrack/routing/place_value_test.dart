import 'package:flutter_test/flutter_test.dart';
import 'package:touch_grass/datatrack/models/place_stats.dart';
import 'package:touch_grass/datatrack/routing/place_value.dart';
import 'package:touch_grass/datatrack/routing/route_recommender.dart';
import 'package:touch_grass/datatrack/routing/walk_graph.dart';

import 'grid.dart';

const day = 24 * 60 * 60 * 1000;
const now = 100 * day;

PlaceStats stats(String id, {int walks = 5, int devices = 5, int entries = 0, int notes = 0, int photos = 0}) =>
    PlaceStats(osmId: id, walks: walks, devices: devices, entries: entries, notes: notes, photos: photos);

void main() {
  group('place value', () {
    test('no community data: the category weight is used unchanged', () {
      expect(blendedValue(3, null), 3);
      expect(blendedValue(3, stats('x', devices: 0)), 3);
    });

    test('many memories pull the value up, empty visits pull it down, more people = more pull', () {
      final loved = stats('x', walks: 10, devices: 10, notes: 20, photos: 10);
      final boring = stats('x', walks: 10, devices: 10);
      expect(crowdValue(loved), closeTo(5, 1e-9));
      expect(crowdValue(boring), closeTo(1, 1e-9));
      expect(blendedValue(3, loved), greaterThan(4));
      expect(blendedValue(3, boring), lessThan(2));
      // one enthusiastic person barely moves a place; ten move it a lot
      final one = stats('x', walks: 1, devices: 1, notes: 3);
      final ten = stats('x', walks: 10, devices: 10, notes: 30);
      expect(blendedValue(2, one) - 2, lessThan(blendedValue(2, ten) - 2));
      expect(blendedValue(2, one), lessThan(3.0));
    });

    test('freshness: new places first, recent repeats last, never zero', () {
      expect(freshness(null, now), 1);
      final longAgo = freshness(const PlaceHistory(1, now - 90 * day), now);
      final recent = freshness(const PlaceHistory(1, now - day), now);
      final often = freshness(const PlaceHistory(30, now - day), now);
      expect(longAgo, lessThan(1));
      expect(recent, lessThan(longAgo));
      expect(often, greaterThanOrEqualTo(0.15));
    });

    test('seeded random: deterministic, in range, varies by seed and place, smaller with more data', () {
      expect(seededUnit(7, 'node/1'), seededUnit(7, 'node/1'));
      final us = [for (var s = 0; s < 200; s++) seededUnit(s, 'node/1')];
      expect(us.every((u) => u >= 0 && u < 1), isTrue);
      expect(us.toSet().length, greaterThan(150));
      expect(seededUnit(1, 'node/1'), isNot(seededUnit(1, 'node/2')));
      final spread0 = [for (var s = 0; s < 200; s++) jitter(s, 'node/1', null)];
      final spread5 = [for (var s = 0; s < 200; s++) jitter(s, 'node/1', stats('node/1', devices: 5))];
      double range(List<double> l) => l.reduce((a, b) => a > b ? a : b) - l.reduce((a, b) => a < b ? a : b);
      expect(range(spread0), greaterThan(0.4));
      expect(range(spread5), lessThan(range(spread0) / 3));
    });

    test('reasons read well for both cases', () {
      expect(reasonFor(null, null, now), 'no community data yet; new to you');
      expect(reasonFor(stats('x', devices: 1, notes: 1, photos: 0), const PlaceHistory(2, now - 3 * day), now),
          '1 person visited, 1 note, 0 photos; you visited 2x, last 3 days ago');
    });
  });

  group('recommender with community data, history and seed', () {
    final grid = Grid(21);
    final graph = WalkGraph.fromWays(grid.ways());
    final byName = {for (final c in grid.pois()) c.name: c.osmId};
    List<List<String>> run({int seed = 0, Map<String, PlaceStats> stats = const {}, Map<String, PlaceHistory> history = const {}, int? communityRadiusM}) =>
        [
          for (final o in recommendRoutes(
            pois: grid.pois(),
            request: RouteRequest(start: grid.center, minutes: 30, seed: seed, communityRadiusM: communityRadiusM),
            graph: graph,
            stats: stats,
            history: history,
            nowMs: now,
          ))
            [for (final c in o.picks) c.name],
        ];

    test('same seed gives the same answer; different seeds rotate the options', () {
      expect(run(seed: 3), run(seed: 3));
      final tops = {for (var s = 0; s < 10; s++) run(seed: s).first.join('|')};
      expect(tops.length, greaterThan(1));
    });

    test('with no data at all you still get full routes (round robin + random fallback)', () {
      final r = run();
      expect(r, isNotEmpty);
      expect(r.first.length, inInclusiveRange(3, 4));
    });

    test('a place people love moves into the best route', () {
      final base = run(seed: 0);
      expect(base.first, isNot(contains('Chapel E')));
      final loved = {byName['Chapel E']!: stats(byName['Chapel E']!, walks: 12, devices: 12, notes: 30, photos: 12)};
      expect(run(seed: 0, stats: loved).first, contains('Chapel E'));
    });

    test('a place people found empty is dropped from the best route', () {
      final base = run(seed: 0).first;
      final victim = base.first;
      final empty = {byName[victim]!: stats(byName[victim]!, walks: 12, devices: 12)};
      expect(run(seed: 0, stats: empty).first, isNot(contains(victim)));
    });

    test('only community data inside the chosen area counts', () {
      final loved = {byName['Chapel E']!: stats(byName['Chapel E']!, walks: 12, devices: 12, notes: 30, photos: 12)};
      // Chapel E is ~500 m from the start: a 100 m area or 0 (off) ignores it.
      expect(run(seed: 0, stats: loved, communityRadiusM: 100), run(seed: 0));
      expect(run(seed: 0, stats: loved, communityRadiusM: 0), run(seed: 0));
      expect(run(seed: 0, stats: loved, communityRadiusM: 2000).first, contains('Chapel E'));
    });

    test('places you just visited are rotated out, not banned', () {
      final base = run(seed: 0).first;
      final visited = {for (final n in base) byName[n]!: PlaceHistory(1, now - day)};
      final next = run(seed: 0, history: visited);
      expect(next.first.toSet(), isNot(base.toSet()));
      expect(next.first.where((n) => !base.contains(n)), isNotEmpty);
    });

    test('reasons are given per pick', () {
      final opts = recommendRoutes(
        pois: grid.pois(),
        request: RouteRequest(start: grid.center, minutes: 30, seed: 0),
        graph: graph,
        stats: {byName['Mural B']!: stats(byName['Mural B']!, devices: 3, notes: 4, photos: 1)},
        nowMs: now,
      );
      for (final o in opts) {
        expect(o.reasons.length, o.picks.length);
        expect(o.reasons.every((r) => r.endsWith('new to you')), isTrue);
      }
      final withMural = opts.firstWhere((o) => o.picks.any((c) => c.name == 'Mural B'));
      expect(withMural.reasons[withMural.picks.indexWhere((c) => c.name == 'Mural B')], startsWith('3 people visited, 4 notes, 1 photo'));
    });
  });
}

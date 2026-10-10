import 'dart:math';

import '../db/walk_repository.dart';
import '../interfaces/types.dart';
import '../util/geo.dart';

/// A route-length bucket, e.g. "short" = loops under 1.9 km in this area.
class RouteBand {
  final String name;
  final double minMeters;
  final double maxMeters;
  const RouteBand(this.name, this.minMeters, this.maxMeters);

  bool contains(double m) => m >= minMeters && m < maxMeters;

  @override
  String toString() => '$name (${(minMeters / 1000).toStringAsFixed(1)}–${(maxMeters / 1000).toStringAsFixed(1)} km)';
}

/// A previous walk, as seen by the planner.
class PastRoute {
  final Set<String> placeKeys;
  final double lengthMeters;
  const PastRoute(this.placeKeys, this.lengthMeters);
}

class RouteHistory {
  /// Most recent first.
  final List<PastRoute> recent;

  /// All walks ever prepared on this device; positions the band cycle.
  final int totalWalks;
  const RouteHistory(this.recent, this.totalWalks);

  static const empty = RouteHistory([], 0);

  /// Loads the last [limit] walks from the DB. Any error → empty history
  /// (variety degrades gracefully; quest preparation never fails because of it).
  static Future<RouteHistory> load(WalkRepository repo, {int limit = 6}) async {
    try {
      final walks = await repo.listWalks();
      final out = <PastRoute>[];
      for (final w in walks.take(limit)) {
        final stops = await repo.stopsForWalk(w.id);
        if (stops.isEmpty) continue;
        out.add(PastRoute(stops.map(stopKey).toSet(), loopLengthMeters(Location(w.startLat, w.startLng), stops)));
      }
      return RouteHistory(out, walks.length);
    } catch (_) {
      return empty;
    }
  }
}

class RoutePlan {
  final List<Stop> stops;
  final double lengthMeters;

  /// Null when no route fit under maxRouteMeters and the shortest was used.
  final RouteBand? band;

  /// Distinct candidate routes considered (for logs/debugging).
  final int candidates;
  const RoutePlan(this.stops, this.lengthMeters, this.band, this.candidates);

  String describe() =>
      '${band?.name ?? 'compact'} route · ${(lengthMeters / 1000).toStringAsFixed(1)} km · ${stops.length} stops';
}

/// Picks which places to visit, and in what order, so consecutive walks differ.
///
/// **Distance — shuffled round robin.** Candidate loops are split into
/// short / medium / long *for this area* (terciles of what's possible from
/// the start point, so every area gets real variety). Walks cycle through all
/// bands in a freshly shuffled order each cycle (a "bag"), never repeating a
/// band back-to-back, even across cycles.
///
/// **Places — rotation.** Places from recent walks are down-weighted
/// (least-recently-visited first) and routes resembling recent ones score
/// lower, so over time every candidate place gets visited.
///
/// **Not greedy.** The final pick is weighted-random among a band's routes.
///
/// Pure and synchronous; pass a seeded [Random] for reproducible results.
class RoutePlanner {
  final List<String> bandNames;

  /// Absolute km bands instead of per-area terciles (e.g. for a fixed demo).
  final List<RouteBand>? fixedBands;

  /// Loops longer than this are never offered.
  final double maxRouteMeters;

  /// If all possible loops are within this spread, distance can't really vary:
  /// use a single band.
  final double minBandSpreadMeters;

  /// Aim for at least this many stops when the pool allows it.
  final int preferredMinStops;

  /// Random candidate routes generated per plan.
  final int attempts;

  /// How many past walks influence place rotation.
  final int historySize;
  final Random random;

  RoutePlanner({
    this.bandNames = const ['short', 'medium', 'long'],
    this.fixedBands,
    this.maxRouteMeters = 5000,
    this.minBandSpreadMeters = 300,
    this.preferredMinStops = 3,
    this.attempts = 120,
    this.historySize = 6,
    Random? random,
  }) : assert(bandNames.isNotEmpty && (fixedBands == null || fixedBands.isNotEmpty)),
       random = random ?? Random();

  RoutePlan plan({
    required Location start,
    required List<Stop> pool,
    required RouteHistory history,
    required int minStops,
    required int maxStops,
  }) {
    if (pool.isEmpty) throw StateError('no candidate places to plan a route from');
    final kMax = min(maxStops, pool.length);
    final kMin = min(max(minStops, preferredMinStops), kMax);
    final near = List.of(pool)
      ..sort((a, b) => distanceMeters(start, locationOf(a)).compareTo(distanceMeters(start, locationOf(b))));
    final freshness = {for (final s in pool) stopKey(s): _freshness(stopKey(s), history.recent)};

    // 1. Candidates: random size k, random "reach" (only the nearest m places),
    //    places weighted by freshness, visited nearest-neighbour, random direction.
    final byKey = <String, _Candidate>{};
    for (var a = 0; a < attempts; a++) {
      final route = _randomRoute(random, start, near, kMin, kMax, (s) => 0.05 + freshness[stopKey(s)]!);
      final ordered = random.nextBool() ? route : route.reversed.toList();
      byKey.putIfAbsent(_routeKey(ordered), () => _Candidate(ordered, loopLengthMeters(start, ordered)));
    }
    final all = byKey.values.toList();
    final fits = all.where((c) => c.length <= maxRouteMeters).toList();
    if (fits.isEmpty) {
      final shortest = all.reduce((a, b) => a.length <= b.length ? a : b);
      return RoutePlan(shortest.stops, shortest.length, null, all.length);
    }

    // 2. Bands for this area. Thresholds come from a separate pass with a
    //    seed derived from the pool, so they're identical every time for the
    //    same area and past walks are classified consistently.
    final bands = fixedBands ?? _areaBands(start, near, kMin, kMax, fits);
    int? bandOf(double m) {
      for (var i = 0; i < bands.length; i++) {
        if (bands[i].contains(m)) return i;
      }
      return null;
    }

    final byBand = <int, List<_Candidate>>{};
    for (final c in fits) {
      final b = bandOf(c.length);
      if (b != null) (byBand[b] ??= []).add(c);
    }
    if (byBand.isEmpty) {
      final shortest = fits.reduce((a, b) => a.length <= b.length ? a : b);
      return RoutePlan(shortest.stops, shortest.length, null, all.length);
    }

    // 3. Shuffled round robin over bands.
    final bandIdx = _pickBand(byBand.keys.toSet(), bands.length, history, bandOf);

    // 4. Weighted-random pick inside the band.
    final pick = _weightedSample(random, byBand[bandIdx]!, 1, (c) {
      final keys = c.stops.map(stopKey).toSet();
      final fresh = c.stops.map((s) => freshness[stopKey(s)]!).reduce((a, b) => a + b) / c.stops.length;
      final novelty = 1 - history.recent.fold<double>(0, (m, h) => max(m, _jaccard(keys, h.placeKeys)));
      final score = 0.1 + fresh * novelty;
      return score * score;
    }).single;
    return RoutePlan(pick.stops, pick.length, bands[bandIdx], all.length);
  }

  /// Terciles (or as many bands as there are names) of possible loop lengths.
  List<RouteBand> _areaBands(Location start, List<Stop> near, int kMin, int kMax, List<_Candidate> fallback) {
    final stable = Random(_fnv1a(near.map(stopKey).toList()..sort()));
    final ref = <double>[];
    for (var a = 0; a < attempts; a++) {
      final l = loopLengthMeters(start, _randomRoute(stable, start, near, kMin, kMax, (_) => 1));
      if (l <= maxRouteMeters) ref.add(l);
    }
    final lengths = (ref.isEmpty ? fallback.map((c) => c.length).toList() : ref)..sort();
    final n = lengths.last - lengths.first < minBandSpreadMeters ? 1 : min(bandNames.length, lengths.length);
    final cuts = [for (var i = 1; i < n; i++) lengths[lengths.length * i ~/ n]];
    final edges = [0.0, ...cuts, double.infinity];
    final names = n == 1 ? const ['local'] : bandNames;
    return [for (var i = 0; i < n; i++) RouteBand(names[i], edges[i], edges[i + 1])];
  }

  int _pickBand(Set<int> available, int bandCount, RouteHistory history, int? Function(double) bandOf) {
    final past = history.recent.map((h) => bandOf(h.lengthMeters)).toList();
    final last = past.isEmpty ? null : past.first;
    final pos = history.totalWalks % bandCount; // walks already done in this cycle
    final usedThisCycle = past.take(pos).whereType<int>().toSet();
    var eligible = available.where((b) => !usedThisCycle.contains(b)).toList();
    if (pos == 0 && last != null) {
      // New cycle: any order, but don't repeat the band we just walked.
      final noRepeat = eligible.where((b) => b != last).toList();
      if (noRepeat.isNotEmpty) eligible = noRepeat;
    }
    if (eligible.isEmpty) eligible = available.where((b) => b != last).toList(); // area lacks the needed band
    if (eligible.isEmpty) eligible = available.toList();
    eligible.sort();
    return eligible[random.nextInt(eligible.length)];
  }

  static List<Stop> _randomRoute(
    Random rng,
    Location start,
    List<Stop> near,
    int kMin,
    int kMax,
    double Function(Stop) weight,
  ) {
    final k = kMin + rng.nextInt(kMax - kMin + 1);
    final reach = k + rng.nextInt(near.length - k + 1);
    return _nearestNeighbourOrder(start, _weightedSample(rng, near.sublist(0, reach), k, weight));
  }

  /// 1.0 = not in recent history; lower the more recently it was visited.
  static double _freshness(String key, List<PastRoute> recent) {
    for (var i = 0; i < recent.length; i++) {
      if (recent[i].placeKeys.contains(key)) return 1 - pow(0.85, i + 1).toDouble();
    }
    return 1.0;
  }

  static double _jaccard(Set<String> a, Set<String> b) {
    if (a.isEmpty && b.isEmpty) return 1;
    return a.intersection(b).length / a.union(b).length;
  }

  static String _routeKey(List<Stop> stops) => (stops.map(stopKey).toList()..sort()).join('|');

  /// Stable 31-bit hash (String.hashCode isn't guaranteed stable across runs).
  static int _fnv1a(List<String> parts) {
    var h = 0x811c9dc5;
    for (final c in parts.join('|').codeUnits) {
      h = ((h ^ c) * 0x01000193) & 0xffffffff;
    }
    return h & 0x7fffffff;
  }

  static List<Stop> _nearestNeighbourOrder(Location start, List<Stop> stops) {
    final left = List.of(stops);
    final out = <Stop>[];
    var at = start;
    while (left.isNotEmpty) {
      left.sort((a, b) => distanceMeters(at, locationOf(a)).compareTo(distanceMeters(at, locationOf(b))));
      final next = left.removeAt(0);
      out.add(next);
      at = locationOf(next);
    }
    return out;
  }

  /// [k] distinct items, each draw proportional to [weight].
  static List<T> _weightedSample<T>(Random rng, List<T> items, int k, double Function(T) weight) {
    final left = List.of(items);
    final out = <T>[];
    while (out.length < k && left.isNotEmpty) {
      final ws = left.map(weight).toList();
      final total = ws.fold<double>(0, (a, b) => a + b);
      var r = rng.nextDouble() * total;
      var i = 0;
      while (i < ws.length - 1 && r >= ws[i]) {
        r -= ws[i];
        i++;
      }
      out.add(left.removeAt(i));
    }
    return out;
  }
}

class _Candidate {
  final List<Stop> stops;
  final double length;
  _Candidate(this.stops, this.length);
}

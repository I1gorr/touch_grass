import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

import '../interfaces/types.dart';
import '../models/place_stats.dart';
import '../tracks/data/candidate.dart';
import '../tracks/data/candidate_filter.dart';
import '../tracks/data/candidate_scorer.dart';
import 'latlng.dart';
import 'place_card.dart';
import 'place_value.dart';
import 'polyline.dart';
import 'router.dart';
import 'walk_graph.dart';
import 'walk_way.dart';

/// Default walking pace, about 4.8 km/h.
const double kWalkSpeedMps = 1.34;

/// What the person asked for: a walk of about [minutes] or [distanceM], looping back to the start.
class RouteRequest {
  final Location start;
  final int? minutes;
  final int? distanceM;
  final double speedMps;
  /// How many ranked alternatives to return.
  final int options;
  /// Seed for the random nudge. Same seed = same recommendations; change it (e.g. daily) to rotate them.
  final int? seed;
  /// Only community data from places within this many metres of the start is used.
  /// Null = the whole downloaded area, 0 = ignore community data.
  final int? communityRadiusM;
  /// Places the person chose to skip. They never appear in the results.
  final Set<String> excludeOsmIds;

  RouteRequest({
    required this.start,
    this.minutes,
    this.distanceM,
    this.speedMps = kWalkSpeedMps,
    this.options = 3,
    this.seed,
    this.communityRadiusM,
    this.excludeOsmIds = const {},
  })
      : assert(minutes != null || distanceM != null, 'give minutes or distanceM');

  RouteRequest copyWith({int? seed, Set<String>? excludeOsmIds}) => RouteRequest(
        start: start,
        minutes: minutes,
        distanceM: distanceM,
        speedMps: speedMps,
        options: options,
        seed: seed ?? this.seed,
        communityRadiusM: communityRadiusM,
        excludeOsmIds: excludeOsmIds ?? this.excludeOsmIds,
      );

  /// Target loop length in metres. A distance wins over a time if both are given.
  double get budgetM => distanceM?.toDouble() ?? minutes! * 60 * speedMps;
}

/// One recommended loop: start -> [picks] in order -> start.
class RouteOption {
  final List<Candidate> picks;
  /// Whole route, start to start.
  final List<LatLng> points;
  /// Metres of each leg (`picks.length + 1` values).
  final List<int> legsM;
  /// Index into [points] where each pick is reached.
  final List<int> stopPointIndex;
  final double score;
  /// `street` (follows the downloaded walking network) or `straight` (no network: crow-flies x 1.3).
  final String mode;
  final int durationS;
  /// Why each pick was chosen (community data and this person's history), one line per pick.
  final List<String> reasons;
  /// What to show for each stop on the review screen (same order as [picks]).
  final List<PlaceCard> cards;

  const RouteOption({
    required this.picks,
    required this.points,
    required this.legsM,
    required this.stopPointIndex,
    required this.score,
    required this.mode,
    required this.durationS,
    this.reasons = const [],
    this.cards = const [],
  });

  int get totalM => legsM.fold(0, (a, b) => a + b);

  RouteOption withCards(List<PlaceCard> c) => RouteOption(
        picks: picks,
        points: points,
        legsM: legsM,
        stopPointIndex: stopPointIndex,
        score: score,
        mode: mode,
        durationS: durationS,
        reasons: [for (final x in c) x.reason],
        cards: c,
      );

  /// The string stored in `walk.route_json` (kept under the 20,000-char sync limit).
  String toRouteJson(RouteRequest r) => jsonEncode({
        'v': 1,
        'mode': mode,
        'polyline': encodePolyline(points),
        'legs_m': legsM,
        'total_m': totalM,
        'duration_s': durationS,
        'stop_point_index': stopPointIndex,
        'request': {
          'minutes': r.minutes,
          'distance_m': r.distanceM,
          'loop': true,
          if (r.excludeOsmIds.isNotEmpty) 'skipped': r.excludeOsmIds.toList()..sort(),
        },
      });
}

const int _maxCandidates = 20;
/// Longer walks get more stops: about one per 600 m, between 3 and 6.
int _maxStopsFor(double budgetM) => (budgetM / 600).round().clamp(3, 6);
const int _minStops = 3;
const int _maxPerCategory = 2;
const double _maxSnapM = 300;
const double _straightDetour = 1.3;
const int _maxPolylineChars = 15000;

/// Recommends up to `request.options` loops, best first. Pure and deterministic, so it can run in an isolate.
/// With a [graph] routes follow real paths; without one it falls back to straight lines.
List<RouteOption> recommendRoutes({
  required List<Candidate> pois,
  required RouteRequest request,
  WalkGraph? graph,
  Map<String, PlaceStats> stats = const {},
  Map<String, PlaceHistory> history = const {},
  Set<String> hiddenNoteIds = const {},
  int nowMs = 0,
}) {
  final budget = request.budgetM;
  final lo = 0.7 * budget, hi = 1.1 * budget;
  final maxStops = _maxStopsFor(budget);
  final start = request.start;

  // A loop out and back is at least twice the crow-flies distance to its farthest stop.
  final near = filterCandidates(pois)
      .where((c) => !request.excludeOsmIds.contains(c.osmId) && distanceMeters(start.lat, start.lng, c.lat, c.lng) <= hi / 2)
      .toList();

  // Community data only counts inside the area the person chose.
  final communityR = request.communityRadiusM;
  PlaceStats? statsFor(Candidate c) {
    if (communityR != null && (communityR <= 0 || distanceMeters(start.lat, start.lng, c.lat, c.lng) > communityR)) return null;
    return stats[c.osmId];
  }

  // Value of a place: category weight blended with what people left there, rotated by this
  // person's history, plus a seeded random nudge. Without any data it is the category weight
  // with round-robin and random variety.
  final value = {
    for (final c in near)
      c.osmId: placeValue(
        base: categoryWeight(c),
        osmId: c.osmId,
        stats: statsFor(c),
        history: history[c.osmId],
        nowMs: nowMs,
        seed: request.seed ?? 0,
      ),
  };
  final shortlist = [...near]..sort((a, b) {
      double score(Candidate c) => value[c.osmId]! - distanceMeters(start.lat, start.lng, c.lat, c.lng) / 300;
      final r = score(b).compareTo(score(a));
      return r != 0 ? r : a.osmId.compareTo(b.osmId);
    });
  final ranked = shortlist.take(_maxCandidates).toList();

  // Snap to the network; fall back to straight lines if the start is not on it.
  WalkGraph? g = graph;
  int startNode = -1;
  Uint8List? mask;
  if (g != null) {
    final snap = g.nearestNode(start.lat, start.lng, maxSnapM: _maxSnapM);
    if (snap == null) {
      g = null;
    } else {
      startNode = snap.node;
      mask = g.reachableFrom(startNode);
    }
  }

  final cands = <Candidate>[];
  final nodes = <int>[];
  for (final c in ranked) {
    if (g == null) {
      cands.add(c);
    } else {
      final snap = g.nearestNode(c.lat, c.lng, mask: mask, maxSnapM: _maxSnapM);
      if (snap == null) continue;
      cands.add(c);
      nodes.add(snap.node);
    }
  }
  if (cands.isEmpty) return const [];

  // d[i][j]: metres between points; index 0 is the start, i >= 1 is cands[i - 1].
  final n = cands.length;
  final d = List.generate(n + 1, (_) => List<double>.filled(n + 1, double.infinity));
  if (g == null) {
    final pts = <LatLng>[(lat: start.lat, lng: start.lng), for (final c in cands) (lat: c.lat, lng: c.lng)];
    for (var i = 0; i <= n; i++) {
      for (var j = 0; j <= n; j++) {
        d[i][j] = i == j ? 0 : distanceMeters(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng) * _straightDetour;
      }
    }
  } else {
    final all = [startNode, ...nodes];
    for (var i = 0; i <= n; i++) {
      final res = dijkstra(g, all[i], maxCost: hi);
      for (var j = 0; j <= n; j++) {
        d[i][j] = i == j ? 0 : res.len[all[j]];
      }
    }
    for (var i = 0; i <= n; i++) {
      for (var j = i + 1; j <= n; j++) {
        final m = d[i][j] < d[j][i] ? d[i][j] : d[j][i];
        d[i][j] = d[j][i] = m;
      }
    }
  }

  final w = [0.0, for (final c in cands) value[c.osmId]!];
  final cat = ['', for (final c in cands) c.category];
  double loopLen(List<int> t) {
    var sum = 0.0, prev = 0;
    for (final s in t) {
      sum += d[prev][s];
      prev = s;
    }
    return sum + d[prev][0];
  }

  // Greedy insertion: best weight per extra metre, within the length cap.
  void fill(List<int> tour, {required bool capCategories}) {
    var cur = loopLen(tour);
    while (tour.length < maxStops) {
      int? bestC, bestP;
      var bestRatio = -1.0;
      var bestAdded = 0.0;
      for (var c = 1; c <= n; c++) {
        if (tour.contains(c)) continue;
        if (capCategories && tour.where((t) => cat[t] == cat[c]).length >= _maxPerCategory) continue;
        for (var p = 0; p <= tour.length; p++) {
          final prev = p == 0 ? 0 : tour[p - 1];
          final next = p == tour.length ? 0 : tour[p];
          final added = d[prev][c] + d[c][next] - d[prev][next];
          if (!added.isFinite || cur + added > hi) continue;
          final ratio = w[c] / (added < 50 ? 50 : added);
          if (ratio > bestRatio + 1e-12 ||
              ((ratio - bestRatio).abs() <= 1e-12 && bestC != null && cands[c - 1].osmId.compareTo(cands[bestC - 1].osmId) < 0)) {
            bestRatio = ratio;
            bestC = c;
            bestP = p;
            bestAdded = added;
          }
        }
      }
      if (bestC == null) break;
      tour.insert(bestP!, bestC);
      cur += bestAdded;
    }
  }

  // Exact best order: at most 6 stops, so at most 720 permutations.
  List<int> bestOrder(List<int> tour) {
    var best = tour, bestLen = loopLen(tour);
    void permute(List<int> rest, List<int> acc) {
      if (rest.isEmpty) {
        final l = loopLen(acc);
        if (l < bestLen - 1e-9) {
          best = [...acc];
          bestLen = l;
        }
        return;
      }
      for (var i = 0; i < rest.length; i++) {
        permute([...rest]..removeAt(i), [...acc, rest[i]]);
      }
    }

    permute(tour, const []);
    return best;
  }

  List<int>? buildTour(int? anchor) {
    final tour = <int>[];
    if (anchor != null) {
      if (!(d[0][anchor] + d[anchor][0] <= hi)) return null;
      tour.add(anchor);
    }
    fill(tour, capCategories: true);
    if (tour.length < _minStops) fill(tour, capCategories: false);
    return tour.isEmpty ? null : bestOrder(tour);
  }

  // Different anchors give different-looking loops; dedupe by stop set.
  final seen = <String>{};
  final tours = <List<int>>[];
  for (final anchor in <int?>[null, for (var i = 1; i <= n && i <= 8; i++) i]) {
    final t = buildTour(anchor);
    if (t == null) continue;
    final key = ([for (final s in t) cands[s - 1].osmId]..sort()).join('|');
    if (seen.add(key)) tours.add(t);
  }

  double scoreOf(List<int> t) {
    final len = loopLen(t);
    final cats = {for (final s in t) cat[s]};
    return t.fold(0.0, (a, s) => a + w[s]) + 0.5 * cats.length - 4 * (len - budget).abs() / budget;
  }

  int cmp(List<int> a, List<int> b) {
    final c = scoreOf(b).compareTo(scoreOf(a));
    if (c != 0) return c;
    return [for (final s in a) cands[s - 1].osmId].join('|').compareTo([for (final s in b) cands[s - 1].osmId].join('|'));
  }

  // Prefer loops long enough to count as the walk that was asked for.
  final fitting = tours.where((t) => loopLen(t) >= lo).toList()..sort(cmp);
  final short = tours.where((t) => loopLen(t) < lo).toList()..sort(cmp);
  final chosen = [...fitting, ...short].take(request.options);

  final out = <RouteOption>[];
  for (final t in chosen) {
    final opt = g == null
        ? _straightOption(request, cands, t, d, scoreOf(t))
        : _streetOption(request, g, cands, nodes, startNode, t, scoreOf(t));
    if (opt == null) continue;
    out.add(opt.withCards([
      for (final s in t)
        PlaceCard.of(cands[s - 1],
            stats: statsFor(cands[s - 1]), history: history[cands[s - 1].osmId], hiddenNoteIds: hiddenNoteIds, nowMs: nowMs),
    ]));
  }
  return out;
}

RouteOption _straightOption(RouteRequest r, List<Candidate> cands, List<int> tour, List<List<double>> d, double score) {
  final picks = [for (final s in tour) cands[s - 1]];
  final points = <LatLng>[
    (lat: r.start.lat, lng: r.start.lng),
    for (final c in picks) (lat: c.lat, lng: c.lng),
    (lat: r.start.lat, lng: r.start.lng),
  ];
  final legs = <int>[];
  var prev = 0;
  for (final s in [...tour, 0]) {
    legs.add(d[prev][s].round());
    prev = s;
  }
  final total = legs.fold(0, (a, b) => a + b);
  return RouteOption(
    picks: picks,
    points: points,
    legsM: legs,
    stopPointIndex: [for (var i = 1; i <= picks.length; i++) i],
    score: score,
    mode: 'straight',
    durationS: (total / r.speedMps).round(),
  );
}

RouteOption? _streetOption(
  RouteRequest r,
  WalkGraph g,
  List<Candidate> cands,
  List<int> nodes,
  int startNode,
  List<int> tour,
  double score,
) {
  final picks = [for (final s in tour) cands[s - 1]];
  final stopNodes = [for (final s in tour) nodes[s - 1]];
  final chain = [startNode, ...stopNodes, startNode];
  final points = <LatLng>[(lat: r.start.lat, lng: r.start.lng)];
  final legs = <int>[];
  final stopIdx = <int>[];
  for (var i = 0; i + 1 < chain.length; i++) {
    final p = astar(g, chain[i], chain[i + 1]);
    if (p == null) return null;
    for (var k = i == 0 ? 0 : 1; k < p.nodes.length; k++) {
      points.add((lat: g.lat[p.nodes[k]], lng: g.lng[p.nodes[k]]));
    }
    legs.add(p.lengthM.round());
    if (i < stopNodes.length) stopIdx.add(points.length - 1);
  }
  points.add((lat: r.start.lat, lng: r.start.lng));

  // Shrink the polyline (keeping the stops) until its encoded form is small enough to store and sync.
  var tol = 3.0;
  var keepIdx = simplifyIndices(points, tol, keep: stopIdx.toSet());
  while (encodePolyline([for (final i in keepIdx) points[i]]).length > _maxPolylineChars && tol < 200) {
    tol *= 2;
    keepIdx = simplifyIndices(points, tol, keep: stopIdx.toSet());
  }
  final remap = {for (var k = 0; k < keepIdx.length; k++) keepIdx[k]: k};
  final total = legs.fold(0, (a, b) => a + b);
  return RouteOption(
    picks: picks,
    points: [for (final i in keepIdx) points[i]],
    legsM: legs,
    stopPointIndex: [for (final i in stopIdx) remap[i]!],
    score: score,
    mode: 'street',
    durationS: (total / r.speedMps).round(),
  );
}

/// Everything [planRoutes] needs, in a form that can be sent to a background isolate.
class PlanJob {
  final List<Candidate> pois;
  final List<WalkWay> ways;
  final RouteRequest request;
  final Map<String, PlaceStats> stats;
  final Map<String, PlaceHistory> history;
  final Set<String> hiddenNoteIds;
  final int nowMs;
  const PlanJob(this.pois, this.ways, this.request,
      {this.stats = const {}, this.history = const {}, this.hiddenNoteIds = const {}, this.nowMs = 0});
}

/// Builds the walking graph (if there are ways) and recommends routes. Top-level so it can run in an isolate.
List<RouteOption> planRoutes(PlanJob job) => recommendRoutes(
      pois: job.pois,
      request: job.request,
      graph: job.ways.isEmpty ? null : WalkGraph.fromWays(job.ways),
      stats: job.stats,
      history: job.history,
      hiddenNoteIds: job.hiddenNoteIds,
      nowMs: job.nowMs,
    );

/// Runs [planRoutes] off the UI isolate; graph building is the slow part.
Future<List<RouteOption>> planRoutesInIsolate(PlanJob job) => Isolate.run(() => planRoutes(job));

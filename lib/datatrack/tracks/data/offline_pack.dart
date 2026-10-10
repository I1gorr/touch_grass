import 'dart:math';

import '../../interfaces/types.dart';
import '../../models/place_stats.dart';
import '../../routing/walk_graph.dart';
import '../../routing/walk_way.dart';
import 'candidate.dart';

/// A downloaded area: points of interest plus the walking network, like an offline map region.
/// Lives in files (not SQLite) and is never synced.
class OfflinePack {
  final String id;
  final double centerLat;
  final double centerLng;
  final int radiusM;
  /// ms since epoch when the data was downloaded.
  final int createdAt;
  final List<Candidate> pois;
  final List<WalkWay> ways;
  /// Community counts per place, for the area the user chose. Empty if none were fetched.
  final Map<String, PlaceStats> stats;
  /// ms since epoch when [stats] were fetched (0 = never).
  final int statsAt;
  /// Radius the community data was fetched for (the user's chosen area); null = the whole pack.
  final int? communityRadiusM;

  const OfflinePack({
    required this.id,
    required this.centerLat,
    required this.centerLng,
    required this.radiusM,
    required this.createdAt,
    required this.pois,
    required this.ways,
    this.stats = const {},
    this.statsAt = 0,
    this.communityRadiusM,
  });

  static String idFor(Location center, int radiusM) =>
      '${center.lat.toStringAsFixed(3)}_${center.lng.toStringAsFixed(3)}_$radiusM'.replaceAll('-', 'm');

  /// True if a walk of [reachM] from [start] stays inside this pack.
  bool covers(Location start, double reachM) =>
      distanceMeters(centerLat, centerLng, start.lat, start.lng) + reachM <= radiusM;

  WalkGraph buildGraph() => WalkGraph.fromWays(ways);

  Map<String, Object?> manifest() => {
        'v': 1,
        'id': id,
        'center_lat': centerLat,
        'center_lng': centerLng,
        'radius_m': radiusM,
        'created_at': createdAt,
        'poi_count': pois.length,
        'way_count': ways.length,
        'stats_at': statsAt,
        'community_radius_m': communityRadiusM,
      };
}

/// Pack metadata without the (large) data files.
class PackInfo {
  final String id;
  final double centerLat;
  final double centerLng;
  final int radiusM;
  final int createdAt;
  final int statsAt;
  final int? communityRadiusM;
  const PackInfo(this.id, this.centerLat, this.centerLng, this.radiusM, this.createdAt,
      {this.statsAt = 0, this.communityRadiusM});

  factory PackInfo.fromManifest(Map<String, dynamic> m) => PackInfo(
        m['id'] as String,
        (m['center_lat'] as num).toDouble(),
        (m['center_lng'] as num).toDouble(),
        (m['radius_m'] as num).toInt(),
        (m['created_at'] as num).toInt(),
        statsAt: (m['stats_at'] as num?)?.toInt() ?? 0,
        communityRadiusM: (m['community_radius_m'] as num?)?.toInt(),
      );

  Location get center => Location(centerLat, centerLng);

  bool covers(Location start, double reachM) =>
      distanceMeters(centerLat, centerLng, start.lat, start.lng) + reachM <= radiusM;
}

/// Pack radius for a loop of [budgetM]: the farthest useful stop is about half the loop away,
/// plus 15% for streets that are not straight. Clamped to what Overpass will serve comfortably.
int packRadiusFor(double budgetM) => max(800, min(4000, (budgetM / 2 * 1.15).ceil()));

/// How far from the start a loop of [budgetM] can reach (what a pack must cover).
double reachFor(double budgetM) => budgetM / 2 * 1.1;

Map<String, Object?> candidateToJson(Candidate c) =>
    {'id': c.osmId, 'name': c.name, 'lat': c.lat, 'lng': c.lng, 'tags': c.tags};

Candidate candidateFromJson(Map<String, dynamic> j) => Candidate(
      osmId: j['id'] as String,
      name: j['name'] as String,
      lat: (j['lat'] as num).toDouble(),
      lng: (j['lng'] as num).toDouble(),
      tags: (j['tags'] as Map).map((k, v) => MapEntry('$k', '$v')),
    );

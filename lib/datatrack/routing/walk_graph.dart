import 'dart:collection';
import 'dart:math';
import 'dart:typed_data';

import '../tracks/data/candidate.dart' show distanceMeters;
import 'walk_way.dart';

class Edge {
  final int to;
  final double len;
  /// `len` x a preference factor (>= 1): quiet footpaths are cheaper than busy roads.
  final double cost;
  const Edge(this.to, this.len, this.cost);
}

/// Routing preference per OSM highway class. Always >= 1 so haversine stays an admissible A* heuristic.
double highwayFactor(String h) {
  switch (h) {
    case 'footway':
    case 'path':
    case 'pedestrian':
    case 'track':
      return 1.0;
    case 'cycleway':
    case 'residential':
    case 'living_street':
      return 1.05;
    case 'unclassified':
      return 1.1;
    case 'service':
      return 1.15;
    case 'tertiary':
    case 'tertiary_link':
      return 1.2;
    case 'steps':
    case 'secondary':
    case 'secondary_link':
      return 1.5;
    case 'primary':
    case 'primary_link':
      return 1.7;
    default:
      return 1.3;
  }
}

/// Walking network built from pack ways. Ways that share an OSM node id are connected there.
class WalkGraph {
  final List<double> lat;
  final List<double> lng;
  final List<List<Edge>> adj;

  WalkGraph._(this.lat, this.lng, this.adj);

  int get nodeCount => lat.length;

  factory WalkGraph.fromWays(List<WalkWay> ways) {
    final index = <int, int>{};
    final lat = <double>[], lng = <double>[];
    final adj = <List<Edge>>[];
    int nodeOf(int osmId, double la, double lo) => index.putIfAbsent(osmId, () {
          lat.add(la);
          lng.add(lo);
          adj.add(<Edge>[]);
          return lat.length - 1;
        });

    for (final w in ways) {
      final f = highwayFactor(w.highway);
      var prev = nodeOf(w.nodes[0], w.coords[0], w.coords[1]);
      for (var i = 1; i < w.nodes.length; i++) {
        final cur = nodeOf(w.nodes[i], w.coords[2 * i], w.coords[2 * i + 1]);
        if (cur != prev) {
          final len = distanceMeters(lat[prev], lng[prev], lat[cur], lng[cur]);
          adj[prev].add(Edge(cur, len, len * f));
          adj[cur].add(Edge(prev, len, len * f));
        }
        prev = cur;
      }
    }
    return WalkGraph._(lat, lng, adj);
  }

  /// 1 for every node reachable from [node] (walking), 0 otherwise.
  Uint8List reachableFrom(int node) {
    final seen = Uint8List(nodeCount)..[node] = 1;
    final queue = Queue<int>()..add(node);
    while (queue.isNotEmpty) {
      for (final e in adj[queue.removeFirst()]) {
        if (seen[e.to] == 0) {
          seen[e.to] = 1;
          queue.add(e.to);
        }
      }
    }
    return seen;
  }

  // --- nearest-node lookup (lazy grid, ~110 m cells) ---
  static const _cell = 0.001;
  Map<int, List<int>>? _grid;
  late final double _lngScale = lat.isEmpty ? 1 : cos(lat[lat.length ~/ 2] * pi / 180);

  int _cx(double lng) => (lng * _lngScale / _cell).floor();
  int _cy(double lat) => (lat / _cell).floor();
  static int _key(int cy, int cx) => cy * 2000003 + cx;

  Map<int, List<int>> _buildGrid() {
    final g = <int, List<int>>{};
    for (var i = 0; i < nodeCount; i++) {
      g.putIfAbsent(_key(_cy(lat[i]), _cx(lng[i])), () => []).add(i);
    }
    return g;
  }

  /// Closest node to the point within [maxSnapM], optionally limited to nodes where [mask] is 1.
  ({int node, double distM})? nearestNode(double la, double lo, {Uint8List? mask, double maxSnapM = 300}) {
    final grid = _grid ??= _buildGrid();
    final rings = (maxSnapM / 100).ceil() + 1;
    final cy = _cy(la), cx = _cx(lo);
    int? best;
    var bestD = double.infinity;
    for (var dy = -rings; dy <= rings; dy++) {
      for (var dx = -rings; dx <= rings; dx++) {
        for (final n in grid[_key(cy + dy, cx + dx)] ?? const <int>[]) {
          if (mask != null && mask[n] == 0) continue;
          final d = distanceMeters(la, lo, lat[n], lng[n]);
          if (d < bestD || (d == bestD && n < best!)) {
            bestD = d;
            best = n;
          }
        }
      }
    }
    return best == null || bestD > maxSnapM ? null : (node: best, distM: bestD);
  }
}

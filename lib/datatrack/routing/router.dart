import 'dart:typed_data';

import '../tracks/data/candidate.dart' show distanceMeters;
import 'walk_graph.dart';

/// Binary min-heap keyed by double. Duplicate nodes are allowed (lazy deletion).
class _MinHeap {
  final List<double> _k = [];
  final List<int> _v = [];
  bool get isEmpty => _k.isEmpty;

  void push(double key, int value) {
    _k.add(key);
    _v.add(value);
    var i = _k.length - 1;
    while (i > 0) {
      final p = (i - 1) >> 1;
      if (_k[p] <= _k[i]) break;
      _swap(i, p);
      i = p;
    }
  }

  (double, int) pop() {
    final top = (_k[0], _v[0]);
    final lastK = _k.removeLast(), lastV = _v.removeLast();
    if (_k.isNotEmpty) {
      _k[0] = lastK;
      _v[0] = lastV;
      var i = 0;
      while (true) {
        final l = 2 * i + 1, r = l + 1;
        var m = i;
        if (l < _k.length && _k[l] < _k[m]) m = l;
        if (r < _k.length && _k[r] < _k[m]) m = r;
        if (m == i) break;
        _swap(i, m);
        i = m;
      }
    }
    return top;
  }

  void _swap(int a, int b) {
    final k = _k[a];
    _k[a] = _k[b];
    _k[b] = k;
    final v = _v[a];
    _v[a] = _v[b];
    _v[b] = v;
  }
}

class PathResult {
  final List<int> nodes;
  final double lengthM;
  final double cost;
  const PathResult(this.nodes, this.lengthM, this.cost);
}

/// Cheapest path by preference-weighted cost. Null if [to] is unreachable.
PathResult? astar(WalkGraph g, int from, int to) {
  final n = g.nodeCount;
  final best = Float64List(n)..fillRange(0, n, double.infinity);
  final len = Float64List(n);
  final parent = Int32List(n)..fillRange(0, n, -1);
  final closed = Uint8List(n);
  double h(int i) => distanceMeters(g.lat[i], g.lng[i], g.lat[to], g.lng[to]);

  final heap = _MinHeap()..push(h(from), from);
  best[from] = 0;
  while (!heap.isEmpty) {
    final (_, u) = heap.pop();
    if (closed[u] == 1) continue;
    closed[u] = 1;
    if (u == to) {
      final path = <int>[];
      for (var c = to; c != -1; c = parent[c]) {
        path.add(c);
      }
      return PathResult(path.reversed.toList(), len[to], best[to]);
    }
    for (final e in g.adj[u]) {
      final c = best[u] + e.cost;
      if (c < best[e.to]) {
        best[e.to] = c;
        len[e.to] = len[u] + e.len;
        parent[e.to] = u;
        heap.push(c + h(e.to), e.to);
      }
    }
  }
  return null;
}

class DijkstraResult {
  /// Cost to each node (infinity if beyond [maxCost] / unreachable).
  final Float64List cost;
  /// Walked length in metres along the cheapest path.
  final Float64List len;
  const DijkstraResult(this.cost, this.len);
}

DijkstraResult dijkstra(WalkGraph g, int from, {double maxCost = double.infinity}) {
  final n = g.nodeCount;
  final cost = Float64List(n)..fillRange(0, n, double.infinity);
  final len = Float64List(n)..fillRange(0, n, double.infinity);
  final closed = Uint8List(n);
  final heap = _MinHeap()..push(0, from);
  cost[from] = 0;
  len[from] = 0;
  while (!heap.isEmpty) {
    final (_, u) = heap.pop();
    if (closed[u] == 1) continue;
    closed[u] = 1;
    for (final e in g.adj[u]) {
      final c = cost[u] + e.cost;
      if (c <= maxCost && c < cost[e.to]) {
        cost[e.to] = c;
        len[e.to] = len[u] + e.len;
        heap.push(c, e.to);
      }
    }
  }
  return DijkstraResult(cost, len);
}

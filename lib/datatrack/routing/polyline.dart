import 'dart:math';

import 'latlng.dart';

/// Google encoded-polyline format (precision 1e-5 deg, ~1 m). Compact enough to store
/// a whole route in one TEXT column.
String encodePolyline(List<LatLng> points) {
  final sb = StringBuffer();
  var pLat = 0, pLng = 0;
  void put(int v) {
    var x = v < 0 ? ~(v << 1) : v << 1;
    while (x >= 0x20) {
      sb.writeCharCode((0x20 | (x & 0x1f)) + 63);
      x >>= 5;
    }
    sb.writeCharCode(x + 63);
  }

  for (final p in points) {
    final la = (p.lat * 1e5).round(), ln = (p.lng * 1e5).round();
    put(la - pLat);
    put(ln - pLng);
    pLat = la;
    pLng = ln;
  }
  return sb.toString();
}

List<LatLng> decodePolyline(String s) {
  final out = <LatLng>[];
  var i = 0, lat = 0, lng = 0;
  int next() {
    var result = 0, shift = 0;
    int b;
    do {
      b = s.codeUnitAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return (result & 1) != 0 ? ~(result >> 1) : result >> 1;
  }

  while (i < s.length) {
    lat += next();
    lng += next();
    out.add((lat: lat / 1e5, lng: lng / 1e5));
  }
  return out;
}

/// Douglas-Peucker. Returns the indices to keep (sorted). Indices in [keep], plus the
/// first and last point, are always kept so stops stay addressable after simplifying.
List<int> simplifyIndices(List<LatLng> pts, double toleranceM, {Set<int> keep = const {}}) {
  if (pts.length <= 2) return [for (var i = 0; i < pts.length; i++) i];
  final lat0 = pts.first.lat;
  final kx = cos(lat0 * pi / 180) * 111320.0;
  const ky = 110540.0;
  final xs = [for (final p in pts) (p.lng - pts.first.lng) * kx];
  final ys = [for (final p in pts) (p.lat - lat0) * ky];

  double dist(int i, int a, int b) {
    final dx = xs[b] - xs[a], dy = ys[b] - ys[a];
    final len2 = dx * dx + dy * dy;
    if (len2 == 0) return sqrt(pow(xs[i] - xs[a], 2) + pow(ys[i] - ys[a], 2));
    final t = (((xs[i] - xs[a]) * dx + (ys[i] - ys[a]) * dy) / len2).clamp(0.0, 1.0);
    return sqrt(pow(xs[i] - (xs[a] + t * dx), 2) + pow(ys[i] - (ys[a] + t * dy), 2));
  }

  final anchors = <int>{0, pts.length - 1, ...keep.where((i) => i >= 0 && i < pts.length)}.toList()..sort();
  final kept = <int>{...anchors};
  for (var k = 0; k + 1 < anchors.length; k++) {
    final stack = <(int, int)>[(anchors[k], anchors[k + 1])];
    while (stack.isNotEmpty) {
      final (a, b) = stack.removeLast();
      var worst = -1.0, idx = -1;
      for (var i = a + 1; i < b; i++) {
        final d = dist(i, a, b);
        if (d > worst) {
          worst = d;
          idx = i;
        }
      }
      if (idx != -1 && worst > toleranceM) {
        kept.add(idx);
        stack..add((a, idx))..add((idx, b));
      }
    }
  }
  return kept.toList()..sort();
}

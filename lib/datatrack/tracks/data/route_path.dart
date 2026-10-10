import '../../interfaces/types.dart';
import 'candidate.dart';

/// Straight-line walking path: start -> each stop in route order.
/// Pure geometry, so it needs no network and can be rebuilt on every render.
class RoutePath {
  final List<({double lat, double lng})> points;
  /// Metres for each leg (`points.length - 1` values, rounded).
  final List<int> legsM;
  int get totalM => legsM.fold(0, (a, b) => a + b);

  const RoutePath(this.points, this.legsM);

  Map<String, Object?> toJson() => {
        'points': [for (final p in points) {'lat': p.lat, 'lng': p.lng}],
        'legs_m': legsM,
        'total_m': totalM,
      };
}

RoutePath buildRoutePath(double startLat, double startLng, List<Stop> stops) {
  final ordered = [...stops]..sort((a, b) => a.position.compareTo(b.position));
  final points = <({double lat, double lng})>[
    (lat: startLat, lng: startLng),
    for (final s in ordered) (lat: s.lat, lng: s.lng),
  ];
  final legs = <int>[
    for (var i = 1; i < points.length; i++)
      distanceMeters(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng).round(),
  ];
  return RoutePath(points, legs);
}

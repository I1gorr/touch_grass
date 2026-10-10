import 'dart:math';

import '../interfaces/types.dart';

/// Great-circle distance (haversine), in metres.
double distanceMeters(Location a, Location b) {
  const r = 6371000.0;
  double rad(double d) => d * pi / 180;
  final dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  final h = sin(dLat / 2) * sin(dLat / 2) + cos(rad(a.lat)) * cos(rad(b.lat)) * sin(dLng / 2) * sin(dLng / 2);
  return 2 * r * asin(sqrt(min(1.0, h)));
}

Location locationOf(Stop s) => Location(s.lat, s.lng);

/// Length of the loop start → stops (in order) → start, in metres.
double loopLengthMeters(Location start, List<Stop> stops) {
  if (stops.isEmpty) return 0;
  var total = distanceMeters(start, locationOf(stops.first));
  for (var i = 1; i < stops.length; i++) {
    total += distanceMeters(locationOf(stops[i - 1]), locationOf(stops[i]));
  }
  return total + distanceMeters(locationOf(stops.last), start);
}

/// Identity of a real-world place across walks (stop row ids differ per walk).
String stopKey(Stop s) => s.osmId.isNotEmpty ? s.osmId : '${s.name}@${s.lat},${s.lng}';

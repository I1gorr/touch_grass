import '../../interfaces/types.dart';
import 'candidate.dart';

/// Greedy nearest-neighbour ordering starting from [start].
List<Candidate> orderNearestNeighbour(Location start, List<Candidate> picks) {
  final remaining = [...picks];
  final out = <Candidate>[];
  var lat = start.lat, lng = start.lng;
  while (remaining.isNotEmpty) {
    remaining.sort((a, b) {
      final c = distanceMeters(lat, lng, a.lat, a.lng).compareTo(distanceMeters(lat, lng, b.lat, b.lng));
      return c != 0 ? c : a.osmId.compareTo(b.osmId);
    });
    final next = remaining.removeAt(0);
    out.add(next);
    lat = next.lat;
    lng = next.lng;
  }
  return out;
}

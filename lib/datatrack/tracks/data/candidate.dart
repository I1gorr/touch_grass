import 'dart:convert';
import 'dart:math';

import '../../interfaces/types.dart';

class Candidate {
  final String osmId;
  final String name;
  final double lat;
  final double lng;
  final Map<String, String> tags;

  const Candidate({
    required this.osmId,
    required this.name,
    required this.lat,
    required this.lng,
    required this.tags,
  });

  /// Primary category used for variety and scoring, e.g. "tourism=artwork".
  String get category {
    for (final k in const ['tourism', 'historic', 'leisure', 'amenity', 'natural', 'man_made']) {
      final v = tags[k];
      if (v != null) return '$k=${k == 'historic' ? '*' : v}';
    }
    return 'other';
  }

  String get tagsJson => jsonEncode(tags);

  Stop toStop(String id, {String prompt = ''}) => Stop(
        id: id,
        osmId: osmId,
        name: name,
        lat: lat,
        lng: lng,
        tagsJson: tagsJson,
        prompt: prompt,
      );
}

/// Parses an Overpass JSON body (`out center`) into candidates.
List<Candidate> parseOverpass(String body) {
  final data = jsonDecode(body) as Map<String, dynamic>;
  final out = <Candidate>[];
  for (final e in (data['elements'] as List? ?? const [])) {
    final m = e as Map<String, dynamic>;
    final center = m['center'] as Map<String, dynamic>?;
    final lat = (m['lat'] ?? center?['lat']) as num?;
    final lng = (m['lon'] ?? center?['lon']) as num?;
    if (lat == null || lng == null) continue;
    final tags = ((m['tags'] as Map?) ?? const {}).map((k, v) => MapEntry('$k', '$v'));
    out.add(Candidate(
      osmId: '${m['type']}/${m['id']}',
      name: tags['name'] ?? '',
      lat: lat.toDouble(),
      lng: lng.toDouble(),
      tags: tags,
    ));
  }
  return out;
}

/// Haversine distance in metres.
double distanceMeters(double lat1, double lng1, double lat2, double lng2) {
  const r = 6371000.0;
  double rad(double d) => d * pi / 180;
  final dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  final a = pow(sin(dLat / 2), 2) + cos(rad(lat1)) * cos(rad(lat2)) * pow(sin(dLng / 2), 2);
  return 2 * r * asin(sqrt(a));
}

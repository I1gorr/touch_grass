import 'dart:convert';

import '../../models/walk_bundle.dart';
import '../../routing/polyline.dart';
import 'route_path.dart';

/// The final JSON the UI renders a walk from. Built purely from [WalkBundle]
/// (SQLite rows), so it never needs the network. Field names match DATA_SCHEMA.md;
/// sync columns (`updated_at`, `synced_at`) are intentionally left out.
Map<String, Object?> renderWalkJson(WalkBundle b) {
  final path = _storedPath(b.walk.routeJson) ?? buildRoutePath(b.walk.startLat, b.walk.startLng, b.stops).toJson();
  return {
    // The route lives under `path`; keep the walk object small.
    'walk': {...b.walk.toRow()}..remove('route_json'),
    'stops': [
      for (final s in b.stops)
        {
          ...s.toRow(),
          'tags': _tags(s.tagsJson),
          'entries': [for (final e in b.entriesOf(s.id)) e.toRow()],
        },
    ],
    'path': path,
  };
}

String renderWalkJsonString(WalkBundle b, {bool pretty = false}) =>
    (pretty ? const JsonEncoder.withIndent('  ') : const JsonEncoder()).convert(renderWalkJson(b));

Map<String, Object?> _tags(String tagsJson) {
  try {
    final v = jsonDecode(tagsJson);
    return v is Map ? v.map((k, v) => MapEntry('$k', v)) : const {};
  } catch (_) {
    return const {};
  }
}

/// The planned route saved on the walk, decoded for rendering. Null if absent or unreadable
/// (the caller then falls back to straight lines between the stops).
Map<String, Object?>? _storedPath(String? routeJson) {
  if (routeJson == null) return null;
  try {
    final r = jsonDecode(routeJson) as Map<String, dynamic>;
    final points = decodePolyline(r['polyline'] as String);
    return {
      'points': [for (final p in points) {'lat': p.lat, 'lng': p.lng}],
      'legs_m': r['legs_m'],
      'total_m': r['total_m'],
      'duration_s': r['duration_s'],
      'mode': r['mode'],
      'stop_point_index': r['stop_point_index'],
    };
  } catch (_) {
    return null;
  }
}

import 'dart:convert';

/// One walkable OSM way in the compact form stored in an offline pack:
/// `{id, h: highway class, n: [node ids], g: [lat, lon, lat, lon, ...]}`.
class WalkWay {
  final int id;
  final String highway;
  final List<int> nodes;
  /// Flat lat/lon pairs, same length as `nodes * 2`.
  final List<double> coords;

  const WalkWay(this.id, this.highway, this.nodes, this.coords);

  Map<String, Object?> toJson() => {'id': id, 'h': highway, 'n': nodes, 'g': coords};

  factory WalkWay.fromJson(Map<String, dynamic> j) => WalkWay(
        j['id'] as int,
        j['h'] as String,
        [for (final n in j['n'] as List) n as int],
        [for (final g in j['g'] as List) (g as num).toDouble()],
      );
}

const _excludedHighways = {
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'construction', 'proposed', 'raceway',
  'bus_guideway', 'corridor', 'elevator', 'escape', 'platform', 'bus_stop', 'rest_area', 'services',
};

double _round6(num v) => (v * 1e6).round() / 1e6;

/// Parses an Overpass `out geom` body of highway ways into compact [WalkWay]s.
/// Drops non-walkable ways (motorways, `foot=no`, private access, ...) and broken geometry.
List<WalkWay> parseWays(String body) {
  final data = jsonDecode(body) as Map<String, dynamic>;
  final out = <WalkWay>[];
  for (final e in (data['elements'] as List? ?? const [])) {
    final m = e as Map<String, dynamic>;
    if (m['type'] != 'way') continue;
    final tags = (m['tags'] as Map?) ?? const {};
    final h = tags['highway'];
    if (h is! String || _excludedHighways.contains(h)) continue;
    if (tags['foot'] == 'no' || tags['access'] == 'private' || tags['access'] == 'no') continue;
    final nodes = m['nodes'] as List?;
    final geom = m['geometry'] as List?;
    if (nodes == null || geom == null || nodes.length < 2 || nodes.length != geom.length) continue;
    final coords = <double>[];
    var ok = true;
    for (final g in geom) {
      if (g is! Map || g['lat'] == null || g['lon'] == null) {
        ok = false;
        break;
      }
      coords..add(_round6(g['lat'] as num))..add(_round6(g['lon'] as num));
    }
    if (!ok) continue;
    out.add(WalkWay(m['id'] as int, h, [for (final n in nodes) n as int], coords));
  }
  return out;
}

import 'dart:convert';
import 'dart:math';

import 'package:touch_grass/datatrack/interfaces/types.dart';
import 'package:touch_grass/datatrack/routing/walk_way.dart';
import 'package:touch_grass/datatrack/tracks/data/candidate.dart';

/// A square street grid: [n] x [n] nodes, ~[spacingM] metres apart, centred on [center].
class Grid {
  final int n;
  final double spacingM;
  final Location center;
  late final double dLat = spacingM / 110540;
  late final double dLng = spacingM / (111320 * cos(center.lat * pi / 180));

  Grid(this.n, {this.spacingM = 100, this.center = const Location(40.7829, -73.9654)});

  double latAt(int r) => center.lat + (r - n ~/ 2) * dLat;
  double lngAt(int c) => center.lng + (c - n ~/ 2) * dLng;
  int idAt(int r, int c) => r * 1000 + c + 1;

  /// Rows and columns as footways. Pass [skip] to remove grid edges (r1,c1,r2,c2) and make obstacles.
  List<WalkWay> ways({String highway = 'footway', bool Function(int r1, int c1, int r2, int c2)? skip}) {
    final out = <WalkWay>[];
    var wid = 1;
    for (var r = 0; r < n; r++) {
      for (var c = 0; c + 1 < n; c++) {
        if (skip != null && skip(r, c, r, c + 1)) continue;
        out.add(_seg(wid++, highway, r, c, r, c + 1));
      }
    }
    for (var c = 0; c < n; c++) {
      for (var r = 0; r + 1 < n; r++) {
        if (skip != null && skip(r, c, r + 1, c)) continue;
        out.add(_seg(wid++, highway, r, c, r + 1, c));
      }
    }
    return out;
  }

  WalkWay _seg(int id, String h, int r1, int c1, int r2, int c2) =>
      WalkWay(id, h, [idAt(r1, c1), idAt(r2, c2)], [latAt(r1), lngAt(c1), latAt(r2), lngAt(c2)]);

  Candidate poi(String name, int r, int c, Map<String, String> tags) => Candidate(
        osmId: 'node/${name.hashCode.abs()}',
        name: name,
        lat: latAt(r),
        lng: lngAt(c),
        tags: {'name': name, ...tags},
      );

  /// A handful of POIs spread around the centre, with mixed categories.
  List<Candidate> pois() => [
        poi('Fountain A', 12, 10, {'amenity': 'fountain'}),
        poi('Mural B', 10, 14, {'tourism': 'artwork'}),
        poi('View C', 6, 10, {'tourism': 'viewpoint'}),
        poi('Garden D', 10, 5, {'leisure': 'garden'}),
        poi('Chapel E', 14, 13, {'amenity': 'place_of_worship'}),
        poi('Park F', 8, 15, {'leisure': 'park'}),
        poi('Old Gate G', 15, 8, {'historic': 'gate'}),
        poi('Far Statue H', 20, 20, {'tourism': 'artwork'}),
      ];
}

extension GridOverpass on Grid {
  /// The grid as an Overpass `out geom` response.
  String overpassWaysBody() => jsonEncode({
        'elements': [
          for (final w in ways())
            {
              'type': 'way',
              'id': w.id,
              'nodes': w.nodes,
              'geometry': [
                for (var i = 0; i < w.nodes.length; i++) {'lat': w.coords[2 * i], 'lon': w.coords[2 * i + 1]},
              ],
              'tags': {'highway': w.highway},
            },
        ],
      });

  /// [pois] as an Overpass `out center` response.
  String overpassPoisBody() => jsonEncode({
        'elements': [
          for (final (i, c) in pois().indexed) {'type': 'node', 'id': i + 1, 'lat': c.lat, 'lon': c.lng, 'tags': c.tags},
        ],
      });
}

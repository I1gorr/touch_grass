import 'dart:convert';
import 'dart:math';

import 'package:touch_grass/interfaces/quest_builder.dart';
import 'package:touch_grass/interfaces/types.dart';

/// Test place pool. Returns a candidate
/// pool of up to 12 places spread 120 m–1.1 km around [location] (golden-angle
/// spiral), so the route planner has real choices of length and direction.
class FakeQuestBuilder implements QuestBuilder {
  final Duration latency;
  final int count;
  const FakeQuestBuilder({this.latency = const Duration(milliseconds: 400), this.count = 12});

  static const _places = [
    ('Old Oak Tree', {'natural': 'tree', 'species': 'Quercus robur'}),
    ('Corner Bench', {'amenity': 'bench', 'backrest': 'yes'}),
    ('Drinking Fountain', {'amenity': 'drinking_water'}),
    ('Park Memorial', {'historic': 'memorial', 'memorial': 'plaque'}),
    ('Pond Viewpoint', {'tourism': 'viewpoint'}),
    ('Community Garden', {'leisure': 'garden'}),
    ('Mural Wall', {'tourism': 'artwork', 'artwork_type': 'mural'}),
    ('Little Library', {'amenity': 'public_bookcase'}),
    ('Stone Bridge', {'man_made': 'bridge'}),
    ('Wildflower Meadow', {'natural': 'grassland'}),
    ('Bandstand', {'leisure': 'bandstand'}),
    ('Sundial', {'man_made': 'sundial'}),
  ];

  @override
  Future<List<Stop>> build(Location location) async {
    await Future<void>.delayed(latency);
    const metersPerDegLat = 111320.0;
    // Clamp so the poles don't divide by ~0.
    final metersPerDegLng = metersPerDegLat * max(0.01, cos(location.lat * pi / 180));
    const goldenAngle = 2.39996323;
    final n = count.clamp(0, _places.length);
    return [
      for (var i = 0; i < n; i++)
        () {
          final r = 120 + 980 * i / max(1, _places.length - 1); // 120 m … 1.1 km
          final a = i * goldenAngle;
          return Stop(
            id: 'fake-$i',
            osmId: 'node/${9000000000 + i}',
            name: _places[i].$1,
            lat: location.lat + r * sin(a) / metersPerDegLat,
            lng: location.lng + r * cos(a) / metersPerDegLng,
            tagsJson: jsonEncode(_places[i].$2),
          );
        }(),
    ];
  }
}

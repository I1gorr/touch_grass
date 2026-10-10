import '../../routing/place_card.dart';
import '../../routing/route_recommender.dart';
import 'route_service.dart';

/// The data for the route review screen: every option with its stops, what people said about each,
/// and the geometry to draw. The person can keep one, skip places, or recalculate
/// (`RouteService.recalculate`). Pure data, so the UI only renders it.
Map<String, Object?> previewJson(List<RecommendedRoute> routes) => {
      'options': [
        for (final (i, r) in routes.indexed) optionPreview(i, r.option, r.quest.walk.id),
      ],
    };

Map<String, Object?> optionPreview(int index, RouteOption o, String walkId) => {
      'index': index,
      'walk_id': walkId,
      'mode': o.mode,
      'total_m': o.totalM,
      'duration_s': o.durationS,
      'path': [for (final p in o.points) {'lat': p.lat, 'lng': p.lng}],
      'stops': [
        for (final (i, PlaceCard c) in o.cards.indexed)
          {
            'position': i,
            ...c.toJson(),
            'point_index': o.stopPointIndex[i],
            'leg_m': o.legsM[i],
          },
      ],
      'return_leg_m': o.legsM.last,
    };

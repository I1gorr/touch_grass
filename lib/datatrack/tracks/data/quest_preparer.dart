import '../../interfaces/quest_builder.dart';
import '../../interfaces/types.dart';
import '../../models/ids.dart';
import '../../models/walk.dart';
import 'weather_client.dart';

/// Everything needed to create a `walk` row plus its `stop` rows.
/// Stops are in route order with ids `<walkId>-<position>`.
class PreparedQuest {
  final Walk walk;
  final List<Stop> stops;
  const PreparedQuest(this.walk, this.stops);

  String get weatherSummary => walk.weatherSummary;
  String get timeOfDay => walk.timeOfDay;
}

String timeOfDayFor(DateTime t) {
  final h = t.hour;
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

/// Runs the quest build and the weather snapshot in parallel. This is the online
/// prepare step: the only part of a walk that may use the network.
class QuestPreparer {
  final QuestBuilder builder;
  final WeatherService weather;
  final DateTime Function() clock;
  final String Function() idGenerator;

  QuestPreparer({
    required this.builder,
    required this.weather,
    DateTime Function()? clock,
    String Function()? idGenerator,
  })  : clock = clock ?? DateTime.now,
        idGenerator = idGenerator ?? newId;

  Future<PreparedQuest> prepare(Location location) async {
    final results = await Future.wait([builder.build(location), weather.snapshot(location)]);
    final now = clock();
    final walk = Walk(
      id: idGenerator(),
      createdAt: now.millisecondsSinceEpoch,
      startLat: location.lat,
      startLng: location.lng,
      timeOfDay: timeOfDayFor(now),
      weatherSummary: results[1] as String,
      status: WalkStatus.ready,
    );
    final stops = [
      for (final (i, s) in (results[0] as List<Stop>).indexed)
        s.copyWith(id: stopIdFor(walk.id, i), walkId: walk.id, position: i),
    ];
    return PreparedQuest(walk, stops);
  }
}

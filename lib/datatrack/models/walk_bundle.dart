import '../interfaces/types.dart';
import 'entry.dart';
import 'walk.dart';

/// A walk with its stops (in route order) and each stop's entries, as read from SQLite.
class WalkBundle {
  final Walk walk;
  final List<Stop> stops;
  final Map<String, List<Entry>> entriesByStop;

  const WalkBundle(this.walk, this.stops, this.entriesByStop);

  List<Entry> entriesOf(String stopId) => entriesByStop[stopId] ?? const [];
}

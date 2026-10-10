import 'types.dart';

// Owned by Person 3 (Data & Quest logic).
abstract class QuestBuilder {
  Future<List<Stop>> build(Location location);
}

import '../interfaces/types.dart';
import '../models/entry.dart';
import '../models/walk.dart';
import '../models/walk_photo.dart';

/// Persistence contract for walks, stops and entries. UI and services depend
/// on this, never on sqflite directly; use MemoryWalkRepository in tests.
abstract class WalkRepository {
  Future<void> insertWalk(Walk walk, List<Stop> stops);
  Future<void> updateWalkStatus(String walkId, WalkStatus status);
  Future<Walk?> getWalk(String walkId);

  /// Newest first.
  Future<List<Walk>> listWalks();
  Future<List<Stop>> stopsForWalk(String walkId);

  Future<void> insertEntry(Entry entry);

  /// Sets only the non-null fields.
  Future<void> updateEntry(String entryId, {String? rawTranscript, String? cleanedText});
  Future<Entry?> getEntry(String entryId);

  /// Oldest first. Entries carry `hasPhoto`.
  Future<List<Entry>> entriesForStop(String stopId);
  Future<List<Entry>> entriesForWalk(String walkId);

  /// Moves an entry to another stop (e.g. a photo-only entry when its photo
  /// is retaken elsewhere) and resets its time.
  Future<void> moveEntry(String entryId, {required String stopId, required DateTime recordedAt});

  /// Stores the walk's single photo (one per walk), replacing any previous one.
  /// If [newEntry] is given it is inserted in the same transaction, so a
  /// failed photo write never leaves an empty entry behind.
  /// Images live only here, in the local database; they are never synced.
  Future<void> putWalkPhoto(WalkPhoto photo, {Entry? newEntry});
  Future<WalkPhoto?> walkPhoto(String walkId);

  /// The stored photo's identity without its bytes (cheap change check).
  Future<PhotoStamp?> walkPhotoStamp(String walkId);

  /// Fires after every write, for UIs that re-query.
  Stream<void> get changes;

  /// Fires [changes] for writes made by another writer on the same database
  /// (the data track's repository), so screens and sync react to them too.
  void notifyExternalChange();

  /// Raw rows per table, for the DB viewer (acceptance step 8). Photo BLOBs
  /// are summarised as `<N bytes>`, not returned.
  Future<Map<String, List<Map<String, Object?>>>> dumpTables();

  Future<void> close();
}

Map<String, Object?> stopToRow(Stop s, String walkId, int position) => {
  'id': s.id,
  'walk_id': walkId,
  'position': position,
  'osm_id': s.osmId,
  'name': s.name,
  'lat': s.lat,
  'lng': s.lng,
  'tags_json': s.tagsJson,
  'blurb': s.blurb,
  'prompt': s.prompt,
};

Stop stopFromRow(Map<String, Object?> m) => Stop(
  id: m['id'] as String,
  osmId: (m['osm_id'] as String?) ?? '',
  name: (m['name'] as String?) ?? '',
  lat: (m['lat'] as num).toDouble(),
  lng: (m['lng'] as num).toDouble(),
  tagsJson: (m['tags_json'] as String?) ?? '{}',
  blurb: (m['blurb'] as String?) ?? '',
  prompt: (m['prompt'] as String?) ?? '',
);

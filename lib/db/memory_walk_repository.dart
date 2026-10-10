import 'dart:async';

import '../interfaces/types.dart';
import '../models/entry.dart';
import '../models/walk.dart';
import '../models/walk_photo.dart';
import 'walk_repository.dart';

/// In-memory WalkRepository for tests and desk demos. Same semantics as sqflite.
class MemoryWalkRepository implements WalkRepository {
  final _walks = <String, Walk>{};
  final _stops = <String, List<Stop>>{}; // walkId -> ordered stops
  final _entries = <String, Entry>{};
  final _photos = <String, WalkPhoto>{}; // walkId -> photo
  final _changes = StreamController<void>.broadcast();

  void _changed() => _changes.add(null);

  @override
  Stream<void> get changes => _changes.stream;

  @override
  void notifyExternalChange() => _changed();

  @override
  Future<void> insertWalk(Walk walk, List<Stop> stops) async {
    _walks[walk.id] = walk;
    _stops[walk.id] = List.of(stops);
    _changed();
  }

  @override
  Future<void> updateWalkStatus(String walkId, WalkStatus status) async {
    final w = _walks[walkId];
    if (w != null) _walks[walkId] = w.copyWith(status: status);
    _changed();
  }

  @override
  Future<Walk?> getWalk(String walkId) async => _walks[walkId];

  @override
  Future<List<Walk>> listWalks() async => _walks.values.toList()..sort((a, b) => b.createdAt.compareTo(a.createdAt));

  @override
  Future<List<Stop>> stopsForWalk(String walkId) async => List.of(_stops[walkId] ?? const []);

  @override
  Future<void> insertEntry(Entry entry) async {
    _entries[entry.id] = entry;
    _changed();
  }

  @override
  Future<void> updateEntry(String entryId, {String? rawTranscript, String? cleanedText}) async {
    final e = _entries[entryId];
    if (e == null) throw StateError('entry $entryId not found');
    _entries[entryId] = Entry(
      id: e.id,
      stopId: e.stopId,
      recordedAt: e.recordedAt,
      rawTranscript: rawTranscript ?? e.rawTranscript,
      cleanedText: cleanedText ?? e.cleanedText,
    );
    _changed();
  }

  Entry _withPhotoFlag(Entry e) => e.withPhoto(_photos.values.any((p) => p.entryId == e.id));

  @override
  Future<Entry?> getEntry(String entryId) async {
    final e = _entries[entryId];
    return e == null ? null : _withPhotoFlag(e);
  }

  @override
  Future<List<Entry>> entriesForStop(String stopId) async =>
      _entries.values.where((e) => e.stopId == stopId).map(_withPhotoFlag).toList()
        ..sort((a, b) => a.recordedAt.compareTo(b.recordedAt));

  @override
  Future<List<Entry>> entriesForWalk(String walkId) async {
    final out = <Entry>[];
    for (final s in _stops[walkId] ?? const <Stop>[]) {
      out.addAll(await entriesForStop(s.id));
    }
    return out;
  }

  @override
  Future<void> moveEntry(String entryId, {required String stopId, required DateTime recordedAt}) async {
    final e = _entries[entryId];
    if (e == null) throw StateError('entry $entryId not found');
    _entries[entryId] = Entry(
      id: e.id,
      stopId: stopId,
      recordedAt: recordedAt,
      rawTranscript: e.rawTranscript,
      cleanedText: e.cleanedText,
    );
    _changed();
  }

  /// Test hook: make the next photo write fail (simulates a full disk).
  Object? failNextPhotoWrite;

  @override
  Future<void> putWalkPhoto(WalkPhoto photo, {Entry? newEntry}) async {
    final fail = failNextPhotoWrite;
    if (fail != null) {
      failNextPhotoWrite = null;
      throw fail; // nothing written, like a rolled-back transaction
    }
    if (newEntry != null) _entries[newEntry.id] = newEntry;
    _photos[photo.walkId] = photo;
    _changed();
  }

  @override
  Future<WalkPhoto?> walkPhoto(String walkId) async => _photos[walkId];

  @override
  Future<PhotoStamp?> walkPhotoStamp(String walkId) async => _photos[walkId]?.stamp;

  @override
  Future<Map<String, List<Map<String, Object?>>>> dumpTables() async => {
    'walk': [for (final w in _walks.values) w.toMap()],
    'stop': [
      for (final e in _stops.entries)
        for (var i = 0; i < e.value.length; i++) stopToRow(e.value[i], e.key, i),
    ],
    'entry': [for (final e in _entries.values) e.toMap()],
    'photo': [
      for (final p in _photos.values) {...p.toMap(), 'data': '<${p.bytes.length} bytes>'},
    ],
  };

  @override
  Future<void> close() => _changes.close();
}

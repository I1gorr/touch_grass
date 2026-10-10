import 'dart:math';

import 'package:sqflite/sqflite.dart';

import '../interfaces/types.dart';
import '../models/entry.dart';
import '../models/ids.dart';
import '../models/place_stats.dart';
import '../models/walk.dart';
import '../models/walk_bundle.dart';
import '../tracks/data/quest_preparer.dart';

/// All app reads and writes go through here (SQLite is the source of truth).
/// Nothing in this class touches the network, so a walk works in airplane mode.
class WalkRepository {
  final Database db;
  final int Function() _nowMs;
  int _last = 0;

  WalkRepository(this.db, {int Function()? nowMs}) : _nowMs = nowMs ?? (() => DateTime.now().millisecondsSinceEpoch);

  /// Version stamp for new rows: strictly increasing even if the clock jumps back.
  int _nextVersion() => _last = max(_nowMs(), _last + 1);

  /// Stores the prepared walk and its stops in one transaction.
  Future<void> saveQuest(PreparedQuest q) async {
    final v = _nextVersion();
    await db.transaction((txn) async {
      await txn.insert('walk', {...q.walk.toRow(), 'updated_at': v}, conflictAlgorithm: ConflictAlgorithm.replace);
      for (final s in q.stops) {
        await txn.insert('stop', {...s.toRow(), 'updated_at': v}, conflictAlgorithm: ConflictAlgorithm.replace);
      }
    });
  }

  Future<List<Walk>> walks() async {
    final rows = await db.query('walk', orderBy: 'created_at DESC');
    return [for (final r in rows) Walk.fromRow(r)];
  }

  Future<Walk?> getWalk(String id) async {
    final rows = await db.query('walk', where: 'id = ?', whereArgs: [id]);
    return rows.isEmpty ? null : Walk.fromRow(rows.first);
  }

  /// Walk, its stops in route order and each stop's entries by time.
  Future<WalkBundle?> loadWalk(String id) async {
    final walk = await getWalk(id);
    if (walk == null) return null;
    final stopRows = await db.query('stop', where: 'walk_id = ?', whereArgs: [id], orderBy: 'position');
    final stops = [for (final r in stopRows) Stop.fromRow(r)];
    final entries = <String, List<Entry>>{};
    for (final s in stops) {
      final rows = await db.query('entry', where: 'stop_id = ?', whereArgs: [s.id], orderBy: 'recorded_at');
      entries[s.id] = [for (final r in rows) Entry.fromRow(r)];
    }
    return WalkBundle(walk, stops, entries);
  }

  /// This person's visits per place (OSM id), counting finished walks only. Used to rotate recommendations.
  Future<Map<String, PlaceHistory>> placeHistory() async {
    final rows = await db.rawQuery(
      'SELECT s.osm_id AS osm_id, COUNT(DISTINCT w.id) AS visits, MAX(w.created_at) AS last '
      'FROM stop s JOIN walk w ON w.id = s.walk_id '
      "WHERE w.status = ? AND s.osm_id IS NOT NULL AND s.osm_id != '' GROUP BY s.osm_id",
      [WalkStatus.done.name],
    );
    return {
      for (final r in rows) r['osm_id'] as String: PlaceHistory((r['visits'] as num).toInt(), (r['last'] as num?)?.toInt() ?? 0),
    };
  }

  /// True while any walk is being walked. Sync is blocked in that state.
  Future<bool> hasActiveWalk() async {
    final rows = await db.query('walk', columns: ['id'], where: 'status = ?', whereArgs: [WalkStatus.active.name], limit: 1);
    return rows.isNotEmpty;
  }

  /// Moves a walk forward (preparing -> ready -> active -> done). Going back throws.
  Future<void> setStatus(String walkId, WalkStatus status) async {
    final walk = await getWalk(walkId);
    if (walk == null) throw StateError('No walk $walkId');
    if (status.index < walk.status.index) {
      throw StateError('Walk status cannot go from ${walk.status.name} back to ${status.name}');
    }
    await _update('walk', walkId, {'status': status.name});
  }

  /// The entry row exists before transcription so the UI can show it at once.
  Future<Entry> createEntry({required String stopId, String? photoPath}) async {
    final v = _nextVersion();
    final e = Entry(id: newId(), stopId: stopId, recordedAt: v, photoPath: photoPath);
    await db.insert('entry', {...e.toRow(), 'updated_at': v});
    return e;
  }

  /// `''` means silence; null (never set) means not transcribed yet.
  Future<void> setRawTranscript(String entryId, String text) => _update('entry', entryId, {'raw_transcript': text});
  Future<void> setCleanedText(String entryId, String text) => _update('entry', entryId, {'cleaned_text': text});
  Future<void> setPhotoPath(String entryId, String path) => _update('entry', entryId, {'photo_path': path});

  /// Publishes [text] (default: this entry's cleaned text) to people nearby. Opt-in, per entry.
  /// Stores a snapshot trimmed to 280 chars, so editing the private note later changes nothing public.
  /// Throws if there is nothing to share (transcripts are never shared).
  Future<void> shareEntry(String entryId, {String? text}) async {
    final rows = await db.query('entry', columns: ['cleaned_text'], where: 'id = ?', whereArgs: [entryId]);
    if (rows.isEmpty) throw StateError('No entry $entryId');
    final source = (text ?? rows.first['cleaned_text'] as String? ?? '').trim();
    if (source.isEmpty) throw StateError('Nothing to share: the entry has no cleaned text yet');
    final snippet = source.length <= Entry.maxSharedChars ? source : source.substring(0, Entry.maxSharedChars);
    await _update('entry', entryId, {'shared': 1, 'shared_text': snippet});
  }

  /// Takes the note back. It disappears for others after the next sync and pack refresh.
  Future<void> unshareEntry(String entryId) => _update('entry', entryId, {'shared': 0, 'shared_text': null});

  Future<void> setBlurb(String stopId, String blurb) => _update('stop', stopId, {'blurb': blurb});

  /// `updated_at = max(now, old + 1)`, so an edit always looks newer than its last upload.
  Future<void> _update(String table, String id, Map<String, Object?> values) async {
    final sets = [...values.keys.map((k) => '$k = ?'), 'updated_at = MAX(?, COALESCE(updated_at, 1) + 1)'].join(', ');
    final n = await db.rawUpdate('UPDATE $table SET $sets WHERE id = ?', [...values.values, _nowMs(), id]);
    if (n == 0) throw StateError('No $table $id');
  }
}

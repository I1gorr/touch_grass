import 'package:sqflite/sqflite.dart';

import 'schema.dart';

/// Rows waiting to be uploaded, as raw column maps (incl. `updated_at`, minus `synced_at`).
class PendingRows {
  final Map<String, List<Map<String, Object?>>> byTable;
  const PendingRows(this.byTable);

  List<Map<String, Object?>> get walks => byTable['walk'] ?? const [];
  List<Map<String, Object?>> get stops => byTable['stop'] ?? const [];
  List<Map<String, Object?>> get entries => byTable['entry'] ?? const [];
  int get count => byTable.values.fold(0, (a, l) => a + l.length);
  bool get isEmpty => count == 0;
}

class SyncQueue {
  final Database db;
  SyncQueue(this.db);

  static const _needsUpload = 'COALESCE(updated_at, 1) > COALESCE(synced_at, 0)';

  /// Up to [limit] rows in total, parents first (walks, stops, entries).
  Future<PendingRows> pending({int limit = 1000}) async {
    final out = <String, List<Map<String, Object?>>>{};
    var left = limit;
    for (final t in kTables) {
      if (left <= 0) break;
      final rows = await db.query(t, where: _needsUpload, orderBy: 'COALESCE(updated_at, 1), id', limit: left);
      out[t] = [for (final r in rows) _forUpload(t, r)];
      left -= rows.length;
    }
    return PendingRows(out);
  }

  /// Strips local bookkeeping, and for entries replaces the phone-local
  /// `photo_path` with a `has_photo` flag: the server only needs to know a
  /// photo exists, and paths (or images) never leave the phone.
  static Map<String, Object?> _forUpload(String table, Map<String, Object?> row) {
    final out = {...row}..remove('synced_at');
    if (table == 'entry') {
      final path = out.remove('photo_path');
      out['has_photo'] = path is String && path.trim().isNotEmpty ? 1 : 0;
    }
    return out;
  }

  /// Records the *uploaded* version (never "now"), so an edit made while the upload
  /// was in flight (higher `updated_at`) stays pending.
  Future<void> markSynced(String table, String id, int? uploadedUpdatedAt) async {
    assert(kTables.contains(table));
    await db.rawUpdate('UPDATE $table SET synced_at = MAX(COALESCE(synced_at, 0), ?) WHERE id = ?', [
      uploadedUpdatedAt ?? 1,
      id,
    ]);
  }

  Future<int> pendingCount() async {
    var n = 0;
    for (final t in kTables) {
      n += Sqflite.firstIntValue(await db.rawQuery('SELECT COUNT(*) FROM $t WHERE $_needsUpload')) ?? 0;
    }
    return n;
  }
}

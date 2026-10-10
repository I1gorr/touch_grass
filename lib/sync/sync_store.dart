/// Rows not yet uploaded, per table, in upload order (walk → stop → entry).
class SyncBatch {
  final Map<String, List<Map<String, Object?>>> rows;
  const SyncBatch(this.rows);

  int get count => rows.values.fold(0, (n, r) => n + r.length);
  bool get isEmpty => count == 0;
}

/// Local store that tracks which rows changed since the last upload.
/// Implemented by SqfliteWalkRepository. Only walk/stop/entry rows sync;
/// photos stay in the local database and are never uploaded.
abstract class SyncableStore {
  /// Up to [limitPerTable] changed rows from each table. Each row includes
  /// `updated_at`, which [markSynced] uses as the version that was uploaded.
  Future<SyncBatch> pendingChanges({int limitPerTable = 200});

  /// Marks exactly the uploaded versions as synced. Rows changed again after
  /// [pendingChanges] read them stay pending.
  Future<void> markSynced(SyncBatch batch);

  Future<int> pendingCount();

  /// This install's id, stored with the data so the two can't drift apart.
  /// [legacyId] supplies an id from an older storage location to adopt once.
  Future<String> deviceId({Future<String?> Function()? legacyId});
}

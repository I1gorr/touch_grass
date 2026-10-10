/// A journal entry at a stop: a voice note (raw + cleaned transcript), the
/// walk's photo, or both. rawTranscript is null until STT has persisted it.
class Entry {
  final String id;
  final String stopId;
  final DateTime recordedAt;
  final String? rawTranscript;
  final String? cleanedText;

  /// True if the walk's photo (stored in the `photo` table) belongs to this
  /// entry. Filled in by the repository; not a column of `entry`.
  final bool hasPhoto;

  /// Data track: the author chose to share this note with people nearby, as
  /// the snapshot [sharedText]. Written only through the data track's
  /// repository (shareEntry/unshareEntry); read-only here.
  final bool shared;
  final String? sharedText;

  const Entry({
    required this.id,
    required this.stopId,
    required this.recordedAt,
    this.rawTranscript,
    this.cleanedText,
    this.hasPhoto = false,
    this.shared = false,
    this.sharedText,
  });

  bool get hasTranscript => rawTranscript != null;

  /// Cleaned text if available, otherwise raw.
  String? text({required bool cleaned}) => cleaned ? (cleanedText ?? rawTranscript) : rawTranscript;

  Entry withPhoto(bool value) => Entry(
    id: id,
    stopId: stopId,
    recordedAt: recordedAt,
    rawTranscript: rawTranscript,
    cleanedText: cleanedText,
    hasPhoto: value,
    shared: shared,
    sharedText: sharedText,
  );

  /// Row for the `entry` table. The legacy `photo_path` column is left NULL:
  /// photos live in the `photo` table.
  Map<String, Object?> toMap() => {
    'id': id,
    'stop_id': stopId,
    'recorded_at': recordedAt.millisecondsSinceEpoch,
    'raw_transcript': rawTranscript,
    'cleaned_text': cleanedText,
  };

  /// Accepts plain `entry` rows and rows with a computed `has_photo` column.
  factory Entry.fromMap(Map<String, Object?> m) => Entry(
    id: m['id'] as String,
    stopId: m['stop_id'] as String,
    recordedAt: DateTime.fromMillisecondsSinceEpoch((m['recorded_at'] as num?)?.toInt() ?? 0),
    rawTranscript: m['raw_transcript'] as String?,
    cleanedText: m['cleaned_text'] as String?,
    hasPhoto: ((m['has_photo'] as num?) ?? 0) != 0,
    shared: m['shared'] == 1,
    sharedText: m['shared_text'] as String?,
  );
}

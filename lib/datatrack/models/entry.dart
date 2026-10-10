/// An `entry` row: a voice note and/or photo at a stop.
///
/// [rawTranscript] null = not transcribed yet (or photo only); '' = silence.
/// [cleanedText] is null until cleanup finishes.
class Entry {
  final String id;
  final String stopId;
  final int recordedAt;
  final String? rawTranscript;
  final String? cleanedText;
  final String? photoPath;
  /// True only if the author chose to share this entry with people nearby. Off by default.
  final bool shared;
  /// What was published: a snapshot of the cleaned text, so later edits never change it silently.
  final String? sharedText;

  const Entry({
    required this.id,
    required this.stopId,
    required this.recordedAt,
    this.rawTranscript,
    this.cleanedText,
    this.photoPath,
    this.shared = false,
    this.sharedText,
  });

  /// Longest note shared with the community.
  static const int maxSharedChars = 280;

  Map<String, Object?> toRow() => {
        'id': id,
        'stop_id': stopId,
        'recorded_at': recordedAt,
        'raw_transcript': rawTranscript,
        'cleaned_text': cleanedText,
        'photo_path': photoPath,
        'shared': shared ? 1 : 0,
        'shared_text': sharedText,
      };

  factory Entry.fromRow(Map<String, Object?> r) => Entry(
        id: r['id'] as String,
        stopId: r['stop_id'] as String,
        recordedAt: (r['recorded_at'] as num?)?.toInt() ?? 0,
        rawTranscript: r['raw_transcript'] as String?,
        cleanedText: r['cleaned_text'] as String?,
        photoPath: r['photo_path'] as String?,
        shared: r['shared'] == 1,
        sharedText: r['shared_text'] as String?,
      );
}

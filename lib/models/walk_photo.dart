import 'dart:typed_data';

/// The single photo of a walk, stored as a BLOB in the local SQLite `photo`
/// table. Never uploaded: the cloud backup holds no images.
class WalkPhoto {
  final String walkId;

  /// The entry (and so the stop) the photo was taken at.
  final String entryId;

  /// 'image/jpeg' or 'image/png' (static only).
  final String mime;
  final Uint8List bytes;
  final DateTime createdAt;

  const WalkPhoto({
    required this.walkId,
    required this.entryId,
    required this.mime,
    required this.bytes,
    required this.createdAt,
  });

  Map<String, Object?> toMap() => {
    'walk_id': walkId,
    'entry_id': entryId,
    'mime': mime,
    'data': bytes,
    'size': bytes.length,
    'created_at': createdAt.millisecondsSinceEpoch,
  };

  /// Cheap identity of the stored photo, for change checks without the bytes.
  PhotoStamp get stamp => PhotoStamp(entryId, createdAt.millisecondsSinceEpoch, bytes.length);

  factory WalkPhoto.fromMap(Map<String, Object?> m) => WalkPhoto(
    walkId: m['walk_id'] as String,
    entryId: m['entry_id'] as String,
    mime: m['mime'] as String,
    bytes: m['data'] is Uint8List ? m['data'] as Uint8List : Uint8List.fromList((m['data'] as List).cast<int>()),
    createdAt: DateTime.fromMillisecondsSinceEpoch((m['created_at'] as num?)?.toInt() ?? 0),
  );
}

/// Which photo a walk has, without its bytes: lets screens skip reloading
/// (and re-decoding) a multi-MB image when nothing changed.
class PhotoStamp {
  final String entryId;
  final int createdAtMs;
  final int size;
  const PhotoStamp(this.entryId, this.createdAtMs, this.size);

  @override
  bool operator ==(Object other) =>
      other is PhotoStamp && other.entryId == entryId && other.createdAtMs == createdAtMs && other.size == size;

  @override
  int get hashCode => Object.hash(entryId, createdAtMs, size);
}

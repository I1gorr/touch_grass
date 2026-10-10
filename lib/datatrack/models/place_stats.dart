/// One note a person chose to share about a place. Anonymous: no author, no device id.
class CommunityNote {
  /// The entry id (needed to report it).
  final String id;
  final String text;
  final bool hasPhoto;
  final int atMs;
  const CommunityNote({required this.id, required this.text, this.hasPhoto = false, this.atMs = 0});

  Map<String, Object?> toJson() => {'id': id, 'text': text, 'photo': hasPhoto, 'at': atMs};

  factory CommunityNote.fromJson(Map<String, dynamic> j) => CommunityNote(
        id: j['id'] as String,
        text: j['text'] as String,
        hasPhoto: j['photo'] == true,
        atMs: (j['at'] as num?)?.toInt() ?? 0,
      );
}

/// Community data for one place (OSM id) in the user's chosen area: counts, plus the few notes people chose to share.
/// Never raw transcripts, authors or photos.
class PlaceStats {
  final String osmId;
  /// Finished walks that stopped here.
  final int walks;
  /// Different people who did.
  final int devices;
  final int entries;
  /// Entries with spoken/written text.
  final int notes;
  final int photos;
  /// What people chose to say here (newest first, a few). Empty if nobody shared anything.
  final List<CommunityNote> sharedNotes;

  const PlaceStats({
    required this.osmId,
    required this.walks,
    required this.devices,
    required this.entries,
    required this.notes,
    required this.photos,
    this.sharedNotes = const [],
  });

  Map<String, Object?> toJson() =>
      {
        'osm_id': osmId,
        'walks': walks,
        'devices': devices,
        'entries': entries,
        'notes': notes,
        'photos': photos,
        'shared_notes': [for (final n in sharedNotes) n.toJson()],
      };

  factory PlaceStats.fromJson(Map<String, dynamic> j) => PlaceStats(
        osmId: j['osm_id'] as String,
        walks: (j['walks'] as num?)?.toInt() ?? 0,
        devices: (j['devices'] as num?)?.toInt() ?? 0,
        entries: (j['entries'] as num?)?.toInt() ?? 0,
        notes: (j['notes'] as num?)?.toInt() ?? 0,
        photos: (j['photos'] as num?)?.toInt() ?? 0,
        sharedNotes: [
          for (final n in (j['shared_notes'] as List? ?? const [])) CommunityNote.fromJson(n as Map<String, dynamic>),
        ],
      );
}

/// This person's own past visits to a place (from their finished walks in SQLite).
class PlaceHistory {
  final int visits;
  /// `walk.created_at` of the latest finished walk that stopped here.
  final int lastVisitedMs;
  const PlaceHistory(this.visits, this.lastVisitedMs);
}

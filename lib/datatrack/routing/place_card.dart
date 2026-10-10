import '../models/place_stats.dart';
import '../tracks/data/candidate.dart';
import 'place_value.dart';

/// Everything the review screen shows about one stop of a recommended route:
/// what the place is, what people said, how often this person has been, and why it was picked.
class PlaceCard {
  final String osmId;
  final String name;
  final String category;
  final String reason;
  /// Community counts (zero when nobody has been there).
  final int walks;
  final int people;
  final int notes;
  final int photos;
  /// What people chose to share, newest first, with notes this person reported removed.
  final List<CommunityNote> sharedNotes;
  /// This person's own past visits.
  final int myVisits;

  const PlaceCard({
    required this.osmId,
    required this.name,
    required this.category,
    required this.reason,
    required this.walks,
    required this.people,
    required this.notes,
    required this.photos,
    required this.sharedNotes,
    required this.myVisits,
  });

  /// At most this many notes per card keep the review screen readable.
  static const int maxNotes = 3;

  factory PlaceCard.of(
    Candidate c, {
    PlaceStats? stats,
    PlaceHistory? history,
    Set<String> hiddenNoteIds = const {},
    required int nowMs,
  }) =>
      PlaceCard(
        osmId: c.osmId,
        name: c.name,
        category: c.category,
        reason: reasonFor(stats, history, nowMs),
        walks: stats?.walks ?? 0,
        people: stats?.devices ?? 0,
        notes: stats?.notes ?? 0,
        photos: stats?.photos ?? 0,
        sharedNotes: [
          for (final n in stats?.sharedNotes ?? const <CommunityNote>[])
            if (!hiddenNoteIds.contains(n.id)) n,
        ].take(maxNotes).toList(),
        myVisits: history?.visits ?? 0,
      );

  Map<String, Object?> toJson() => {
        'osm_id': osmId,
        'name': name,
        'category': category,
        'reason': reason,
        'community': {'walks': walks, 'people': people, 'notes': notes, 'photos': photos},
        'shared_notes': [for (final n in sharedNotes) n.toJson()],
        'my_visits': myVisits,
      };
}

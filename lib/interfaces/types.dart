// Shared types for all tracks (app track and data track). Keep stable;
// changes need a heads-up to the team. This is a superset of both tracks'
// original definitions, so code from either compiles against it unchanged.

class Location {
  final double lat;
  final double lng;
  const Location(this.lat, this.lng);

  /// Finite and within WGS84 bounds.
  bool get isValid => lat.isFinite && lng.isFinite && lat.abs() <= 90 && lng.abs() <= 180;

  @override
  bool operator ==(Object other) => other is Location && other.lat == lat && other.lng == lng;

  @override
  int get hashCode => Object.hash(lat, lng);

  @override
  String toString() => 'Location($lat, $lng)';
}

/// A place in a walk. Shared by every track: the app track (screens, ML) and
/// the data track (routing, packs). [walkId] and [position] are filled in when
/// a quest is saved; [toRow]/[fromRow] are the data track's SQLite mapping.
class Stop {
  final String id;

  /// Owning walk and 0-based route order; filled in when the quest is prepared.
  final String walkId;
  final int position;
  final String osmId;
  final String name;
  final double lat;
  final double lng;
  final String tagsJson;
  final String blurb;
  final String prompt;

  const Stop({
    required this.id,
    this.walkId = '',
    this.position = 0,
    required this.osmId,
    required this.name,
    required this.lat,
    required this.lng,
    required this.tagsJson,
    this.blurb = '',
    this.prompt = '',
  });

  Stop copyWith({String? id, String? walkId, int? position, String? blurb, String? prompt}) => Stop(
        id: id ?? this.id,
        walkId: walkId ?? this.walkId,
        position: position ?? this.position,
        osmId: osmId,
        name: name,
        lat: lat,
        lng: lng,
        tagsJson: tagsJson,
        blurb: blurb ?? this.blurb,
        prompt: prompt ?? this.prompt,
      );

  /// Schema columns (snake_case); sync columns are managed by the repository.
  Map<String, Object?> toRow() => {
        'id': id,
        'walk_id': walkId,
        'position': position,
        'osm_id': osmId,
        'name': name,
        'lat': lat,
        'lng': lng,
        'tags_json': tagsJson,
        'blurb': blurb,
        'prompt': prompt,
      };

  factory Stop.fromRow(Map<String, Object?> r) => Stop(
        id: r['id'] as String,
        walkId: (r['walk_id'] as String?) ?? '',
        position: (r['position'] as num?)?.toInt() ?? 0,
        osmId: (r['osm_id'] as String?) ?? '',
        name: (r['name'] as String?) ?? '',
        lat: (r['lat'] as num).toDouble(),
        lng: (r['lng'] as num).toDouble(),
        tagsJson: (r['tags_json'] as String?) ?? '{}',
        blurb: (r['blurb'] as String?) ?? '',
        prompt: (r['prompt'] as String?) ?? '',
      );
}

class TranscriptSegment {
  /// Offsets from start of clip, in milliseconds.
  final int startMs;
  final int endMs;
  final String text;

  const TranscriptSegment(this.startMs, this.endMs, this.text);

  factory TranscriptSegment.fromJson(Map<String, dynamic> j) => TranscriptSegment(
        (j['startMs'] as num).toInt(),
        (j['endMs'] as num).toInt(),
        j['text'] as String,
      );

  Map<String, dynamic> toJson() => {'startMs': startMs, 'endMs': endMs, 'text': text};
}

class Transcription {
  final String rawText;
  final List<TranscriptSegment> segments;

  const Transcription({required this.rawText, this.segments = const []});
}

/// Structured facts the LLM is allowed to use. Nothing else goes into a prompt.
class StopFacts {
  final String name;
  final String tagType; // e.g. "amenity=bench", "historic=memorial"
  final String timeOfDay; // e.g. "morning"
  final String weatherSummary; // e.g. "light rain, 12°C"

  const StopFacts({
    required this.name,
    required this.tagType,
    required this.timeOfDay,
    required this.weatherSummary,
  });
}

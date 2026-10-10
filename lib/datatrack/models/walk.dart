enum WalkStatus {
  preparing,
  ready,
  active,
  done;

  /// Tolerant read: unknown or missing values fall back to [ready].
  static WalkStatus parse(String? s) => values.firstWhere((v) => v.name == s, orElse: () => ready);
}

/// A `walk` row: one prepared quest.
class Walk {
  final String id;
  final int createdAt;
  final double startLat;
  final double startLng;
  final String timeOfDay;
  final String weatherSummary;
  final WalkStatus status;
  /// JSON string with the planned route (see `RouteOption.toRouteJson`); null for walks without one.
  final String? routeJson;

  const Walk({
    required this.id,
    required this.createdAt,
    required this.startLat,
    required this.startLng,
    required this.timeOfDay,
    this.weatherSummary = 'unknown',
    this.status = WalkStatus.ready,
    this.routeJson,
  });

  Walk copyWith({WalkStatus? status}) => Walk(
        id: id,
        createdAt: createdAt,
        startLat: startLat,
        startLng: startLng,
        timeOfDay: timeOfDay,
        weatherSummary: weatherSummary,
        status: status ?? this.status,
        routeJson: routeJson,
      );

  /// Schema columns (snake_case); sync columns are managed by the repository.
  Map<String, Object?> toRow() => {
        'id': id,
        'created_at': createdAt,
        'start_lat': startLat,
        'start_lng': startLng,
        'time_of_day': timeOfDay,
        'weather_summary': weatherSummary,
        'status': status.name,
        'route_json': routeJson,
      };

  factory Walk.fromRow(Map<String, Object?> r) => Walk(
        id: r['id'] as String,
        createdAt: (r['created_at'] as num?)?.toInt() ?? 0,
        startLat: (r['start_lat'] as num).toDouble(),
        startLng: (r['start_lng'] as num).toDouble(),
        timeOfDay: (r['time_of_day'] as String?) ?? 'morning',
        weatherSummary: (r['weather_summary'] as String?) ?? 'unknown',
        status: WalkStatus.parse(r['status'] as String?),
        routeJson: r['route_json'] as String?,
      );
}

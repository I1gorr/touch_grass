enum WalkStatus { preparing, ready, active, done }

class Walk {
  final String id;
  final DateTime createdAt;
  final double startLat;
  final double startLng;
  final String timeOfDay;
  final String weatherSummary;
  final WalkStatus status;

  /// Data track: the planned street route as JSON (`total_m`, `duration_s`,
  /// `mode`, polyline…). Null for walks planned without street routing.
  /// Written by the data track's repository; read-only here.
  final String? routeJson;

  const Walk({
    required this.id,
    required this.createdAt,
    required this.startLat,
    required this.startLng,
    required this.timeOfDay,
    required this.weatherSummary,
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

  Map<String, Object?> toMap() => {
    'id': id,
    'created_at': createdAt.millisecondsSinceEpoch,
    'start_lat': startLat,
    'start_lng': startLng,
    'time_of_day': timeOfDay,
    'weather_summary': weatherSummary,
    'status': status.name,
  };

  factory Walk.fromMap(Map<String, Object?> m) => Walk(
    id: m['id'] as String,
    createdAt: DateTime.fromMillisecondsSinceEpoch((m['created_at'] as num?)?.toInt() ?? 0),
    startLat: (m['start_lat'] as num?)?.toDouble() ?? 0,
    startLng: (m['start_lng'] as num?)?.toDouble() ?? 0,
    timeOfDay: (m['time_of_day'] as String?) ?? '',
    weatherSummary: (m['weather_summary'] as String?) ?? '',
    status: WalkStatus.values.asNameMap()[m['status']] ?? WalkStatus.ready,
    routeJson: m['route_json'] as String?,
  );
}

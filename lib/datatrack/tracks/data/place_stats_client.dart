import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../interfaces/types.dart';
import '../../models/place_stats.dart';

/// Fetches community counts for an area from the server (`GET /v1/places`).
/// Needs internet; only used while downloading or refreshing a pack, never during a walk.
class PlaceStatsClient {
  final Uri baseUrl;

  /// Sent as `x-api-key`; required by the API. Null = no header.
  final String? apiKey;
  final http.Client _client;
  final Duration timeout;

  PlaceStatsClient({required this.baseUrl, this.apiKey, http.Client? client, this.timeout = const Duration(seconds: 10)})
      : _client = client ?? http.Client();

  /// Max area the server will answer for.
  static const int maxRadiusM = 5000;

  Future<List<PlaceStats>> fetch(Location center, int radiusM) async {
    final r = radiusM.clamp(100, maxRadiusM);
    final uri = baseUrl.resolve('/v1/places').replace(queryParameters: {
      'lat': '${center.lat}',
      'lng': '${center.lng}',
      'radius': '$r',
    });
    final res = await _client.get(uri, headers: {'x-api-key': ?apiKey}).timeout(timeout);
    if (res.statusCode != 200) throw Exception('places HTTP ${res.statusCode}');
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return [for (final p in (body['places'] as List? ?? const [])) PlaceStats.fromJson(p as Map<String, dynamic>)];
  }
}

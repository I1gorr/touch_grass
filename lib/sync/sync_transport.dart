import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'sync_store.dart';

class SyncException implements Exception {
  final String message;

  /// HTTP status, or null for network/timeout errors.
  final int? status;
  const SyncException(this.message, {this.status});

  /// 4xx other than 408/429 won't fix themselves by retrying (bad key, bad payload).
  bool get isPermanent => status != null && status! >= 400 && status! < 500 && status != 408 && status != 429;

  @override
  String toString() => status == null ? 'SyncException: $message' : 'SyncException($status): $message';
}

/// Sends walk/stop/entry rows to the cloud (never images). Throws
/// [SyncException] on failure; must be idempotent on the server side (the
/// same batch may be sent twice).
abstract class SyncTransport {
  /// Returns how many rows the server refused because another install owns
  /// them (they can't be retried by this one).
  Future<int> push(String deviceId, SyncBatch batch);

  /// Releases connections. Called once, when sync shuts down.
  Future<void> close();
}

/// POSTs to the touch_grass sync API (server/), which writes to MongoDB Atlas.
/// The phone never holds Atlas credentials, only this API's key.
class HttpSyncTransport implements SyncTransport {
  final Uri endpoint;
  final String apiKey;
  final Duration timeout;
  final http.Client _client;

  HttpSyncTransport({
    required String baseUrl,
    required this.apiKey,
    this.timeout = const Duration(seconds: 15),
    http.Client? client,
  }) : endpoint = Uri.parse('${baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl}/v1/sync'),
       _client = client ?? http.Client();

  @override
  Future<int> push(String deviceId, SyncBatch batch) async {
    final body = jsonEncode({
      'deviceId': deviceId,
      'walks': batch.rows['walk'] ?? const [],
      'stops': batch.rows['stop'] ?? const [],
      'entries': batch.rows['entry'] ?? const [],
    });
    final http.Response res;
    try {
      res = await _client
          .post(endpoint, headers: {'content-type': 'application/json', 'x-api-key': apiKey}, body: body)
          .timeout(timeout);
    } on TimeoutException {
      throw const SyncException('timed out (offline?)');
    } catch (e) {
      throw SyncException('network error: $e');
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      final snippet = res.body.length > 200 ? '${res.body.substring(0, 200)}…' : res.body;
      throw SyncException(snippet.isEmpty ? 'HTTP ${res.statusCode}' : snippet, status: res.statusCode);
    }
    return _foreignCount(res.body);
  }

  /// Sums `counts.<collection>.foreign` from the server reply; 0 if absent.
  static int _foreignCount(String body) {
    try {
      final counts = (jsonDecode(body) as Map)['counts'];
      if (counts is! Map) return 0;
      var n = 0;
      for (final c in counts.values) {
        if (c is Map && c['foreign'] is int) n += c['foreign'] as int;
      }
      return n;
    } catch (_) {
      return 0;
    }
  }

  @override
  Future<void> close() async => _client.close();
}

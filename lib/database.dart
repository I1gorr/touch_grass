import 'datatrack/db/walk_repository.dart' as dt;
import 'db/sqflite_walk_repository.dart';
import 'sync/device_id.dart';
import 'sync/sync_service.dart';
import 'sync/sync_transport.dart';

/// Where the sync API (server/, which writes to MongoDB Atlas) lives. Both are
/// build-time: --dart-define=SYNC_URL=... --dart-define=SYNC_API_KEY=...
class SyncConfig {
  final String url;
  final String apiKey;
  const SyncConfig({this.url = '', this.apiKey = ''});

  factory SyncConfig.fromEnvironment() => SyncConfig(
    url: normalizeSyncUrl(const String.fromEnvironment('SYNC_URL')) ?? '',
    apiKey: const String.fromEnvironment('SYNC_API_KEY'),
  );

  bool get enabled => url.isNotEmpty;

  /// '' → '' (sync off); valid http(s) URL → trimmed without trailing '/';
  /// anything else → null (invalid). Plain http is allowed only for local
  /// development hosts.
  static String? normalizeSyncUrl(String s) {
    final t = s.trim();
    if (t.isEmpty) return '';
    final u = Uri.tryParse(t);
    if (u == null || u.host.isEmpty || !(u.scheme == 'https' || u.scheme == 'http')) return null;
    const devHosts = {'localhost', '127.0.0.1', '10.0.2.2'};
    if (u.scheme == 'http' && !devHosts.contains(u.host) && !u.host.startsWith('192.168.')) return null;
    return t.endsWith('/') ? t.substring(0, t.length - 1) : t;
  }
}

/// The on-device SQLite database and its cloud backup:
///
///   phone (SQLite, source of truth) ──HTTPS──▶ server/ ──▶ MongoDB Atlas
///
/// [repo] (walks, stops, entries, photos) and [routes] (saved quests with
/// their street route, place history, shared notes) work on the same file and
/// share one version clock. [sync] is null when no sync URL is configured.
class AppDatabase {
  final SqfliteWalkRepository repo;
  final dt.WalkRepository routes;
  final SyncService? sync;

  AppDatabase._(this.repo, this.routes, this.sync);

  /// [transport] replaces the HTTP client (tests, other backends) and turns
  /// sync on even without a URL.
  static Future<AppDatabase> open({
    SyncConfig config = const SyncConfig(),
    SqfliteWalkRepository? repo,
    SyncTransport? transport,
  }) async {
    final r = repo ?? await SqfliteWalkRepository.open();
    final routes = dt.WalkRepository(r.db, nowMs: r.stamp);
    SyncService? sync;
    if (config.enabled || transport != null) {
      sync = SyncService(
        store: r,
        transport: transport ?? HttpSyncTransport(baseUrl: config.url, apiKey: config.apiKey),
        deviceId: await r.deviceId(legacyId: DeviceId.readLegacy),
        changes: r.changes,
        ownsTransport: transport == null,
        // No network while a walk is being walked.
        walkInProgress: routes.hasActiveWalk,
      )..start();
    }
    return AppDatabase._(r, routes, sync);
  }

  /// Waits for an upload in flight, then closes the database.
  Future<void> close() async {
    await sync?.close();
    await repo.close();
  }
}

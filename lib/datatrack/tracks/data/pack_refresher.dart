import 'pack_downloader.dart';
import 'offline_pack_store.dart';

/// Re-downloads packs older than [maxAge]. Call when the internet is available.
/// A failed refresh keeps the old pack, so offline use is never made worse.
class PackRefresher {
  final OfflinePackStore store;
  final PackDownloader downloader;
  final Duration maxAge;
  /// Community data changes faster than streets, so it is refreshed on its own, more often.
  final Duration statsMaxAge;
  final DateTime Function() clock;

  PackRefresher({
    required this.store,
    required this.downloader,
    this.maxAge = const Duration(days: 30),
    this.statsMaxAge = const Duration(days: 7),
    DateTime Function()? clock,
  }) : clock = clock ?? DateTime.now;

  /// Returns how many packs (or their community data) were refreshed.
  Future<int> refreshStale() async {
    var refreshed = 0;
    final now = clock();
    final cutoff = now.subtract(maxAge).millisecondsSinceEpoch;
    final statsCutoff = now.subtract(statsMaxAge).millisecondsSinceEpoch;
    for (final info in await store.list()) {
      if (info.createdAt < cutoff) {
        try {
          await downloader.download(info.center, info.radiusM, communityRadiusM: info.communityRadiusM);
          refreshed++;
        } catch (_) {/* offline or busy: keep the old pack, try next time */}
      } else if (info.statsAt < statsCutoff && await downloader.refreshStats(info)) {
        refreshed++;
      }
    }
    return refreshed;
  }
}

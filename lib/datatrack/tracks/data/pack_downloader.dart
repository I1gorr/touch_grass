import '../../interfaces/types.dart';
import '../../models/place_stats.dart';
import '../../routing/walk_way.dart';
import 'candidate.dart';
import 'offline_pack.dart';
import 'offline_pack_store.dart';
import 'overpass_client.dart';
import 'place_stats_client.dart';

/// Downloads POIs and the walking network around a point and saves them as an [OfflinePack].
/// Needs the network. If anything fails nothing is written and any existing pack is untouched.
class PackDownloader {
  final OverpassClient overpass;
  final OfflinePackStore store;
  final DateTime Function() clock;
  final Duration waysTimeout;
  /// Where community data comes from. Null = packs have no community data.
  final PlaceStatsClient? placeStats;

  PackDownloader({
    required this.overpass,
    required this.store,
    this.placeStats,
    DateTime Function()? clock,
    this.waysTimeout = const Duration(seconds: 60),
  }) : clock = clock ?? DateTime.now;

  /// [communityRadiusM] is the area the user chose for community data (null = the whole pack).
  Future<OfflinePack> download(Location center, int radiusM, {int? communityRadiusM}) async {
    final poiBody = await overpass.fetchQuery(OverpassClient.buildQuery(center, radius: radiusM, limit: 500));
    final waysBody = await overpass.fetchQuery(OverpassClient.buildWaysQuery(center, radius: radiusM), timeout: waysTimeout);
    final pois = parseOverpass(poiBody);
    final ways = parseWays(waysBody);
    if (ways.isEmpty) throw Exception('No walkable ways found around ${center.lat}, ${center.lng}');
    final id = OfflinePack.idFor(center, radiusM);
    var stats = <String, PlaceStats>{};
    var statsAt = 0;
    // Community data is a bonus: if it can't be fetched keep what the old pack had (or nothing).
    if (placeStats != null && communityRadiusM != 0) {
      try {
        stats = {for (final p in await placeStats!.fetch(center, communityRadiusM ?? radiusM)) p.osmId: p};
        statsAt = clock().millisecondsSinceEpoch;
      } catch (_) {
        stats = await store.loadStats(id);
      }
    }
    final pack = OfflinePack(
      id: id,
      centerLat: center.lat,
      centerLng: center.lng,
      radiusM: radiusM,
      createdAt: clock().millisecondsSinceEpoch,
      pois: pois,
      ways: ways,
      stats: stats,
      statsAt: statsAt,
      communityRadiusM: communityRadiusM,
    );
    await store.save(pack);
    return pack;
  }

  /// Re-fetches only the community data of a saved pack. Returns false if it could not (offline, no client).
  Future<bool> refreshStats(PackInfo info) async {
    final client = placeStats;
    if (client == null || info.communityRadiusM == 0) return false;
    try {
      final list = await client.fetch(info.center, info.communityRadiusM ?? info.radiusM);
      await store.saveStats(info.id, {for (final p in list) p.osmId: p}, clock().millisecondsSinceEpoch);
      return true;
    } catch (_) {
      return false;
    }
  }
}

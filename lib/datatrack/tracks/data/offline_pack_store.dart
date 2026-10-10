import 'dart:convert';
import 'dart:io';

import '../../interfaces/types.dart';
import '../../models/place_stats.dart';
import '../../routing/walk_way.dart';
import 'offline_pack.dart';

/// Packs on disk at `<root>/packs/<id>/{manifest.json, pois.json, ways.json.gz}`.
/// Writes go to a temp folder and are renamed into place, so a crash or a failed
/// refresh never leaves a half-written pack or destroys the previous one.
class OfflinePackStore {
  final Directory root;
  OfflinePackStore(this.root);

  Directory get _packs => Directory('${root.path}/packs');
  Directory _dir(String id) => Directory('${_packs.path}/$id');

  Future<void> save(OfflinePack pack) async {
    await _packs.create(recursive: true);
    final tmp = Directory('${_packs.path}/.tmp-${pack.id}');
    if (await tmp.exists()) await tmp.delete(recursive: true);
    await tmp.create();
    try {
      await File('${tmp.path}/pois.json').writeAsString(jsonEncode([for (final c in pack.pois) candidateToJson(c)]));
      await File('${tmp.path}/ways.json.gz')
          .writeAsBytes(gzip.encode(utf8.encode(jsonEncode([for (final w in pack.ways) w.toJson()]))));
      await File('${tmp.path}/places.json').writeAsString(jsonEncode([for (final p in pack.stats.values) p.toJson()]));
      await File('${tmp.path}/manifest.json').writeAsString(jsonEncode(pack.manifest())); // last: marks the pack complete
      final dest = _dir(pack.id);
      final old = Directory('${_packs.path}/.old-${pack.id}');
      if (await old.exists()) await old.delete(recursive: true);
      if (await dest.exists()) await dest.rename(old.path);
      await tmp.rename(dest.path);
      if (await old.exists()) await old.delete(recursive: true);
    } catch (_) {
      if (await tmp.exists()) await tmp.delete(recursive: true);
      rethrow;
    }
    await _evictCovered(pack);
  }

  /// A new pack makes the packs it fully contains redundant.
  Future<void> _evictCovered(OfflinePack pack) async {
    for (final info in await list()) {
      if (info.id == pack.id) continue;
      if (PackInfo(pack.id, pack.centerLat, pack.centerLng, pack.radiusM, pack.createdAt)
          .covers(info.center, info.radiusM.toDouble())) {
        await delete(info.id);
      }
    }
  }

  /// Metadata of every complete pack; unreadable folders are skipped.
  Future<List<PackInfo>> list() async {
    if (!await _packs.exists()) return const [];
    final out = <PackInfo>[];
    await for (final e in _packs.list()) {
      if (e is! Directory || e.uri.pathSegments.where((s) => s.isNotEmpty).last.startsWith('.')) continue;
      try {
        final m = jsonDecode(await File('${e.path}/manifest.json').readAsString()) as Map<String, dynamic>;
        out.add(PackInfo.fromManifest(m));
      } catch (_) {/* incomplete or corrupt: ignore */}
    }
    out.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return out;
  }

  Future<OfflinePack?> load(String id) async {
    try {
      final dir = _dir(id);
      final info = PackInfo.fromManifest(jsonDecode(await File('${dir.path}/manifest.json').readAsString()) as Map<String, dynamic>);
      final pois = [
        for (final j in jsonDecode(await File('${dir.path}/pois.json').readAsString()) as List)
          candidateFromJson(j as Map<String, dynamic>),
      ];
      final waysJson = jsonDecode(utf8.decode(gzip.decode(await File('${dir.path}/ways.json.gz').readAsBytes()))) as List;
      final stats = await _readStats(dir);
      return OfflinePack(
        id: info.id,
        centerLat: info.centerLat,
        centerLng: info.centerLng,
        radiusM: info.radiusM,
        createdAt: info.createdAt,
        pois: pois,
        ways: [for (final j in waysJson) WalkWay.fromJson(j as Map<String, dynamic>)],
        stats: stats,
        statsAt: info.statsAt,
        communityRadiusM: info.communityRadiusM,
      );
    } catch (_) {
      return null;
    }
  }

  /// Packs saved before community data existed have no `places.json`: that just means no stats.
  Future<Map<String, PlaceStats>> _readStats(Directory dir) async {
    try {
      final f = File('${dir.path}/places.json');
      if (!await f.exists()) return const {};
      return {
        for (final j in jsonDecode(await f.readAsString()) as List)
          (j as Map<String, dynamic>)['osm_id'] as String: PlaceStats.fromJson(j),
      };
    } catch (_) {
      return const {};
    }
  }

  Future<Map<String, PlaceStats>> loadStats(String id) => _readStats(_dir(id));

  /// Replaces only the community data (cheap: the map files are untouched). Each file is swapped by rename.
  Future<void> saveStats(String id, Map<String, PlaceStats> stats, int statsAt) async {
    final dir = _dir(id);
    final manifestFile = File('${dir.path}/manifest.json');
    if (!await manifestFile.exists()) return;
    final manifest = jsonDecode(await manifestFile.readAsString()) as Map<String, dynamic>;
    manifest['stats_at'] = statsAt;
    final places = File('${dir.path}/places.json.tmp');
    await places.writeAsString(jsonEncode([for (final p in stats.values) p.toJson()]));
    await places.rename('${dir.path}/places.json');
    final m = File('${dir.path}/manifest.json.tmp');
    await m.writeAsString(jsonEncode(manifest));
    await m.rename(manifestFile.path);
  }

  Future<void> delete(String id) async {
    final d = _dir(id);
    if (await d.exists()) await d.delete(recursive: true);
  }

  /// The newest pack in which a walk reaching [reachM] from [start] stays inside the downloaded area.
  Future<OfflinePack?> findCovering(Location start, double reachM) async {
    for (final info in await list()) {
      if (info.covers(start, reachM)) {
        final p = await load(info.id);
        if (p != null) return p;
      }
    }
    return null;
  }

  /// Pack whose area contains [start] but is too small for [reachM] (better than nothing when offline).
  Future<OfflinePack?> findContaining(Location start) async {
    for (final info in await list()) {
      if (info.covers(start, 0)) {
        final p = await load(info.id);
        if (p != null) return p;
      }
    }
    return null;
  }
}

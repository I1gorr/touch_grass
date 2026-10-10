import '../../models/ids.dart';
import '../../models/place_stats.dart';
import '../../models/walk.dart';
import '../../routing/route_recommender.dart';
import 'offline_pack.dart';
import 'offline_pack_store.dart';
import 'pack_downloader.dart';
import 'prompts.dart';
import 'quest_preparer.dart';
import 'report_queue.dart';
import 'weather_client.dart';

/// No downloaded area covers the start and the network is not available to get one.
class NoPackException implements Exception {
  final String message;
  const NoPackException(this.message);
  @override
  String toString() => 'NoPackException: $message';
}

/// A recommendation ready to show ([option]) and to save ([quest]) if the person picks it.
class RecommendedRoute {
  final RouteOption option;
  final PreparedQuest quest;
  const RecommendedRoute(this.option, this.quest);
}

/// "Where should I walk for 30 minutes?" - works offline once a pack covers the start.
/// Order of data sources: downloaded pack -> download one (if online) -> bundled demo pack -> any pack containing the start.
class RouteService {
  final OfflinePackStore packs;
  /// Null = never touch the network.
  final PackDownloader? downloader;
  final WeatherService? weather;
  /// Quick connectivity check used only to decide whether to ask for the weather.
  final Future<bool> Function()? isOnline;
  final Future<OfflinePack?> Function()? bundledPack;
  /// This person's past visits (e.g. `repo.placeHistory`), used to rotate recommendations. Null = no history.
  final Future<Map<String, PlaceHistory>> Function()? placeHistory;
  /// Notes this person reported are hidden from the review cards, even offline.
  final ReportQueue? reportQueue;
  final Future<List<RouteOption>> Function(PlanJob) planner;
  final DateTime Function() clock;
  final String Function() idGenerator;

  RouteService({
    required this.packs,
    this.downloader,
    this.weather,
    this.isOnline,
    this.bundledPack,
    this.placeHistory,
    this.reportQueue,
    this.planner = planRoutesInIsolate,
    DateTime Function()? clock,
    String Function()? idGenerator,
  })  : clock = clock ?? DateTime.now,
        idGenerator = idGenerator ?? newId;

  /// Returns up to `request.options` loops, best first. Throws [NoPackException] if there is no data at all.
  Future<List<RecommendedRoute>> recommend(RouteRequest request) => _recommend(request, allowDownload: true);

  /// The person read the community notes and wants something different: skip some places and/or ask for a fresh
  /// set of options. Runs on the data already on the phone, so it works in airplane mode.
  Future<List<RecommendedRoute>> recalculate(RouteRequest request, {Set<String> skip = const {}, bool reroll = false}) {
    final base = request.seed ?? _daySeed(clock());
    return _recommend(
      request.copyWith(excludeOsmIds: {...request.excludeOsmIds, ...skip}, seed: reroll ? base + 1 : base),
      allowDownload: false,
    );
  }

  /// Default seed: the day number, so the same request rotates through places from day to day.
  static int _daySeed(DateTime t) => t.millisecondsSinceEpoch ~/ Duration.millisecondsPerDay;

  Future<List<RecommendedRoute>> _recommend(RouteRequest request, {required bool allowDownload}) async {
    final budget = request.budgetM;
    final reach = reachFor(budget);
    var downloaded = false;

    var pack = await packs.findCovering(request.start, reach);
    if (pack == null && allowDownload && downloader != null) {
      try {
        pack = await downloader!.download(request.start, packRadiusFor(budget), communityRadiusM: request.communityRadiusM);
        downloaded = true;
      } catch (_) {/* offline: use what is on the phone */}
    }
    if (pack == null) {
      final bundled = await bundledPack?.call();
      if (bundled != null && bundled.covers(request.start, reach)) pack = bundled;
    }
    pack ??= await packs.findContaining(request.start);
    if (pack == null) {
      final bundled = await bundledPack?.call();
      if (bundled != null && bundled.covers(request.start, 0)) pack = bundled;
    }
    if (pack == null) {
      throw const NoPackException('No offline map covers this location. Connect to the internet to download one.');
    }

    final now = clock();
    final history = await placeHistory?.call() ?? const <String, PlaceHistory>{};
    final seeded = request.seed != null ? request : request.copyWith(seed: _daySeed(now));
    final options = await planner(PlanJob(pack.pois, pack.ways, seeded,
        stats: pack.stats,
        history: history,
        hiddenNoteIds: await reportQueue?.hiddenIds() ?? const {},
        nowMs: now.millisecondsSinceEpoch));

    var weatherSummary = 'unknown';
    if (weather != null && (downloaded || (await isOnline?.call() ?? false))) {
      weatherSummary = await weather!.snapshot(request.start);
    }

    return [
      for (final o in options)
        () {
          final walk = Walk(
            id: idGenerator(),
            createdAt: now.millisecondsSinceEpoch,
            startLat: request.start.lat,
            startLng: request.start.lng,
            timeOfDay: timeOfDayFor(now),
            weatherSummary: weatherSummary,
            routeJson: o.toRouteJson(seeded),
          );
          final stops = [
            for (final (i, c) in o.picks.indexed)
              c.toStop(stopIdFor(walk.id, i), prompt: promptForCandidate(c)).copyWith(walkId: walk.id, position: i),
          ];
          return RecommendedRoute(o, PreparedQuest(walk, stops));
        }(),
    ];
  }
}

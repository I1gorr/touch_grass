import 'package:flutter/services.dart' show rootBundle;
import 'package:uuid/uuid.dart';

import '../../interfaces/quest_builder.dart';
import '../../interfaces/types.dart';
import 'cache_store.dart';
import 'candidate.dart';
import 'candidate_filter.dart';
import 'candidate_scorer.dart';
import 'overpass_client.dart';
import 'prompts.dart';
import 'route_orderer.dart';

const kFallbackAsset = 'assets/fallback/demo_overpass.json';

class RealQuestBuilder implements QuestBuilder {
  final OverpassClient overpass;
  final CacheStore cache;
  final Future<String> Function() loadFallback;
  final int radius;
  /// Radius used when the first search yields fewer than [minCandidates].
  final int widerRadius;
  final int minCandidates;
  final Uuid _uuid = const Uuid();

  /// Candidate count after filtering on the last build (for the Gate 1 check).
  int lastCandidateCount = 0;
  /// Where the last build's data came from: "cache", "network" or "fallback".
  String lastSource = '';

  RealQuestBuilder({
    required this.overpass,
    required this.cache,
    Future<String> Function()? loadFallback,
    this.radius = 1200,
    this.widerRadius = 2500,
    this.minCandidates = 6,
  }) : loadFallback = loadFallback ?? (() => rootBundle.loadString(kFallbackAsset));

  @override
  Future<List<Stop>> build(Location location) async {
    var candidates = filterCandidates(await _load(location, radius));
    // Sparse area: widen the search once (network or cache, never the fallback).
    if (candidates.length < minCandidates && lastSource != 'fallback') {
      final firstSource = lastSource;
      final wider = filterCandidates(await _load(location, widerRadius));
      if (lastSource != 'fallback' && wider.length > candidates.length) {
        candidates = wider;
      } else {
        lastSource = firstSource;
      }
    }
    lastCandidateCount = candidates.length;

    // Too few candidates (sparse area, bad data): top up from the fallback set.
    if (candidates.length < 3) {
      candidates = filterCandidates([...candidates, ...parseOverpass(await loadFallback())]);
      lastSource = 'fallback';
    }

    final picks = pickVaried(scoreCandidates(candidates, location));
    final ordered = orderNearestNeighbour(location, picks);
    return [
      for (final c in ordered) c.toStop(_uuid.v4(), prompt: promptForCandidate(c)),
    ];
  }

  Future<List<Candidate>> _load(Location location, int radius) async {
    final key = CacheStore.areaKey(location, radius);
    final cached = await cache.read(key);
    if (cached != null) {
      try {
        final c = parseOverpass(cached);
        lastSource = 'cache';
        return c;
      } catch (_) {/* corrupt cache: refetch */}
    }
    try {
      final body = await overpass.fetchRaw(location, radius: radius);
      final c = parseOverpass(body);
      await cache.write(key, body);
      lastSource = 'network';
      return c;
    } catch (_) {
      lastSource = 'fallback';
      return parseOverpass(await loadFallback());
    }
  }
}

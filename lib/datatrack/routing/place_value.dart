import 'dart:math';

import '../models/place_stats.dart';

/// How many "visits' worth" of belief the category weight is given against community data.
/// With no community data the category weight is used as is; each different person who
/// has been there shifts the value toward what they actually left behind.
const double kPriorWeight = 3;

const int _day = 24 * 60 * 60 * 1000;

/// Community value on the same 1..5 scale as category weights: memories (notes, photos) per visit.
double crowdValue(PlaceStats s) {
  final rate = (s.notes + 0.5 * s.photos) / (s.walks < 1 ? 1 : s.walks);
  return 1 + 4 * min(1.0, rate / 1.5);
}

/// Shrinks the community value toward [base] when few people have been there.
double blendedValue(double base, PlaceStats? s) {
  final n = s?.devices ?? 0;
  if (s == null || n <= 0) return base;
  return (kPriorWeight * base + n * crowdValue(s)) / (kPriorWeight + n);
}

/// Round robin: places this person has not been to (or not lately) come first. Never excludes a place.
double freshness(PlaceHistory? h, int nowMs) {
  if (h == null || h.visits <= 0) return 1;
  var f = 1 / (1 + 0.7 * h.visits);
  if (nowMs - h.lastVisitedMs < 14 * _day) f *= 0.6;
  return max(f, 0.15);
}

/// Deterministic pseudo-random number in [0, 1) from a seed and a place id (FNV-1a).
double seededUnit(int seed, String osmId) {
  var h = 0x811c9dc5;
  for (final u in '$seed:$osmId'.codeUnits) {
    h = ((h ^ u) * 0x01000193) & 0xffffffff;
  }
  h ^= h >> 15;
  h = (h * 0x2c1b3c6d) & 0xffffffff;
  h ^= h >> 12;
  return (h & 0xffffff) / 0x1000000;
}

/// Seeded random nudge, bigger where we know less (explore places with little data).
/// +-30% with no community data, shrinking as more people have been there.
double jitter(int seed, String osmId, PlaceStats? s) {
  final amp = 0.3 / (1 + (s?.devices ?? 0));
  return 1 + amp * (seededUnit(seed, osmId) * 2 - 1);
}

/// Final value of a place for ranking: blended community value, rotated by this person's history,
/// with a seeded random nudge.
double placeValue({
  required double base,
  required String osmId,
  PlaceStats? stats,
  PlaceHistory? history,
  required int nowMs,
  int seed = 0,
}) =>
    blendedValue(base, stats) * freshness(history, nowMs) * jitter(seed, osmId, stats);

/// One-line reason shown with a recommendation.
String reasonFor(PlaceStats? s, PlaceHistory? h, int nowMs) {
  final crowd = s == null || s.devices <= 0
      ? 'no community data yet'
      : '${s.devices} ${s.devices == 1 ? 'person' : 'people'} visited, ${s.notes} ${s.notes == 1 ? 'note' : 'notes'}, ${s.photos} ${s.photos == 1 ? 'photo' : 'photos'}';
  final mine = h == null || h.visits <= 0
      ? 'new to you'
      : 'you visited ${h.visits}x, last ${max(0, (nowMs - h.lastVisitedMs) ~/ _day)} days ago';
  return '$crowd; $mine';
}

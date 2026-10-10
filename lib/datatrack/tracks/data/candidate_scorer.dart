import '../../interfaces/types.dart';
import 'candidate.dart';

const _categoryWeight = <String, double>{
  'tourism=artwork': 5,
  'tourism=viewpoint': 5,
  'amenity=fountain': 4,
  'historic=*': 4,
  'leisure=garden': 3,
  'leisure=park': 3,
  'amenity=place_of_worship': 3,
  'tourism=attraction': 2,
};

/// Base value of a stop by category (1 for anything unlisted).
double categoryWeight(Candidate c) => _categoryWeight[c.category] ?? 1;

class ScoredCandidate {
  final Candidate candidate;
  final double score;
  const ScoredCandidate(this.candidate, this.score);
}

/// Higher is better: category weight minus a distance penalty (1 point per 300 m).
/// Sorted descending; ties break on osmId so results are deterministic.
List<ScoredCandidate> scoreCandidates(List<Candidate> input, Location start) {
  final scored = input.map((c) {
    final d = distanceMeters(start.lat, start.lng, c.lat, c.lng);
    return ScoredCandidate(c, categoryWeight(c) - d / 300);
  }).toList();
  scored.sort((a, b) {
    final s = b.score.compareTo(a.score);
    return s != 0 ? s : a.candidate.osmId.compareTo(b.candidate.osmId);
  });
  return scored;
}

/// Picks up to [count] candidates, at most [maxPerCategory] from one category.
/// If that leaves fewer than [minCount], the cap is relaxed to fill the gap.
List<Candidate> pickVaried(List<ScoredCandidate> sorted, {int count = 4, int minCount = 3, int maxPerCategory = 2}) {
  final perCat = <String, int>{};
  final out = <Candidate>[];
  for (final s in sorted) {
    if (out.length == count) break;
    final n = perCat[s.candidate.category] ?? 0;
    if (n >= maxPerCategory) continue;
    perCat[s.candidate.category] = n + 1;
    out.add(s.candidate);
  }
  if (out.length < minCount) {
    for (final s in sorted) {
      if (out.length == minCount) break;
      if (!out.contains(s.candidate)) out.add(s.candidate);
    }
  }
  return out;
}

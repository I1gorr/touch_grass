import 'candidate.dart';

/// Drops wikidata/wikipedia-tagged (famous) items, nameless items and duplicate names.
List<Candidate> filterCandidates(List<Candidate> input) {
  final seen = <String>{};
  final out = <Candidate>[];
  for (final c in input) {
    if (c.name.trim().isEmpty) continue;
    if (c.tags.keys.any((k) => k.contains('wikidata') || k.contains('wikipedia'))) continue;
    if (!seen.add(c.name.trim().toLowerCase())) continue;
    out.add(c);
  }
  return out;
}

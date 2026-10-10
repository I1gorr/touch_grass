import 'package:http/http.dart' as http;

import '../../interfaces/types.dart';

class OverpassClient {
  final http.Client _client;
  final List<Uri> endpoints;
  final Duration timeout;

  OverpassClient({
    http.Client? client,
    List<Uri>? endpoints,
    this.timeout = const Duration(seconds: 12),
  })  : _client = client ?? http.Client(),
        endpoints = endpoints ??
            [
              Uri.parse('https://overpass-api.de/api/interpreter'),
              Uri.parse('https://overpass.openstreetmap.fr/api/interpreter'),
              Uri.parse('https://overpass.kumi.systems/api/interpreter'),
            ];

  static String buildQuery(Location l, {int radius = 1200, int limit = 200}) {
    final a = '(around:$radius,${l.lat},${l.lng})';
    return '[out:json][timeout:25];('
        'nwr["leisure"~"^(park|garden)\$"]["name"]$a;'
        'nwr["tourism"~"^(artwork|viewpoint|attraction)\$"]["name"]$a;'
        'nwr["historic"]["name"]$a;'
        'nwr["amenity"~"^(fountain|place_of_worship)\$"]["name"]$a;'
        'nwr["man_made"~"^(tower|bridge)\$"]["name"]$a;'
        ');out center $limit;';
  }

  /// Walkable ways around [l] with full geometry (node ids + coordinates), for the offline routing graph.
  static String buildWaysQuery(Location l, {int radius = 1200}) {
    return '[out:json][timeout:60];('
        'way["highway"]["highway"!~"^(motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway|bus_guideway|corridor|elevator|escape|platform)\$"]'
        '["foot"!="no"]["access"!~"^(private|no)\$"](around:$radius,${l.lat},${l.lng});'
        ');out geom;';
  }

  /// Returns the raw JSON body. Tries each endpoint; throws if all fail.
  Future<String> fetchRaw(Location l, {int radius = 1200}) => fetchQuery(buildQuery(l, radius: radius));

  /// Runs any Overpass QL [query]. Big queries (routing ways) pass a longer [timeout].
  Future<String> fetchQuery(String query, {Duration? timeout}) async {
    Object? last;
    for (final url in endpoints) {
      try {
        final res = await _client
            .post(url, headers: {'User-Agent': 'touch-grass/0.1'}, body: {'data': query})
            .timeout(timeout ?? this.timeout);
        if (res.statusCode == 200 && res.body.trimLeft().startsWith('{')) return res.body;
        last = 'HTTP ${res.statusCode}';
      } catch (e) {
        last = e;
      }
    }
    throw Exception('Overpass failed: $last');
  }
}

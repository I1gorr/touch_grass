import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../interfaces/types.dart';

class WeatherService {
  final http.Client _client;
  WeatherService({http.Client? client}) : _client = client ?? http.Client();

  /// Short summary like "clear, 18°C". Returns "unknown" on any failure.
  Future<String> snapshot(Location l) async {
    try {
      final uri = Uri.parse('https://api.open-meteo.com/v1/forecast'
          '?latitude=${l.lat}&longitude=${l.lng}&current=temperature_2m,weather_code');
      final res = await _client.get(uri).timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return 'unknown';
      final cur = (jsonDecode(res.body) as Map)['current'] as Map;
      return '${describeCode((cur['weather_code'] as num).toInt())}, ${(cur['temperature_2m'] as num).round()}°C';
    } catch (_) {
      return 'unknown';
    }
  }

  static String describeCode(int c) {
    if (c == 0) return 'clear';
    if (c <= 3) return 'cloudy';
    if (c == 45 || c == 48) return 'foggy';
    if (c >= 51 && c <= 67) return 'rainy';
    if (c >= 71 && c <= 77) return 'snowy';
    if (c >= 80 && c <= 82) return 'showers';
    if (c >= 95) return 'stormy';
    return 'mixed';
  }
}

import 'dart:io';

import '../../interfaces/types.dart';

/// File cache at `<root>/overpass/<area>.json`.
class CacheStore {
  final Directory root;
  CacheStore(this.root);

  /// ~1.1 km grid cell (2 decimal places) plus radius.
  static String areaKey(Location l, int radius) =>
      '${l.lat.toStringAsFixed(2)}_${l.lng.toStringAsFixed(2)}_$radius'.replaceAll('-', 'm');

  File _file(String key) => File('${root.path}/overpass/$key.json');

  Future<String?> read(String key) async {
    final f = _file(key);
    return await f.exists() ? f.readAsString() : null;
  }

  Future<File> write(String key, String body) async {
    final f = _file(key);
    await f.parent.create(recursive: true);
    return f.writeAsString(body);
  }
}

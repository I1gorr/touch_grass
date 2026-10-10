import 'dart:math';

final Random _rng = Random.secure();

/// 32 random lowercase hex chars (walk, entry and device ids).
String newId() => List.generate(16, (_) => _rng.nextInt(256).toRadixString(16).padLeft(2, '0')).join();

/// Stop ids are `<walkId>-<position>`: the same OSM place gets a fresh row in every walk.
String stopIdFor(String walkId, int position) => '$walkId-$position';

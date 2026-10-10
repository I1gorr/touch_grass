import 'dart:math';

final _rng = Random.secure();

/// Random 128-bit id as 32 hex chars (no uuid dependency needed).
String newId() => List.generate(16, (_) => _rng.nextInt(256).toRadixString(16).padLeft(2, '0')).join();

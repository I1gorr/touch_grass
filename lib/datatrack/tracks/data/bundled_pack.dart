import 'dart:convert';

import 'package:flutter/services.dart' show rootBundle;

import '../../routing/walk_way.dart';
import 'candidate.dart';
import 'demo_location.dart';
import 'offline_pack.dart';

const kBundledWaysAsset = 'assets/fallback/demo_ways.json';
const kBundledPoisAsset = 'assets/fallback/demo_overpass.json';
const kBundledRadiusM = 1500;

/// The demo area shipped inside the app, so recommendations work on a fresh install with no internet.
/// Returns null if the asset is missing.
Future<OfflinePack?> loadBundledPack() async {
  try {
    final ways = [
      for (final j in jsonDecode(await rootBundle.loadString(kBundledWaysAsset)) as List)
        WalkWay.fromJson(j as Map<String, dynamic>),
    ];
    final pois = parseOverpass(await rootBundle.loadString(kBundledPoisAsset));
    return OfflinePack(
      id: 'bundled-demo',
      centerLat: kDemoLocation.lat,
      centerLng: kDemoLocation.lng,
      radiusM: kBundledRadiusM,
      createdAt: 0,
      pois: pois,
      ways: ways,
    );
  } catch (_) {
    return null;
  }
}

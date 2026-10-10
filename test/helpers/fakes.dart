import 'package:touch_grass/interfaces/types.dart';

/// Builders shared by the database and routing tests.

/// Builds a minimal PNG: signature + chunks (CRCs zeroed; nothing here checks them).
List<int> pngBytes({bool animated = false, int idatLen = 4}) {
  List<int> chunk(String type, int len) => [
        (len >> 24) & 0xFF,
        (len >> 16) & 0xFF,
        (len >> 8) & 0xFF,
        len & 0xFF,
        ...type.codeUnits,
        ...List.filled(len + 4, 0)
      ];
  return [
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, //
    ...chunk('IHDR', 13),
    if (animated) ...chunk('acTL', 8),
    ...chunk('IDAT', idatLen),
    ...chunk('IEND', 0),
  ];
}

Stop stop(String id, {String? name, double lat = 51.5, double lng = -0.1, String blurb = '', String prompt = ''}) =>
    Stop(
        id: id,
        osmId: 'node/$id',
        name: name ?? 'Place $id',
        lat: lat,
        lng: lng,
        tagsJson: '{}',
        blurb: blurb,
        prompt: prompt);

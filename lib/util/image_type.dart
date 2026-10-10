import 'dart:typed_data';

/// The only media the app stores: static JPEG and PNG, kept in the local
/// database and never uploaded. No video, GIF, WebP or animated PNG.
const allowedPhotoTypes = {'image/jpeg', 'image/png'};

/// Largest photo stored in the local database (one per walk).
const maxPhotoBytes = 8 * 1024 * 1024;

const _pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// Detects a *static* JPEG or PNG from the file's bytes (not its extension).
/// Pass the whole file: PNGs are checked chunk by chunk for animation.
/// Returns null for everything else, including GIF, WebP, animated or
/// malformed PNG, and every video container (MP4/MOV/3GP/WebM/AVI…).
String? sniffImageType(Uint8List b) {
  if (b.length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return 'image/jpeg';
  if (b.length >= 8 && Iterable.generate(8).every((i) => b[i] == _pngSignature[i])) {
    return pngKind(b) == PngKind.static ? 'image/png' : null;
  }
  return null;
}

enum PngKind { static, animated, invalid }

/// Walks PNG chunks up to the first IDAT. An `acTL` chunk before the image
/// data means APNG (animated). Truncated / no IDAT → invalid.
PngKind pngKind(Uint8List b) {
  final view = ByteData.sublistView(b);
  var pos = 8;
  while (pos + 8 <= b.length) {
    final len = view.getUint32(pos);
    final type = String.fromCharCodes(b.sublist(pos + 4, pos + 8));
    if (type == 'acTL') return PngKind.animated;
    if (type == 'IDAT') return PngKind.static;
    pos += 12 + len; // length + type + data + CRC
  }
  return PngKind.invalid;
}

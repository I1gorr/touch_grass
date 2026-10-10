/**
 * The only media the app stores: static JPEG and PNG, kept in the local
 * database and never uploaded. No video, GIF, WebP or animated PNG.
 */
export const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png']);

/** Largest photo stored in the local database (one per walk). */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type PngKind = 'static' | 'animated' | 'invalid';

/** Walks PNG chunks up to the first IDAT. An `acTL` chunk before the image data means APNG (animated). */
export function pngKind(b: Uint8Array): PngKind {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8;
  while (pos + 8 <= b.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    if (type === 'acTL') return 'animated';
    if (type === 'IDAT') return 'static';
    pos += 12 + len; // length + type + data + CRC
  }
  return 'invalid';
}

/**
 * Detects a *static* JPEG or PNG from the file's bytes (not its extension).
 * Pass the whole file: PNGs are checked chunk by chunk for animation.
 * Returns null for everything else, including GIF, WebP, animated or malformed PNG, and video.
 */
export function sniffImageType(b: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)) {
    return pngKind(b) === 'static' ? 'image/png' : null;
  }
  return null;
}

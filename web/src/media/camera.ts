import { MAX_PHOTO_BYTES, sniffImageType } from '../util/imageType';

/** A captured photo, in memory, ready to be stored in the local database. */
export interface CapturedPhoto {
  /** 'image/jpeg' or 'image/png' (static only). */
  mime: string;
  bytes: Uint8Array;
}

export class InvalidPhoto extends Error {
  override name = 'InvalidPhoto';
}

/** Static JPEG/PNG photos only. The app never records, picks or stores video, GIF, WebP or animated images. */
export interface PhotoCapture {
  /**
   * Opens the camera and returns the photo's bytes, or null if the user cancelled. Throws InvalidPhoto if the
   * result isn't a static JPEG/PNG of at most MAX_PHOTO_BYTES.
   */
  capture(): Promise<CapturedPhoto | null>;
}

/** Checks `bytes` and wraps them; shared by every PhotoCapture. */
export function validatePhoto(bytes: Uint8Array): CapturedPhoto {
  if (bytes.length === 0) throw new InvalidPhoto('The photo was empty');
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw new InvalidPhoto(
      `It’s ${(bytes.length / (1024 * 1024)).toFixed(1)} MB, and the limit is ${MAX_PHOTO_BYTES / (1024 * 1024)} MB`,
    );
  }
  const mime = sniffImageType(bytes);
  if (!mime) throw new InvalidPhoto('Only still JPEG or PNG photos can be saved');
  return { mime, bytes };
}

export const MAX_PHOTO_WIDTH = 2048;
export const PHOTO_QUALITY = 0.85;

/**
 * Opens the phone camera through a file input (`capture="environment"`), then re-encodes the picture as a
 * JPEG no wider than 2048 px. Re-encoding keeps it well under the size limit and drops the EXIF block, so
 * the stored photo carries no GPS position or device details.
 */
export class CameraPhotoCapture implements PhotoCapture {
  async capture(): Promise<CapturedPhoto | null> {
    const file = await pickPhotoFile();
    if (!file) return null;
    return validatePhoto(await downscaleToJpeg(file));
  }
}

/** Resolves with the chosen file, or null if the person cancelled the camera. */
function pickPhotoFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    let settled = false;
    const done = (f: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(f);
    };
    // Browsers without the `cancel` event: when the page regains focus and nothing was chosen, treat it as cancelled.
    const onFocus = () => setTimeout(() => done(input.files?.[0] ?? null), 1000);
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    window.addEventListener('focus', onFocus);
    document.body.append(input);
    input.click();
  });
}

async function downscaleToJpeg(file: Blob): Promise<Uint8Array> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new InvalidPhoto('That file couldn’t be read as a picture');
  }
  try {
    const scale = Math.min(1, MAX_PHOTO_WIDTH / bitmap.width);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) throw new InvalidPhoto('This browser can’t process pictures');
    g.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', PHOTO_QUALITY));
    if (!blob) throw new InvalidPhoto('The picture couldn’t be saved as a JPEG');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/** A 1x1 static PNG; for desk testing and tests. */
export const FAKE_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export class FakePhotoCapture implements PhotoCapture {
  async capture(): Promise<CapturedPhoto | null> {
    return validatePhoto(FAKE_PNG);
  }
}

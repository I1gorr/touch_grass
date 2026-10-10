import { describe, expect, it } from 'vitest';
import { MAX_PHOTO_BYTES, pngKind, sniffImageType } from '../src/util/imageType';
import { newId, stopIdFor } from '../src/util/ids';
import { tagTypeFrom, timeOfDayFor } from '../src/util/stopFacts';

const png = (chunks: string[]): Uint8Array => {
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const type of chunks) {
    parts.push(0, 0, 0, 0, ...[...type].map((c) => c.charCodeAt(0)), 0, 0, 0, 0); // empty chunk + CRC
  }
  return Uint8Array.from(parts);
};

describe('image sniffing', () => {
  it('accepts JPEG and static PNG by content', () => {
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffImageType(png(['IHDR', 'IDAT', 'IEND']))).toBe('image/png');
  });

  it('rejects animated PNG, truncated PNG, GIF, WebP, video and junk', () => {
    expect(pngKind(png(['IHDR', 'acTL', 'IDAT']))).toBe('animated');
    expect(sniffImageType(png(['IHDR', 'acTL', 'IDAT']))).toBeNull();
    expect(sniffImageType(png(['IHDR']))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('GIF89a......'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBeNull();
    expect(sniffImageType(Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBeNull(); // MP4
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });

  it('caps photos at 8 MB', () => expect(MAX_PHOTO_BYTES).toBe(8 * 1024 * 1024));
});

describe('ids', () => {
  it('are 32 lowercase hex chars and unique', () => {
    const ids = new Set(Array.from({ length: 200 }, newId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
  it('stop ids are <walk>-<position>', () => expect(stopIdFor('abc', 2)).toBe('abc-2'));
});

describe('stop facts', () => {
  it('time of day buckets', () => {
    const at = (h: number) => timeOfDayFor(new Date(2026, 0, 1, h));
    expect([4, 5, 11, 12, 16, 17, 20, 21, 0].map(at)).toEqual([
      'night', 'morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'night', 'night',
    ]);
  });

  it('picks the most descriptive tag, skipping yes, tolerating bad JSON', () => {
    expect(tagTypeFrom('{"amenity":"bench","historic":"memorial"}')).toBe('historic=memorial');
    expect(tagTypeFrom('{"building":"yes","amenity":"cafe"}')).toBe('amenity=cafe');
    expect(tagTypeFrom('{"building":"yes"}')).toBe('building=yes');
    expect(tagTypeFrom('{"name":"x"}')).toBe('');
    expect(tagTypeFrom('not json')).toBe('');
    expect(tagTypeFrom('[1,2]')).toBe('');
  });
});

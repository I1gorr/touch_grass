import { describe, expect, it } from 'vitest';
import { clipSeconds, concatChunks, encodeWav, resample, silentClip } from '../src/media/audio';
import { FAKE_PNG, FakePhotoCapture, InvalidPhoto, validatePhoto } from '../src/media/camera';
import { FakeRecorder } from '../src/media/recorder';
import { sniffImageType } from '../src/util/imageType';

const sine = (hz: number, rate: number, seconds: number) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));
const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

describe('resample', () => {
  it('does nothing when the rates match, or there is no audio', () => {
    const a = Float32Array.of(1, 2, 3);
    expect(resample(a, 16000, 16000)).toBe(a);
    expect(resample(new Float32Array(), 48000, 16000)).toHaveLength(0);
  });

  it('48 kHz -> 16 kHz keeps the duration and a speech-band tone', () => {
    const out = resample(sine(440, 48000, 1), 48000, 16000);
    expect(out.length).toBe(16000);
    expect(rms(out)).toBeGreaterThan(0.6); // a sine has rms ~0.707
  });

  it('44.1 kHz -> 16 kHz (non-integer ratio) keeps the duration', () => {
    const out = resample(sine(300, 44100, 2), 44100, 16000);
    expect(out.length).toBe(32000);
    expect(rms(out)).toBeGreaterThan(0.6);
  });

  it('filters out tones above the new Nyquist instead of aliasing them in', () => {
    const lowTone = rms(resample(sine(1000, 48000, 1), 48000, 16000));
    const highTone = rms(resample(sine(20000, 48000, 1), 48000, 16000)); // inaudible, would alias to 4 kHz
    expect(highTone).toBeLessThan(lowTone / 3);
  });

  it('averages constant audio to the same constant, including the last partial window', () => {
    const out = resample(new Float32Array(1001).fill(0.5), 48000, 16000);
    expect([...out].every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it('upsampling also works', () => {
    expect(resample(new Float32Array(8000).fill(0.25), 8000, 16000).length).toBe(16000);
  });
});

describe('audio helpers', () => {
  it('concatenates chunks in order', () => {
    expect([...concatChunks([Float32Array.of(1, 2), new Float32Array(), Float32Array.of(3)])]).toEqual([1, 2, 3]);
    expect(concatChunks([])).toHaveLength(0);
  });

  it('silent clips are 16 kHz mono of the right length', () => {
    const c = silentClip(500);
    expect([c.sampleRate, c.samples.length, clipSeconds(c)]).toEqual([16000, 8000, 0.5]);
  });

  it('encodes a valid 16-bit PCM WAV and clips out-of-range samples', () => {
    const wav = encodeWav({ samples: Float32Array.of(0, 1, -1, 2, -2, 0.5), sampleRate: 16000 });
    const v = new DataView(wav.buffer);
    const tag = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)]).toEqual([1, 1, 16000, 16]);
    expect(v.getUint32(40, true)).toBe(12);
    expect([44, 46, 48, 50, 52, 54].map((o) => v.getInt16(o, true))).toEqual([0, 32767, -32767, 32767, -32767, 16384]);
    expect(wav.length).toBe(56);
  });
});

describe('fake recorder', () => {
  it('returns at least half a second of silence, and nothing if never started', async () => {
    let t = 1000;
    const r = new FakeRecorder(() => t);
    expect(await r.stop()).toBeNull();
    await r.start();
    t += 10;
    expect(clipSeconds((await r.stop())!)).toBe(0.5);
    await r.start();
    t += 4000;
    expect(clipSeconds((await r.stop())!)).toBe(4);
    await r.start();
    t += 10 * 60_000;
    expect(clipSeconds((await r.stop())!)).toBe(30);
    expect(await r.ensurePermission()).toBe(true);
  });
});

describe('photo validation', () => {
  it('the fake camera produces a valid static PNG', async () => {
    const shot = (await new FakePhotoCapture().capture())!;
    expect([sniffImageType(shot.bytes), shot.mime]).toEqual(['image/png', 'image/png']);
    expect(FAKE_PNG.length).toBeGreaterThan(20);
  });

  it('accepts JPEG and refuses everything else with a plain-language reason', () => {
    expect(validatePhoto(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)).mime).toBe('image/jpeg');
    expect(() => validatePhoto(new Uint8Array())).toThrow(InvalidPhoto);
    expect(() => validatePhoto(new TextEncoder().encode('GIF89a'))).toThrow(/Only still JPEG or PNG/);
    expect(() => validatePhoto(new Uint8Array(9 * 1024 * 1024).fill(0xff))).toThrow(/limit is 8 MB/);
  });
});

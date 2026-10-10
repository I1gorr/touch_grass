import { type AudioClip, STT_SAMPLE_RATE } from '../ml/types';

/**
 * Resamples mono audio by averaging the input samples that fall inside each output sample (a box filter,
 * which also acts as a cheap anti-aliasing low-pass when downsampling 44.1/48 kHz mic audio to 16 kHz).
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = i * ratio;
    const end = Math.min((i + 1) * ratio, input.length);
    let sum = 0;
    let weight = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      const w = Math.min(j + 1, end) - Math.max(j, start); // overlap of [j, j+1) with [start, end)
      sum += input[j] * w;
      weight += w;
    }
    out[i] = weight > 0 ? sum / weight : 0;
  }
  return out;
}

/** Joins recorded chunks into one buffer. */
export function concatChunks(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A clip of silence, for the fake recorder and tests. */
export const silentClip = (ms: number): AudioClip => ({
  samples: new Float32Array(Math.round((ms * STT_SAMPLE_RATE) / 1000)),
  sampleRate: STT_SAMPLE_RATE,
});

export const clipSeconds = (c: AudioClip): number => c.samples.length / c.sampleRate;

/** 16 kHz mono 16-bit PCM WAV, e.g. to export or debug a recording. */
export function encodeWav(clip: AudioClip): Uint8Array {
  const dataLen = clip.samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, clip.sampleRate, true);
  v.setUint32(28, clip.sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, dataLen, true);
  clip.samples.forEach((s, i) => v.setInt16(44 + 2 * i, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true));
  return new Uint8Array(buf);
}

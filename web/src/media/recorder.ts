import { type AudioClip, STT_SAMPLE_RATE } from '../ml/types';
import { concatChunks, resample, silentClip } from './audio';

/** Microphone abstraction. Implementations return 16 kHz mono audio, the format the speech model expects. */
export interface VoiceRecorder {
  ensurePermission(): Promise<boolean>;
  start(): Promise<void>;
  /** Returns the finished clip, or null if nothing was recorded. */
  stop(): Promise<AudioClip | null>;
  dispose(): Promise<void>;
}

/** Longest single note kept in memory (a safety cap; samples past it are dropped). */
export const MAX_NOTE_SECONDS = 300;

// AudioWorklet that forwards each 128-frame block of the first input channel to the main thread.
const WORKLET_SOURCE = `
class TgCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('tg-capture', TgCapture);
`;

/** Real microphone via getUserMedia + Web Audio. Needs HTTPS and a user gesture. */
export class MicRecorder implements VoiceRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private teardown: (() => void) | null = null;
  private chunks: Float32Array[] = [];
  private frames = 0;

  async ensurePermission(): Promise<boolean> {
    if (this.stream) return true;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      // Keep the stream: start() uses it, so the person is asked once, at the tap.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      return true;
    } catch {
      return false; // denied, or no microphone
    }
  }

  async start(): Promise<void> {
    if (!(await this.ensurePermission()) || !this.stream) throw new Error('microphone not available');
    this.chunks = [];
    this.frames = 0;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(this.stream);
    const maxFrames = MAX_NOTE_SECONDS * ctx.sampleRate;
    const onBlock = (block: Float32Array) => {
      if (this.frames >= maxFrames) return;
      this.chunks.push(block);
      this.frames += block.length;
    };
    // The capture node must reach the destination to be processed; a zero gain keeps it silent (no feedback).
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);

    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, 'tg-capture');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => onBlock(e.data);
      source.connect(node);
      node.connect(mute);
      this.teardown = () => {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
      };
    } else {
      // Older browsers: the deprecated ScriptProcessorNode.
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => onBlock(e.inputBuffer.getChannelData(0).slice(0));
      source.connect(node);
      node.connect(mute);
      this.teardown = () => {
        node.onaudioprocess = null;
        source.disconnect();
        node.disconnect();
      };
    }
    if (ctx.state === 'suspended') await ctx.resume();
  }

  async stop(): Promise<AudioClip | null> {
    const ctx = this.ctx;
    const rate = ctx?.sampleRate ?? STT_SAMPLE_RATE;
    this.teardown?.();
    this.teardown = null;
    this.ctx = null;
    await ctx?.close().catch(() => undefined);
    // Release the microphone (the browser's recording indicator turns off).
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const raw = concatChunks(this.chunks);
    this.chunks = [];
    this.frames = 0;
    if (raw.length === 0) return null;
    return { samples: resample(raw, rate, STT_SAMPLE_RATE), sampleRate: STT_SAMPLE_RATE };
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

/** Returns a short silent clip on stop, for desk testing and tests (pair with FakeStt). */
export class FakeRecorder implements VoiceRecorder {
  private startedAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  async ensurePermission(): Promise<boolean> {
    return true;
  }

  async start(): Promise<void> {
    this.startedAt = this.now();
  }

  async stop(): Promise<AudioClip | null> {
    if (this.startedAt === null) return null;
    const ms = Math.min(30_000, Math.max(500, this.now() - this.startedAt));
    this.startedAt = null;
    return silentClip(ms);
  }

  async dispose(): Promise<void> {}
}

import type { AudioClip } from '../ml/types';
import type { TgDb } from './schema';

/**
 * Recorded notes waiting for transcription, in IndexedDB. A recording is stored BEFORE its entry row is
 * created and deleted only AFTER the transcript is saved, so the audio is never the only copy that is lost.
 */
export class RecordingStore {
  constructor(
    private readonly db: TgDb,
    private readonly now: () => number = Date.now,
  ) {}

  async put(id: string, clip: AudioClip): Promise<void> {
    await this.db.put('recordings', { id, samples: clip.samples, sampleRate: clip.sampleRate, created_at: this.now() });
  }

  async get(id: string): Promise<AudioClip | null> {
    const r = await this.db.get('recordings', id);
    return r ? { samples: r.samples, sampleRate: r.sampleRate } : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete('recordings', id);
  }

  /** Ids of every stored recording. */
  async ids(): Promise<string[]> {
    return (await this.db.getAllKeys('recordings')) as string[];
  }
}

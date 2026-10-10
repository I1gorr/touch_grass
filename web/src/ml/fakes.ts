import type { StopFacts } from '../models/types';
import { Prompts, ruleBasedCleanup } from './prompts';
import type { AudioClip, Llm, LlmTask, StructuredLlm, Stt, Transcription } from './types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Deterministic Llm for UI work and tests. Only echoes the given facts. */
export class FakeLlm implements Llm, StructuredLlm {
  constructor(private readonly latencyMs = 300) {}

  generate(prompt: string): Promise<string> {
    return this.respond(Prompts.taskOf(prompt) ?? 'blurb', {
      facts: Prompts.factsFromPrompt(prompt),
      transcript: Prompts.parseTranscript(prompt),
    });
  }

  async respond(task: LlmTask, o: { facts?: StopFacts; transcript?: string }): Promise<string> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    const name = o.facts?.name ? o.facts.name : 'this spot';
    const time = o.facts?.timeOfDay ? o.facts.timeOfDay : 'today';
    switch (task) {
      case 'cleanup':
        return ruleBasedCleanup(o.transcript ?? '');
      case 'question':
        return `What do you notice at ${name} right now?`;
      case 'blurb':
        return `Pause at ${name} this ${time}. Take a slow look around before moving on.`;
    }
  }
}

export const FAKE_TRANSCRIPT = 'um so the light here is really nice and uh the the bench is still wet from the rain';

/** Returns a canned transcript. For desk testing and tests only: never selected automatically. */
export class FakeStt implements Stt {
  constructor(
    private readonly text = FAKE_TRANSCRIPT,
    private readonly latencyMs = 500,
  ) {}

  async transcribe(_clip: AudioClip): Promise<Transcription> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    return { rawText: this.text, segments: [{ startMs: 0, endMs: 5000, text: this.text }] };
  }
}

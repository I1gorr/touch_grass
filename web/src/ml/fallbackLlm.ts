import type { StopFacts } from '../models/types';
import { Prompts, ruleBasedCleanup } from './prompts';
import type { Llm, LlmTask, StructuredLlm } from './types';

/**
 * Offline fallback when the on-device model is unavailable: serves pre-generated text from
 * `fallback/{blurbs,questions}.json` keyed by stop name, and does rule-based cleanup for journal entries.
 */
export class FallbackLlm implements Llm, StructuredLlm {
  constructor(
    private readonly blurbs: Record<string, unknown> = {},
    private readonly questions: Record<string, unknown> = {},
  ) {}

  static async load(f: typeof fetch = (...a) => fetch(...a), base = ''): Promise<FallbackLlm> {
    const read = async (p: string): Promise<Record<string, unknown>> => {
      try {
        const res = await f(base + p);
        if (!res.ok) return {};
        const j = await res.json();
        return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
      } catch {
        return {};
      }
    };
    return new FallbackLlm(await read('fallback/blurbs.json'), await read('fallback/questions.json'));
  }

  generate(prompt: string): Promise<string> {
    return this.respond(Prompts.taskOf(prompt) ?? 'blurb', {
      facts: Prompts.factsFromPrompt(prompt),
      transcript: Prompts.parseTranscript(prompt),
    });
  }

  async respond(task: LlmTask, o: { facts?: StopFacts; transcript?: string }): Promise<string> {
    const name = o.facts?.name ?? '';
    const lookup = (m: Record<string, unknown>, d: string): string => {
      const v = m[name] ?? m._default;
      return typeof v === 'string' && v.trim() !== '' ? v : d;
    };
    switch (task) {
      case 'cleanup':
        return ruleBasedCleanup(o.transcript ?? '');
      case 'question':
        return lookup(this.questions, 'What do you notice here?');
      case 'blurb':
        return lookup(this.blurbs, `Take a moment to look around${name === '' ? '' : ` ${name}`}.`);
    }
  }
}

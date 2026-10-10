import type { StopFacts } from '../models/types';
import { PromptSet } from './prompts';
import { isStructured, type Llm, type LlmTask } from './types';
import { ruleBasedCleanup } from './prompts';
import { isFaithfulCleanup, isGoodBlurb, isGoodQuestion } from './guards';

/** Output acceptance rules; tune per model without code changes elsewhere. */
export interface TaskLimits {
  blurbMaxChars: number;
  questionMaxChars: number;
  /** Cleaned text may be at most raw.length * ratio + slack characters. */
  cleanupMaxRatio: number;
  cleanupSlackChars: number;
}

export const DEFAULT_LIMITS: TaskLimits = { blurbMaxChars: 400, questionMaxChars: 200, cleanupMaxRatio: 1.5, cleanupSlackChars: 40 };

export const DEFAULT_BLURB = 'Slow down here for a minute and notice one thing you would normally walk past.';
export const DEFAULT_QUESTION = 'What is one thing you notice here right now?';

export interface LlmTasksOptions {
  backup?: Llm | null;
  timeoutMs?: number;
  prompts?: PromptSet;
  limits?: Partial<TaskLimits>;
  /** Called when the primary fails or returns unusable output (for logs/UI). */
  onDegraded?: (task: string, reason: unknown) => void;
}

/** Rejects after `ms`, clearing the timer either way. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The one place the app asks the LLM for something. Callers never build prompts or handle model failures:
 * every task has a timeout, an output guard, and a backup (FallbackLlm / rule-based cleanup), so it always returns.
 */
export class LlmTasks {
  private readonly backup: Llm | null;
  private readonly timeoutMs: number;
  private readonly prompts: PromptSet;
  private readonly limits: TaskLimits;
  private readonly onDegraded?: (task: string, reason: unknown) => void;

  constructor(
    private readonly primary: Llm,
    o: LlmTasksOptions = {},
  ) {
    this.backup = o.backup ?? null;
    this.timeoutMs = o.timeoutMs ?? 45_000;
    this.prompts = o.prompts ?? new PromptSet();
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.onDegraded = o.onDegraded;
  }

  blurb(f: StopFacts): Promise<string> {
    return this.run(
      'blurb',
      (s) => s !== '' && s.length <= this.limits.blurbMaxChars && isGoodBlurb(s, f),
      DEFAULT_BLURB,
      { facts: f },
    );
  }

  question(f: StopFacts): Promise<string> {
    return this.run(
      'question',
      (s) => s !== '' && s.length <= this.limits.questionMaxChars && isGoodQuestion(s, f),
      DEFAULT_QUESTION,
      { facts: f },
    );
  }

  async cleanup(raw: string): Promise<string> {
    const text = raw.trim();
    if (text === '') return '';
    // A cleaned entry should be about as long as the input, and made of the same words: anything added, echoed from
    // the prompt, or summarised away means the model got it wrong, and the rule-based cleanup is used instead.
    const max = text.length * this.limits.cleanupMaxRatio + this.limits.cleanupSlackChars;
    return this.run('cleanup', (s) => s !== '' && s.length <= max && isFaithfulCleanup(text, s), ruleBasedCleanup(text), {
      transcript: text,
    });
  }

  private async run(
    task: LlmTask,
    valid: (s: string) => boolean,
    lastResort: string,
    o: { facts?: StopFacts; transcript?: string },
  ): Promise<string> {
    for (const llm of [this.primary, this.backup]) {
      if (!llm) continue;
      try {
        const call = isStructured(llm) ? llm.respond(task, o) : llm.generate(this.prompts.build(task, o));
        const out = LlmTasks.sanitize(await withTimeout(call, this.timeoutMs));
        if (valid(out)) return out;
        this.onDegraded?.(task, `invalid output from ${llm.constructor.name}: "${out}"`);
      } catch (e) {
        this.onDegraded?.(task, e);
      }
    }
    return lastResort;
  }

  /** Strips chat-model wrapping: surrounding quotes, "Here is ...:" preambles, markdown. */
  static sanitize(s: string): string {
    let t = s.trim();
    t = t.replace(/^(sure[,!.]?\s*)?here('s| is| are)[^\n:]*:\s*/i, '');
    t = t.replace(/^\*\*|\*\*$/g, '').trim();
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”')))) {
      t = t.slice(1, -1).trim();
    }
    return t;
  }
}

import type { StopFacts } from '../models/types';
import type { LlmTask } from './types';

/**
 * Prompt templates as data. Placeholders: {name} {type} {time_of_day} {weather} for stop tasks,
 * {transcript} for cleanup. Override any of them with a JSON file (see `PromptSet.load`) without touching code.
 *
 * The `TASK: <name>` header is always added by `build`, never by templates, so runtimes can rely on it
 * (e.g. the on-device engine picks max tokens from it).
 */
const BLURB = `Write 1-2 short sentences (max 40 words) inviting a walker to notice this place.
Use ONLY the facts below. Do not add history, dates, people, or claims not listed.
If a fact is missing, leave it out.
FACTS
name: {name}
type: {type}
time_of_day: {time_of_day}
weather: {weather}
Reply with the blurb text only.`;

const QUESTION = `Write ONE short reflective question (max 20 words) for a walker standing at this place.
Use ONLY the facts below. Ask about what they see, hear, or feel. No invented facts.
FACTS
name: {name}
type: {type}
time_of_day: {time_of_day}
weather: {weather}
Reply with the question only.`;

const CLEANUP = `Clean up this spoken journal entry: fix punctuation and capitalisation, remove filler
words (um, uh, like, you know) and false starts. Keep the speaker's words and meaning.
Do NOT add, summarise, or invent anything.
TRANSCRIPT
{transcript}
END TRANSCRIPT
Reply with the cleaned text only.`;

export const header = (t: LlmTask): string => `TASK: ${t}`;

/** Fact values come from OSM/weather APIs: force them onto one short line so a crafted name cannot add fake fact lines or instructions. */
export function oneLine(s: string, maxChars = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= maxChars ? t : t.slice(0, maxChars).trimEnd();
}

export class PromptSet {
  constructor(
    readonly blurb: string = BLURB,
    readonly question: string = QUESTION,
    readonly cleanup: string = CLEANUP,
  ) {}

  /** Missing or empty keys fall back to the built-in template. */
  static fromJson(j: Record<string, unknown>): PromptSet {
    const pick = (key: string, d: string) => {
      const v = j[key];
      return typeof v === 'string' && v.trim() !== '' ? v : d;
    };
    return new PromptSet(pick('blurb', BLURB), pick('question', QUESTION), pick('cleanup', CLEANUP));
  }

  /**
   * Loads an optional override file from `url`; any problem gives the built-in templates. With no `url` it does not
   * touch the network at all (the app ships no override file, and asking for a missing file shows as an error when offline).
   */
  static async load(f: typeof fetch = (...a) => fetch(...a), url?: string): Promise<PromptSet> {
    if (!url) return new PromptSet();
    try {
      const res = await f(url);
      if (!res.ok) return new PromptSet();
      const j = await res.json();
      return j && typeof j === 'object' && !Array.isArray(j) ? PromptSet.fromJson(j) : new PromptSet();
    } catch {
      return new PromptSet();
    }
  }

  build(task: LlmTask, o: { facts?: StopFacts; transcript?: string } = {}): string {
    const template = { blurb: this.blurb, question: this.question, cleanup: this.cleanup }[task];
    const values: Record<string, string> = {};
    if (o.facts) {
      values.name = oneLine(o.facts.name);
      values.type = oneLine(o.facts.tagType);
      values.time_of_day = oneLine(o.facts.timeOfDay);
      values.weather = oneLine(o.facts.weatherSummary);
    }
    if (o.transcript !== undefined) values.transcript = o.transcript.trim();
    // A function replacer keeps `$` in a transcript from being read as a replacement pattern.
    const body = template.replace(/\{(\w+)\}/g, (m, key: string) => values[key] ?? m);
    return `${header(task)}\n${body.trim()}`;
  }
}

/** Static helpers over the default PromptSet, plus parsing used by fakes when they receive a plain prompt string. */
export const Prompts = {
  blurbTask: header('blurb'),
  questionTask: header('question'),
  cleanupTask: header('cleanup'),
  blurb: (f: StopFacts) => new PromptSet().build('blurb', { facts: f }),
  question: (f: StopFacts) => new PromptSet().build('question', { facts: f }),
  cleanup: (raw: string) => new PromptSet().build('cleanup', { transcript: raw }),

  taskOf(prompt: string): LlmTask | null {
    for (const t of ['blurb', 'question', 'cleanup'] as const) if (prompt.startsWith(header(t))) return t;
    return null;
  },

  /** Reads `key: value` lines (first occurrence wins) from a prompt. */
  parseFacts(prompt: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of prompt.split('\n')) {
      const i = line.indexOf(': ');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      if (['name', 'type', 'time_of_day', 'weather'].includes(key) && !(key in out)) out[key] = line.slice(i + 2).trim();
    }
    return out;
  },

  factsFromPrompt(prompt: string): StopFacts {
    const f = Prompts.parseFacts(prompt);
    return { name: f.name ?? '', tagType: f.type ?? '', timeOfDay: f.time_of_day ?? '', weatherSummary: f.weather ?? '' };
  },

  /** Text between TRANSCRIPT and END TRANSCRIPT of a default cleanup prompt. */
  parseTranscript(prompt: string): string {
    const open = 'TRANSCRIPT\n';
    const close = '\nEND TRANSCRIPT';
    const start = prompt.indexOf(open);
    const end = prompt.lastIndexOf(close);
    if (start < 0 || end < start) return '';
    return prompt.slice(start + open.length, end).trim();
  },
};

/**
 * Deterministic, offline transcript cleanup. Used by fake and fallback Llms, and as the last resort when
 * the real model's output is rejected.
 */
export function ruleBasedCleanup(raw: string): string {
  let t = raw.trim();
  t = t.replace(/\[[^\]]*\]|\([^)]*\)/g, ' '); // whisper tags e.g. [BLANK_AUDIO]
  t = t.replace(/\b(um+|uh+|erm+|hmm+|you know|i mean)\b,?\s*/gi, '');
  t = t.replace(/\b(\w+)( \1\b)+/gi, (_m, w: string) => w); // "the the"
  t = t.replace(/\s+/g, ' ').trim();
  if (t === '') return t;
  t = t[0].toUpperCase() + t.slice(1);
  t = t.replace(/([.!?]\s+)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
  t = t.replace(/\bi\b/g, 'I');
  if (!/[.!?]$/.test(t)) t = `${t}.`;
  return t;
}

import type { StopFacts } from '../models/types';

/*
 * Output guards for the on-device language model. Small models ignore instructions: they echo the prompt,
 * leave placeholders, and invent details. These checks look at the CONTENT of an answer, not just its length,
 * and anything rejected falls back to pre-written text or rule-based cleanup (see LlmTasks), which is safe.
 */

const SENTENCE_END = /[.!?]["”')\]]*\s+/;

/** Lowercase word tokens; apostrophes are dropped so "don't" and "dont" match. */
export function wordsOf(s: string): string[] {
  return s.toLowerCase().replace(/['’]/g, '').match(/[a-z0-9]+/g) ?? [];
}

/** Text that is clearly the prompt, a template placeholder or chat markup rather than an answer. */
export function looksLikePromptEcho(s: string): boolean {
  return (
    /end transcript|reply with the|task:|\bfacts\b\s*\n|only the facts|\bdo not add\b|\[[^\]]*\]|<[^>]+>|```/i.test(s) ||
    /(^|\n)\s*(#{1,6}\s|[*-]\s|\d+\.\s)/.test(s)
  );
}

/** Words that spoken-journal cleanup is allowed to drop. */
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'erm', 'er', 'ah', 'hmm', 'hm', 'like', 'yeah']);

/**
 * A cleaned journal entry must stay faithful to what was said: (almost) no words that weren't spoken, and
 * (almost) no spoken content words dropped. That is the "do NOT add, summarise, or invent" rule, enforced.
 */
export function isFaithfulCleanup(raw: string, out: string): boolean {
  if (looksLikePromptEcho(out)) return false;
  const outWords = wordsOf(out);
  if (outWords.length === 0) return false;
  const inSet = new Set(wordsOf(raw));
  const added = outWords.filter((w) => !inSet.has(w)).length;
  if (added / outWords.length > 0.1) return false;
  const outSet = new Set(outWords);
  const content = [...inSet].filter((w) => !FILLERS.has(w));
  if (content.length === 0) return true;
  const kept = content.filter((w) => outSet.has(w)).length;
  return kept / content.length >= 0.7;
}

/**
 * Replaces the stop's own facts (its name above all) with a plain word, so punctuation and capitals inside a name like
 * "The Church of St. Matthew & St. Timothy" aren't mistaken for sentence ends or invented names.
 */
export function maskFacts(s: string, f?: StopFacts): string {
  if (!f) return s;
  const values = [f.name, f.tagType, f.timeOfDay, f.weatherSummary].map((v) => v.trim()).filter((v) => v.length >= 2);
  let out = s;
  for (const v of values.sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'there');
  }
  return out;
}

const factWords = (f?: StopFacts): Set<string> =>
  new Set(wordsOf(f ? `${f.name} ${f.tagType} ${f.timeOfDay} ${f.weatherSummary}` : ''));

/** Capitalised words that do not start a sentence: probably names the model made up. */
function inventedNames(s: string, allowed: Set<string>): string[] {
  const out: string[] = [];
  for (const sentence of s.split(SENTENCE_END)) {
    const tokens = sentence.match(/[A-Za-z][A-Za-z'’]*/g) ?? [];
    tokens.slice(1).forEach((t) => {
      if (/^[A-Z][a-z]+/.test(t) && !allowed.has(wordsOf(t)[0] ?? '')) out.push(t);
    });
  }
  return out;
}

function sharedChecks(s: string, f?: StopFacts): boolean {
  if (s.includes('\n') || /[*#`_]{1,}/.test(s.replace(/\w_\w/g, ''))) return false; // one plain paragraph
  if (looksLikePromptEcho(s)) return false;
  const allowed = factWords(f);
  // Numbers (years, distances, temperatures) may only come from the facts.
  if ((s.match(/\d+/g) ?? []).some((n) => !allowed.has(n))) return false;
  // So may names.
  const allowedWords = new Set([...allowed, 'i']);
  return inventedNames(s, allowedWords).length === 0;
}

const sentenceCount = (s: string) => s.split(SENTENCE_END).filter((x) => x.trim() !== '').length;

/** A 1-2 sentence invitation built only from the stop's facts. */
export function isGoodBlurb(s: string, f?: StopFacts): boolean {
  const t = maskFacts(s, f);
  return wordsOf(t).length <= 60 && sentenceCount(t) <= 3 && sharedChecks(t, f);
}

/** ONE short reflective question. */
export function isGoodQuestion(s: string, f?: StopFacts): boolean {
  const t = maskFacts(s, f);
  return wordsOf(t).length <= 30 && sentenceCount(t) <= 2 && sharedChecks(t, f);
}

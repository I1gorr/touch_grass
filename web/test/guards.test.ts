import { describe, expect, it } from 'vitest';
import type { StopFacts } from '../src/models/types';
import { isFaithfulCleanup, isGoodBlurb, isGoodQuestion, looksLikePromptEcho, maskFacts, wordsOf } from '../src/ml/guards';
import { LlmTasks } from '../src/ml/llmTasks';
import type { Llm } from '../src/ml/types';

const facts: StopFacts = { name: 'Bethesda Fountain', tagType: 'amenity=fountain', timeOfDay: 'morning', weatherSummary: 'clear, 12°C' };
const RAW = 'um so the light here is really nice and uh the the bench is still wet from the rain';

describe('cleanup guard (what the real Gemma 270M returned in testing)', () => {
  it('rejects the prompt echoed back as the "cleaned" entry', () => {
    const echoed = 'um so the light here is really nice and uh the the bench is still wet from the rain.\nEND TRANSCRIPT\nReply with the cleaned text only.';
    expect(isFaithfulCleanup(RAW, echoed)).toBe(false);
    expect(looksLikePromptEcho(echoed)).toBe(true);
  });

  it('accepts a faithful cleanup, with or without fillers kept', () => {
    expect(isFaithfulCleanup(RAW, 'So the light here is really nice and the bench is still wet from the rain.')).toBe(true);
    expect(isFaithfulCleanup(RAW, RAW + '.')).toBe(true);
    expect(isFaithfulCleanup("dont know i like it", "I don't know. I like it.")).toBe(true); // apostrophes
  });

  it('rejects added content, summaries and unrelated text', () => {
    expect(isFaithfulCleanup(RAW, 'The light is nice and the bench is wet, which made the whole walk magical and unforgettable.')).toBe(false);
    expect(isFaithfulCleanup(RAW, 'Nice light.')).toBe(false); // summarised away
    expect(isFaithfulCleanup(RAW, 'Today I walked to the park.')).toBe(false);
    expect(isFaithfulCleanup(RAW, '')).toBe(false);
    expect(isFaithfulCleanup(RAW, '...')).toBe(false);
  });

  it('only fillers in the input: anything alphabetic is accepted only if spoken', () => {
    expect(isFaithfulCleanup('um uh', 'Um, uh.')).toBe(true);
  });

  it('LlmTasks falls back to rule-based cleanup instead of saving the echo', async () => {
    const echo: Llm = { generate: async () => `${RAW}.\nEND TRANSCRIPT\nReply with the cleaned text only.` };
    const reasons: unknown[] = [];
    const out = await new LlmTasks(echo, { onDegraded: (_t, r) => reasons.push(r) }).cleanup(RAW);
    expect(out).toBe('So the light here is really nice and the bench is still wet from the rain.');
    expect(reasons).toHaveLength(1);
  });
});

describe('blurb guard (what the real Gemma 270M returned in testing)', () => {
  const hallucinated =
    "** Bethesda Fountain** is a beautiful and relaxing amenity perfect for a walker. It offers a scenic view of the city, a friendly atmosphere, and a convenient spot for enjoying the sunshine. It's a great place to stay and enjoy the fresh air and the friendly faces of the locals.\n\n**It's a must-have for any walker!**\n\n**[Your Address]**\n";

  it('rejects markdown, placeholders and multi-paragraph rambling', () => {
    expect(isGoodBlurb(hallucinated, facts)).toBe(false);
    expect(isGoodBlurb('Pause here.\n\nThen look up.', facts)).toBe(false);
    expect(isGoodBlurb('Visit [Your Address] today.', facts)).toBe(false);
    expect(isGoodBlurb('**Look** up.', facts)).toBe(false);
  });

  it('rejects invented numbers and names, but allows the facts', () => {
    expect(isGoodBlurb('This fountain was built in 1873 for the city.', facts)).toBe(false);
    expect(isGoodBlurb('Stand by the fountain and think of Central Park history.', facts)).toBe(false);
    expect(isGoodBlurb('It is 12 degrees. Stand by Bethesda Fountain this morning and listen.', facts)).toBe(true);
    expect(isGoodBlurb('Pause at Bethesda Fountain this morning. Notice the water.', facts)).toBe(true);
  });

  it('keeps blurbs short', () => {
    expect(isGoodBlurb(Array(70).fill('water').join(' ') + '.', facts)).toBe(false);
    expect(isGoodBlurb('One. Two. Three. Four.', facts)).toBe(false);
  });

  it('LlmTasks uses the pre-written backup when the model makes things up', async () => {
    const liar: Llm = { generate: async () => hallucinated };
    const backup: Llm = { generate: async () => 'Take a moment at the fountain.' };
    expect(await new LlmTasks(liar, { backup }).blurb(facts)).toBe('Take a moment at the fountain.');
    expect(await new LlmTasks(liar).blurb(facts)).toContain('Slow down here'); // last resort
  });
});

describe('question guard', () => {
  it('accepts one short question about the place and rejects rambling or invented names', () => {
    expect(isGoodQuestion('What do you hear near Bethesda Fountain right now?', facts)).toBe(true);
    expect(isGoodQuestion('What do you notice about the water?', facts)).toBe(true);
    expect(isGoodQuestion('Do you think Napoleon would have liked this?', facts)).toBe(false);
    expect(isGoodQuestion('A?\nB?', facts)).toBe(false);
    expect(isGoodQuestion('Why? Why? Why?', facts)).toBe(false);
  });
});

describe('words', () => {
  it('tokenises ignoring case, punctuation and apostrophes', () => {
    expect(wordsOf("Don't STOP, it's 12°C!")).toEqual(['dont', 'stop', 'its', '12', 'c']);
    expect(wordsOf('')).toEqual([]);
  });
});

describe('names with punctuation (regression: "St." was counted as a sentence end)', () => {
  const church: StopFacts = { name: 'The Church of St. Matthew & St. Timothy', tagType: 'amenity=place_of_worship', timeOfDay: 'afternoon', weatherSummary: 'clear, 12°C' };

  it('a good blurb about such a place is accepted', () => {
    expect(isGoodBlurb('Pause at The Church of St. Matthew & St. Timothy this afternoon. Take a slow look around before moving on.', church)).toBe(true);
    expect(isGoodBlurb('Stand outside the church of st. matthew & st. timothy and listen.', church)).toBe(true);
  });

  it('and so is a question', () => {
    expect(isGoodQuestion('What do you hear outside The Church of St. Matthew & St. Timothy right now?', church)).toBe(true);
  });

  it('masking does not let real inventions through', () => {
    expect(isGoodBlurb('The Church of St. Matthew & St. Timothy was built in 1873 by Christopher Wren.', church)).toBe(false);
    expect(isGoodBlurb('Pause at The Church of St. Matthew & St. Timothy. See. The. Sky. Now.', church)).toBe(false); // too many sentences
    expect(isGoodBlurb('Pause at The Church of St. Matthew & St. Timothy.\n\nGo inside.', church)).toBe(false);
  });

  it('masks facts case-insensitively and survives regex characters in names', () => {
    const odd: StopFacts = { name: 'Café (North) [Gate] +1?', tagType: '', timeOfDay: 'morning', weatherSummary: '' };
    expect(maskFacts('Meet at café (north) [gate] +1? soon', odd)).toBe('Meet at there soon');
    expect(maskFacts('unchanged', undefined)).toBe('unchanged');
    expect(isGoodBlurb('Meet at Café (North) [Gate] +1? this morning.', odd)).toBe(true);
  });
});

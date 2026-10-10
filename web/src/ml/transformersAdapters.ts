import type { LoadedPipeline, TranscribeResult } from './protocol';

/*
 * Maps transformers.js pipeline outputs to the app's own shapes. Kept apart from the (browser-only) loader so
 * the shapes can be tested with plain objects.
 */

/** `{text, chunks: [{timestamp: [start, end|null], text}]}` -> text + segments in milliseconds. */
export function toTranscription(out: any): TranscribeResult {
  const chunks: any[] = Array.isArray(out?.chunks) ? out.chunks : [];
  return {
    text: String(out?.text ?? '').trim(),
    segments: chunks.map((c) => {
      const [start, end] = Array.isArray(c.timestamp) ? c.timestamp : [0, null];
      const startMs = Math.round((Number(start) || 0) * 1000);
      return { startMs, endMs: end == null ? startMs : Math.round(Number(end) * 1000), text: String(c.text ?? '').trim() };
    }),
  };
}

/** The assistant's reply from a chat-style text-generation result. */
export function lastAssistantText(out: any): string {
  const generated = Array.isArray(out) ? out[0]?.generated_text : out?.generated_text;
  if (typeof generated === 'string') return generated;
  if (Array.isArray(generated)) {
    for (let i = generated.length - 1; i >= 0; i--) {
      if (generated[i]?.role === 'assistant' && typeof generated[i].content === 'string') return generated[i].content;
    }
  }
  throw new Error('the language model returned nothing');
}

/** Wraps a speech-recognition pipeline. Whisper wants 16 kHz mono, which the recorder already produces. */
export function adaptStt(pipe: any): LoadedPipeline {
  return {
    async run(input) {
      const { samples } = input as { samples: Float32Array };
      return toTranscription(await pipe(samples, { chunk_length_s: 30, return_timestamps: true }));
    },
    dispose: async () => pipe.dispose?.(),
  };
}

/** Wraps a text-generation pipeline. The whole prompt goes in as one user message (the model's chat template is applied for us). */
export function adaptLlm(pipe: any): LoadedPipeline {
  return {
    async run(input) {
      const { prompt, maxTokens, temperature } = input as { prompt: string; maxTokens: number; temperature: number };
      const out = await pipe([{ role: 'user', content: prompt }], {
        max_new_tokens: maxTokens,
        do_sample: temperature > 0,
        ...(temperature > 0 ? { temperature } : {}),
      });
      return lastAssistantText(out);
    },
    dispose: async () => pipe.dispose?.(),
  };
}

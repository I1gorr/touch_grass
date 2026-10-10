import { describe, expect, it } from 'vitest';
import { hasWebGpu } from '../src/ml/capabilities';

describe('WebGPU check', () => {
  it('is true only with an adapter', async () => {
    expect(await hasWebGpu({ gpu: { requestAdapter: async () => ({}) } })).toBe(true);
    expect(await hasWebGpu({ gpu: { requestAdapter: async () => null } })).toBe(false);
    expect(await hasWebGpu({ gpu: { requestAdapter: async () => { throw new Error('blocked'); } } })).toBe(false);
    expect(await hasWebGpu({})).toBe(false);
    expect(await hasWebGpu(undefined)).toBe(false);
  });
});

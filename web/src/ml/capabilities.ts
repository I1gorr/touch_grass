/** Minimal view of `navigator` for capability checks (so tests can fake it). */
export interface NavLike {
  gpu?: { requestAdapter(): Promise<unknown | null> };
}

/**
 * Whether this browser has a usable WebGPU adapter. The on-device language model needs it: its 4-bit weights use an
 * operator the WebAssembly backend doesn't implement (it fails with "Could not find an implementation for
 * GatherBlockQuantized"), so without WebGPU the model would download (~880 MB) and then never run.
 * The speech model runs on WebAssembly and does not need it.
 */
export async function hasWebGpu(nav: NavLike | undefined = globalThis.navigator as NavLike | undefined): Promise<boolean> {
  try {
    return !!nav?.gpu && !!(await nav.gpu.requestAdapter());
  } catch {
    return false;
  }
}

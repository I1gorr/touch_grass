export type Fetch = typeof fetch;

/** `fetch` that gives up after `ms`. Throws on timeout like any network failure. */
export async function fetchWithTimeout(f: Fetch, url: string | URL, init: RequestInit, ms: number): Promise<Response> {
  return f(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** Ensures a base URL ends without a trailing slash, for `${base}/v1/...`. */
export const trimSlash = (u: string): string => (u.endsWith('/') ? u.slice(0, -1) : u);

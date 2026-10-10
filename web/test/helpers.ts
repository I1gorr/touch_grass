/** A fetch double: `handler` sees a simple request view and returns a Response (or throws like a network failure). */
export interface Req {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
  /** For Overpass form posts: the `data` field (the query). */
  query: string | null;
}

export function mockFetch(handler: (r: Req) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = init.body == null ? '' : String(init.body);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let query: string | null = null;
    if (body.startsWith('data=')) query = new URLSearchParams(body).get('data');
    const pending = Promise.resolve(handler({ url: new URL(String(input), 'http://localhost/'), method: init.method ?? 'GET', headers, body, query }));
    // Like a real fetch, give up when the caller's AbortSignal fires (e.g. AbortSignal.timeout).
    const signal = init.signal;
    if (!signal) return pending;
    return Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        const fail = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      }),
    ]);
  }) as typeof fetch;
}

export const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
export const text = (v: string, status = 200) => new Response(v, { status });
export const offline = (): never => {
  throw new TypeError('Failed to fetch');
};

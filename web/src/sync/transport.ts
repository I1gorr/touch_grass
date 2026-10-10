import type { SyncBatch } from '../db/walkRepo';
import { type Fetch, fetchWithTimeout, trimSlash } from '../data/http';

export class SyncException extends Error {
  override name = 'SyncException';
  constructor(
    message: string,
    /** HTTP status, or undefined for network/timeout errors. */
    readonly status?: number,
  ) {
    super(message);
  }

  /** 4xx other than 408/429 won't fix themselves by retrying (bad key, bad payload). */
  get isPermanent(): boolean {
    const s = this.status;
    return s !== undefined && s >= 400 && s < 500 && s !== 408 && s !== 429;
  }
}

/**
 * Sends walk/stop/entry rows to the cloud (never images). Throws SyncException on failure; must be
 * idempotent on the server side (the same batch may be sent twice).
 */
export interface SyncTransport {
  /** Returns how many rows the server refused because another install owns them (this one can't retry them). */
  push(deviceId: string, batch: SyncBatch): Promise<number>;
  /** Releases connections. Called once, when sync shuts down. */
  close(): Promise<void>;
}

/** POSTs to the touch_grass sync API (server/), which writes to MongoDB Atlas. The phone only holds this API's key. */
export class HttpSyncTransport implements SyncTransport {
  private readonly endpoint: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 15_000,
    private readonly f: Fetch = (...a) => fetch(...a),
  ) {
    this.endpoint = `${trimSlash(baseUrl)}/v1/sync`;
  }

  async push(deviceId: string, batch: SyncBatch): Promise<number> {
    const body = JSON.stringify({ deviceId, walks: batch.walk ?? [], stops: batch.stop ?? [], entries: batch.entry ?? [] });
    let res: Response;
    try {
      res = await fetchWithTimeout(this.f, this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey }, body }, this.timeoutMs);
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new SyncException('timed out (offline?)');
      throw new SyncException(`network error: ${e}`);
    }
    const text = await res.text().catch(() => '');
    if (res.status < 200 || res.status >= 300) {
      const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      throw new SyncException(snippet === '' ? `HTTP ${res.status}` : snippet, res.status);
    }
    return foreignCount(text);
  }

  async close(): Promise<void> {}
}

/** Sums `counts.<collection>.foreign` from the server reply; 0 if absent. */
function foreignCount(body: string): number {
  try {
    const counts = (JSON.parse(body) as { counts?: unknown }).counts;
    if (!counts || typeof counts !== 'object') return 0;
    let n = 0;
    for (const c of Object.values(counts as Record<string, { foreign?: unknown }>)) {
      if (c && typeof c.foreign === 'number' && Number.isInteger(c.foreign)) n += c.foreign;
    }
    return n;
  } catch {
    return 0;
  }
}

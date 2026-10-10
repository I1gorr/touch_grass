import type { TgDb } from '../db/schema';
import { type Fetch, fetchWithTimeout, trimSlash } from './http';

interface ReportDoc {
  pending: { entryId: string; reason: string }[];
  hidden: string[];
}

const KEY = 'reports';

/**
 * Reports of community notes, kept on the phone until the internet is back.
 * A reported note is hidden for this person immediately, even offline.
 */
export class ReportQueue {
  constructor(private readonly db: TgDb) {}

  private async read(): Promise<ReportDoc> {
    try {
      const row = await this.db.get('kv', KEY);
      const v = row?.value as Partial<ReportDoc> | undefined;
      if (v && Array.isArray(v.pending) && Array.isArray(v.hidden)) return { pending: v.pending, hidden: v.hidden };
    } catch {
      /* corrupt: start fresh */
    }
    return { pending: [], hidden: [] };
  }

  private async write(doc: ReportDoc): Promise<void> {
    await this.db.put('kv', { key: KEY, value: doc });
  }

  /** Notes this person reported (and so no longer sees). */
  async hiddenIds(): Promise<Set<string>> {
    return new Set((await this.read()).hidden);
  }

  async pending(): Promise<{ entryId: string; reason: string }[]> {
    return (await this.read()).pending;
  }

  async report(entryId: string, reason = 'other'): Promise<void> {
    const d = await this.read();
    const hidden = new Set([...d.hidden, entryId]);
    const pending = d.pending.some((p) => p.entryId === entryId) ? d.pending : [...d.pending, { entryId, reason }];
    await this.write({ pending, hidden: [...hidden] });
  }

  /** Forget a report once the server has it. The note stays hidden locally. */
  async markSent(entryId: string): Promise<void> {
    const d = await this.read();
    await this.write({ ...d, pending: d.pending.filter((p) => p.entryId !== entryId) });
  }
}

/** Sends queued reports to `POST /v1/reports` when online. Never throws. */
export class ReportClient {
  constructor(
    private readonly baseUrl: string,
    private readonly queue: ReportQueue,
    private readonly deviceId: () => Promise<string>,
    private readonly apiKey: string | null = null,
    private readonly f: Fetch = (...a) => fetch(...a),
    private readonly timeoutMs = 10_000,
  ) {}

  /** Returns how many reports the server now has. Stops at the first network failure; the rest stay queued. */
  async flush(): Promise<number> {
    let sent = 0;
    try {
      const device = await this.deviceId();
      for (const r of await this.queue.pending()) {
        const res = await fetchWithTimeout(
          this.f,
          `${trimSlash(this.baseUrl)}/v1/reports`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) },
            body: JSON.stringify({ deviceId: device, entryId: r.entryId, reason: r.reason }),
          },
          this.timeoutMs,
        );
        // 404 = the note no longer exists, so there is nothing left to report.
        if (res.status === 202 || res.status === 404 || res.status === 400) {
          await this.queue.markSent(r.entryId);
          if (res.status === 202) sent++;
        } else {
          break;
        }
      }
    } catch {
      /* offline: try again next time */
    }
    return sent;
  }
}

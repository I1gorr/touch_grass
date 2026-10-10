/**
 * Keeps the screen on while something needs it (recording a note). Browsers stop microphone capture when the
 * phone's screen locks, so without this a long note would be cut off. Silently does nothing where unsupported.
 */
export class WakeLockHolder {
  private lock: { release(): Promise<void> } | null = null;
  private wanted = false;

  constructor(private readonly nav: { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } } = globalThis.navigator ?? {}) {}

  /** Call with true while recording, false otherwise. Safe to call repeatedly. */
  async set(on: boolean): Promise<void> {
    this.wanted = on;
    if (on && !this.lock) {
      try {
        const l = await this.nav.wakeLock?.request('screen');
        if (!l) return;
        if (this.wanted) this.lock = l;
        else await l.release(); // no longer wanted by the time it was granted
      } catch {
        /* denied (e.g. low battery) */
      }
    } else if (!on && this.lock) {
      const l = this.lock;
      this.lock = null;
      await l.release().catch(() => undefined);
    }
  }

  /** The browser drops the lock when the page is hidden; ask again when it comes back. */
  async reacquire(): Promise<void> {
    if (this.wanted && !this.lock) await this.set(true);
  }

  get held(): boolean {
    return this.lock !== null;
  }
}

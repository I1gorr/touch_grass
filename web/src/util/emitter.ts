/** Minimal change signal: the web stand-in for the Dart broadcast `Stream<void>`. */
export class Emitter {
  private listeners = new Set<() => void>();

  /** Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  clear(): void {
    this.listeners.clear();
  }
}

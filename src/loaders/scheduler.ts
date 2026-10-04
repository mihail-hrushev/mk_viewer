/**
 * Cooperative time slicing for loaders: `shouldYield()` is one clock read; `yield()` resumes in a new
 * macrotask (MessageChannel like React's scheduler — no 4 ms setTimeout clamping; setImmediate in Node), which lets the
 * browser render frames and handle input between slices, so partially loaded content is presented.
 */

const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();

export function abortError(): DOMException {
  return new DOMException('Model load aborted', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';
}

export class Slicer {
  private sliceStart = now();
  private channel: MessageChannel | null = null;
  private waiting: Array<() => void> = [];
  private readonly resolved = Promise.resolve();
  /** Number of yields performed (diagnostics). */
  yields = 0;

  constructor(
    private readonly budgetMs: number,
    private readonly signal: AbortSignal,
  ) {}

  shouldYield(): boolean {
    return this.signal.aborted || now() - this.sliceStart >= this.budgetMs;
  }

  yield(): Promise<void> {
    if (this.signal.aborted) return Promise.reject(abortError());
    this.yields++;
    return new Promise<void>((resolve, reject) => {
      this.waiting.push(() => {
        this.sliceStart = now();
        if (this.signal.aborted) reject(abortError());
        else resolve();
      });
      this.post();
    });
  }

  yieldIfNeeded(): Promise<void> {
    if (this.signal.aborted) return Promise.reject(abortError());
    return this.shouldYield() ? this.yield() : this.resolved;
  }

  /** Releases the MessageChannel (it would keep a Node process alive). */
  dispose(): void {
    const ch = this.channel;
    this.channel = null;
    if (ch) {
      ch.port1.onmessage = null;
      ch.port1.close();
      ch.port2.close();
    }
    const w = this.waiting;
    this.waiting = [];
    for (const fn of w) fn();
  }

  private post(): void {
    // Node: setImmediate (MessagePort deliveries can be drained back-to-back there, starving timers/IO).
    const si = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate;
    if (typeof si === 'function') {
      si(() => this.flush());
      return;
    }
    if (typeof MessageChannel === 'undefined') {
      setTimeout(() => this.flush(), 0);
      return;
    }
    if (!this.channel) {
      this.channel = new MessageChannel();
      this.channel.port1.onmessage = () => this.flush();
    }
    this.channel.port2.postMessage(0);
  }

  private flush(): void {
    const w = this.waiting;
    if (w.length === 0) return;
    this.waiting = [];
    for (const fn of w) fn();
  }
}

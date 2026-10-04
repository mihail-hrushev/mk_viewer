/**
 * Cooperative time slicing for loaders: `shouldYield()` is one clock read; `yield()` resumes in a new
 * macrotask, which lets the browser render frames and handle input between slices, so partially loaded
 * content is presented.
 *
 * All loads share one FIFO dispatcher: every yielded continuation is queued and each macrotask
 * (MessageChannel message like React's scheduler, no 4 ms setTimeout clamping; setImmediate in Node)
 * resumes exactly one of them. Concurrent loads therefore run round-robin, one slice each. In
 * browsers the dispatcher is also frame-paced: all loads together get a budget of main-thread time
 * per animation frame (half the frame interval, 8..50 ms), so rendering keeps its rate and each frame
 * only has to batch / upload a bounded amount of new content.
 */

const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();

export function abortError(): DOMException {
  return new DOMException('Model load aborted', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';
}

// --- shared dispatcher ----------------------------------------------------------------------------

const queue: Array<() => void> = [];
let head = 0;
let channel: MessageChannel | null = null;
/** A pump message (or timer) is in flight. */
let pumping = false;

// Frame pacing (browsers): loaders may use `frameBudget` ms of main-thread time per rendered frame,
// then wait for the next animation frame. Without it, Chrome runs queued slices back to back while
// the GPU renders a slow frame, and the next frame then has to batch and upload everything that
// arrived (long frames, a stalled-looking picture).
const raf: ((cb: (t: number) => void) => number) | undefined =
  typeof requestAnimationFrame === 'function' && typeof document !== 'undefined'
    ? requestAnimationFrame.bind(globalThis)
    : undefined;
let usedMs = 0;
let frameBudget = 10;
let lastFrame = 0;
let rafArmed = false;
let waitingFrame = false;
let waitTimer: ReturnType<typeof setTimeout> | null = null;
/** Frames requested while hidden never come: resume after this anyway. */
const FRAME_WAIT_MAX_MS = 100;

function onFrame(): void {
  rafArmed = false;
  const t = now();
  if (lastFrame > 0) {
    // half of the frame interval, within [8, 50] ms (slow GPUs leave the main thread idle longer)
    const interval = t - lastFrame;
    frameBudget = Math.min(50, Math.max(8, interval * 0.5));
  }
  lastFrame = t;
  usedMs = 0;
  if (head < queue.length) armFrame(); // keep observing frame boundaries while loads run
  else lastFrame = 0;
  if (waitingFrame) resume();
}

function armFrame(): void {
  if (rafArmed || !raf) return;
  rafArmed = true;
  raf(onFrame);
}

function resume(): void {
  waitingFrame = false;
  if (waitTimer !== null) {
    clearTimeout(waitTimer);
    waitTimer = null;
  }
  usedMs = 0;
  postPump();
}

function pump(): void {
  pumping = false;
  if (head >= queue.length) {
    releaseChannel();
    return;
  }
  if (raf && usedMs >= frameBudget) {
    waitingFrame = true;
    armFrame();
    waitTimer = setTimeout(resume, FRAME_WAIT_MAX_MS);
    return;
  }
  const fn = queue[head];
  queue[head++] = noop;
  if (head > 1024 && head * 2 > queue.length) {
    queue.splice(0, head);
    head = 0;
  }
  fn(); // resolves a yield promise: the slice itself runs in this task's microtasks
  if (head < queue.length) postPump();
  else releaseChannel();
}

function noop(): void {}

function releaseChannel(): void {
  // an open MessagePort keeps a Node process alive (tests); browsers do not care
  if (head < queue.length || !channel || pumping) return;
  channel.port1.onmessage = null;
  channel.port1.close();
  channel.port2.close();
  channel = null;
}

function postPump(): void {
  if (pumping || waitingFrame) return;
  pumping = true;
  // Node: setImmediate (MessagePort deliveries can be drained back-to-back there, starving timers/IO).
  const si = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate;
  if (typeof si === 'function') {
    si(pump);
    return;
  }
  if (typeof MessageChannel === 'undefined') {
    setTimeout(pump, 0);
    return;
  }
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = pump;
  }
  channel.port2.postMessage(0);
}

/** Charges main-thread time spent by a loader slice to the current frame's budget. */
function charge(ms: number): void {
  usedMs += ms;
}

/** Queues `fn` to run in its own macrotask, after every continuation queued before it. */
export function schedule(fn: () => void): void {
  queue.push(fn);
  armFrame();
  postPump();
}

// --- per-load slicer --------------------------------------------------------------------------------

export class Slicer {
  private sliceStart = now();
  private readonly resolved = Promise.resolve();
  private pending = new Set<() => void>();
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
    charge(now() - this.sliceStart);
    return new Promise<void>((resolve, reject) => {
      const resume = () => {
        if (!this.pending.delete(resume)) return; // already settled by dispose()
        this.sliceStart = now();
        if (this.signal.aborted) reject(abortError());
        else resolve();
      };
      this.pending.add(resume);
      schedule(resume);
    });
  }

  yieldIfNeeded(): Promise<void> {
    if (this.signal.aborted) return Promise.reject(abortError());
    return this.shouldYield() ? this.yield() : this.resolved;
  }

  /** Settles pending yields at once (the load finished or was rolled back). */
  dispose(): void {
    const p = Array.from(this.pending);
    for (const fn of p) {
      // run the continuation now instead of waiting for its macrotask
      fn.call(null);
    }
  }
}

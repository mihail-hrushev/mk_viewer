import { describe, expect, it } from 'vitest';
import { BudgetController } from './BudgetController';

const REFRESH = 1000 / 60;

interface SimResult {
  submitted: number[];
  intervals: number[];
  limited: boolean[];
  units: number[];
}

/**
 * Simulated GPU-bound renderer: `capacity` work units fit into one refresh interval; the frame
 * interval is the next vsync multiple of the GPU time. `lag` delays the measured interval by that
 * many frames (GPU pipelining), `gpuTimer` additionally reports the GPU time.
 */
function simulate(opts: {
  capacity: number;
  demand: number;
  frames: number;
  initialUnits?: number;
  lag?: number;
  gpuTimer?: boolean;
  jitter?: () => number;
}): SimResult {
  const b = new BudgetController({ targetMs: 12, initialUnits: opts.initialUnits });
  const lag = opts.lag ?? 0;
  const r: SimResult = { submitted: [], intervals: [], limited: [], units: [] };
  const gpuMsHist: number[] = [];
  for (let i = 0; i < opts.frames; i++) {
    const submitted = Math.min(b.units, opts.demand);
    const limited = opts.demand > b.units;
    const gpuMs = (submitted / opts.capacity) * REFRESH;
    gpuMsHist.push(gpuMs);
    const measured = gpuMsHist[Math.max(0, i - lag)];
    const interval = Math.max(1, Math.ceil(measured / REFRESH - 1e-9)) * REFRESH + (opts.jitter ? opts.jitter() : 0);
    r.submitted.push(submitted);
    r.limited.push(limited);
    r.intervals.push(interval);
    r.units.push(b.units);
    b.update({
      submitted,
      limited,
      intervalMs: interval,
      cpuMs: 0.3,
      gpuMs: opts.gpuTimer ? gpuMsHist[Math.max(0, i - 2)] : NaN,
    });
  }
  return r;
}

function tail<T>(a: T[], n: number): T[] {
  return a.slice(a.length - n);
}

describe('BudgetController', () => {
  it('converges to holding the refresh rate on a scene far heavier than the GPU (rAF only)', () => {
    const capacity = 400_000;
    const r = simulate({ capacity, demand: 10_000_000, frames: 600 });
    const iv = tail(r.intervals, 300);
    const late = iv.filter((x) => x > REFRESH * 1.01).length / iv.length;
    const sub = tail(r.submitted, 300);
    const mean = sub.reduce((s, x) => s + x, 0) / sub.length;
    expect(late).toBeLessThan(0.1); // at most ~1 missed frame in 10
    expect(mean).toBeGreaterThan(capacity * 0.6); // and not needlessly conservative
    expect(mean).toBeLessThan(capacity * 1.05);
  });

  it('still converges when measurements arrive one frame late', () => {
    const capacity = 250_000;
    const r = simulate({ capacity, demand: 5_000_000, frames: 800, lag: 1 });
    const iv = tail(r.intervals, 400);
    const late = iv.filter((x) => x > REFRESH * 1.01).length / iv.length;
    const sub = tail(r.submitted, 400);
    const mean = sub.reduce((s, x) => s + x, 0) / sub.length;
    expect(late).toBeLessThan(0.15);
    expect(mean).toBeGreaterThan(capacity * 0.5);
  });

  it('uses GPU timer measurements to settle closer to the target', () => {
    const capacity = 1_000_000;
    const r = simulate({ capacity, demand: 20_000_000, frames: 400, gpuTimer: true, lag: 1 });
    const iv = tail(r.intervals, 200);
    const late = iv.filter((x) => x > REFRESH * 1.01).length / iv.length;
    const sub = tail(r.submitted, 200);
    const mean = sub.reduce((s, x) => s + x, 0) / sub.length;
    expect(late).toBeLessThan(0.05);
    // target is min(12 ms, 0.8 * refresh) = 12 ms of a 16.7 ms interval
    expect(mean).toBeGreaterThan(capacity * 0.5);
  });

  it('a light scene that fits the budget draws completely every frame', () => {
    const r = simulate({ capacity: 5_000_000, demand: 300_000, frames: 200 });
    expect(r.limited.every((l) => !l)).toBe(true);
    expect(r.submitted.every((s) => s === 300_000)).toBe(true);
  });

  it('grows quickly when the scene grows and the GPU has headroom', () => {
    const capacity = 3_000_000;
    const r = simulate({ capacity, demand: 2_000_000, frames: 120, initialUnits: 20_000 });
    // ~10 % per frame from 20k: well above 1M within 2 seconds
    expect(tail(r.submitted, 1)[0]).toBe(2_000_000);
    expect(r.limited.slice(-20).every((l) => !l)).toBe(true);
  });

  it('recovers from a spurious overload (e.g. a GC pause) instead of staying low', () => {
    let i = 0;
    const capacity = 600_000;
    const r = simulate({
      capacity,
      demand: 10_000_000,
      frames: 900,
      jitter: () => (++i === 400 ? 300 : 0), // one 300 ms hiccup
    });
    const sub = tail(r.submitted, 200);
    const mean = sub.reduce((s, x) => s + x, 0) / sub.length;
    expect(mean).toBeGreaterThan(capacity * 0.55);
  });

  it('tracks the display refresh interval', () => {
    const b = new BudgetController({ targetMs: 12 });
    for (let i = 0; i < 100; i++) {
      b.update({ submitted: 1, limited: false, intervalMs: 1000 / 120, cpuMs: 0.1, gpuMs: NaN });
    }
    expect(b.refreshMs).toBeCloseTo(1000 / 120, 1);
    expect(b.effectiveTargetMs).toBeLessThan(1000 / 120);
  });
});

/**
 * Adaptive per-frame work budget for the progressive renderer.
 *
 * GL calls are asynchronous, so the time a frame's draw calls cost is not known when they are
 * issued. The renderer therefore spends a budget of abstract work units (triangles plus a fixed
 * overhead per draw item) and this controller corrects that budget from what it can measure
 * afterwards:
 *
 *  - the rAF interval that followed a busy frame: when the GPU (or CPU) cannot keep up, frames
 *    miss vsync and the interval grows beyond the display refresh interval;
 *  - the CPU time spent submitting the frame;
 *  - GPU time from EXT_disjoint_timer_query_webgl2 when available (a few frames late).
 *
 * Policy: multiplicative decrease on overrun (proportional to how late the frame was), cautious
 * multiplicative increase only while the previous frame was actually limited by the budget and
 * arrived on time. The budget that last caused an overrun is remembered as a soft ceiling, so the
 * controller settles just below it instead of oscillating; the ceiling relaxes slowly so the
 * controller keeps probing when conditions improve. Light scenes that fit into the budget never
 * trigger "limited", so nothing is ever dropped for them.
 *
 * Pure logic, no DOM/GL: unit tested in BudgetController.test.ts.
 */

export interface BudgetOptions {
  /** Upper bound of frame time the renderer may use (ViewerOptions.frameBudgetMs). */
  targetMs: number;
  /** Starting budget in work units. Default 1.5M. */
  initialUnits?: number;
  /** Lower clamp. Default 20k. */
  minUnits?: number;
  /** Upper clamp. Default 400M. */
  maxUnits?: number;
}

export interface FrameSample {
  /** Work units submitted by the measured frame. */
  submitted: number;
  /** True when the frame stopped because of the budget (more work was available). */
  limited: boolean;
  /**
   * rAF interval that followed the measured frame, ms. NaN when unknown (first frame after the loop
   * was idle, or the frames were not consecutive).
   */
  intervalMs: number;
  /** CPU time spent in the measured frame (traversal + submission), ms. */
  cpuMs: number;
  /** Most recent GPU frame time, ms, NaN when no timer query is available. */
  gpuMs: number;
}

export class BudgetController {
  /** Current per-frame work budget (units). */
  units: number;
  /** Estimated display refresh interval in ms (tracks the shortest typical rAF interval). */
  refreshMs = 1000 / 60;
  /** Budget that last caused an overrun (Infinity when none recently). */
  ceiling = Infinity;
  /** Number of decreases so far (diagnostics). */
  decreases = 0;

  targetMs: number;
  readonly minUnits: number;
  readonly maxUnits: number;
  private cooldown = 0;
  private hold = 0;
  private refreshSamples = 0;

  constructor(opts: BudgetOptions) {
    this.targetMs = opts.targetMs;
    this.units = opts.initialUnits ?? 1.5e6;
    this.minUnits = opts.minUnits ?? 2e4;
    this.maxUnits = opts.maxUnits ?? 4e8;
  }

  /** Time the renderer aims to use per frame: the configured budget, but below the refresh interval. */
  get effectiveTargetMs(): number {
    return Math.min(this.targetMs, this.refreshMs * 0.8);
  }

  /** Feeds the measurements of one finished frame. */
  update(s: FrameSample): void {
    const interval = s.intervalMs;
    if (Number.isFinite(interval) && interval > 0) this.trackRefresh(interval);
    if (this.cooldown > 0) this.cooldown--;
    if (this.hold > 0) this.hold--;
    // relax the ceiling so the controller keeps probing (doubles in ~6 s at 60 Hz)
    if (this.ceiling !== Infinity) {
      this.ceiling *= 1.002;
      if (this.ceiling > this.maxUnits) this.ceiling = Infinity;
    }

    // Only frames that used a meaningful share of the budget tell something about capacity.
    const significant = s.submitted >= this.units * 0.3;
    const target = this.effectiveTargetMs;
    const refresh = this.refreshMs;

    // Overload signals -> decrease factor (smallest wins).
    let factor = 1;
    if (significant && Number.isFinite(interval) && interval > refresh * 1.4) {
      // Missed vsync. Intervals are quantized to vsync multiples, so a frame that was 2 % too slow
      // looks like 2x: back off mildly for one missed vsync, proportionally for severe overruns.
      factor = interval <= refresh * 2.5 ? 0.8 : clamp((refresh * 0.9) / interval, 0.3, 0.8);
    }
    if (significant && Number.isFinite(s.gpuMs) && s.gpuMs > target) {
      factor = Math.min(factor, clamp((target * 0.95) / s.gpuMs, 0.3, 0.95));
    }
    if (significant && s.cpuMs > target) {
      factor = Math.min(factor, clamp((target * 0.95) / s.cpuMs, 0.3, 0.95));
    }

    if (factor < 1) {
      // Measurements lag the submission by a frame or two: the samples right after a decrease still
      // describe the old, larger budget, so they must not decrease again.
      if (this.hold === 0) {
        this.ceiling = Math.min(this.ceiling, this.units);
        this.units *= factor;
        this.hold = 3;
        this.cooldown = 6;
        this.decreases++;
      }
    } else if (s.limited && this.cooldown === 0 && (!Number.isFinite(interval) || interval <= refresh * 1.25)) {
      let inc: number;
      const used = Math.max(s.cpuMs, Number.isFinite(s.gpuMs) ? s.gpuMs : 0);
      if (Number.isFinite(s.gpuMs) && used > 0.05) {
        // measured headroom (GPU timer): move half of the way towards the target
        inc = clamp(1 + ((target / used) - 1) * 0.5, 1, 1.25);
      } else {
        inc = 1.1;
      }
      // approach the budget that last overran gently
      if (this.units * inc > this.ceiling * 0.9) inc = Math.min(inc, 1.004);
      this.units *= inc;
    }
    this.units = clamp(this.units, this.minUnits, this.maxUnits);
  }

  /** Forget the ceiling (e.g. after a resize or a context restore). */
  resetCeiling(): void {
    this.ceiling = Infinity;
    this.cooldown = 0;
    this.hold = 0;
  }

  private trackRefresh(interval: number): void {
    // ignore absurd values (tab in background, debugger)
    if (interval > 250) return;
    this.refreshSamples++;
    if (interval < this.refreshMs) {
      // fast down: the display can go at least this fast
      this.refreshMs += (interval - this.refreshMs) * (this.refreshSamples < 10 ? 0.5 : 0.2);
    } else {
      // slow up: long intervals are usually our own overruns, not the display
      this.refreshMs += (interval - this.refreshMs) * 0.002;
    }
    this.refreshMs = clamp(this.refreshMs, 1000 / 360, 1000 / 20);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

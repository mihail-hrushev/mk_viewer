/**
 * Sorted, non-overlapping set of half-open [start, end) ranges (bytes, floats, rows: unit-agnostic)
 * used to batch partial GPU uploads. Ranges closer than `mergeGap` are fused (one larger upload is
 * cheaper than many tiny ones); when more than `maxRanges` would remain, the closest pair is fused.
 * No allocation after construction.
 */
export class DirtyRanges {
  private readonly starts: Float64Array;
  private readonly ends: Float64Array;
  private n = 0;

  constructor(
    /** Ranges separated by at most this many units are merged. */
    readonly mergeGap = 0,
    /** Upper bound on stored ranges. */
    readonly maxRanges = 32,
  ) {
    if (maxRanges < 1) throw new Error('DirtyRanges: maxRanges must be >= 1');
    this.starts = new Float64Array(maxRanges + 1);
    this.ends = new Float64Array(maxRanges + 1);
  }

  get count(): number {
    return this.n;
  }

  get isEmpty(): boolean {
    return this.n === 0;
  }

  start(i: number): number {
    return this.starts[i];
  }

  end(i: number): number {
    return this.ends[i];
  }

  /** Smallest start, or 0 when empty. */
  get min(): number {
    return this.n ? this.starts[0] : 0;
  }

  /** Largest end, or 0 when empty. */
  get max(): number {
    return this.n ? this.ends[this.n - 1] : 0;
  }

  /** Total units covered. */
  get size(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.ends[i] - this.starts[i];
    return s;
  }

  clear(): void {
    this.n = 0;
  }

  /** Adds [start, end). Empty or inverted ranges are ignored. */
  add(start: number, end: number): void {
    if (!(end > start)) return;
    const s = this.starts;
    const e = this.ends;
    const gap = this.mergeGap;
    // first range whose end (+gap) reaches start
    let i = 0;
    while (i < this.n && e[i] + gap < start) i++;
    if (i < this.n && s[i] - gap <= end) {
      // overlaps / touches range i: grow it, then absorb following ranges it now reaches
      if (start < s[i]) s[i] = start;
      if (end > e[i]) e[i] = end;
      let j = i + 1;
      while (j < this.n && s[j] - gap <= e[i]) {
        if (e[j] > e[i]) e[i] = e[j];
        j++;
      }
      const removed = j - (i + 1);
      if (removed > 0) {
        for (let k = j; k < this.n; k++) {
          s[k - removed] = s[k];
          e[k - removed] = e[k];
        }
        this.n -= removed;
      }
      return;
    }
    // insert at i
    for (let k = this.n; k > i; k--) {
      s[k] = s[k - 1];
      e[k] = e[k - 1];
    }
    s[i] = start;
    e[i] = end;
    this.n++;
    if (this.n > this.maxRanges) this.fuseClosest();
  }

  private fuseClosest(): void {
    const s = this.starts;
    const e = this.ends;
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i + 1 < this.n; i++) {
      const g = s[i + 1] - e[i];
      if (g < bestGap) {
        bestGap = g;
        best = i;
      }
    }
    e[best] = Math.max(e[best], e[best + 1]);
    for (let k = best + 2; k < this.n; k++) {
      s[k - 1] = s[k];
      e[k - 1] = e[k];
    }
    this.n--;
  }
}

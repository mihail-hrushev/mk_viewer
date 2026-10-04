/**
 * Row-granular dirty tracking for data textures. Marks are O(1) per row; flushing reports maximal
 * runs of consecutive dirty rows, so a bulk write of N consecutive records yields one range.
 */
export class DirtyRows {
  private flags: Uint8Array;
  private lo = Infinity;
  private hi = -1;

  constructor(rows: number) {
    this.flags = new Uint8Array(Math.max(rows, 1));
  }

  /** Grows the tracked row count (existing marks kept). */
  resize(rows: number): void {
    if (rows <= this.flags.length) return;
    const f = new Uint8Array(rows);
    f.set(this.flags);
    this.flags = f;
  }

  get isDirty(): boolean {
    return this.hi >= 0;
  }

  mark(row: number): void {
    this.flags[row] = 1;
    if (row < this.lo) this.lo = row;
    if (row > this.hi) this.hi = row;
  }

  /** Marks rows r0..r1 inclusive. */
  markRange(r0: number, r1: number): void {
    if (r1 < r0) return;
    this.flags.fill(1, r0, r1 + 1);
    if (r0 < this.lo) this.lo = r0;
    if (r1 > this.hi) this.hi = r1;
  }

  /**
   * Calls fn(firstRow, rowCount) for each maximal run of dirty rows (ascending), then clears.
   * Pass a long-lived function to avoid per-frame closure allocation.
   */
  flush(fn: (firstRow: number, rowCount: number) => void): void {
    if (this.hi < 0) return;
    const f = this.flags;
    const end = this.hi + 1;
    let r = this.lo;
    this.lo = Infinity;
    this.hi = -1;
    while (r < end) {
      if (f[r] === 0) {
        r++;
        continue;
      }
      const start = r;
      while (r < end && f[r] !== 0) f[r++] = 0;
      fn(start, r - start);
    }
  }

  clear(): void {
    if (this.hi >= 0) this.flags.fill(0, this.lo, this.hi + 1);
    this.lo = Infinity;
    this.hi = -1;
  }
}

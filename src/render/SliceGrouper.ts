/**
 * Groups the entries of one time slice of the draw list by geometry VAO (page), so all merged
 * ranges of a page go out in one multiDrawElementsWEBGL call and VAO binds are minimised.
 *
 * The draw list is ordered by importance, not by page. Grouping happens only inside the slice a
 * frame draws, so the importance ordering *across* slices (frames) is untouched; inside a slice
 * the order does not matter for opaque passes (depth test). Blended passes that need their order
 * (transparent, back to front) must not use this; they fuse consecutive same-page runs instead.
 *
 * Stable counting sort over dense keys; no allocation after warm-up.
 */
export class SliceGrouper {
  /** Slice-relative entry indices, grouped by key (stable inside a group). */
  order = new Int32Array(256);
  /** Group g covers order[groupStart[g] .. groupStart[g + 1]) and has key groupKey[g]. */
  groupStart = new Int32Array(257);
  groupKey = new Int32Array(256);
  groupCount = 0;
  private hist = new Int32Array(256);

  /**
   * Groups `n` entries by `keys[0..n)` (dense ints in [0, keyCount); negative keys are dropped).
   * Returns the number of groups.
   */
  group(keys: Int32Array, n: number, keyCount: number): number {
    if (this.order.length < n) {
      this.order = new Int32Array(Math.max(n, this.order.length * 2));
    }
    if (this.hist.length < keyCount + 1) this.hist = new Int32Array(Math.max(keyCount + 1, this.hist.length * 2));
    const h = this.hist;
    h.fill(0, 0, keyCount + 1);
    let distinct = 0;
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      if (k < 0) continue;
      if (h[k]++ === 0) distinct++;
    }
    if (this.groupKey.length < distinct) {
      this.groupKey = new Int32Array(Math.max(distinct, this.groupKey.length * 2));
      this.groupStart = new Int32Array(this.groupKey.length + 1);
    }
    // prefix sums in key order; record groups
    let sum = 0;
    let g = 0;
    for (let k = 0; k < keyCount; k++) {
      const c = h[k];
      if (c === 0) continue;
      h[k] = sum;
      this.groupKey[g] = k;
      this.groupStart[g] = sum;
      g++;
      sum += c;
    }
    this.groupStart[g] = sum;
    this.groupCount = g;
    const order = this.order;
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      if (k < 0) continue;
      order[h[k]++] = i;
    }
    return g;
  }
}

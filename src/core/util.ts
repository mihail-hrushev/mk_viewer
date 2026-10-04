/**
 * Small internal helpers for src/core: typed-array growth, sorting without allocation, timing.
 * Kept private to the core module (no dependency on src/math, which is developed separately).
 */

export type NumArray =
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Uint16Array
  | Uint8Array;

/** High resolution clock in ms (performance.now when available). */
export const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/**
 * Returns `a` if it already holds `minLen` elements, otherwise a new array of the same type with
 * capacity doubled until it fits (contents copied). Amortised O(1) per element.
 */
export function grow<T extends NumArray>(a: T, minLen: number): T {
  if (a.length >= minLen) return a;
  let n = Math.max(a.length * 2, 16);
  while (n < minLen) n *= 2;
  const b = new (a.constructor as new (len: number) => T)(n);
  (b as unknown as { set(x: ArrayLike<number>): void }).set(a);
  return b;
}

/** Like grow() but resizes to exactly `len` elements (copying the common prefix). */
export function resize<T extends NumArray>(a: T, len: number): T {
  const b = new (a.constructor as new (len: number) => T)(len);
  (b as unknown as { set(x: ArrayLike<number>): void }).set(len >= a.length ? a : a.subarray(0, len));
  return b;
}

/**
 * Stable LSD radix sort of u32 keys with a parallel i32 payload. Scratch buffers are kept and
 * grown amortised, so repeated sorts do not allocate.
 */
export class RadixSorter {
  private kb = new Uint32Array(0);
  private vb = new Int32Array(0);
  private readonly hist = new Uint32Array(1024);

  /** Sorts keys[0..n) ascending, permuting vals[0..n) alongside. */
  sort(keys: Uint32Array, vals: Int32Array, n: number): void {
    if (n < 2) return;
    this.kb = grow(this.kb, n);
    this.vb = grow(this.vb, n);
    const h = this.hist;
    h.fill(0);
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      h[k & 255]++;
      h[256 + ((k >>> 8) & 255)]++;
      h[512 + ((k >>> 16) & 255)]++;
      h[768 + (k >>> 24)]++;
    }
    let src: Uint32Array = keys;
    let srcV: Int32Array = vals;
    let dst: Uint32Array = this.kb;
    let dstV: Int32Array = this.vb;
    for (let pass = 0; pass < 4; pass++) {
      const base = pass * 256;
      const shift = pass * 8;
      // Byte identical for every key: the pass would be the identity permutation.
      if (h[base + ((src[0] >>> shift) & 255)] === n) continue;
      let sum = 0;
      for (let b = 0; b < 256; b++) {
        const c = h[base + b];
        h[base + b] = sum;
        sum += c;
      }
      for (let i = 0; i < n; i++) {
        const k = src[i];
        const p = h[base + ((k >>> shift) & 255)]++;
        dst[p] = k;
        dstV[p] = srcV[i];
      }
      const tk = src;
      src = dst;
      dst = tk;
      const tv = srcV;
      srcV = dstV;
      dstV = tv;
    }
    if (src !== keys) {
      keys.set(src.subarray(0, n));
      vals.set(srcV.subarray(0, n));
    }
  }
}

/** In-place sort of keys[lo..hi) descending, permuting vals alongside (quicksort + insertion). */
export function sortPairsDesc(keys: Float32Array, vals: Int32Array, lo: number, hi: number): void {
  while (hi - lo > 16) {
    // median of three pivot
    const mid = (lo + hi) >>> 1;
    const a = keys[lo];
    const b = keys[mid];
    const c = keys[hi - 1];
    const pivot = a > b ? (b > c ? b : a > c ? c : a) : a > c ? a : b > c ? c : b;
    let i = lo;
    let j = hi - 1;
    while (i <= j) {
      while (keys[i] > pivot) i++;
      while (keys[j] < pivot) j--;
      if (i <= j) {
        const tk = keys[i];
        keys[i] = keys[j];
        keys[j] = tk;
        const tv = vals[i];
        vals[i] = vals[j];
        vals[j] = tv;
        i++;
        j--;
      }
    }
    // recurse into the smaller half, loop on the larger one
    if (j + 1 - lo < hi - i) {
      sortPairsDesc(keys, vals, lo, j + 1);
      lo = i;
    } else {
      sortPairsDesc(keys, vals, i, hi);
      hi = j + 1;
    }
  }
  for (let i = lo + 1; i < hi; i++) {
    const k = keys[i];
    const v = vals[i];
    let j = i - 1;
    while (j >= lo && keys[j] < k) {
      keys[j + 1] = keys[j];
      vals[j + 1] = vals[j];
      j--;
    }
    keys[j + 1] = k;
    vals[j + 1] = v;
  }
}

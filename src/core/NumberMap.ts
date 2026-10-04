/**
 * Open-addressing hash map from a number key (any finite double) to an int32 value, stored in
 * typed arrays (linear probing, backward-shift deletion). Used for the objectId index so millions
 * of entries cost no JS objects.
 */

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

function hashKey(k: number): number {
  let h: number;
  if ((k | 0) === k) {
    h = k | 0;
  } else {
    f64[0] = k;
    h = u32[0] ^ Math.imul(u32[1], 0x9e3779b1);
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export class NumberMap {
  private keys: Float64Array;
  private vals: Int32Array;
  private used: Uint8Array;
  private mask: number;
  size = 0;

  constructor(initialCapacity = 64) {
    let cap = 16;
    while (cap < initialCapacity * 2) cap *= 2;
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
    this.used = new Uint8Array(cap);
    this.mask = cap - 1;
  }

  get(k: number, missing = -1): number {
    const keys = this.keys;
    const used = this.used;
    const mask = this.mask;
    let i = hashKey(k) & mask;
    while (used[i]) {
      if (keys[i] === k) return this.vals[i];
      i = (i + 1) & mask;
    }
    return missing;
  }

  set(k: number, v: number): void {
    if ((this.size + 1) * 2 > this.mask + 1) this.rehash((this.mask + 1) * 2);
    const keys = this.keys;
    const used = this.used;
    const mask = this.mask;
    let i = hashKey(k) & mask;
    while (used[i]) {
      if (keys[i] === k) {
        this.vals[i] = v;
        return;
      }
      i = (i + 1) & mask;
    }
    used[i] = 1;
    keys[i] = k;
    this.vals[i] = v;
    this.size++;
  }

  delete(k: number): boolean {
    const keys = this.keys;
    const vals = this.vals;
    const used = this.used;
    const mask = this.mask;
    let i = hashKey(k) & mask;
    while (used[i]) {
      if (keys[i] === k) break;
      i = (i + 1) & mask;
    }
    if (!used[i]) return false;
    let j = i;
    for (;;) {
      j = (j + 1) & mask;
      if (!used[j]) break;
      const h = hashKey(keys[j]) & mask;
      // entry j may stay if its home slot h lies cyclically in (i, j]
      if (i <= j ? i < h && h <= j : i < h || h <= j) continue;
      keys[i] = keys[j];
      vals[i] = vals[j];
      i = j;
    }
    used[i] = 0;
    this.size--;
    return true;
  }

  clear(): void {
    this.used.fill(0);
    this.size = 0;
  }

  private rehash(cap: number): void {
    const ok = this.keys;
    const ov = this.vals;
    const ou = this.used;
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
    this.used = new Uint8Array(cap);
    this.mask = cap - 1;
    this.size = 0;
    for (let i = 0; i < ou.length; i++) if (ou[i]) this.set(ok[i], ov[i]);
  }
}

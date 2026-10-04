/**
 * Columnar metadata tree: parent indices (Int32Array), objectIds (Float64Array) and names that are
 * either stored sparsely or produced lazily by per-batch callbacks. Children (CSR) and the
 * objectId -> node index are built on first query. No per-node objects.
 */
import type { HierarchyBuilder, ModelHierarchy } from './types';

interface NameBatch {
  start: number;
  count: number;
  fn: (i: number) => string | undefined;
}

const EMPTY = new Int32Array(0);

export class HierarchyStore implements HierarchyBuilder, ModelHierarchy {
  private parents = new Int32Array(64);
  private oids = new Float64Array(64);
  private n = 0;
  private names = new Map<number, string>();
  private batches: NameBatch[] = [];
  // lazy indices
  private childStart: Int32Array | null = null;
  private childList: Int32Array | null = null;
  private rootList: Int32Array | null = null;
  private oidIndex: { base: number; table: Int32Array } | Map<number, number> | null = null;

  get count(): number {
    return this.n;
  }
  get nodeCount(): number {
    return this.n;
  }

  private ensure(extra: number): void {
    const need = this.n + extra;
    if (need <= this.parents.length) return;
    let cap = this.parents.length;
    while (cap < need) cap *= 2;
    const p = new Int32Array(cap);
    p.set(this.parents.subarray(0, this.n));
    const o = new Float64Array(cap);
    o.set(this.oids.subarray(0, this.n));
    this.parents = p;
    this.oids = o;
  }

  private invalidate(): void {
    this.childStart = this.childList = this.rootList = null;
    this.oidIndex = null;
  }

  addNode(parent: number, name?: string, objectId?: number): number {
    if (!(parent >= -2 && parent < this.n)) throw new RangeError(`hierarchy: parent ${parent} is not an existing node`);
    this.ensure(1);
    const i = this.n++;
    this.parents[i] = parent;
    this.oids[i] = objectId ?? NaN;
    if (name !== undefined) this.names.set(i, name);
    this.invalidate();
    return i;
  }

  addNodes(parents: ArrayLike<number>, objectIds?: ArrayLike<number>, name?: (i: number) => string | undefined): number {
    const k = parents.length;
    const start = this.n;
    this.ensure(k);
    const end = start + k;
    for (let i = 0; i < k; i++) {
      const p = parents[i];
      if (!(p >= -2 && p < end)) throw new RangeError(`hierarchy: parent ${p} of node ${start + i} is out of range`);
      this.parents[start + i] = p;
      this.oids[start + i] = objectIds ? objectIds[i] : NaN;
    }
    this.n = end;
    if (name) this.batches.push({ start, count: k, fn: name });
    this.invalidate();
    return start;
  }

  // --- ModelHierarchy ---

  parent(node: number): number {
    return node >= 0 && node < this.n ? this.parents[node] : -2;
  }

  objectId(node: number): number {
    return node >= 0 && node < this.n ? this.oids[node] : NaN;
  }

  name(node: number): string | undefined {
    if (!(node >= 0 && node < this.n)) return undefined;
    const s = this.names.get(node);
    if (s !== undefined) return s;
    const b = this.batches;
    for (let i = b.length - 1; i >= 0; i--) {
      const x = b[i];
      if (node >= x.start && node < x.start + x.count) return x.fn(node - x.start);
    }
    return undefined;
  }

  roots(): Int32Array {
    this.buildChildren();
    return this.rootList!.slice();
  }

  children(node: number): Int32Array {
    if (!(node >= 0 && node < this.n)) return EMPTY;
    this.buildChildren();
    return this.childList!.slice(this.childStart![node], this.childStart![node + 1]);
  }

  nodeOfObject(objectId: number): number {
    const idx = this.buildOidIndex();
    if (idx instanceof Map) return idx.get(objectId) ?? -1;
    const k = objectId - idx.base;
    return k >= 0 && k < idx.table.length && (k | 0) === k ? idx.table[k] : -1;
  }

  /** Drops lazy name callbacks (and whatever they capture). */
  dropNames(): void {
    this.batches = [];
    this.names.clear();
  }

  private buildChildren(): void {
    if (this.childStart) return;
    const n = this.n, par = this.parents;
    const start = new Int32Array(n + 1);
    let roots = 0;
    for (let i = 0; i < n; i++) {
      const p = par[i];
      if (p >= 0) start[p + 1]++;
      else if (p === -1) roots++;
    }
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const list = new Int32Array(start[n]);
    const fill = start.slice(0, n);
    const rl = new Int32Array(roots);
    let r = 0;
    for (let i = 0; i < n; i++) {
      const p = par[i];
      if (p >= 0) list[fill[p]++] = i;
      else if (p === -1) rl[r++] = i;
    }
    this.childStart = start;
    this.childList = list;
    this.rootList = rl;
  }

  private buildOidIndex(): { base: number; table: Int32Array } | Map<number, number> {
    if (this.oidIndex) return this.oidIndex;
    let lo = Infinity, hi = -Infinity, cnt = 0, ints = true;
    for (let i = 0; i < this.n; i++) {
      const o = this.oids[i];
      if (o !== o) continue;
      cnt++;
      if (o < lo) lo = o;
      if (o > hi) hi = o;
      if ((o | 0) !== o && Math.floor(o) !== o) ints = false;
    }
    const span = hi - lo + 1;
    if (cnt > 0 && ints && span <= cnt * 4 + 1024) {
      const table = new Int32Array(span).fill(-1);
      for (let i = 0; i < this.n; i++) {
        const o = this.oids[i];
        if (o === o && table[o - lo] < 0) table[o - lo] = i;
      }
      this.oidIndex = { base: lo, table };
    } else {
      const m = new Map<number, number>();
      for (let i = 0; i < this.n; i++) {
        const o = this.oids[i];
        if (o === o && !m.has(o)) m.set(o, i);
      }
      this.oidIndex = m;
    }
    return this.oidIndex;
  }
}

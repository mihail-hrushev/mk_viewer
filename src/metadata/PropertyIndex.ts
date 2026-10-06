/**
 * Property index of one model: a column store over the hierarchy's node properties.
 *
 * Layout (all typed arrays, built once from the HierarchyStore on first query):
 *
 * - Preorder: `order[pos]` = node, `pos[node]` = position, `end[node]` = exclusive end of the
 *   node's subtree in preorder, so "everything below a node" is the contiguous position range
 *   [pos, end). `preObj` lists the objectIds of the nodes in preorder and `objStart[pos]` is the
 *   prefix count, so the objects under a node are the slice preObj[objStart[pos] .. objStart[end]).
 * - One Column per key: the distinct values (dictionary) sorted case-insensitively, the parsed
 *   number of every value (NaN when not numeric), and CSR postings: for value v the sorted
 *   positions postNode[postStart[v] .. postStart[v+1]) of the nodes carrying it.
 *
 * Queries resolve value ranges in the dictionary (binary search; `in` lists are sorted once and
 * merge-walked), gather the postings, and expand the matched positions to object ranges, skipping
 * positions already covered by a matched ancestor, so the result has no duplicates.
 */
import type { HierarchyStore } from '../loaders/hierarchy';
import type { NodeProperties, PropertyIndex, PropertyKeyInfo, PropertyMatch, PropertyQuery } from '../loaders/types';

/** Node names are indexed under this key. */
export const NAME_KEY = 'name';
/** Nested property objects are flattened to dotted keys down to this depth. */
const MAX_DEPTH = 4;

interface Column {
  key: string;
  /** Distinct values sorted by (lower-case text, text). */
  values: string[];
  lowers: string[];
  /** Parsed number per value, NaN when the text is not a number. */
  nums: Float64Array;
  /** Value ids sorted by number (only numeric values); built on the first range query. */
  numOrder: Int32Array | null;
  postStart: Int32Array;
  /** Preorder positions. */
  postNode: Int32Array;
  numeric: boolean;
}

/** Collects (value, position) occurrences of one key during the build. */
interface ColumnBuild {
  key: string;
  dict: Map<string, number>;
  values: string[];
  occVal: number[];
  occPos: number[];
}

const EMPTY_F64 = new Float64Array(0);
const EMPTY_I32 = new Int32Array(0);
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export class PropertyIndexImpl implements PropertyIndex {
  private store: HierarchyStore | null;
  private columns = new Map<string, Column>();
  private order = EMPTY_I32;
  private pos = EMPTY_I32;
  private end = EMPTY_I32;
  private objStart = EMPTY_I32;
  private preObj = EMPTY_F64;
  private built = false;

  constructor(store: HierarchyStore) {
    this.store = store;
  }

  get ready(): boolean {
    return this.built;
  }

  /** Drops the index and its source (unload). Later queries return nothing. */
  dispose(): void {
    this.store = null;
    this.columns.clear();
    this.order = this.pos = this.end = this.objStart = EMPTY_I32;
    this.preObj = EMPTY_F64;
    this.built = true;
  }

  build(): number {
    if (this.built) return 0;
    const t0 = now();
    const h = this.store!;
    const n = h.nodeCount;
    this.buildPreorder(h, n);
    this.buildColumns(h, n);
    this.built = true;
    return now() - t0;
  }

  keys(): PropertyKeyInfo[] {
    this.build();
    const out: PropertyKeyInfo[] = [];
    for (const c of this.columns.values()) {
      out.push({ key: c.key, count: c.postStart[c.values.length], distinct: c.values.length, numeric: c.numeric });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  values(key: string): string[] {
    this.build();
    const c = this.columns.get(key);
    return c ? c.values.slice() : [];
  }

  objectsUnder(node: number): Float64Array {
    this.build();
    if (!(node >= 0 && node < this.pos.length)) return new Float64Array(0);
    const p = this.pos[node];
    const out = this.preObj.slice(this.objStart[p], this.objStart[this.end[node]]);
    return sortIfNeeded(out);
  }

  find(q: PropertyQuery): PropertyMatch {
    this.build();
    const col = this.columns.get(q.key);
    const inList = q.in;
    const hits = inList ? new Int32Array(inList.length) : null;
    if (!col) return { objectIds: new Float64Array(0), nodes: new Int32Array(0), values: [], hits };

    // --- which dictionary entries match -------------------------------------------------------
    const V = col.values.length;
    const mask = new Uint8Array(V);
    const cs = q.caseSensitive === true;
    if (inList) {
      this.matchList(col, inList, cs, mask, hits!);
    } else if (q.equals !== undefined) {
      const text = String(q.equals).trim();
      const low = text.toLowerCase();
      const a = lowerBound(col.lowers, low), b = upperBound(col.lowers, low);
      for (let i = a; i < b; i++) if (!cs || col.values[i] === text) mask[i] = 1;
    } else if (q.startsWith !== undefined) {
      const text = String(q.startsWith).trim();
      const low = text.toLowerCase();
      for (let i = lowerBound(col.lowers, low); i < V && col.lowers[i].startsWith(low); i++) {
        if (!cs || col.values[i].startsWith(text)) mask[i] = 1;
      }
    } else if (q.min !== undefined || q.max !== undefined) {
      const ord = (col.numOrder ??= numericOrder(col));
      const lo = q.min ?? -Infinity, hi = q.max ?? Infinity;
      let a = 0, b = ord.length;
      // first value >= lo
      {
        let l = 0, r = ord.length;
        while (l < r) {
          const m = (l + r) >> 1;
          if (col.nums[ord[m]] < lo) l = m + 1;
          else r = m;
        }
        a = l;
      }
      // first value > hi
      {
        let l = a, r = ord.length;
        while (l < r) {
          const m = (l + r) >> 1;
          if (col.nums[ord[m]] <= hi) l = m + 1;
          else r = m;
        }
        b = l;
      }
      for (let i = a; i < b; i++) mask[ord[i]] = 1;
    }

    // --- gather postings ----------------------------------------------------------------------
    const values: string[] = [];
    let count = 0;
    for (let v = 0; v < V; v++) {
      if (!mask[v]) continue;
      values.push(col.values[v]);
      count += col.postStart[v + 1] - col.postStart[v];
    }
    const positions = new Int32Array(count);
    let k = 0;
    for (let v = 0; v < V; v++) {
      if (!mask[v]) continue;
      positions.set(col.postNode.subarray(col.postStart[v], col.postStart[v + 1]), k);
      k += col.postStart[v + 1] - col.postStart[v];
    }
    positions.sort();
    return { objectIds: this.expand(positions), nodes: this.nodesOf(positions), values, hits };
  }

  // ---------------------------------------------------------------------------------------------

  /** `in` query: sort the inputs once, merge-walk the dictionary, count postings per input. */
  private matchList(col: Column, list: ArrayLike<string | number>, cs: boolean, mask: Uint8Array, hits: Int32Array): void {
    const N = list.length;
    const texts = new Array<string>(N);
    const lows = new Array<string>(N);
    for (let i = 0; i < N; i++) {
      texts[i] = String(list[i]).trim();
      lows[i] = texts[i].toLowerCase();
    }
    const idx = new Int32Array(N);
    for (let i = 0; i < N; i++) idx[i] = i;
    idx.sort((a, b) => (lows[a] < lows[b] ? -1 : lows[a] > lows[b] ? 1 : 0));
    const lowers = col.lowers, V = lowers.length;
    let j = 0;
    for (let s = 0; s < N; s++) {
      const i = idx[s];
      const low = lows[i];
      while (j < V && lowers[j] < low) j++;
      let h = 0;
      for (let t = j; t < V && lowers[t] === low; t++) {
        if (cs && col.values[t] !== texts[i]) continue;
        mask[t] = 1;
        h += col.postStart[t + 1] - col.postStart[t];
      }
      hits[i] = h;
    }
  }

  /** Matched preorder positions (sorted) -> objectIds under them, ascending, no duplicates. */
  private expand(positions: Int32Array): Float64Array {
    const { order, end, objStart, preObj } = this;
    let total = 0, cover = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (p < cover) continue;
      const e = end[order[p]];
      total += objStart[e] - objStart[p];
      cover = e;
    }
    const out = new Float64Array(total);
    let k = 0;
    cover = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (p < cover) continue;
      const e = end[order[p]];
      out.set(preObj.subarray(objStart[p], objStart[e]), k);
      k += objStart[e] - objStart[p];
      cover = e;
    }
    return sortIfNeeded(out);
  }

  private nodesOf(positions: Int32Array): Int32Array {
    const out = new Int32Array(positions.length);
    for (let i = 0; i < positions.length; i++) out[i] = this.order[positions[i]];
    return sortIfNeededI32(out);
  }

  private buildPreorder(h: HierarchyStore, n: number): void {
    const parents = h.parentColumn();
    // children CSR (local: the store's own is private and slices on access)
    const childStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) if (parents[i] >= 0) childStart[parents[i] + 1]++;
    for (let i = 0; i < n; i++) childStart[i + 1] += childStart[i];
    const childList = new Int32Array(childStart[n]);
    {
      const fill = childStart.slice(0, n);
      for (let i = 0; i < n; i++) if (parents[i] >= 0) childList[fill[parents[i]]++] = i;
    }
    const order = new Int32Array(n);
    const pos = new Int32Array(n).fill(-1);
    const treeParent = new Int32Array(n).fill(-1);
    const stack = new Int32Array(Math.max(16, n));
    let count = 0;
    const visit = (root: number): void => {
      let sp = 0;
      stack[sp++] = root;
      while (sp > 0) {
        const node = stack[--sp];
        if (pos[node] >= 0) continue; // malformed (cycle / shared child): keep the first place
        pos[node] = count;
        order[count++] = node;
        for (let c = childStart[node + 1] - 1; c >= childStart[node]; c--) {
          const ch = childList[c];
          if (pos[ch] < 0) {
            treeParent[ch] = node;
            stack[sp++] = ch;
          }
        }
      }
    };
    // roots in index order, then detached nodes (-2) as their own roots, then anything unreachable
    for (let i = 0; i < n; i++) if (parents[i] === -1) visit(i);
    for (let i = 0; i < n; i++) if (parents[i] === -2) visit(i);
    for (let i = 0; i < n; i++) if (pos[i] < 0) visit(i);
    // subtree sizes: positions descending so every child is summed before its parent
    const size = new Int32Array(n).fill(1);
    for (let p = n - 1; p >= 0; p--) {
      const node = order[p];
      const tp = treeParent[node];
      if (tp >= 0) size[tp] += size[node];
    }
    const end = new Int32Array(n);
    for (let i = 0; i < n; i++) end[i] = pos[i] + size[i];
    // objects in preorder
    const oids = h.objectIdColumn();
    const objStart = new Int32Array(n + 1);
    let objects = 0;
    for (let p = 0; p < n; p++) {
      const o = oids[order[p]];
      if (o === o) objects++;
      objStart[p + 1] = objects;
    }
    const preObj = new Float64Array(objects);
    for (let p = 0, k = 0; p < n; p++) {
      const o = oids[order[p]];
      if (o === o) preObj[k++] = o;
    }
    this.order = order;
    this.pos = pos;
    this.end = end;
    this.objStart = objStart;
    this.preObj = preObj;
  }

  private buildColumns(h: HierarchyStore, n: number): void {
    const builds = new Map<string, ColumnBuild>();
    const add = (key: string, raw: unknown, p: number): void => {
      const text = String(raw).trim();
      if (text === '') return;
      let b = builds.get(key);
      if (!b) builds.set(key, (b = { key, dict: new Map(), values: [], occVal: [], occPos: [] }));
      let vid = b.dict.get(text);
      if (vid === undefined) {
        vid = b.values.length;
        b.dict.set(text, vid);
        b.values.push(text);
      }
      const last = b.occPos.length - 1;
      if (last >= 0 && b.occPos[last] === p && b.occVal[last] === vid) return; // same pair twice
      b.occVal.push(vid);
      b.occPos.push(p);
    };
    const order = this.order;
    for (let p = 0; p < n; p++) {
      const node = order[p];
      const name = h.name(node);
      if (name !== undefined) add(NAME_KEY, name, p);
      const props = h.ownProperties(node);
      if (props) flatten(props, '', 0, p, add);
    }
    for (const b of builds.values()) this.columns.set(b.key, finishColumn(b));
  }
}

/** Walks a property object, emitting (dotted key, primitive, position) for every leaf. */
function flatten(
  obj: NodeProperties,
  prefix: string,
  depth: number,
  p: number,
  add: (key: string, value: unknown, p: number) => void,
): void {
  for (const k in obj) {
    const v = obj[k];
    if (v === null || v === undefined) continue;
    const key = prefix + k;
    if (typeof v === 'object') {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const e = v[i];
          if (e !== null && e !== undefined && typeof e !== 'object') add(key, e, p);
        }
      } else if (depth < MAX_DEPTH) {
        flatten(v as NodeProperties, key + '.', depth + 1, p, add);
      }
    } else {
      add(key, v, p);
    }
  }
}

function finishColumn(b: ColumnBuild): Column {
  const D = b.values.length;
  const lowersRaw = new Array<string>(D);
  for (let i = 0; i < D; i++) lowersRaw[i] = b.values[i].toLowerCase();
  const perm = new Int32Array(D);
  for (let i = 0; i < D; i++) perm[i] = i;
  perm.sort((x, y) => {
    const a = lowersRaw[x], c = lowersRaw[y];
    if (a !== c) return a < c ? -1 : 1;
    const u = b.values[x], w = b.values[y];
    return u < w ? -1 : u > w ? 1 : 0;
  });
  const rank = new Int32Array(D);
  const values = new Array<string>(D);
  const lowers = new Array<string>(D);
  const nums = new Float64Array(D);
  let numeric = D > 0;
  for (let i = 0; i < D; i++) {
    const old = perm[i];
    rank[old] = i;
    values[i] = b.values[old];
    lowers[i] = lowersRaw[old];
    const x = parseNumber(values[i]);
    nums[i] = x;
    if (x !== x) numeric = false;
  }
  // postings by counting sort; occurrences arrive in preorder, so each run is sorted
  const O = b.occVal.length;
  const postStart = new Int32Array(D + 1);
  for (let i = 0; i < O; i++) postStart[rank[b.occVal[i]] + 1]++;
  for (let i = 0; i < D; i++) postStart[i + 1] += postStart[i];
  const postNode = new Int32Array(O);
  const fill = postStart.slice(0, D);
  for (let i = 0; i < O; i++) postNode[fill[rank[b.occVal[i]]]++] = b.occPos[i];
  return { key: b.key, values, lowers, nums, numOrder: null, postStart, postNode, numeric };
}

function numericOrder(col: Column): Int32Array {
  const nums = col.nums;
  let k = 0;
  for (let i = 0; i < nums.length; i++) if (nums[i] === nums[i]) k++;
  const ord = new Int32Array(k);
  k = 0;
  for (let i = 0; i < nums.length; i++) if (nums[i] === nums[i]) ord[k++] = i;
  ord.sort((a, b) => nums[a] - nums[b]);
  return ord;
}

export function parseNumber(text: string): number {
  return NUMBER_RE.test(text) ? Number(text) : NaN;
}

/** First index with a[i] >= x. */
function lowerBound(a: string[], x: string): number {
  let l = 0, r = a.length;
  while (l < r) {
    const m = (l + r) >> 1;
    if (a[m] < x) l = m + 1;
    else r = m;
  }
  return l;
}

/** First index with a[i] > x. */
function upperBound(a: string[], x: string): number {
  let l = 0, r = a.length;
  while (l < r) {
    const m = (l + r) >> 1;
    if (a[m] <= x) l = m + 1;
    else r = m;
  }
  return l;
}

function sortIfNeeded(a: Float64Array): Float64Array {
  for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1]) return a.sort();
  return a;
}

function sortIfNeededI32(a: Int32Array): Int32Array {
  for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1]) return a.sort();
  return a;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

import { describe, expect, it } from 'vitest';
import { HierarchyStore } from '../loaders/hierarchy';
import { PropertyIndexImpl, parseNumber } from './PropertyIndex';
import { sortedDifference, sortedIntersection, sortedUnion } from './sortedSets';

/**
 * A spool-like tree (objectIds in brackets, properties in braces):
 *
 *   0 Plant {Units: m}
 *     1 ISO-A {Isometric: ISO-A, Rev: 2}
 *       2 ISO-A_SP001 {Spool: ISO-A_SP001, Isometric: ISO-A, Spec: 1W3AX, Weight: 70.4}
 *         3 pipe [100]   4 elbow [101]
 *       5 ISO-A_SP002 {Spool: ISO-A_SP002, Isometric: ISO-A, Spec: 1W3AX, Weight: 12}
 *         6 pipe [102]
 *     7 ISO-B {Isometric: ISO-B, Rev: 0}
 *       8 iso-b_sp001 {Spool: iso-b_sp001, Isometric: ISO-B, Spec: 2C1, Weight: 5.5}
 *         9 flange [103]  10 flange [104]
 *   11 loose [105] {Spec: 2C1}   (detached, parent -2)
 */
function spools(): HierarchyStore {
  const h = new HierarchyStore();
  const plant = h.addNode(-1, 'Plant', undefined, { Units: 'm' });
  const isoA = h.addNode(plant, 'ISO-A', undefined, { Isometric: 'ISO-A', Rev: 2 });
  const sp1 = h.addNode(isoA, 'ISO-A_SP001', undefined, { Spool: 'ISO-A_SP001', Isometric: 'ISO-A', Spec: '1W3AX', Weight: '70.4' });
  h.addNode(sp1, 'pipe', 100);
  h.addNode(sp1, 'elbow', 101);
  const sp2 = h.addNode(isoA, 'ISO-A_SP002', undefined, { Spool: 'ISO-A_SP002', Isometric: 'ISO-A', Spec: '1W3AX', Weight: '12' });
  h.addNode(sp2, 'pipe', 102);
  const isoB = h.addNode(plant, 'ISO-B', undefined, { Isometric: 'ISO-B', Rev: 0 });
  const sp3 = h.addNode(isoB, 'iso-b_sp001', undefined, { Spool: 'iso-b_sp001', Isometric: 'ISO-B', Spec: '2C1', Weight: '5.5' });
  h.addNode(sp3, 'flange', 103);
  h.addNode(sp3, 'flange', 104);
  h.addNode(-2, 'loose', 105, { Spec: '2C1' });
  return h;
}

const arr = (a: ArrayLike<number>) => Array.from(a);

describe('PropertyIndex: build', () => {
  it('lists keys with counts, distinct values and numeric flags', () => {
    const idx = new PropertyIndexImpl(spools());
    expect(idx.ready).toBe(false);
    const keys = idx.keys();
    expect(idx.ready).toBe(true);
    expect(keys.map((k) => k.key)).toEqual(['Isometric', 'Rev', 'Spec', 'Spool', 'Units', 'Weight', 'name']);
    expect(keys.find((k) => k.key === 'Spec')).toEqual({ key: 'Spec', count: 4, distinct: 2, numeric: false });
    expect(keys.find((k) => k.key === 'Weight')).toEqual({ key: 'Weight', count: 3, distinct: 3, numeric: true });
    expect(keys.find((k) => k.key === 'Rev')).toEqual({ key: 'Rev', count: 2, distinct: 2, numeric: true });
    expect(keys.find((k) => k.key === 'name')!.count).toBe(12);
  });

  it('dictionary is sorted case-insensitively and deduplicated', () => {
    const idx = new PropertyIndexImpl(spools());
    expect(idx.values('Spool')).toEqual(['ISO-A_SP001', 'ISO-A_SP002', 'iso-b_sp001']);
    expect(idx.values('Spec')).toEqual(['1W3AX', '2C1']);
    expect(idx.values('nope')).toEqual([]);
    expect(idx.build()).toBe(0); // already built
  });

  it('objectsUnder gives the subtree objects, ascending', () => {
    const idx = new PropertyIndexImpl(spools());
    expect(arr(idx.objectsUnder(0))).toEqual([100, 101, 102, 103, 104]);
    expect(arr(idx.objectsUnder(1))).toEqual([100, 101, 102]);
    expect(arr(idx.objectsUnder(8))).toEqual([103, 104]);
    expect(arr(idx.objectsUnder(3))).toEqual([100]);
    expect(arr(idx.objectsUnder(11))).toEqual([105]);
    expect(arr(idx.objectsUnder(99))).toEqual([]);
  });

  it('flattens nested objects to dotted keys and arrays to repeated values', () => {
    const h = new HierarchyStore();
    h.addNode(-1, 'a', 1, { Pset: { Fire: 'R60', Load: 3 }, Tags: ['x', 'y', 7, null], Empty: '  ', Nil: null });
    const idx = new PropertyIndexImpl(h);
    expect(idx.keys().map((k) => k.key)).toEqual(['Pset.Fire', 'Pset.Load', 'Tags', 'name']);
    expect(idx.values('Tags')).toEqual(['7', 'x', 'y']);
    expect(arr(idx.find({ key: 'Tags', equals: 'y' }).objectIds)).toEqual([1]);
    expect(arr(idx.find({ key: 'Pset.Load', min: 3, max: 3 }).objectIds)).toEqual([1]);
  });

  it('parseNumber is strict', () => {
    expect(parseNumber('70.4')).toBe(70.4);
    expect(parseNumber('-1e3')).toBe(-1000);
    expect(parseNumber('.5')).toBe(0.5);
    expect(parseNumber('1W3AX')).toBeNaN();
    expect(parseNumber('')).toBeNaN();
    expect(parseNumber('0x10')).toBeNaN();
    expect(parseNumber('1,5')).toBeNaN();
  });
});

describe('PropertyIndex: find', () => {
  it('equals: one value, case-insensitive by default', () => {
    const idx = new PropertyIndexImpl(spools());
    const r = idx.find({ key: 'Spool', equals: 'iso-a_sp001' });
    expect(arr(r.nodes)).toEqual([2]);
    expect(arr(r.objectIds)).toEqual([100, 101]);
    expect(r.values).toEqual(['ISO-A_SP001']);
    expect(r.hits).toBeNull();
    expect(idx.find({ key: 'Spool', equals: 'iso-a_sp001', caseSensitive: true }).nodes.length).toBe(0);
    expect(arr(idx.find({ key: 'Spool', equals: ' ISO-A_SP001 ' }).objectIds)).toEqual([100, 101]);
  });

  it('equals on a group key expands the whole subtree without duplicates', () => {
    const idx = new PropertyIndexImpl(spools());
    // ISO-A is carried by the isometric node and by both spools under it: nested matches
    const r = idx.find({ key: 'Isometric', equals: 'ISO-A' });
    expect(arr(r.nodes)).toEqual([1, 2, 5]);
    expect(arr(r.objectIds)).toEqual([100, 101, 102]);
  });

  it('matches numbers by their text and names under the key name', () => {
    const idx = new PropertyIndexImpl(spools());
    expect(arr(idx.find({ key: 'Rev', equals: 2 }).objectIds)).toEqual([100, 101, 102]);
    expect(arr(idx.find({ key: 'name', equals: 'flange' }).objectIds)).toEqual([103, 104]);
    expect(arr(idx.find({ key: 'name', equals: 'Plant' }).objectIds)).toEqual([100, 101, 102, 103, 104]);
  });

  it('in: thousands of values in one pass, with per-input hit counts', () => {
    const idx = new PropertyIndexImpl(spools());
    const list = ['ISO-A_SP002', 'missing', 'iso-b_sp001', 'ISO-A_SP001', 'ISO-A_SP002'];
    const r = idx.find({ key: 'Spool', in: list });
    expect(arr(r.hits!)).toEqual([1, 0, 1, 1, 1]);
    expect(arr(r.nodes)).toEqual([2, 5, 8]);
    expect(arr(r.objectIds)).toEqual([100, 101, 102, 103, 104]);
    expect(r.values).toEqual(['ISO-A_SP001', 'ISO-A_SP002', 'iso-b_sp001']);
    // a value carried by several nodes counts them all
    expect(arr(idx.find({ key: 'Spec', in: ['2c1', '1W3AX', 'zzz'] }).hits!)).toEqual([2, 2, 0]);
    // case-sensitive
    expect(arr(idx.find({ key: 'Spool', in: ['ISO-B_SP001', 'iso-b_sp001'], caseSensitive: true }).hits!)).toEqual([0, 1]);
    // unknown key: all misses, no crash
    const none = idx.find({ key: 'nope', in: ['a', 'b'] });
    expect(arr(none.hits!)).toEqual([0, 0]);
    expect(none.objectIds.length).toBe(0);
  });

  it('in: large list (sort + merge) agrees with repeated equals', () => {
    const h = new HierarchyStore();
    const root = h.addNode(-1, 'root');
    const N = 5000;
    for (let i = 0; i < N; i++) h.addNode(root, `n${i}`, 1000 + i, { Tag: `T-${(i * 7919) % N}` });
    const idx = new PropertyIndexImpl(h);
    const list: string[] = [];
    for (let i = 0; i < 3000; i++) list.push(`t-${(i * 13) % (N + 500)}`); // some beyond N: misses
    const r = idx.find({ key: 'Tag', in: list });
    let expectedHits = 0;
    const expected = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      const one = idx.find({ key: 'Tag', equals: list[i] });
      expect(r.hits![i]).toBe(one.nodes.length);
      expectedHits += one.nodes.length;
      for (const id of one.objectIds) expected.add(id);
    }
    expect(expectedHits).toBeGreaterThan(0);
    expect(arr(r.objectIds)).toEqual(Array.from(expected).sort((a, b) => a - b));
  });

  it('startsWith', () => {
    const idx = new PropertyIndexImpl(spools());
    const r = idx.find({ key: 'Spool', startsWith: 'iso-a' });
    expect(r.values).toEqual(['ISO-A_SP001', 'ISO-A_SP002']);
    expect(arr(r.objectIds)).toEqual([100, 101, 102]);
    expect(idx.find({ key: 'Spool', startsWith: 'iso-a', caseSensitive: true }).values).toEqual([]);
    expect(idx.find({ key: 'Spool', startsWith: 'ISO-A_SP001', caseSensitive: true }).values).toEqual(['ISO-A_SP001']);
    expect(idx.find({ key: 'Spool', startsWith: 'zzz' }).values).toEqual([]);
  });

  it('numeric range, inclusive, ignoring non-numeric values', () => {
    const idx = new PropertyIndexImpl(spools());
    expect(idx.find({ key: 'Weight', min: 10, max: 70.4 }).values).toEqual(['12', '70.4']);
    expect(idx.find({ key: 'Weight', min: 12.1 }).values).toEqual(['70.4']);
    expect(idx.find({ key: 'Weight', max: 5.5 }).values).toEqual(['5.5']);
    expect(arr(idx.find({ key: 'Weight', max: 5.5 }).objectIds)).toEqual([103, 104]);
    expect(idx.find({ key: 'Spec', min: 0 }).values).toEqual([]); // text values never match a range
    expect(idx.find({ key: 'Weight', min: 100 }).values).toEqual([]);
  });

  it('detached nodes are searchable', () => {
    const idx = new PropertyIndexImpl(spools());
    expect(arr(idx.find({ key: 'Spec', equals: '2C1' }).objectIds)).toEqual([103, 104, 105]);
  });

  it('returns nothing after dispose', () => {
    const idx = new PropertyIndexImpl(spools());
    expect(idx.find({ key: 'Spec', equals: '2C1' }).objectIds.length).toBe(3);
    idx.dispose();
    expect(idx.find({ key: 'Spec', equals: '2C1' }).objectIds.length).toBe(0);
    expect(idx.keys()).toEqual([]);
    expect(idx.objectsUnder(0).length).toBe(0);
  });

  it('survives lazily named batches and an empty hierarchy', () => {
    const empty = new PropertyIndexImpl(new HierarchyStore());
    expect(empty.keys()).toEqual([]);
    expect(empty.find({ key: 'name', equals: 'x' }).objectIds.length).toBe(0);
    const h = new HierarchyStore();
    const names = ['a', 'b', 'c'];
    h.addNodes([-1, 0, 0], [NaN, 7, 8], (i) => names[i], (i) => (i ? { k: `v${i}` } : undefined));
    const idx = new PropertyIndexImpl(h);
    expect(idx.values('k')).toEqual(['v1', 'v2']);
    expect(arr(idx.find({ key: 'k', equals: 'v2' }).objectIds)).toEqual([8]);
    expect(arr(idx.find({ key: 'name', equals: 'a' }).objectIds)).toEqual([7, 8]);
  });
});

describe('HierarchyStore: node properties', () => {
  it('own and inherited properties', () => {
    const h = spools();
    expect(h.properties(3)).toBeUndefined();
    expect(h.properties(2)).toEqual({ Spool: 'ISO-A_SP001', Isometric: 'ISO-A', Spec: '1W3AX', Weight: '70.4' });
    expect(h.properties(3, true)).toEqual({ Units: 'm', Rev: 2, Spool: 'ISO-A_SP001', Isometric: 'ISO-A', Spec: '1W3AX', Weight: '70.4' });
    expect(h.properties(0, true)).toEqual({ Units: 'm' });
    expect(h.properties(99)).toBeUndefined();
    // a copy, not the stored object
    const p = h.properties(2)!;
    p.Spec = 'changed';
    expect(h.properties(2)!.Spec).toBe('1W3AX');
  });

  it('dropNames drops properties too', () => {
    const h = spools();
    h.dropNames();
    expect(h.properties(2)).toBeUndefined();
    expect(h.name(2)).toBeUndefined();
  });
});

describe('sorted sets', () => {
  const A = [1, 3, 5, 7, 9], B = [3, 4, 5, 10];
  it('intersection / union / difference', () => {
    expect(arr(sortedIntersection(A, B))).toEqual([3, 5]);
    expect(arr(sortedUnion(A, B))).toEqual([1, 3, 4, 5, 7, 9, 10]);
    expect(arr(sortedDifference(A, B))).toEqual([1, 7, 9]);
    expect(arr(sortedDifference(B, A))).toEqual([4, 10]);
    expect(arr(sortedIntersection(A, []))).toEqual([]);
    expect(arr(sortedUnion([], B))).toEqual(B);
    expect(arr(sortedDifference([], B))).toEqual([]);
  });
});

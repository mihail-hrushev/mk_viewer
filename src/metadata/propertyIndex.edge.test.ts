/**
 * Adversarial edge cases for the property index (src/metadata/PropertyIndex.ts), the hierarchy
 * store it reads and the sorted-set helpers. Tests marked FIXED were written against defects of the
 * first version and pin the behaviour the contract in src/loaders/types.ts implies.
 */
import { describe, expect, it } from 'vitest';
import { HierarchyStore } from '../loaders/hierarchy';
import type { NodeProperties } from '../loaders/types';
import { PropertyIndexImpl, parseNumber } from './PropertyIndex';
import { sortedDifference, sortedIntersection, sortedUnion } from './sortedSets';

const arr = (a: ArrayLike<number>) => Array.from(a);
const isStrictlyAscending = (a: ArrayLike<number>) => {
  for (let i = 1; i < a.length; i++) if (!(a[i] > a[i - 1])) return false;
  return true;
};

/** Brute-force reference: objectIds of `node` and everything below it, via the parent column. */
function bruteUnder(h: HierarchyStore, node: number): number[] {
  const n = h.nodeCount;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let p = i, guard = 0;
    while (p !== node && p >= 0 && guard++ <= n) p = h.parent(p);
    if (p === node) {
      const o = h.objectId(i);
      if (o === o) out.push(o);
    }
  }
  return out.sort((a, b) => a - b);
}

/** A flat tree: node 0 'root', then node i+1 under it carrying `props[i]` and objectId 100 + i. */
function flat(props: (NodeProperties | undefined)[], names?: (string | undefined)[]): HierarchyStore {
  const h = new HierarchyStore();
  const root = h.addNode(-1, 'root');
  props.forEach((p, i) => h.addNode(root, names?.[i], 100 + i, p));
  return h;
}

describe('PropertyIndex edge: preorder and subtree ranges', () => {
  it('parents pointing to later nodes of the same batch', () => {
    const h = new HierarchyStore();
    // 0 -> parent 3, 1 -> parent 0, 2 -> parent 3, 3 root; an objectId on every node
    h.addNodes([3, 0, 3, -1], [10, 11, 12, 13], (i) => `n${i}`, (i) => ({ k: i === 0 ? 'x' : 'y' }));
    const idx = new PropertyIndexImpl(h);
    expect(arr(idx.objectsUnder(3))).toEqual([10, 11, 12, 13]);
    expect(arr(idx.objectsUnder(0))).toEqual([10, 11]);
    expect(arr(idx.objectsUnder(1))).toEqual([11]);
    expect(arr(idx.find({ key: 'k', equals: 'x' }).objectIds)).toEqual([10, 11]);
    expect(arr(idx.find({ key: 'k', equals: 'y' }).nodes)).toEqual([1, 2, 3]);
    expect(arr(idx.find({ key: 'k', equals: 'y' }).objectIds)).toEqual([10, 11, 12, 13]);
  });

  it('several roots, detached nodes with children, and a second batch', () => {
    const h = new HierarchyStore();
    h.addNodes([-1, 0, -1, 2], [1, 2, 3, 4]);
    // second batch: a detached node with a child, and a child under the first root
    h.addNodes([-2, 4, 0], [5, 6, 7]);
    const idx = new PropertyIndexImpl(h);
    expect(arr(idx.objectsUnder(0))).toEqual([1, 2, 7]);
    expect(arr(idx.objectsUnder(2))).toEqual([3, 4]);
    expect(arr(idx.objectsUnder(4))).toEqual([5, 6]);
    expect(arr(idx.objectsUnder(5))).toEqual([6]);
    for (let i = 0; i < h.nodeCount; i++) expect(arr(idx.objectsUnder(i))).toEqual(bruteUnder(h, i));
  });

  it('a malformed cycle neither hangs nor throws', () => {
    const h = new HierarchyStore();
    // 0 -> 1 -> 2 -> 0 (no root), 3 under 1, 4 a self-loop, 5 a real root
    h.addNodes([2, 0, 1, 1, 4, -1], [10, 11, 12, 13, 14, 15], undefined, () => ({ k: 'v' }));
    const idx = new PropertyIndexImpl(h);
    expect(() => idx.build()).not.toThrow();
    // every object appears exactly once
    const all = idx.find({ key: 'k', equals: 'v' });
    expect(arr(all.objectIds)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(arr(all.nodes)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(arr(idx.objectsUnder(4))).toEqual([14]);
    // the cycle is cut at the first node visited, which holds the rest of its cycle
    expect(arr(idx.objectsUnder(0))).toEqual([10, 11, 12, 13]);
    // inherited properties on a cycle terminate as well
    expect(h.properties(3, true)).toEqual({ k: 'v' });
  });

  it('FIXED: a descendant of a cycle with a lower index than the cycle is cut off from its parent', () => {
    const h = new HierarchyStore();
    // 0 -> parent 1; 1 <-> 2 cycle. Node 0 is visited first by the "unreachable" pass and becomes
    // its own root, so it is missing from objectsUnder(1).
    h.addNodes([1, 2, 1], [10, 11, 12]);
    const idx = new PropertyIndexImpl(h);
    expect(arr(idx.objectsUnder(1))).toEqual([10, 11, 12]);
  });

  it('a group with no objects, and groups whose subtree has none', () => {
    const h = new HierarchyStore();
    const r = h.addNode(-1, 'r');
    const empty = h.addNode(r, 'empty', undefined, { g: 'a' });
    h.addNode(empty, 'emptyChild', undefined, { g: 'b' });
    h.addNode(r, 'leaf', 7, { g: 'a' });
    const idx = new PropertyIndexImpl(h);
    expect(arr(idx.objectsUnder(empty))).toEqual([]);
    const m = idx.find({ key: 'g', equals: 'a' });
    expect(arr(m.nodes)).toEqual([1, 3]);
    expect(arr(m.objectIds)).toEqual([7]);
    const b = idx.find({ key: 'g', equals: 'b' });
    expect(arr(b.nodes)).toEqual([2]);
    expect(arr(b.objectIds)).toEqual([]);
  });

  it('objectIds that are not ascending in preorder come back ascending', () => {
    const h = new HierarchyStore();
    const r = h.addNode(-1, 'r', 50, { k: 'v' });
    const a = h.addNode(r, 'a', 40, { k: 'v' });
    h.addNode(a, 'a1', 90);
    h.addNode(a, 'a2', 10);
    const b = h.addNode(r, 'b', 5, { k: 'w' });
    h.addNode(b, 'b1', 1);
    const idx = new PropertyIndexImpl(h);
    expect(arr(idx.objectsUnder(r))).toEqual([1, 5, 10, 40, 50, 90]);
    expect(arr(idx.objectsUnder(a))).toEqual([10, 40, 90]);
    expect(arr(idx.find({ key: 'k', equals: 'v' }).objectIds)).toEqual([1, 5, 10, 40, 50, 90]);
    expect(arr(idx.find({ key: 'k', in: ['w', 'v'] }).objectIds)).toEqual([1, 5, 10, 40, 50, 90]);
    expect(arr(idx.find({ key: 'name', in: ['a', 'b'] }).objectIds)).toEqual([1, 5, 10, 40, 90]);
  });

  it('objectsUnder on detached, self-parented, negative, NaN and out-of-range nodes', () => {
    const h = new HierarchyStore();
    // 0 root, 1 detached, 2 under 1, 3 its own parent (unreachable), 4 under 2
    h.addNodes([-1, -2, 1, 3, 2], [1, 2, 3, 4, 5]);
    const idx = new PropertyIndexImpl(h);
    expect(arr(idx.objectsUnder(1))).toEqual([2, 3, 5]);
    expect(arr(idx.objectsUnder(3))).toEqual([4]);
    expect(arr(idx.objectsUnder(-1))).toEqual([]);
    expect(arr(idx.objectsUnder(NaN))).toEqual([]);
    expect(arr(idx.objectsUnder(h.nodeCount))).toEqual([]);
  });

  it('random forests agree with a brute-force subtree walk', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let trial = 0; trial < 20; trial++) {
      const h = new HierarchyStore();
      const n = 1 + Math.floor(rnd() * 60);
      const parents: number[] = [];
      const oids: number[] = [];
      for (let i = 0; i < n; i++) {
        const r = rnd();
        // mostly earlier parents, some later ones (allowed in a batch), roots and detached nodes
        parents.push(r < 0.1 ? -1 : r < 0.15 ? -2 : r < 0.3 ? Math.floor(rnd() * n) : i === 0 ? -1 : Math.floor(rnd() * i));
        oids.push(rnd() < 0.6 ? 1000 - i * 3 : NaN);
      }
      h.addNodes(parents, oids, undefined, (i) => ({ k: `v${i % 4}` }));
      const idx = new PropertyIndexImpl(h);
      // only nodes on an acyclic path to a root (cycles are malformed, see the DEFECT test above)
      for (let i = 0; i < n; i++) {
        let p = i, steps = 0;
        while (p >= 0 && steps++ <= n) p = h.parent(p);
        if (steps > n) continue;
        expect(arr(idx.objectsUnder(i))).toEqual(bruteUnder(h, i));
      }
      for (let v = 0; v < 4; v++) {
        const m = idx.find({ key: 'k', equals: `v${v}` });
        expect(isStrictlyAscending(m.objectIds)).toBe(true);
        expect(isStrictlyAscending(m.nodes)).toBe(true);
      }
    }
  });
});

describe('PropertyIndex edge: dictionary and matching', () => {
  it('values differing only by case are distinct entries, matched together unless caseSensitive', () => {
    const idx = new PropertyIndexImpl(flat([{ t: 'Abc' }, { t: 'ABC' }, { t: 'abc' }, { t: 'abd' }]));
    expect(idx.values('t')).toEqual(['ABC', 'Abc', 'abc', 'abd']);
    expect(arr(idx.find({ key: 't', equals: 'aBc' }).objectIds)).toEqual([100, 101, 102]);
    expect(idx.find({ key: 't', equals: 'aBc' }).values).toEqual(['ABC', 'Abc', 'abc']);
    expect(arr(idx.find({ key: 't', equals: 'ABC', caseSensitive: true }).objectIds)).toEqual([101]);
    expect(arr(idx.find({ key: 't', equals: 'aBc', caseSensitive: true }).objectIds)).toEqual([]);
    expect(idx.keys().find((k) => k.key === 't')!.distinct).toBe(4);
  });

  it('surrounding whitespace is trimmed at build and query time; inner whitespace is kept', () => {
    const idx = new PropertyIndexImpl(flat([{ t: '  a b ' }, { t: 'a b' }, { t: 'a  b' }, { t: ' a b\t\n' }]));
    expect(idx.values('t')).toEqual(['a  b', 'a b']);
    expect(arr(idx.find({ key: 't', equals: ' a b ' }).objectIds)).toEqual([100, 101, 103]);
    expect(arr(idx.find({ key: 't', in: ['\ta  b'] }).hits!)).toEqual([1]);
  });

  it('Unicode: Cyrillic, accents, dotted I, sharp s, final sigma', () => {
    const idx = new PropertyIndexImpl(
      flat([{ t: 'Труба' }, { t: 'ТРУБА' }, { t: 'Élan' }, { t: 'élan' }, { t: 'İstanbul' }, { t: 'STRASSE' }, { t: 'straße' }, { t: 'ΟΔΟΣ' }]),
    );
    expect(arr(idx.find({ key: 't', equals: 'труба' }).objectIds)).toEqual([100, 101]);
    expect(arr(idx.find({ key: 't', equals: 'ÉLAN' }).objectIds)).toEqual([102, 103]);
    // no accent folding
    expect(arr(idx.find({ key: 't', equals: 'elan' }).objectIds)).toEqual([]);
    // 'İ' lower-cases to 'i' + U+0307: matched by itself, while 'istanbul' is a different text
    expect(arr(idx.find({ key: 't', equals: 'İSTANBUL' }).objectIds)).toEqual([104]);
    expect(arr(idx.find({ key: 't', equals: 'istanbul' }).objectIds)).toEqual([]);
    // toLowerCase is not case folding: ß is not ss
    expect(arr(idx.find({ key: 't', equals: 'strasse' }).objectIds)).toEqual([105]);
    expect(arr(idx.find({ key: 't', equals: 'STRAßE' }).objectIds)).toEqual([106]);
    // final sigma: 'ΟΔΟΣ'.toLowerCase() === 'οδος'
    expect(arr(idx.find({ key: 't', equals: 'οδος' }).objectIds)).toEqual([107]);
    expect(arr(idx.find({ key: 't', startsWith: 'тр' }).objectIds)).toEqual([100, 101]);
    // the dictionary order is consistent with the binary searches: every value finds itself
    for (const v of idx.values('t')) {
      expect(idx.find({ key: 't', equals: v, caseSensitive: true }).values).toEqual([v]);
      expect(idx.find({ key: 't', in: [v], caseSensitive: true }).values).toEqual([v]);
      expect(idx.find({ key: 't', startsWith: v, caseSensitive: true }).values).toContain(v);
    }
  });

  it('empty and whitespace-only values are not indexed; equals "" matches nothing', () => {
    const idx = new PropertyIndexImpl(flat([{ t: '' }, { t: '   ' }, { t: 'x' }]));
    expect(idx.values('t')).toEqual(['x']);
    expect(idx.find({ key: 't', equals: '' }).nodes.length).toBe(0);
    expect(idx.find({ key: 't', equals: '  ' }).nodes.length).toBe(0);
    expect(arr(idx.find({ key: 't', in: ['', ' '] }).hits!)).toEqual([0, 0]);
    // a key whose only values are empty does not exist
    const only = new PropertyIndexImpl(flat([{ e: '' }]));
    expect(only.keys().map((k) => k.key)).toEqual(['name']);
  });

  it('startsWith "" matches every value of the key', () => {
    const idx = new PropertyIndexImpl(flat([{ t: 'b' }, { t: 'A' }, {}, { t: 'c' }]));
    const r = idx.find({ key: 't', startsWith: '' });
    expect(r.values).toEqual(['A', 'b', 'c']);
    expect(arr(r.objectIds)).toEqual([100, 101, 103]);
    expect(idx.find({ key: 't', startsWith: '  ', caseSensitive: true }).values).toEqual(['A', 'b', 'c']);
  });

  it('numeric-looking strings: parseNumber grammar and the numeric flag', () => {
    expect(parseNumber('NaN')).toBeNaN();
    expect(parseNumber('Infinity')).toBeNaN();
    expect(parseNumber('-Infinity')).toBeNaN();
    expect(parseNumber('1e5')).toBe(100000);
    expect(parseNumber('1E+5')).toBe(100000);
    expect(Object.is(parseNumber('-0'), -0)).toBe(true);
    expect(parseNumber('007')).toBe(7);
    expect(parseNumber('+3.')).toBe(3);
    expect(parseNumber('.')).toBeNaN();
    expect(parseNumber('1e')).toBeNaN();
    expect(parseNumber(' 1')).toBeNaN(); // values are trimmed before parsing
    expect(parseNumber('1_000')).toBeNaN();
    expect(parseNumber('٣')).toBeNaN(); // Arabic-Indic digit: \d is ASCII only

    const idx = new PropertyIndexImpl(flat([{ n: '007' }, { n: 7 }, { n: '7.0' }, { n: '-0' }, { n: 0 }, { n: '1e5' }]));
    expect(idx.keys().find((k) => k.key === 'n')!.numeric).toBe(true);
    // equals matches text: 7 and '007' are different texts
    expect(arr(idx.find({ key: 'n', equals: 7 }).objectIds)).toEqual([101]);
    expect(arr(idx.find({ key: 'n', equals: '007' }).objectIds)).toEqual([100]);
    // ranges match numbers
    expect(arr(idx.find({ key: 'n', min: 7, max: 7 }).objectIds)).toEqual([100, 101, 102]);
    expect(arr(idx.find({ key: 'n', min: 0, max: 0 }).objectIds)).toEqual([103, 104]);
    expect(arr(idx.find({ key: 'n', min: 1e5 }).objectIds)).toEqual([105]);
    // the number -0 has the text '0'
    expect(arr(idx.find({ key: 'n', equals: -0 }).objectIds)).toEqual([104]);

    const mixed = new PropertyIndexImpl(flat([{ n: 'NaN' }, { n: 1 }, { n: Infinity }, { n: NaN }]));
    expect(mixed.keys().find((k) => k.key === 'n')!.numeric).toBe(false);
    expect(mixed.values('n')).toEqual(['1', 'Infinity', 'NaN']);
    expect(arr(mixed.find({ key: 'n', equals: NaN }).objectIds)).toEqual([100, 103]);
    expect(arr(mixed.find({ key: 'n', min: -1e308 }).objectIds)).toEqual([101]); // 'Infinity' never parses
  });

  it('numbers and strings of the same text are one dictionary entry', () => {
    const idx = new PropertyIndexImpl(flat([{ Rev: 2 }, { Rev: '2' }, { Rev: ' 2 ' }, { Rev: 2.5 }]));
    expect(idx.values('Rev')).toEqual(['2', '2.5']);
    expect(arr(idx.find({ key: 'Rev', equals: 2 }).nodes)).toEqual([1, 2, 3]);
    expect(arr(idx.find({ key: 'Rev', in: ['2', 2, 2.5] }).hits!)).toEqual([3, 3, 1]);
  });

  it('booleans, null and undefined', () => {
    const idx = new PropertyIndexImpl(flat([{ b: true }, { b: false }, { b: null }, { b: undefined }, { b: 'TRUE' }]));
    expect(idx.values('b')).toEqual(['false', 'TRUE', 'true']);
    expect(arr(idx.find({ key: 'b', equals: 'true' }).objectIds)).toEqual([100, 104]);
    expect(arr(idx.find({ key: 'b', equals: 'true', caseSensitive: true }).objectIds)).toEqual([100]);
    expect(idx.keys().find((k) => k.key === 'b')!.count).toBe(3);
  });

  it('nested objects deeper than the flatten limit are dropped; shallow levels kept', () => {
    const deep = { a: { b: { c: { d: { e: 'kept', f: { g: 'dropped' } } } } } };
    const idx = new PropertyIndexImpl(flat([deep]));
    expect(idx.keys().map((k) => k.key)).toEqual(['a.b.c.d.e', 'name']);
    // a self-referencing object terminates
    const cyc: Record<string, unknown> = { v: 1 };
    cyc.self = cyc;
    const c = new PropertyIndexImpl(flat([cyc]));
    expect(c.keys().map((k) => k.key)).toEqual(['name', 'self.self.self.self.v', 'self.self.self.v', 'self.self.v', 'self.v', 'v']);
  });

  it('arrays of objects and nested arrays are ignored (only primitive elements are indexed)', () => {
    const idx = new PropertyIndexImpl(flat([{ list: [{ x: 1 }, 'p', ['q'], 3] }]));
    expect(idx.values('list')).toEqual(['3', 'p']);
    expect(idx.values('list.x')).toEqual([]);
  });

  it('a "name" key in the properties shares the column with the node name', () => {
    const h = new HierarchyStore();
    const r = h.addNode(-1, 'Root');
    h.addNode(r, 'Pump-1', 1, { name: 'P-100' });
    h.addNode(r, 'Valve', 2, { name: 'Valve' }); // same pair twice: one posting
    const idx = new PropertyIndexImpl(h);
    expect(idx.values('name')).toEqual(['P-100', 'Pump-1', 'Root', 'Valve']);
    expect(arr(idx.find({ key: 'name', equals: 'P-100' }).objectIds)).toEqual([1]);
    expect(arr(idx.find({ key: 'name', equals: 'pump-1' }).objectIds)).toEqual([1]);
    expect(arr(idx.find({ key: 'name', equals: 'valve' }).nodes)).toEqual([2]);
  });

  it('the same (key, value) twice in a row on one node is one posting', () => {
    const idx = new PropertyIndexImpl(flat([{ tags: ['x', 'x', ' x'] }]));
    expect(arr(idx.find({ key: 'tags', equals: 'x' }).nodes)).toEqual([1]);
    expect(idx.keys().find((k) => k.key === 'tags')!.count).toBe(1);
  });

  it('FIXED: the same value twice (not adjacent) on one node gives a duplicate node', () => {
    const idx = new PropertyIndexImpl(flat([{ tags: ['x', 'y', 'x'] }]));
    expect(arr(idx.find({ key: 'tags', equals: 'x' }).nodes)).toEqual([1]);
    expect(arr(idx.find({ key: 'tags', in: ['x'] }).hits!)).toEqual([1]);
  });

  it('FIXED: two matching values on one node list that node twice in `nodes`', () => {
    // node name 'Pump' and property name 'PUMP': a case-insensitive equals matches both entries
    const h = new HierarchyStore();
    h.addNode(-1, 'Pump', 1, { name: 'PUMP' });
    const idx = new PropertyIndexImpl(h);
    expect(arr(idx.find({ key: 'name', equals: 'pump' }).nodes)).toEqual([0]);
  });

  it('FIXED: a node carrying two values matched by startsWith is listed twice', () => {
    const t = new PropertyIndexImpl(flat([{ tags: ['a1', 'a2'] }]));
    expect(arr(t.find({ key: 'tags', startsWith: 'a' }).nodes)).toEqual([1]);
  });

  it('FIXED: a node carrying two values of an `in` list is listed twice', () => {
    const t = new PropertyIndexImpl(flat([{ tags: ['a1', 'a2'] }]));
    expect(arr(t.find({ key: 'tags', in: ['a1', 'a2'] }).nodes)).toEqual([1]);
  });

  it('objectIds stay duplicate-free when one node carries two matching values', () => {
    const t = new PropertyIndexImpl(flat([{ tags: ['a1', 'a2'] }, { tags: 'a3' }]));
    expect(arr(t.find({ key: 'tags', startsWith: 'a' }).objectIds)).toEqual([100, 101]);
  });

  it('FIXED: keys().count counts (node, value) pairs, not nodes carrying the key', () => {
    const idx = new PropertyIndexImpl(flat([{ tags: ['a', 'b', 'c'] }, { tags: 'a' }]));
    expect(idx.keys().find((k) => k.key === 'tags')!.count).toBe(2); // "Nodes carrying the key"
  });

  it('FIXED: two nodes sharing one objectId give a duplicate objectId', () => {
    // the hierarchy contract does not forbid it (nodeOfObject returns the first node)
    const h = new HierarchyStore();
    const r = h.addNode(-1, 'r');
    h.addNode(r, 'a', 5, { k: 'v' });
    h.addNode(r, 'b', 5, { k: 'v' });
    const idx = new PropertyIndexImpl(h);
    expect(arr(idx.find({ key: 'k', equals: 'v' }).objectIds)).toEqual([5]);
  });
});

describe('PropertyIndex edge: in lists', () => {
  const tags = () => new PropertyIndexImpl(flat([{ t: 'b' }, { t: 'B' }, { t: 'd' }, { t: 'f' }, { t: 'f' }]));

  it('duplicates, case variants, unsorted input and numbers', () => {
    const idx = tags();
    const r = idx.find({ key: 't', in: ['f', 'B', 'b', 'zz', 'f', 'D', 'a'] });
    expect(arr(r.hits!)).toEqual([2, 2, 2, 0, 2, 1, 0]);
    expect(r.values).toEqual(['B', 'b', 'd', 'f']);
    expect(arr(r.nodes)).toEqual([1, 2, 3, 4, 5]);
    expect(arr(r.objectIds)).toEqual([100, 101, 102, 103, 104]);
    const cs = idx.find({ key: 't', in: ['f', 'B', 'b', 'D'], caseSensitive: true });
    expect(arr(cs.hits!)).toEqual([2, 1, 1, 0]);
    expect(cs.values).toEqual(['B', 'b', 'f']);
    const nums = new PropertyIndexImpl(flat([{ n: 1 }, { n: '2' }, { n: 10 }]));
    expect(arr(nums.find({ key: 'n', in: [10, 2, 3, '1'] }).hits!)).toEqual([1, 1, 0, 1]);
    expect(arr(nums.find({ key: 'n', in: new Float64Array([10, 1]) }).hits!)).toEqual([1, 1]);
  });

  it('an empty list matches nothing and gives empty hits', () => {
    const r = tags().find({ key: 't', in: [] });
    expect(r.hits).not.toBeNull();
    expect(r.hits!.length).toBe(0);
    expect(r.nodes.length + r.objectIds.length + r.values.length).toBe(0);
  });

  it('inputs before every entry, after every entry, and a list longer than the dictionary', () => {
    const idx = tags();
    expect(arr(idx.find({ key: 't', in: ['0', '1', '00'] }).hits!)).toEqual([0, 0, 0]);
    expect(arr(idx.find({ key: 't', in: ['z', 'zz', '~'] }).hits!)).toEqual([0, 0, 0]);
    const list: string[] = [];
    for (let i = 0; i < 200; i++) list.push(String.fromCharCode(97 + (i % 8)) + (i >= 8 ? String(i) : ''));
    const r = idx.find({ key: 't', in: list });
    for (let i = 0; i < list.length; i++) expect(r.hits![i]).toBe(idx.find({ key: 't', equals: list[i] }).nodes.length);
    expect(r.values).toEqual(['B', 'b', 'd', 'f']);
  });

  it('in agrees with equals for random lists, case-sensitive or not', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alpha = ['a', 'A', 'b', 'B', 'é', 'É', 'İ', 'ß', ' '];
    const word = () => {
      let s = '';
      const L = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < L; i++) s += alpha[Math.floor(rnd() * alpha.length)];
      return s;
    };
    const props: NodeProperties[] = [];
    for (let i = 0; i < 300; i++) props.push({ t: word() });
    const idx = new PropertyIndexImpl(flat(props));
    for (const cs of [false, true]) {
      const list: string[] = [];
      for (let i = 0; i < 150; i++) list.push(word());
      const r = idx.find({ key: 't', in: list, caseSensitive: cs });
      const expected = new Set<number>();
      for (let i = 0; i < list.length; i++) {
        const one = idx.find({ key: 't', equals: list[i], caseSensitive: cs });
        expect(r.hits![i]).toBe(one.nodes.length);
        for (const id of one.objectIds) expected.add(id);
      }
      expect(arr(r.objectIds)).toEqual([...expected].sort((a, b) => a - b));
    }
  });

  it('a typed array works as `in` (a plain string is rejected by the type)', () => {
    expect(arr(tags().find({ key: 't', in: Int32Array.of(5) }).hits!)).toEqual([0]);
    // @ts-expect-error a string is not a value list
    expect(arr(tags().find({ key: 't', in: 'bd' }).hits!)).toEqual([2, 1]);
  });
});

describe('PropertyIndex edge: numeric ranges', () => {
  const weights = () => new PropertyIndexImpl(flat([{ w: '1' }, { w: 2.5 }, { w: '10' }, { w: 'heavy' }, { w: '-3' }]));

  it('min > max, only min, only max, bounds equal to values', () => {
    const idx = weights();
    expect(idx.find({ key: 'w', min: 5, max: 1 }).values).toEqual([]);
    expect(idx.find({ key: 'w', min: 2.5 }).values).toEqual(['10', '2.5']);
    expect(idx.find({ key: 'w', max: 2.5 }).values).toEqual(['-3', '1', '2.5']);
    expect(idx.find({ key: 'w', min: 2.5, max: 2.5 }).values).toEqual(['2.5']);
    expect(idx.find({ key: 'w', min: -Infinity, max: Infinity }).values).toEqual(['-3', '1', '10', '2.5']);
    expect(idx.keys().find((k) => k.key === 'w')!.numeric).toBe(false);
  });

  it('a key with no numeric values never matches a range', () => {
    const idx = new PropertyIndexImpl(flat([{ s: 'a' }, { s: 'b' }]));
    expect(idx.find({ key: 's', min: -Infinity }).nodes.length).toBe(0);
    expect(idx.find({ key: 's', max: Infinity }).nodes.length).toBe(0);
  });

  it('huge exponents parse to +-Infinity and sort at the ends', () => {
    const idx = new PropertyIndexImpl(flat([{ w: '1e400' }, { w: '5' }, { w: '-1e400' }]));
    expect(idx.find({ key: 'w', min: 1e300 }).values).toEqual(['1e400']);
    expect(idx.find({ key: 'w', max: -1e300 }).values).toEqual(['-1e400']);
  });

  it('FIXED: a NaN bound counts as absent', () => {
    expect(weights().find({ key: 'w', min: NaN }).values).toEqual(weights().find({ key: 'w', min: -Infinity }).values);
    expect(weights().find({ key: 'w', max: NaN }).values).toEqual(weights().find({ key: 'w', max: Infinity }).values);
  });
});

describe('PropertyIndex edge: query combination', () => {
  const idx = () => new PropertyIndexImpl(flat([{ t: 'a' }, { t: 'b' }, { t: 'c' }, { t: '5' }]));

  it('precedence is in > equals > startsWith > matches > range (documented in PropertyQuery)', () => {
    const i = idx();
    expect(i.find({ key: 't', equals: 'a', in: ['b'] }).values).toEqual(['b']);
    expect(i.find({ key: 't', equals: 'a', in: ['b'] }).hits).not.toBeNull();
    expect(i.find({ key: 't', equals: 'a', startsWith: 'b' }).values).toEqual(['a']);
    expect(i.find({ key: 't', startsWith: 'c', matches: 'a' }).values).toEqual(['c']);
    expect(i.find({ key: 't', matches: 'a', min: 0 }).values).toEqual(['a']);
    expect(i.find({ key: 't', startsWith: 'c', min: 0 }).values).toEqual(['c']);
    expect(i.find({ key: 't', equals: 'a', min: 0 }).values).toEqual(['a']);
  });

  it('a query with only a key matches nothing', () => {
    const r = idx().find({ key: 't' });
    expect(r.nodes.length + r.objectIds.length).toBe(0);
    expect(r.hits).toBeNull();
  });
});

describe('PropertyIndex edge: nested match dedup', () => {
  /**
   *   0 A {k: v} [10]
   *     1 B {k: v} [11]
   *       2 C {k: v} [12]
   *     3 D {k: w} [13]
   *       4 E {k: v} [14]
   *   5 F {k: v} [15]  (detached, parent -2)
   *     6 G {k: v} [16]
   */
  function nested(): HierarchyStore {
    const h = new HierarchyStore();
    h.addNodes([-1, 0, 1, 0, 3, -2, 5], [10, 11, 12, 13, 14, 15, 16], (i) => 'ABCDEFG'[i], (i) => ({ k: i === 3 ? 'w' : 'v' }));
    return h;
  }

  it('ancestor and descendant, siblings, descendant only', () => {
    const idx = new PropertyIndexImpl(nested());
    const v = idx.find({ key: 'k', equals: 'v' });
    expect(arr(v.nodes)).toEqual([0, 1, 2, 4, 5, 6]);
    expect(arr(v.objectIds)).toEqual([10, 11, 12, 13, 14, 15, 16]);
    expect(arr(idx.find({ key: 'k', equals: 'w' }).objectIds)).toEqual([13, 14]);
    const sib = idx.find({ key: 'name', in: ['B', 'D', 'C'] });
    expect(arr(sib.nodes)).toEqual([1, 2, 3]);
    expect(arr(sib.objectIds)).toEqual([11, 12, 13, 14]);
    expect(arr(idx.find({ key: 'name', equals: 'E' }).objectIds)).toEqual([14]);
    const det = idx.find({ key: 'name', in: ['G', 'F'] });
    expect(arr(det.objectIds)).toEqual([15, 16]);
    expect(arr(det.hits!)).toEqual([1, 1]);
  });
});

describe('PropertyIndex edge: lifecycle', () => {
  it('find before build builds; build twice returns 0', () => {
    const idx = new PropertyIndexImpl(flat([{ t: 'a' }]));
    expect(idx.ready).toBe(false);
    expect(arr(idx.find({ key: 't', equals: 'a' }).objectIds)).toEqual([100]);
    expect(idx.ready).toBe(true);
    expect(idx.build()).toBe(0);
    const fresh = new PropertyIndexImpl(flat([{ t: 'a' }]));
    expect(fresh.build()).toBeGreaterThanOrEqual(0);
    expect(fresh.ready).toBe(true);
    expect(fresh.build()).toBe(0);
  });

  it('dispose before any build: queries are empty and do not throw', () => {
    const idx = new PropertyIndexImpl(flat([{ t: 'a' }]));
    idx.dispose();
    expect(idx.find({ key: 't', equals: 'a' }).objectIds.length).toBe(0);
    expect(arr(idx.find({ key: 't', in: ['a', 'b'] }).hits!)).toEqual([0, 0]);
    expect(idx.keys()).toEqual([]);
    expect(idx.values('t')).toEqual([]);
    expect(idx.objectsUnder(0).length).toBe(0);
    expect(idx.build()).toBe(0);
    expect(() => idx.dispose()).not.toThrow();
  });

  it('nodes added after the build are not seen (the index is a snapshot)', () => {
    const h = flat([{ t: 'a' }]);
    const idx = new PropertyIndexImpl(h);
    idx.build();
    const late = h.addNode(0, 'late', 999, { t: 'a' });
    expect(arr(idx.find({ key: 't', equals: 'a' }).objectIds)).toEqual([100]);
    expect(arr(idx.objectsUnder(late))).toEqual([]);
    expect(arr(idx.objectsUnder(0))).toEqual([100]);
  });

  it('a throwing property callback leaves the index unbuilt and retryable', () => {
    const h = new HierarchyStore();
    let fail = true;
    h.addNodes([-1], [1], undefined, () => {
      if (fail) throw new Error('boom');
      return { t: 'a' };
    });
    const idx = new PropertyIndexImpl(h);
    expect(() => idx.build()).toThrow('boom');
    expect(idx.ready).toBe(false);
    fail = false;
    expect(arr(idx.find({ key: 't', equals: 'a' }).objectIds)).toEqual([1]);
  });

  it('results are fresh arrays: mutating them does not corrupt the index', () => {
    const idx = new PropertyIndexImpl(flat([{ t: 'a' }, { t: 'a' }]));
    const r = idx.find({ key: 't', equals: 'a' });
    r.objectIds[0] = -1;
    r.nodes[0] = -1;
    r.values[0] = 'zzz';
    idx.values('t').push('q');
    idx.objectsUnder(0)[0] = -5;
    expect(arr(idx.find({ key: 't', equals: 'a' }).objectIds)).toEqual([100, 101]);
    expect(arr(idx.find({ key: 't', equals: 'a' }).nodes)).toEqual([1, 2]);
    expect(arr(idx.objectsUnder(0))).toEqual([100, 101]);
    expect(idx.values('t')).toEqual(['a']);
  });
});

describe('sorted sets: edge cases', () => {
  it('empty and identical inputs', () => {
    expect(arr(sortedIntersection([], []))).toEqual([]);
    expect(arr(sortedUnion([], []))).toEqual([]);
    expect(arr(sortedDifference([], []))).toEqual([]);
    const A = [1, 2, 3];
    expect(arr(sortedIntersection(A, A))).toEqual(A);
    expect(arr(sortedUnion(A, A))).toEqual(A);
    expect(arr(sortedDifference(A, A))).toEqual([]);
    expect(arr(sortedDifference(A, []))).toEqual(A);
    expect(arr(sortedUnion(A, []))).toEqual(A);
  });

  it('typed and plain arrays mix; results are fresh Float64Arrays', () => {
    const a = new Float64Array([1, 4, 9]);
    const b = new Int32Array([4, 5]);
    const u = sortedUnion(a, b);
    expect(u).toBeInstanceOf(Float64Array);
    expect(arr(u)).toEqual([1, 4, 5, 9]);
    expect(arr(sortedIntersection(a, [4, 9, 10]))).toEqual([4, 9]);
    expect(arr(sortedDifference(a, b))).toEqual([1, 9]);
    const i = sortedIntersection(a, a);
    i[0] = -1;
    expect(a[0]).toBe(1);
  });

  it('inputs with duplicates (outside the contract): pairwise behaviour, recorded here', () => {
    // intersection pairs equal elements one to one
    expect(arr(sortedIntersection([1, 1, 2], [1, 1, 1, 2]))).toEqual([1, 1, 2]);
    // union keeps the larger multiplicity
    expect(arr(sortedUnion([1, 1], [1]))).toEqual([1, 1]);
    // difference removes every copy present in b
    expect(arr(sortedDifference([1, 1, 2], [1]))).toEqual([2]);
  });

  it('large ids and negatives', () => {
    const big = 2 ** 40;
    expect(arr(sortedUnion([-5, big], [0, big + 1]))).toEqual([-5, 0, big, big + 1]);
  });
});

describe('PropertyIndex edge: performance sanity', () => {
  it('200k nodes / 50k distinct values build fast; a 20k-value in query is fast', () => {
    const h = new HierarchyStore();
    const N = 200_000, D = 50_000;
    const parents = new Int32Array(N);
    const oids = new Float64Array(N);
    // 2000 groups of 99 leaves
    for (let i = 0; i < N; i++) {
      parents[i] = i % 100 === 0 ? -1 : i - (i % 100);
      oids[i] = i % 100 === 0 ? NaN : i;
    }
    h.addNodes(parents, oids, (i) => `n${i}`, (i) => ({ Tag: `TAG-${(i * 7919) % D}`, Group: `G${(i / 100) | 0}` }));
    const idx = new PropertyIndexImpl(h);
    const t0 = performance.now();
    idx.build();
    const buildMs = performance.now() - t0;
    expect(idx.keys().find((k) => k.key === 'Tag')!.distinct).toBe(D);
    const list: string[] = [];
    for (let i = 0; i < 20_000; i++) list.push(`tag-${(i * 3) % (D + 5000)}`);
    const t1 = performance.now();
    const r = idx.find({ key: 'Tag', in: list });
    const findMs = performance.now() - t1;
    expect(r.objectIds.length).toBeGreaterThan(0);
    expect(isStrictlyAscending(r.objectIds)).toBe(true);
    // generous bounds, many times the expected time, so a slow CI machine does not flake
    expect(buildMs).toBeLessThan(5000);
    expect(findMs).toBeLessThan(1000);
    console.log(`property index perf: build ${buildMs.toFixed(0)} ms, in(20k) ${findMs.toFixed(1)} ms`);
  });
});

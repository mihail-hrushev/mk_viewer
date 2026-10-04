import { describe, expect, it } from 'vitest';
import { FRAG_COLOR, FRAG_DEQUANT_OFFSET, FRAG_DEQUANT_SCALE, FRAG_FLAGS, FRAG_FLOATS, FRAG_MATERIAL, FRAG_RECORDS_PER_ROW, MAT_FLOATS, MAT_RECORDS_PER_ROW } from '../layout';
import { DirtyRows } from './DirtyRows';
import { FragmentList, STATE_ALIVE } from './FragmentList';
import { GeometryStore } from './GeometryStore';
import { MaterialStore } from './MaterialStore';
import { NumberMap } from './NumberMap';
import { boxGeometry, rng, trs } from './testkit';

function runs(d: { flushDirty(fn: (a: number, b: number) => void): void }): [number, number][] {
  const out: [number, number][] = [];
  d.flushDirty((a, b) => out.push([a, b]));
  return out;
}

describe('FragmentList', () => {
  const gs = new GeometryStore();
  const box = gs.add(boxGeometry(0.5));

  it('writes the record layout and world AABB', () => {
    const fl = new FragmentList();
    const f = fl.alloc();
    const m = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 10, 20, 30, 1];
    fl.init(f, box, gs.dequant, gs.aabb, 7, f, m, 0);
    const r = fl.records.subarray(f * FRAG_FLOATS, f * FRAG_FLOATS + FRAG_FLOATS);
    expect(Array.from(r.subarray(0, 12))).toEqual([2, 0, 0, 10, 0, 3, 0, 20, 0, 0, 4, 30]);
    expect(r[FRAG_MATERIAL]).toBe(7);
    expect(r[FRAG_FLAGS]).toBe(1);
    expect(r[FRAG_DEQUANT_SCALE]).toBeCloseTo(1);
    expect(r[FRAG_DEQUANT_OFFSET]).toBeCloseTo(-0.5);
    expect(Array.from(fl.bounds.subarray(0, 6))).toEqual([9, 18.5, 28, 11, 21.5, 32]);
    const back = new Array(16);
    fl.getTransform(f, back);
    expect(back).toEqual(m);
    // rotated 90 degrees about z: AABB swaps x/y extents
    fl.setTransform(f, [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0, gs.aabb);
    expect(Array.from(fl.bounds.subarray(0, 6))).toEqual([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
    fl.setColor(f, 1, 0.5, 0.25, 1);
    expect(Array.from(r.subarray(FRAG_COLOR, FRAG_COLOR + 4))).toEqual([1, 0.5, 0.25, 1]);
  });

  it('allocates, frees via the free list and grows by doubling', () => {
    const fl = new FragmentList();
    const first = fl.allocRange(FRAG_RECORDS_PER_ROW + 10);
    expect(first).toBe(0);
    expect(fl.capacity).toBe(FRAG_RECORDS_PER_ROW * 2);
    for (let i = 0; i < fl.highWater; i++) fl.init(i, box, gs.dequant, gs.aabb, 0, i, null, 0);
    expect(fl.liveCount).toBe(FRAG_RECORDS_PER_ROW + 10);
    fl.kill(5);
    fl.release(5);
    fl.kill(9);
    fl.release(9);
    expect(fl.alloc()).toBe(9);
    expect(fl.alloc()).toBe(5);
    expect(fl.alloc()).toBe(FRAG_RECORDS_PER_ROW + 10);
    // bulk ranges never use the free list
    fl.kill(3);
    fl.release(3);
    expect(fl.allocRange(4)).toBe(FRAG_RECORDS_PER_ROW + 11);
  });

  it('coalesces dirty rows so bulk adds give one range', () => {
    const fl = new FragmentList();
    const n = 5000;
    const first = fl.allocRange(n);
    const m = new Float32Array(16 * n);
    for (let i = 0; i < n; i++) trs(i, 0, 0, 1, m, i * 16);
    for (let i = 0; i < n; i++) fl.init(first + i, box, gs.dequant, gs.aabb, 0, first + i, m, i * 16);
    expect(runs(fl)).toEqual([[0, Math.ceil(n / FRAG_RECORDS_PER_ROW)]]);
    expect(runs(fl)).toEqual([]);
    fl.setFlags(0, 3);
    fl.setFlags(FRAG_RECORDS_PER_ROW * 5 + 1, 3);
    fl.setFlags(FRAG_RECORDS_PER_ROW * 6 + 1, 3);
    expect(runs(fl)).toEqual([[0, 1], [5, 2]]);
  });

  it('indexes fragments by objectId (self ids, shared ids, removal)', () => {
    const fl = new FragmentList();
    const n = 3000;
    fl.allocRange(n);
    for (let i = 0; i < n; i++) {
      // every third fragment uses its own index, the rest share objectId 1e9 + (i % 7)
      const id = i % 3 === 0 ? i : 1e9 + (i % 7);
      fl.init(i, box, gs.dequant, gs.aabb, 0, id, null, 0);
    }
    const collect = (id: number) => {
      const out: number[] = [];
      fl.forEachOfObject(id, (f) => out.push(f));
      return out.sort((a, b) => a - b);
    };
    expect(collect(3)).toEqual([3]);
    expect(collect(4)).toEqual([]); // fragment 4 carries a shared id
    const shared = collect(1e9 + 2);
    expect(shared.length).toBe(Array.from({ length: n }, (_, i) => i).filter((i) => i % 3 !== 0 && i % 7 === 2).length);
    // a fragment carrying another fragment's index as objectId shares that object
    fl.setObjectId(4, 3);
    expect(collect(3)).toEqual([3, 4]);
    fl.kill(3);
    expect(collect(3)).toEqual([4]);
    for (const f of shared) fl.kill(f);
    expect(collect(1e9 + 2)).toEqual([]);
    expect(fl.state[shared[0]] & STATE_ALIVE).toBe(0);
    // fractional and negative ids
    fl.setObjectId(6, -2.5);
    expect(collect(-2.5)).toEqual([6]);
    expect(collect(6)).toEqual([]);
  });
});

describe('NumberMap', () => {
  it('matches a Map under random insert/delete', () => {
    const r = rng(11);
    const nm = new NumberMap(4);
    const ref = new Map<number, number>();
    for (let i = 0; i < 50000; i++) {
      const k = Math.floor(r() * 2000) * (r() < 0.1 ? 0.5 : 1) - 300;
      if (r() < 0.6) {
        nm.set(k, i);
        ref.set(k, i);
      } else {
        expect(nm.delete(k)).toBe(ref.delete(k));
      }
    }
    expect(nm.size).toBe(ref.size);
    for (const [k, v] of ref) expect(nm.get(k)).toBe(v);
    for (let k = -400; k < 2000; k++) if (!ref.has(k)) expect(nm.get(k)).toBe(-1);
  });
});

describe('DirtyRows', () => {
  it('reports maximal runs', () => {
    const d = new DirtyRows(10);
    d.mark(3);
    d.markRange(4, 6);
    d.mark(9);
    const out: number[][] = [];
    d.flush((a, b) => out.push([a, b]));
    expect(out).toEqual([[3, 4], [9, 1]]);
    expect(d.isDirty).toBe(false);
  });
});

describe('MaterialStore', () => {
  it('converts sRGB to linear, flags transparency and tracks dirty rows', () => {
    const ms = new MaterialStore();
    const a = ms.create({ color: [1, 0.5, 0], roughness: 0.3 });
    const d = ms.data.subarray(a * MAT_FLOATS, a * MAT_FLOATS + MAT_FLOATS);
    expect(d[0]).toBe(1);
    expect(d[1]).toBeCloseTo(0.214, 3);
    expect(d[2]).toBe(0);
    expect(d[3]).toBe(1);
    expect(d[5]).toBeCloseTo(0.3);
    expect(ms.isTransparent(a)).toBe(false);
    expect(ms.update(a, { color: [1, 1, 1, 0.5] })).toBe(true);
    expect(ms.isTransparent(a)).toBe(true);
    expect(ms.update(a, { metalness: 1 })).toBe(false);
    expect(d[5]).toBeCloseTo(0.3); // untouched field kept
    const out: number[][] = [];
    ms.flushDirty((r, c) => out.push([r, c]));
    expect(out).toEqual([[0, 1]]);
    for (let i = 0; i < MAT_RECORDS_PER_ROW + 5; i++) ms.create();
    expect(ms.rows).toBe(2);
    out.length = 0;
    ms.flushDirty((r, c) => out.push([r, c]));
    expect(out).toEqual([[0, 2]]);
    const def = ms.create();
    expect(ms.data[def * MAT_FLOATS]).toBeCloseTo(0.6038, 3); // 0.8 sRGB
    expect(() => ms.update(9999, {})).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { DirtyRanges } from './DirtyRanges';

function list(r: DirtyRanges): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < r.count; i++) out.push([r.start(i), r.end(i)]);
  return out;
}

describe('DirtyRanges', () => {
  it('keeps disjoint ranges sorted', () => {
    const r = new DirtyRanges();
    r.add(50, 60);
    r.add(10, 20);
    r.add(30, 40);
    expect(list(r)).toEqual([[10, 20], [30, 40], [50, 60]]);
    expect(r.size).toBe(30);
    expect(r.min).toBe(10);
    expect(r.max).toBe(60);
  });

  it('merges overlapping and touching ranges', () => {
    const r = new DirtyRanges();
    r.add(10, 20);
    r.add(20, 30); // touching
    expect(list(r)).toEqual([[10, 30]]);
    r.add(5, 12);
    expect(list(r)).toEqual([[5, 30]]);
    r.add(40, 50);
    r.add(60, 70);
    r.add(25, 65); // bridges three ranges
    expect(list(r)).toEqual([[5, 70]]);
  });

  it('merges across small gaps with mergeGap', () => {
    const r = new DirtyRanges(8);
    r.add(0, 10);
    r.add(15, 20); // gap 5 <= 8
    r.add(40, 50); // gap 20
    expect(list(r)).toEqual([[0, 20], [40, 50]]);
  });

  it('ignores empty / inverted ranges', () => {
    const r = new DirtyRanges();
    r.add(5, 5);
    r.add(9, 3);
    expect(r.isEmpty).toBe(true);
  });

  it('fuses the closest pair when exceeding maxRanges', () => {
    const r = new DirtyRanges(0, 3);
    r.add(0, 1);
    r.add(10, 11);
    r.add(100, 101);
    r.add(12, 13); // 4 ranges -> fuse closest ([10,11] & [12,13], gap 1)
    expect(list(r)).toEqual([[0, 1], [10, 13], [100, 101]]);
    expect(r.count).toBe(3);
  });

  it('covers every added unit under random use', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 50; trial++) {
      const r = new DirtyRanges(Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 6));
      const covered = new Uint8Array(1000);
      for (let k = 0; k < 40; k++) {
        const s = Math.floor(rnd() * 990);
        const e = s + 1 + Math.floor(rnd() * 10);
        r.add(s, e);
        covered.fill(1, s, e);
      }
      const got = new Uint8Array(1000);
      for (let i = 0; i < r.count; i++) {
        if (i > 0) expect(r.start(i)).toBeGreaterThan(r.end(i - 1));
        got.fill(1, r.start(i), r.end(i));
      }
      for (let u = 0; u < 1000; u++) if (covered[u]) expect(got[u]).toBe(1);
      expect(r.count).toBeLessThanOrEqual(r.maxRanges);
      r.clear();
      expect(r.isEmpty).toBe(true);
    }
  });
});

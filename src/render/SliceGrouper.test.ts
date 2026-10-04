import { describe, expect, it } from 'vitest';
import { SliceGrouper } from './SliceGrouper';

describe('SliceGrouper', () => {
  it('groups entries by key, keeps the original order inside a group and drops negative keys', () => {
    const keys = Int32Array.from([3, 1, 3, -1, 0, 1, 3, 0]);
    const g = new SliceGrouper();
    const n = g.group(keys, keys.length, 4);
    expect(n).toBe(3);
    const groups: [number, number[]][] = [];
    for (let k = 0; k < g.groupCount; k++) {
      const members: number[] = [];
      for (let j = g.groupStart[k]; j < g.groupStart[k + 1]; j++) members.push(g.order[j]);
      groups.push([g.groupKey[k], members]);
    }
    expect(groups).toEqual([
      [0, [4, 7]],
      [1, [1, 5]],
      [3, [0, 2, 6]],
    ]);
  });

  it('handles large random slices and grows its scratch buffers', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const g = new SliceGrouper();
    for (const n of [10, 1000, 20000]) {
      const keyCount = 1 + Math.floor(rnd() * 600);
      const keys = new Int32Array(n);
      for (let i = 0; i < n; i++) keys[i] = Math.floor(rnd() * keyCount) - (rnd() < 0.05 ? keyCount : 0);
      g.group(keys, n, keyCount);
      const seen = new Uint8Array(n);
      let total = 0;
      let lastKey = -1;
      for (let k = 0; k < g.groupCount; k++) {
        expect(g.groupKey[k]).toBeGreaterThan(lastKey);
        lastKey = g.groupKey[k];
        let prev = -1;
        for (let j = g.groupStart[k]; j < g.groupStart[k + 1]; j++) {
          const i = g.order[j];
          expect(keys[i]).toBe(g.groupKey[k]);
          expect(i).toBeGreaterThan(prev);
          prev = i;
          seen[i]++;
          total++;
        }
      }
      let valid = 0;
      for (let i = 0; i < n; i++) {
        if (keys[i] >= 0) {
          valid++;
          expect(seen[i]).toBe(1);
        } else expect(seen[i]).toBe(0);
      }
      expect(total).toBe(valid);
    }
  });
});

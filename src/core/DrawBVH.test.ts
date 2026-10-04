import { describe, expect, it } from 'vitest';
import { cullAabb, distToAabb } from './coremath';
import { DrawBVH, DrawList, type CullView } from './DrawBVH';
import { DETAIL_STEPS, DrawItems, ITEM_FREE, ITEM_INSTANCED, ITEM_MERGED } from './DrawItems';
import { Scene } from './Scene';
import { boxGeometry, perspectiveView, randomMesh, rng, trs } from './testkit';
import { now } from './util';

/** Random synthetic draw items with simple 3-step detail tables. */
function randomItems(n: number, seed: number, extent = 1000): DrawItems {
  const r = rng(seed);
  const items = new DrawItems();
  for (let i = 0; i < n; i++) {
    const it = items.alloc(r() < 0.8 ? ITEM_MERGED : ITEM_INSTANCED);
    const cx = (r() - 0.5) * extent, cy = (r() - 0.5) * extent, cz = (r() - 0.5) * extent;
    const h = Math.pow(10, r() * 2.5 - 1);
    const b = items.bounds;
    b[it * 6] = cx - h * r();
    b[it * 6 + 1] = cy - h * r();
    b[it * 6 + 2] = cz - h * r();
    b[it * 6 + 3] = cx + h * r();
    b[it * 6 + 4] = cy + h * r();
    b[it * 6 + 5] = cz + h * r();
    items.transparent[it] = r() < 0.1 ? 1 : 0;
    items.indexCount[it] = 300;
    items.instanceCount[it] = 10;
    items.fragCount[it] = items.liveFrags[it] = items.visibleFrags[it] = 10;
    const d0 = it * DETAIL_STEPS;
    // invariant of real items: the largest member fits inside the item bounds
    const big = Math.fround(Math.min(h, Math.hypot(b[it * 6 + 3] - b[it * 6], b[it * 6 + 4] - b[it * 6 + 1], b[it * 6 + 5] - b[it * 6 + 2])) * 0.999);
    items.detailSize[d0] = big;
    items.detailCount[d0] = 0;
    items.detailSize[d0 + 1] = big * 0.3;
    items.detailCount[d0 + 1] = items.kind[it] === ITEM_MERGED ? 150 : 5;
    items.detailSize[d0 + 2] = -1;
    items.detailCount[d0 + 2] = items.kind[it] === ITEM_MERGED ? 300 : 10;
    items.detailLen[it] = 3;
  }
  return items;
}

/** Reference: per-item frustum + detail selection without hierarchy. */
function bruteForce(items: DrawItems, view: CullView): Map<number, number> {
  const out = new Map<number, number>();
  const e = view.eye;
  for (let it = 0; it < items.highWater; it++) {
    if (items.kind[it] === ITEM_FREE || items.visibleFrags[it] === 0) continue;
    if (cullAabb(view.planes, items.bounds, it * 6, 63) < 0) continue;
    const d = view.orthographic ? 0 : distToAabb(e[0], e[1], e[2], items.bounds, it * 6);
    const sMin = view.orthographic ? view.pixelThreshold / view.pixelScale : (view.pixelThreshold * d) / view.pixelScale;
    const d0 = it * DETAIL_STEPS;
    let cnt = items.detailCount[d0 + items.detailLen[it] - 1];
    for (let k = 0; k < items.detailLen[it]; k++) {
      if (items.detailSize[d0 + k] < sMin) {
        cnt = items.detailCount[d0 + k];
        break;
      }
    }
    if (cnt > 0) out.set(it, cnt);
  }
  return out;
}

function listToMap(list: DrawList): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < list.length; i++) {
    expect(m.has(list.item[i])).toBe(false);
    m.set(list.item[i], list.count[i]);
  }
  return m;
}

describe('DrawBVH culling', () => {
  it('matches brute force on random scenes and views', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const items = randomItems(seed % 2 ? 1500 : 3000, seed); // SAH and LBVH builders
      // free some items to exercise holes
      for (let i = 0; i < items.highWater; i += 17) items.free(i);
      const bvh = new DrawBVH();
      bvh.build(items);
      const list = new DrawList();
      const r = rng(seed * 100);
      for (let v = 0; v < 10; v++) {
        const eye: [number, number, number] = [(r() - 0.5) * 1500, (r() - 0.5) * 1500, (r() - 0.5) * 1500];
        const target: [number, number, number] = [(r() - 0.5) * 200, (r() - 0.5) * 200, (r() - 0.5) * 200];
        const view = perspectiveView(eye, target, 0.4 + r(), 1.5, 0.1, 5000, 800, v % 3 === 0 ? 0 : r() * 4);
        bvh.traverse(items, view, list);
        const expected = bruteForce(items, view);
        expect(listToMap(list)).toEqual(expected);
        expect(list.length).toBe(expected.size);
      }
    }
  });

  it('refits after bounds change and stays correct', () => {
    const items = randomItems(500, 42);
    const bvh = new DrawBVH();
    bvh.update(items, 1, 1);
    for (let i = 0; i < 500; i += 3) items.bounds[i * 6 + 3] += 300;
    bvh.update(items, 1, 2); // refit only
    const view = perspectiveView([0, 0, 1500], [0, 0, 0], 1, 1, 1, 5000, 800, 1);
    const list = new DrawList();
    bvh.traverse(items, view, list);
    expect(listToMap(list)).toEqual(bruteForce(items, view));
  });

  it('skips items with no visible fragment', () => {
    const items = randomItems(200, 3);
    for (let i = 0; i < 200; i++) items.visibleFrags[i] = 0;
    const bvh = new DrawBVH();
    bvh.build(items);
    const list = new DrawList();
    bvh.traverse(items, perspectiveView([0, 0, 1500], [0, 0, 0], 1, 1, 1, 5000, 800, 0), list);
    expect(list.length).toBe(0);
  });

  it('builds 10k items in a few ms', () => {
    const items = randomItems(10000, 77);
    const bvh = new DrawBVH();
    bvh.build(items); // warm-up (JIT)
    const t0 = now();
    const runs = 5;
    for (let i = 0; i < runs; i++) bvh.build(items);
    const ms = (now() - t0) / runs;
    console.log(`[bench] BVH build 10k items: ${ms.toFixed(2)} ms, ${bvh.nodeCount} nodes`);
    expect(ms).toBeLessThan(50);
  });
});

describe('traversal ordering', () => {
  it('orders opaque items by projected importance and transparent back to front', () => {
    const items = randomItems(5000, 9);
    const bvh = new DrawBVH();
    bvh.build(items);
    const list = new DrawList();
    const view = perspectiveView([0, 0, 900], [0, 0, 0], 1, 1, 1, 5000, 800, 0.5);
    bvh.traverse(items, view, list);
    expect(list.opaqueCount).toBeGreaterThan(100);
    expect(list.transparentCount).toBeGreaterThan(5);
    const px = (it: number) => {
      const d = distToAabb(0, 0, 900, items.bounds, it * 6);
      return d > 0 ? (items.detailSize[it * DETAIL_STEPS] * view.pixelScale) / d : 1e30;
    };
    const keys: number[] = [];
    for (let i = 0; i < list.opaqueCount; i++) {
      expect(items.transparent[list.item[i]]).toBe(0);
      keys.push(-Math.log2(px(list.item[i])));
    }
    const finite = keys.filter((k) => k > -90);
    const w = (Math.max(...finite) - Math.min(...keys.map((k) => Math.max(k, -99.7)))) / 2047 + 1e-6;
    for (let i = 1; i < keys.length; i++) expect(keys[i]).toBeGreaterThanOrEqual(keys[i - 1] - w);
    // the first item is (within a bucket) the most important one on screen
    expect(keys[0]).toBeLessThanOrEqual(Math.min(...keys) + w);
    let prev = Infinity;
    for (let i = list.opaqueCount; i < list.length; i++) {
      const it = list.item[i];
      expect(items.transparent[it]).toBe(1);
      const b = items.bounds;
      const c = [(b[it * 6] + b[it * 6 + 3]) / 2, (b[it * 6 + 1] + b[it * 6 + 4]) / 2, (b[it * 6 + 2] + b[it * 6 + 5]) / 2];
      const d = Math.hypot(c[0], c[1], c[2] - 900);
      expect(d).toBeLessThanOrEqual(prev + 1e-3);
      prev = d;
    }
  });

  it('drops small far items and shortens index counts with the detail table', () => {
    const s = new Scene();
    const mat = s.createMaterial();
    const r = rng(12);
    // one batch: a big mesh plus many tiny ones, all far away
    for (let i = 0; i < 200; i++) {
      const g = s.createGeometry(randomMesh(r, 1));
      s.addMesh(g, mat, trs(r() * 10, r() * 10, r() * 10, i === 0 ? 10 : 0.01));
    }
    s.flush();
    expect(s.items.liveCount).toBe(1);
    const it = 0;
    const list = new DrawList();
    // close: everything drawn
    s.traverse(perspectiveView([5, 5, 30], [5, 5, 5], 1, 1, 0.1, 1e5, 1000, 1), list);
    expect(list.length).toBe(1);
    expect(list.count[0]).toBe(s.items.indexCount[it]);
    // far: tiny members dropped, only the big one's prefix
    s.traverse(perspectiveView([5, 5, 3000], [5, 5, 5], 1, 1, 0.1, 1e5, 1000, 1), list);
    expect(list.length).toBe(1);
    expect(list.count[0]).toBeLessThan(s.items.indexCount[it]);
    expect(list.count[0]).toBeGreaterThanOrEqual(36);
    // very far: whole item rejected
    s.traverse(perspectiveView([5, 5, 1e5 - 10], [5, 5, 5], 1, 1, 0.1, 2e5, 1000, 1), list);
    expect(list.length).toBe(0);
  });

  it('reports triangle totals and scene bounds', () => {
    const s = new Scene();
    const mat = s.createMaterial();
    const g = s.createGeometry(boxGeometry());
    const t = new Float32Array(16 * 64);
    for (let i = 0; i < 64; i++) trs(i, 0, 0, 1, t, i * 16);
    s.addMeshes(g, mat, t);
    s.flush();
    const list = new DrawList();
    s.traverse(perspectiveView([32, 0, 100], [32, 0, 0], 1.2, 1, 0.1, 1000, 1000, 0), list);
    expect(list.triangles).toBe(64 * 12);
    const b = new Float32Array(6);
    expect(s.getDrawBounds(b)).toBe(true);
    expect(Array.from(b)).toEqual([-0.5, -0.5, -0.5, 63.5, 0.5, 0.5]);
  });
});

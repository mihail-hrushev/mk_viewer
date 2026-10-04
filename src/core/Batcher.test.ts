import { describe, expect, it } from 'vitest';
import { FRAG_DEQUANT_OFFSET, FRAG_DEQUANT_SCALE, FRAG_FLOATS, FragFlags } from '../layout';
import { DETAIL_STEPS, ITEM_FREE, ITEM_INSTANCED, ITEM_MERGED } from './DrawItems';
import { STATE_ALIVE, STATE_FREE } from './FragmentList';
import { PAGE_INSTANCE, PAGE_MERGED, PAGE_SHARED } from './Pages';
import { Scene } from './Scene';
import { boxGeometry, randomMesh, rng, trs } from './testkit';

function membersOf(s: Scene, it: number): number[] {
  const out: number[] = [];
  for (let f = s.items.head[it]; f >= 0; f = s.fragments.itemNext[f]) out.push(f);
  return out;
}

function liveItems(s: Scene): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.items.highWater; i++) if (s.items.kind[i] !== ITEM_FREE) out.push(i);
  return out;
}

/** Checks that every alive, batched fragment is in exactly one item and counts are consistent. */
function checkConsistency(s: Scene): void {
  const seen = new Map<number, number>();
  for (const it of liveItems(s)) {
    const mem = membersOf(s, it);
    expect(mem.length).toBe(s.items.fragCount[it]);
    let live = 0;
    let vis = 0;
    for (const f of mem) {
      expect(seen.has(f)).toBe(false);
      seen.set(f, it);
      expect(s.fragments.item[f]).toBe(it);
      if (s.fragments.state[f] & STATE_ALIVE) {
        live++;
        if (s.fragments.flags[f] & FragFlags.Visible) vis++;
      }
    }
    expect(s.items.liveFrags[it]).toBe(live);
    expect(s.items.visibleFrags[it]).toBe(vis);
  }
  for (let f = 0; f < s.fragments.highWater; f++) {
    if (s.fragments.isAlive(f) && s.geometries.indexCount[s.fragments.geometry[f]] > 0) {
      expect(seen.has(f)).toBe(true);
    }
  }
}

describe('Batcher merged path', () => {
  it('writes merged batches that decode back to the source meshes', () => {
    const r = rng(5);
    const s = new Scene({ batchVertices: 2000 });
    const mat = s.createMaterial();
    const meshes = Array.from({ length: 300 }, () => randomMesh(r, 0.2 + r() * 3));
    const geoms = meshes.map((m) => s.createGeometry(m));
    const ids: number[] = [];
    const m = new Float32Array(16);
    for (let i = 0; i < meshes.length; i++) {
      trs((r() - 0.5) * 100, (r() - 0.5) * 100, (r() - 0.5) * 100, 1, m);
      ids.push(s.addMesh(geoms[i], mat, m));
    }
    expect(s.batcher.pendingCount).toBe(300);
    const created = s.flush();
    expect(created).toBeGreaterThan(1);
    expect(s.batcher.pendingCount).toBe(0);
    checkConsistency(s);
    let totalTris = 0;
    for (const it of liveItems(s)) {
      expect(s.items.kind[it]).toBe(ITEM_MERGED);
      const page = s.pages.get(s.items.page[it]);
      expect(page.kind).toBe(PAGE_MERGED);
      expect(page.vertexStride).toBe(12);
      const mem = membersOf(s, it);
      // batch size bound (single oversize fragment excepted)
      expect(s.items.vertexCount[it]).toBeLessThanOrEqual(2000);
      // largest-first
      for (let k = 1; k < mem.length; k++) {
        const d = (f: number) => {
          const b = s.fragments.bounds.subarray(f * 6, f * 6 + 6);
          return Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
        };
        expect(d(mem[k])).toBeLessThanOrEqual(d(mem[k - 1]) + 1e-6);
      }
      // decode: walk the index range, every vertex carries its fragment index; positions decode
      // (via the fragment record's dequant) to the source mesh positions
      const words = page.vertexWords!;
      const idx = page.indexData!;
      let x = s.items.firstIndex[it];
      let vbase = s.items.firstVertex[it];
      for (const f of mem) {
        const src = meshes[ids.indexOf(f)];
        const rec = s.fragments.records.subarray(f * FRAG_FLOATS, f * FRAG_FLOATS + FRAG_FLOATS);
        for (let k = 0; k < src.indices.length; k++) {
          const v = idx[x + k];
          expect(v - vbase).toBe(src.indices[k]);
          expect(words[v * 3 + 2]).toBe(f);
          const w0 = words[v * 3];
          const w1 = words[v * 3 + 1];
          const q = [w0 & 0xffff, w0 >>> 16, w1 & 0xffff];
          const li = src.indices[k];
          for (let a = 0; a < 3; a++) {
            const p = (q[a] / 65535) * rec[FRAG_DEQUANT_SCALE + a] + rec[FRAG_DEQUANT_OFFSET + a];
            expect(Math.abs(p - src.positions[li * 3 + a])).toBeLessThan(rec[FRAG_DEQUANT_SCALE + a] / 65535 + 1e-6);
          }
        }
        x += src.indices.length;
        vbase += src.positions.length / 3;
      }
      expect(x).toBe(s.items.firstIndex[it] + s.items.indexCount[it]);
      totalTris += s.items.triangles[it];
    }
    expect(totalTris).toBe(300 * 12);
    expect(s.triangleCount).toBe(300 * 12);
  });

  it('builds detail tables whose prefixes cover every member above the size', () => {
    const r = rng(9);
    const s = new Scene();
    const mat = s.createMaterial();
    const m = new Float32Array(16);
    for (let i = 0; i < 400; i++) {
      const g = s.createGeometry(randomMesh(r, 1));
      trs(r() * 50, r() * 50, r() * 50, Math.pow(10, r() * 3 - 1.5), m);
      s.addMesh(g, mat, m);
    }
    s.flush();
    for (const it of liveItems(s)) {
      const mem = membersOf(s, it);
      const len = s.items.detailLen[it];
      expect(len).toBeGreaterThanOrEqual(2);
      expect(len).toBeLessThanOrEqual(DETAIL_STEPS);
      const d0 = it * DETAIL_STEPS;
      expect(s.items.detailCount[d0 + len - 1]).toBe(s.items.indexCount[it]);
      for (let k = 0; k < len; k++) {
        const size = s.items.detailSize[d0 + k];
        const cnt = s.items.detailCount[d0 + k];
        // every member not fully inside the prefix must have size <= size
        let cum = 0;
        for (const f of mem) {
          const b = s.fragments.bounds.subarray(f * 6, f * 6 + 6);
          const diag = Math.fround(Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]));
          const ic = s.geometries.indexCount[s.fragments.geometry[f]];
          if (cum + ic > cnt) expect(diag).toBeLessThanOrEqual(size + 1e-4);
          cum += ic;
        }
        if (k > 0) expect(cnt).toBeGreaterThan(s.items.detailCount[d0 + k - 1]);
      }
    }
  });
});

describe('Batcher instanced path', () => {
  it('stores shared geometry once and writes instance ranges', () => {
    const s = new Scene({ chunkInstances: 100 });
    const mat = s.createMaterial();
    const g = s.createGeometry(boxGeometry());
    const n = 1000;
    const t = new Float32Array(16 * n);
    for (let i = 0; i < n; i++) trs(i % 10, Math.floor(i / 10) % 10, Math.floor(i / 100), 0.5, t, i * 16);
    const first = s.addMeshes(g, mat, t);
    expect(first).toBe(0);
    s.flush();
    checkConsistency(s);
    const items = liveItems(s);
    expect(items.length).toBe(10);
    const sharedPages = new Set<number>();
    const seen = new Set<number>();
    for (const it of items) {
      expect(s.items.kind[it]).toBe(ITEM_INSTANCED);
      expect(s.items.indexCount[it]).toBe(36);
      expect(s.items.instanceCount[it]).toBe(100);
      sharedPages.add(s.items.page[it] * 1e6 + s.items.firstIndex[it]);
      const ip = s.pages.get(s.items.instancePage[it]);
      expect(ip.kind).toBe(PAGE_INSTANCE);
      for (let k = 0; k < 100; k++) {
        const f = ip.vertexWords![s.items.firstInstance[it] + k];
        expect(s.fragments.item[f]).toBe(it);
        seen.add(f);
      }
    }
    expect(seen.size).toBe(n);
    expect(sharedPages.size).toBe(1);
    const sp = s.pages.get(s.items.page[items[0]]);
    expect(sp.kind).toBe(PAGE_SHARED);
    expect(sp.vertexUsed).toBe(24);
    // shared indices are rebased to the page and reference the stored geometry
    const fi = s.items.firstIndex[items[0]];
    expect(Array.from(sp.indexData!.subarray(fi, fi + 36))).toEqual(Array.from(s.geometries.indices(g)));
    expect(s.triangleCount).toBe(n * 12);
  });

  it('moves already merged fragments to the shared copy when a geometry crosses the threshold', () => {
    const s = new Scene({ instanceThreshold: 16 });
    const mat = s.createMaterial();
    const g = s.createGeometry(boxGeometry());
    for (let i = 0; i < 10; i++) s.addMesh(g, mat, trs(i, 0, 0));
    s.flush();
    expect(liveItems(s).map((i) => s.items.kind[i])).toEqual([ITEM_MERGED]);
    for (let i = 0; i < 10; i++) s.addMesh(g, mat, trs(i, 5, 0));
    s.flush();
    // the geometry is now stored once: every fragment draws from the shared page
    expect(liveItems(s).map((i) => s.items.kind[i])).toEqual([ITEM_INSTANCED]);
    expect(s.items.instanceCount[liveItems(s)[0]]).toBe(20);
    expect(s.batcher.migratedItems).toBe(1);
    checkConsistency(s);
  });

  it('instances large geometry reused across flushes (e.g. by a second model) and migrates the merged copy', () => {
    const s = new Scene({ instanceThreshold: 16, reuseInstanceVertices: 24 });
    const mat = s.createMaterial();
    const big = s.createGeometry(boxGeometry()); // 24 vertices: "large" here
    const small = s.createGeometry({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] });
    s.addMesh(big, mat, trs(0, 0, 0));
    s.addMesh(small, mat, trs(1, 0, 0));
    s.flush();
    expect(liveItems(s).map((i) => s.items.kind[i])).toEqual([ITEM_MERGED]);
    // a later flush reuses both: only the large one switches; the small one stays merged (copied)
    s.addMesh(big, mat, trs(0, 3, 0));
    s.addMesh(small, mat, trs(1, 3, 0));
    s.flush();
    const kinds = liveItems(s).map((i) => s.items.kind[i]).sort();
    expect(kinds).toEqual([ITEM_MERGED, ITEM_INSTANCED]);
    const inst = liveItems(s).find((i) => s.items.kind[i] === ITEM_INSTANCED)!;
    expect(s.items.instanceCount[inst]).toBe(2);
    checkConsistency(s);
  });

  it('sends large meshes to the instanced path even when used once', () => {
    const s = new Scene({ largeMeshVertices: 100 });
    const mat = s.createMaterial();
    const r = rng(2);
    const pos = new Float32Array(300 * 3).map(() => r());
    const g = s.createGeometry({ positions: pos });
    s.addMesh(g, mat);
    s.flush();
    expect(s.items.kind[liveItems(s)[0]]).toBe(ITEM_INSTANCED);
  });
});

describe('removal and compaction', () => {
  it('clears visibility, tracks holes, frees dead items and compacts', () => {
    const r = rng(4);
    const s = new Scene({ batchVertices: 4000 });
    const mat = s.createMaterial();
    const ids: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const g = s.createGeometry(randomMesh(r));
      ids.push(s.addMesh(g, mat, trs(r() * 100, r() * 100, r() * 100)));
      s.releaseGeometry(g); // mesh keeps it alive
    }
    s.flush();
    const itemsBefore = s.items.liveCount;
    // remove all members of one item -> item freed immediately and slots recycled
    const victim = liveItems(s)[0];
    const victimMembers = membersOf(s, victim);
    s.remove(victimMembers);
    expect(s.items.kind[victim]).toBe(ITEM_FREE);
    for (const f of victimMembers) expect(s.fragments.state[f]).toBe(STATE_FREE);
    expect(s.items.liveCount).toBe(itemsBefore - 1);
    // remove 60% of the rest at random
    const removed = new Set<number>(victimMembers);
    for (const f of ids) {
      if (!removed.has(f) && r() < 0.6) {
        s.remove(f);
        removed.add(f);
        expect(s.fragments.flags[f] & FragFlags.Visible).toBe(0);
      }
    }
    expect(s.meshCount).toBe(2000 - removed.size);
    checkConsistency(s);
    let holes = 0;
    for (const it of liveItems(s)) holes += s.items.holes(it);
    expect(holes).toBeGreaterThan(0);
    const geomsBefore = s.geometries.liveCount;
    expect(s.compact(1000)).toBe(true);
    checkConsistency(s);
    holes = 0;
    for (const it of liveItems(s)) holes += s.items.holes(it);
    expect(holes).toBe(0);
    // removed meshes' slots and geometries were recycled
    for (const f of removed) expect(s.fragments.state[f]).toBe(STATE_FREE);
    expect(s.geometries.liveCount).toBe(2000 - removed.size);
    expect(geomsBefore).toBeGreaterThan(s.geometries.liveCount);
    // survivors still render: each is in an item and visible
    for (const f of ids) if (!removed.has(f)) expect(s.fragments.item[f]).toBeGreaterThanOrEqual(0);
    // freed slots get reused by new meshes
    const g = s.createGeometry(boxGeometry());
    const nid = s.addMesh(g, mat);
    expect(removed.has(nid)).toBe(true);
    expect(s.triangleCount).toBe((2000 - removed.size) * 12 + 12);
  });

  it('merges undersized items produced by one-mesh-per-frame adds', () => {
    const s = new Scene();
    const mat = s.createMaterial();
    const r = rng(8);
    for (let i = 0; i < 20; i++) {
      s.addMesh(s.createGeometry(randomMesh(r)), mat, trs(i, 0, 0));
      s.flush();
    }
    expect(s.items.liveCount).toBe(20);
    s.compact(1000);
    expect(s.items.liveCount).toBe(1);
    checkConsistency(s);
    // no churn: a single undersized item stays as is
    expect(s.compact(1000)).toBe(false);
  });

  it('removal of pending meshes before flush recycles them', () => {
    const s = new Scene();
    const mat = s.createMaterial();
    const g = s.createGeometry(boxGeometry());
    const a = s.addMesh(g, mat);
    s.remove(a);
    expect(s.meshCount).toBe(0);
    s.flush();
    expect(s.items.liveCount).toBe(0);
    expect(s.fragments.state[a]).toBe(STATE_FREE);
    expect(s.addMesh(g, mat)).toBe(a);
  });

  it('moves fragments between passes when transparency changes', () => {
    const s = new Scene();
    const opaque = s.createMaterial({ color: [1, 0, 0] });
    const other = s.createMaterial({ color: [0, 1, 0] });
    const g = s.createGeometry(boxGeometry());
    const a = s.addMesh(g, opaque, trs(0, 0, 0));
    const b = s.addMesh(g, other, trs(2, 0, 0));
    s.flush();
    expect(s.items.liveCount).toBe(1);
    s.updateMaterial(other, { color: [0, 1, 0, 0.5] });
    s.flush();
    checkConsistency(s);
    expect(s.items.liveCount).toBe(2);
    expect(s.items.transparent[s.fragments.item[b]]).toBe(1);
    expect(s.items.transparent[s.fragments.item[a]]).toBe(0);
    s.setMaterial(b, opaque);
    s.flush();
    checkConsistency(s);
    expect(s.items.transparent[s.fragments.item[b]]).toBe(0);
  });

  it('grows item bounds on transform change and clears everything', () => {
    const s = new Scene();
    const mat = s.createMaterial();
    const g = s.createGeometry(boxGeometry());
    const a = s.addMesh(g, mat);
    s.flush();
    const it = s.fragments.item[a];
    const v0 = s.batcher.boundsVersion;
    s.setTransform(a, trs(100, 0, 0));
    expect(s.batcher.boundsVersion).toBe(v0 + 1);
    expect(s.items.bounds[it * 6 + 3]).toBeCloseTo(100.5);
    s.clear();
    expect(s.meshCount).toBe(0);
    expect(s.items.liveCount).toBe(0);
    expect(s.pages.gpuBytes).toBe(0);
    expect(s.geometries.isAlive(g)).toBe(true); // API handle still held
    s.addMesh(g, mat);
    s.flush();
    expect(s.items.liveCount).toBe(1);
  });

  it('can drop CPU page copies after upload', () => {
    const s = new Scene({ batchVertices: 400, pages: { mergedVertices: 1000, dropCpuAfterUpload: true } });
    const mat = s.createMaterial();
    const r = rng(1);
    for (let i = 0; i < 400; i++) s.addMesh(s.createGeometry(randomMesh(r)), mat, trs(r() * 10, 0, 0));
    s.flush();
    const merged = s.pages.pages.filter((p) => p && p.kind === PAGE_MERGED);
    expect(merged.length).toBeGreaterThan(1);
    for (const p of merged) s.pages.markUploaded(p!.id);
    const sealed = merged.filter((p) => p!.sealed);
    expect(sealed.length).toBe(merged.length - 1);
    for (const p of sealed) expect(p!.hasCpuCopy).toBe(false);
    // compaction still works (re-batches from the GeometryStore, not from pages)
    const all = Array.from({ length: 300 }, (_, i) => i);
    s.remove(all);
    s.compact(1000);
    checkConsistency(s);
  });
});

describe('Scene per-object state', () => {
  it('setVisible / isolate / select / setColor / getBounds by objectId', () => {
    const s = new Scene();
    const mat = s.createMaterial();
    const g = s.createGeometry(boxGeometry());
    const n = 100;
    const t = new Float32Array(16 * n);
    for (let i = 0; i < n; i++) trs(i * 2, 0, 0, 1, t, i * 16);
    const objectIds = new Float64Array(n).map((_, i) => 1000 + Math.floor(i / 10));
    s.addMeshes(g, mat, t, objectIds);
    s.flush();
    s.setVisible(1003, false);
    for (let i = 30; i < 40; i++) expect(s.fragments.flags[i] & FragFlags.Visible).toBe(0);
    expect(s.fragments.flags[40] & FragFlags.Visible).toBe(1);
    checkConsistency(s);
    s.isolate([1001]);
    expect(s.fragments.flags[15] & FragFlags.Ghosted).toBe(0);
    expect(s.fragments.flags[50] & FragFlags.Ghosted).toBe(FragFlags.Ghosted);
    s.isolate([1001], true);
    expect(s.fragments.flags[50] & FragFlags.Visible).toBe(0);
    checkConsistency(s);
    s.showAll();
    expect(s.fragments.flags[50]).toBe(FragFlags.Visible);
    s.select([1002, 1004]);
    expect(s.getSelection()).toEqual([1002, 1004]);
    expect(s.fragments.flags[25] & FragFlags.Selected).toBe(FragFlags.Selected);
    s.select([1005]);
    expect(s.fragments.flags[25] & FragFlags.Selected).toBe(0);
    s.setColor([1005], [1, 0, 0]);
    expect(s.fragments.records[55 * FRAG_FLOATS + 20]).toBe(1);
    expect(s.fragments.records[55 * FRAG_FLOATS + 23]).toBe(1);
    s.setColor(1005, null);
    expect(s.fragments.records[55 * FRAG_FLOATS + 23]).toBe(0);
    const b = s.getBounds([1002])!;
    expect(Array.from(b)).toEqual([39.5, -0.5, -0.5, 58.5, 0.5, 0.5]);
    expect(Array.from(s.getBounds()!)).toEqual([-0.5, -0.5, -0.5, 198.5, 0.5, 0.5]);
    expect(s.getBounds([42])).toBeNull();
    expect(s.objectIdOf(37)).toBe(1003);
  });
});

describe('Batcher: moved members, batch groups', () => {
  it('refits moved items exactly (bounds shrink again) and splits items whose members drifted apart', () => {
    const s = new Scene();
    const mat = s.createMaterial();
    const g = s.createGeometry(boxGeometry());
    for (let i = 0; i < 10; i++) s.addMesh(g, mat, trs(i * 2, 0, 0));
    s.flush();
    expect(liveItems(s).length).toBe(1);
    const it = liveItems(s)[0];
    // move everything rigidly: no split, exact bounds at the new place
    for (let f = 0; f < 10; f++) s.setTransform(f, trs(1000 + f * 2, 0, 0));
    s.flush();
    expect(s.batcher.lastSplitCount).toBe(0);
    expect(s.items.bounds[it * 6]).toBeCloseTo(999.5, 4);
    // move one member far away: the item is split, no item spans the gap
    s.setTransform(3, trs(-5000, 0, 0));
    s.flush();
    expect(s.batcher.lastSplitCount).toBe(1);
    const items = liveItems(s);
    expect(items.length).toBe(2);
    for (const i of items) expect(s.items.bounds[i * 6 + 3] - s.items.bounds[i * 6]).toBeLessThan(30);
    checkConsistency(s);
  });

  it('never consolidates meshes of different batch groups', () => {
    const s = new Scene({ instanceThreshold: 8 });
    const mat = s.createMaterial();
    const small = s.createGeometry({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }); // 6 uses: merged
    const inst = s.createGeometry(boxGeometry()); // 10 uses: instanced
    for (let i = 0; i < 6; i++) s.addMesh(small, mat, trs(i, 0, 0), undefined, i % 2 ? 7 : 3);
    for (let i = 0; i < 10; i++) s.addMesh(inst, mat, trs(i, 2, 0), undefined, i % 2 ? 7 : 3);
    s.flush();
    const kinds = liveItems(s).map((i) => `${s.items.kind[i]}:${s.items.group[i]}`).sort();
    expect(kinds).toEqual([`${ITEM_MERGED}:3`, `${ITEM_MERGED}:7`, `${ITEM_INSTANCED}:3`, `${ITEM_INSTANCED}:7`].sort());
    for (const i of liveItems(s)) for (const f of membersOf(s, i)) expect(s.fragments.group[f]).toBe(s.items.group[i]);
    // compaction does not merge undersized items across groups (and settles)
    let rounds = 0;
    while (s.compact(100) && rounds < 10) rounds++;
    expect(rounds).toBeLessThan(10);
    expect(liveItems(s).length).toBe(4);
    checkConsistency(s);
  });
});

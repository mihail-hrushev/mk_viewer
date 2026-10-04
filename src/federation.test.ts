/**
 * Viewer-level loading and federation, on the real Viewer + core Scene in node (fake GL context):
 * memory stability over load/unload cycles, shared geometry between models, objectId ranges,
 * concurrent loads, placement precision, re-placement, material release, registries, auto-fit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from './__tests__/headlessViewer';
import { objLoader, type LoadContext, type LoaderPlugin, type Model } from './loaders';
import { box } from './primitives';
import type { Viewer } from './Viewer';

interface GridOptions {
  /** Number of meshes. */
  n: number;
  /** Distinct geometries (content-identical between loads, so they are shared). */
  unique: number;
  /** Use one addMeshes call per geometry instead of addMesh per mesh. */
  bulk: boolean;
  /** Record slice boundaries here (concurrency test). */
  trace: string[];
  tag: string;
  /** Base offset of the grid in model space. */
  x0: number;
}

/** Synthetic format: a grid of boxes, 2 materials. */
const gridPlugin: LoaderPlugin<GridOptions> = {
  name: 'grid',
  extensions: ['grid'],
  up: 'y',
  async load(_source, ctx: LoadContext<GridOptions>) {
    const n = ctx.options.n ?? 100;
    const unique = ctx.options.unique ?? 4;
    const x0 = ctx.options.x0 ?? 0;
    const mats = [ctx.createMaterial({ color: [0.8, 0.2, 0.2] }), ctx.createMaterial({ color: [0.2, 0.8, 0.2] })];
    const geoms: number[] = [];
    for (let u = 0; u < unique; u++) geoms.push(ctx.createGeometry(box([1 + u * 0.1, 1, 1])));
    const first = ctx.allocObjectIds(n);
    const root = ctx.hierarchy.addNode(-1, 'grid');
    const T = (i: number) => {
      const m = new Float64Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      m[12] = x0 + (i % 100) * 2;
      m[14] = Math.floor(i / 100) * 2;
      return m;
    };
    if (ctx.options.bulk) {
      for (let u = 0; u < unique; u++) {
        const idx: number[] = [];
        for (let i = u; i < n; i += unique) idx.push(i);
        const tr = new Float64Array(idx.length * 16);
        const ids = new Float64Array(idx.length);
        idx.forEach((i, k) => {
          tr.set(T(i), k * 16);
          ids[k] = first + i;
        });
        ctx.addMeshes({ geometry: geoms[u], material: mats[u % 2], transforms: tr, objectIds: ids });
        await ctx.yieldIfNeeded();
      }
    } else {
      for (let i = 0; i < n; i++) {
        ctx.addMesh({ geometry: geoms[i % unique], material: mats[i % 2], transform: T(i), objectId: first + i });
        ctx.hierarchy.addNode(root, `part ${i}`, first + i);
        if ((i & 15) === 15) {
          ctx.options.trace?.push(ctx.options.tag ?? '?');
          await ctx.yield();
        }
      }
    }
  },
};

const OBJ = `o Plate
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
f 1 2 3 4
o Post
v 0 0 0
v 0.1 0 0
v 0.1 2 0
f 5 6 7
`;

let hv: HeadlessViewer | null = null;
afterEach(() => {
  hv?.dispose();
  hv = null;
});

function setup(up: 'y' | 'z' = 'y'): Viewer {
  hv = createHeadlessViewer({ up, loaders: [gridPlugin, objLoader] });
  return hv.viewer;
}

const input = () => new Uint8Array(1);

function snapshot(v: Viewer) {
  hv!.frame();
  const sc = v.scene;
  return {
    meshes: sc.meshCount,
    fragmentSlots: sc.fragments.highWater,
    geometries: sc.geometries.liveCount,
    geometryBytes: sc.geometries.liveBytes,
    geometryHandles: v.geometryHandleCount,
    materialSlots: sc.materials.slotCount,
    materialHighWater: sc.materials.count,
    items: sc.items.liveCount,
    pageGpuBytes: sc.pages.gpuBytes,
    gpuBytes: hv!.gpuBytes(),
  };
}

describe('Viewer.load: registry wiring', () => {
  it('uses the viewer registry; an empty registry gives the helpful error', async () => {
    hv = createHeadlessViewer({ loaders: [] });
    await expect(hv.viewer.load(input(), { name: 'x.grid' })).rejects.toThrow(/No loader plugin recognizes "x\.grid".*registerLoader/);
    hv.viewer.registerLoader(gridPlugin);
    const m = await hv.viewer.load(input(), { name: 'x.grid', options: { n: 10 } });
    expect(m.stats.meshes).toBe(10);
    expect(hv.viewer.models).toEqual([m]);
  });

  it('falls back to the shared default registry when the viewer has none', async () => {
    hv = createHeadlessViewer();
    const { defaultRegistry } = await import('./loaders');
    const off = defaultRegistry.register(gridPlugin);
    try {
      const m = await hv.viewer.load(input(), { name: 'a.grid', options: { n: 3 } });
      expect(m.loader).toBe('grid');
      // registerLoader adds on top of the default registry (both visible)
      hv.viewer.registerLoader(objLoader);
      expect(hv.viewer.loaderRegistry.list().map((p) => p.name)).toEqual(['grid', 'obj']);
    } finally {
      off();
    }
  });
});

describe('load / unload cycles on the real core Scene', () => {
  it('do not grow memory or slot counts', async () => {
    const v = setup();
    const base = snapshot(v);
    const cycle = async () => {
      const a = await v.load(input(), { name: 'a.grid', options: { n: 600, unique: 6 } });
      const b = await v.load(new TextEncoder().encode(OBJ), { name: 'b.obj' });
      // bulk adds (addMeshes) need consecutive MeshIds: recycled slot runs must be found
      const c = await v.load(input(), { name: 'c.grid', options: { n: 300, unique: 3, bulk: true, x0: 50 } });
      const loaded = snapshot(v);
      a.unload();
      b.unload();
      c.unload();
      return { loaded, after: snapshot(v) };
    };
    const c1 = await cycle();
    expect(c1.loaded.meshes).toBe(902);
    expect(c1.loaded.materialSlots).toBe(base.materialSlots + 5);
    expect(c1.after).toMatchObject({ meshes: 0, geometries: 0, geometryBytes: 0, items: 0, materialSlots: base.materialSlots });
    expect(c1.after.geometryHandles).toBe(base.geometryHandles);
    let last = c1;
    for (let i = 0; i < 5; i++) last = await cycle();
    expect(last.loaded).toEqual(c1.loaded);
    expect(last.after).toEqual(c1.after);
    expect(v.scene.materials.count).toBe(c1.loaded.materialHighWater); // slots reused, not appended
    expect(v.models.length).toBe(0);
  });

  it('abort leaves the scene clean and releases materials', async () => {
    const v = setup();
    const base = snapshot(v);
    const task = v.load(input(), { name: 'a.grid', options: { n: 2000 } });
    await new Promise((r) => setTimeout(r, 5));
    task.abort();
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(snapshot(v)).toMatchObject({ meshes: 0, geometries: 0, materialSlots: base.materialSlots, items: 0 });
  });
});

describe('federation', () => {
  it('shares geometry between models; unloading one keeps the other intact', async () => {
    const v = setup();
    const a = await v.load(input(), { name: 'a.grid', options: { n: 400, unique: 8 } });
    const one = snapshot(v);
    const b = await v.load(input(), { name: 'b.grid', options: { n: 400, unique: 8, x0: 1000 } });
    const two = snapshot(v);
    expect(two.meshes).toBe(800);
    expect(two.geometries).toBe(one.geometries); // deduplicated by content hash
    expect(two.geometryBytes).toBe(one.geometryBytes);
    a.unload();
    const left = snapshot(v);
    expect(left.meshes).toBe(400);
    expect(left.geometries).toBe(one.geometries); // still used by b
    expect(v.getBounds(b.objectIdRange)).not.toBeNull();
    expect(v.getBounds(a.objectIdRange)).toBeNull();
    expect(v.models).toEqual([b]);
    b.unload();
    expect(snapshot(v)).toMatchObject({ meshes: 0, geometries: 0, items: 0 });
  });

  it('models own disjoint objectId ranges: getModelOf, groupByModel, events', async () => {
    const v = setup();
    const events: string[] = [];
    v.on('modelLoaded', (m) => events.push(`loaded ${m.name}`));
    v.on('modelUnloaded', (m) => events.push(`unloaded ${m.name}`));
    const a = await v.load(input(), { name: 'a.grid', options: { n: 50 } });
    const b = await v.load(new TextEncoder().encode(OBJ), { name: 'b.obj' });
    const ra = a.objectIdRange, rb = b.objectIdRange;
    expect(ra.first + ra.count).toBeLessThanOrEqual(rb.first);
    expect(v.getModelOf(ra.first)).toBe(a);
    expect(v.getModelOf(ra.first + ra.count - 1)).toBe(a);
    expect(v.getModelOf(rb.first)).toBe(b);
    expect(v.getModelOf(rb.first + rb.count)).toBeUndefined();
    expect(v.getModelOf(0)).toBeUndefined();
    const g = v.groupByModel([ra.first, rb.first, ra.first + 1, 7]);
    expect(g.get(a)).toEqual([ra.first, ra.first + 1]);
    expect(g.get(b)).toEqual([rb.first]);
    expect(g.get(null)).toEqual([7]);
    expect(a.containsObject(ra.first + 3)).toBe(true);
    a.unload();
    expect(v.getModelOf(ra.first)).toBeUndefined();
    v.clear();
    expect(events).toEqual(['loaded a.grid', 'loaded b.obj', 'unloaded a.grid', 'unloaded b.obj']);
    expect(b.unloaded).toBe(true);
  });

  it('per-model visibility / isolate / bounds leave other models untouched', async () => {
    const v = setup();
    const a = await v.load(input(), { name: 'a.grid', options: { n: 300 } });
    const b = await v.load(input(), { name: 'b.grid', options: { n: 300, x0: 500 } });
    const fr = v.scene.fragments;
    const visibleOf = (m: Model) => Array.from(m.meshIds()).filter((f) => fr.flags[f] & 1).length;
    const ghostOf = (m: Model) => Array.from(m.meshIds()).filter((f) => fr.flags[f] & 4).length;
    a.setVisible(false);
    expect([visibleOf(a), visibleOf(b)]).toEqual([0, 300]);
    expect(a.visible).toBe(false);
    a.setVisible(true);
    b.isolate();
    expect([ghostOf(a), ghostOf(b), visibleOf(b)]).toEqual([300, 0, 300]);
    b.isolate(true);
    expect([visibleOf(a), ghostOf(a), visibleOf(b)]).toEqual([0, 0, 300]);
    v.showAll();
    const ba = a.getBounds()!, bb = b.getBounds()!;
    expect(ba[3]).toBeLessThan(bb[0]);
    expect(bb[0]).toBeCloseTo(500 - 0.5, 4);
    // fitToView(model) frames that model only
    b.fitToView();
    const cam = v.getCamera();
    expect(cam.target[0]).toBeCloseTo((bb[0] + bb[3]) / 2, 3);
  });

  it('concurrent loads interleave slice by slice; aborting one leaves the others untouched', async () => {
    const v = setup();
    const trace: string[] = [];
    const ta = v.load(input(), { name: 'a.grid', options: { n: 320, trace, tag: 'a' } });
    const tb = v.load(input(), { name: 'b.grid', options: { n: 320, trace, tag: 'b', x0: 300 } });
    const tc = v.load(input(), { name: 'c.grid', options: { n: 320, trace, tag: 'c', x0: 600 } });
    // let them run a while, then abort b
    while (trace.filter((t) => t === 'b').length < 5) await new Promise((r) => setTimeout(r, 0));
    tb.abort();
    const [a, c] = await Promise.all([ta, tc]);
    await expect(tb).rejects.toMatchObject({ name: 'AbortError' });
    // round-robin: the first 15 slices alternate a, b, c
    expect(trace.slice(0, 15).join('')).toBe('abcabcabcabcabc');
    expect(snapshot(v).meshes).toBe(640);
    expect(v.models.map((m) => m.name).sort()).toEqual(['a.grid', 'c.grid']);
    expect(a.stats.meshes + c.stats.meshes).toBe(640);
  });

  it('placement composes in float64 with the up conversion and the scene origin (georeferenced, metres apart)', async () => {
    const v = setup('z');
    const E = 4.5e6, N = 7.2e6, H = 120.25; // ~1e6..1e7 from world 0
    const place = (dx: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, E + dx, N, H, 1];
    const a = await v.load(new TextEncoder().encode(OBJ), { name: 'a.obj', transform: place(0) });
    const b = await v.load(new TextEncoder().encode(OBJ), { name: 'b.obj', transform: place(3.125) });
    // OBJ is Y-up: the 2 m tall post must stand along +Z, placed at the georeference
    const ba = a.getBounds()!, bb = b.getBounds()!;
    expect(ba[5] - ba[2]).toBeCloseTo(2, 4);
    expect(ba[0]).toBeCloseTo(E, 4);
    expect(ba[1]).toBeCloseTo(N, 4);
    expect(ba[2]).toBeCloseTo(H, 4);
    for (let i = 0; i < 6; i++) expect(bb[i] - ba[i]).toBeCloseTo(i % 3 === 0 ? 3.125 : 0, 5);
    // per-mesh world matrices read back exactly (float64 path through the float32 core)
    const ma = v.getTransforms(a.meshIds()[0], 1), mb = v.getTransforms(b.meshIds()[0], 1);
    expect(mb[12] - ma[12]).toBeCloseTo(3.125, 6);
    expect(mb[13] - ma[13]).toBeCloseTo(0, 6);
    expect(ma[12]).toBeCloseTo(E, 5);
    // model.bounds (float64 at load time) agree with the scene
    for (let i = 0; i < 6; i++) expect(a.bounds![i]).toBeCloseTo(ba[i], 4);
  });

  it('a second model far from the scene origin is placed within ulp(distance)/2 (documented limit)', async () => {
    const v = setup();
    await v.load(new TextEncoder().encode(OBJ), { name: 'a.obj' }); // fixes the origin near 0
    for (const d of [1e4, 1e5, 5e5]) {
      const x = d + 0.0123456;
      const m = await v.load(new TextEncoder().encode(OBJ), { name: `far${d}.obj`, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1] });
      const t = v.getTransforms(m.meshIds()[0], 1);
      const err = Math.abs(t[12] - x);
      const ulp = 2 ** (Math.floor(Math.log2(d)) - 23);
      expect(err).toBeLessThanOrEqual(ulp / 2 + 1e-9);
    }
  });

  it('model.setTransform re-places in bulk, exactly, without drift, and keeps item bounds tight', async () => {
    const v = setup();
    const a = await v.load(input(), { name: 'a.grid', options: { n: 2000, unique: 3, bulk: true } });
    const b = await v.load(input(), { name: 'b.grid', options: { n: 200, x0: -1000 } });
    hv!.frame();
    const b0 = a.getBounds()!;
    const bOther = b.getBounds()!;
    const move = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
    a.setTransform(move(5000));
    hv!.frame();
    // a and b were batched in the same flush, but each model has its own batch group: no draw item
    // holds meshes of both, so nothing had to be split
    expect(v.scene.batcher.lastSplitCount).toBe(0);
    const owner = new Map<number, string>();
    for (const [m, tag] of [[a, 'a'], [b, 'b']] as const) {
      for (const f of m.meshIds()) {
        const it = v.scene.fragments.item[f];
        expect(owner.get(it) ?? tag).toBe(tag);
        owner.set(it, tag);
      }
    }
    const b1 = a.getBounds()!;
    for (let i = 0; i < 6; i++) expect(b1[i] - b0[i]).toBeCloseTo(i % 3 === 0 ? 5000 : 0, 3);
    expect(Array.from(a.transform)).toEqual(move(5000));
    expect(a.bounds![0] - b0[0]).toBeCloseTo(5000, 3);
    // the other model did not move
    expect(Array.from(b.getBounds()!)).toEqual(Array.from(bOther));
    // draw items of model a were refitted exactly: no item spans the old and the new place
    const items = v.scene.items;
    const fr = v.scene.fragments;
    const seen = new Set<number>();
    for (const f of a.meshIds()) seen.add(fr.item[f]);
    for (const it of seen) {
      expect(it).toBeGreaterThanOrEqual(0);
      expect(items.bounds[it * 6]).toBeGreaterThan(5000 - 10);
    }
    // the BVH root covers both models but nothing beyond
    const root = new Float32Array(6);
    v.scene.getDrawBounds(root);
    expect(root[3]).toBeLessThan(b1[3] + 1);
    // many moves back and forth: no accumulated error
    for (let k = 0; k < 50; k++) a.setTransform(move(k * 37.7));
    a.setTransform(move(0));
    hv!.frame();
    const b2 = a.getBounds()!;
    for (let i = 0; i < 6; i++) expect(b2[i]).toBeCloseTo(b0[i], 4);
  });

  it('re-places a 40k-mesh model in a few ms (bulk path)', async () => {
    const v = setup();
    const a = await v.load(input(), { name: 'big.grid', options: { n: 40000, unique: 50, bulk: true } });
    hv!.frame();
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 123, 0, 45, 1];
    a.setTransform(m); // first call also captures the base matrices
    const t0 = performance.now();
    a.setTransform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 250, 0, 0, 1]);
    const t1 = performance.now();
    const itemsBefore = v.scene.items.liveCount;
    const structure = v.scene.batcher.structureVersion;
    hv!.frame();
    const t2 = performance.now();
    console.log(`[federation] setTransform 40k meshes: ${(t1 - t0).toFixed(1)} ms, refit+flush ${(t2 - t1).toFixed(1)} ms, ${v.scene.batcher.lastRefitCount} items refitted of ${itemsBefore}`);
    expect(v.scene.items.liveCount).toBe(itemsBefore); // no re-batching
    expect(v.scene.batcher.structureVersion).toBe(structure + 1); // one BVH rebuild
    expect(t1 - t0).toBeLessThan(250); // generous for slow CI; typically a few ms
  });

  it('auto-fits the first model only (and not with fitToView: false)', async () => {
    const v = setup();
    const c0 = v.getCamera();
    await v.load(input(), { name: 'a.grid', options: { n: 100 } });
    const c1 = v.getCamera();
    expect(c1.target).not.toEqual(c0.target);
    await v.load(input(), { name: 'b.grid', options: { n: 100, x0: 5000 } });
    expect(v.getCamera()).toEqual(c1);
    v.clear();
    const c2 = v.getCamera();
    await v.load(input(), { name: 'c.grid', options: { n: 100, x0: 99 } , fitToView: false });
    expect(v.getCamera()).toEqual(c2);
  });
});

describe('materials', () => {
  it('releaseMaterial: in-use materials keep rendering; the slot is reused only once unused', () => {
    const v = setup();
    const g = v.primitives.box();
    const m1 = v.createMaterial({ color: [1, 0, 0] });
    const mesh = v.addMesh({ geometry: g, material: m1 });
    v.releaseMaterial(m1);
    expect(() => v.addMesh({ geometry: g, material: m1 })).toThrow(/invalid material/);
    expect(() => v.updateMaterial(m1, { color: [0, 1, 0] })).toThrow(/invalid material/);
    const m2 = v.createMaterial();
    expect(m2).not.toBe(m1); // slot still referenced by the mesh
    v.remove(mesh);
    const m3 = v.createMaterial();
    expect(m3).toBe(m1); // recycled
    // setMaterial moves the use count
    const mesh2 = v.addMesh({ geometry: g, material: m2 });
    v.releaseMaterial(m2);
    v.setMaterial(mesh2, m3);
    expect(v.createMaterial()).toBe(m2);
  });
});

describe('geometry handles', () => {
  it('getGeometryBounds is O(1) and handles are recycled only when unused', () => {
    const v = setup();
    const pos = [10, 20, 30, 11, 20, 30, 10, 25, 31];
    const g = v.createGeometry({ positions: pos });
    expect(Array.from(v.getGeometryBounds(g)!)).toEqual([10, 20, 30, 11, 25, 31]);
    const mat = v.createMaterial();
    const mesh = v.addMesh({ geometry: g, material: mat, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] });
    v.releaseGeometry(g);
    expect(v.getGeometryBounds(g)).toBeNull();
    const g2 = v.createGeometry({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] });
    expect(g2).not.toBe(g); // g is still used by a mesh: its offset must stay valid
    // the mesh still reports its world transform through the released handle's offset
    expect(v.getTransforms(mesh, 1)[12]).toBeCloseTo(5, 6);
    v.remove(mesh);
    expect(v.createGeometry({ positions: [0, 0, 0, 2, 0, 0, 0, 2, 0] })).toBe(g);
  });
});

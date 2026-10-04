import { describe, expect, it } from 'vitest';
import { DrawList } from './DrawBVH';
import { ITEM_INSTANCED, ITEM_MERGED } from './DrawItems';
import { Scene } from './Scene';
import { boxGeometry, perspectiveView, randomMesh, rng, trs } from './testkit';
import { now } from './util';

/**
 * Benchmark-style test: 1,000,000 instanced boxes + 200,000 unique small meshes.
 * Only generous upper bounds are asserted; timings are logged with the [bench] prefix.
 */
describe('scale benchmark', () => {
  it('1M instanced boxes + 200k unique meshes', () => {
    const r = rng(2024);
    const log = (label: string, ms: number, extra = '') =>
      console.log(`[bench] ${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms ${extra}`);
    const s = new Scene();
    const mat = s.createMaterial();
    const glass = s.createMaterial({ color: [0.5, 0.7, 1, 0.4] });
    const box = s.createGeometry(boxGeometry());

    const N = 1_000_000;
    const t = new Float32Array(16 * N);
    for (let i = 0; i < N; i++) trs(r() * 2000, r() * 200, r() * 2000, 0.3 + r(), t, i * 16);
    let t0 = now();
    const first = s.addMeshes(box, mat, t);
    const tAdd = now() - t0;
    log('addMeshes 1M instances', tAdd);
    expect(first).toBe(0);

    const U = 200_000;
    const meshes = new Array(U);
    for (let i = 0; i < U; i++) meshes[i] = randomMesh(r, 0.2 + r() * 2);
    t0 = now();
    const geoms = new Int32Array(U);
    for (let i = 0; i < U; i++) geoms[i] = s.createGeometry(meshes[i]);
    const tGeom = now() - t0;
    log('createGeometry 200k unique', tGeom);
    meshes.length = 0;
    t0 = now();
    const m = new Float32Array(16);
    for (let i = 0; i < U; i++) {
      trs(r() * 2000, r() * 200, r() * 2000, 1, m);
      s.addMesh(geoms[i], i % 50 === 0 ? glass : mat, m);
    }
    const tAddU = now() - t0;
    log('addMesh 200k (one call each)', tAddU);

    t0 = now();
    const created = s.flush();
    const tFlush = now() - t0;
    let merged = 0;
    let inst = 0;
    for (let i = 0; i < s.items.highWater; i++) {
      if (s.items.kind[i] === ITEM_MERGED) merged++;
      else if (s.items.kind[i] === ITEM_INSTANCED) inst++;
    }
    log('flush (batching)', tFlush, `${created} items: ${merged} merged, ${inst} instanced`);
    expect(s.meshCount).toBe(N + U);
    expect(s.triangleCount).toBe((N + U) * 12);

    t0 = now();
    s.updateBvh();
    const tBvh = now() - t0;
    log('BVH build', tBvh, `${s.bvh.nodeCount} nodes`);

    const list = new DrawList();
    const views = [
      perspectiveView([-300, 400, -300], [1000, 0, 1000], 0.9, 16 / 9, 0.5, 1e4, 1080, 2),
      perspectiveView([1000, 100, 1000], [1500, 50, 1200], 0.9, 16 / 9, 0.5, 1e4, 1080, 2),
      perspectiveView([1000, 3000, 1000], [1000, 0, 1000], 0.9, 16 / 9, 0.5, 1e4, 1080, 0.5),
    ];
    for (let v = 0; v < views.length; v++) {
      s.traverse(views[v], list); // warm-up
      const runs = 20;
      t0 = now();
      for (let k = 0; k < runs; k++) s.traverse(views[v], list);
      const tTrav = (now() - t0) / runs;
      log(`traverse view ${v}`, tTrav,
        `${list.opaqueCount} opaque + ${list.transparentCount} transparent items, ${(list.triangles / 1e6).toFixed(2)}M of ${(s.triangleCount / 1e6).toFixed(2)}M tris`);
      expect(tTrav).toBeLessThan(100);
    }

    const ids = new Int32Array(100_000);
    for (let i = 0; i < ids.length; i++) ids[i] = (r() * (N + U)) | 0;
    t0 = now();
    s.remove(ids);
    const tRemove = now() - t0;
    log('remove 100k random', tRemove);
    t0 = now();
    s.setVisible(ids.subarray(0, 50_000).map((x) => x + 1), false);
    log('setVisible 50k objectIds', now() - t0);
    t0 = now();
    s.compact(1e9);
    log('compact (unbounded budget)', now() - t0, `${s.items.liveCount} items`);
    t0 = now();
    s.compact(2);
    log('compact (2 ms budget, nothing to do)', now() - t0);

    console.log(
      `[bench] memory: pages ${(s.pages.gpuBytes / 2 ** 20).toFixed(1)} MB GPU / ${(s.pages.cpuBytes / 2 ** 20).toFixed(1)} MB CPU, ` +
      `geometry store ${(s.geometries.liveBytes / 2 ** 20).toFixed(1)} MB, fragment records ${(s.fragments.records.byteLength / 2 ** 20).toFixed(1)} MB (capacity ${s.fragments.capacity})`,
    );

    expect(tAdd).toBeLessThan(5000);
    expect(tGeom).toBeLessThan(20000);
    expect(tAddU).toBeLessThan(5000);
    expect(tFlush).toBeLessThan(10000);
    expect(tBvh).toBeLessThan(500);
    expect(tRemove).toBeLessThan(2000);
  }, 180_000);
});

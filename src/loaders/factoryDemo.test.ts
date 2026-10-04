/**
 * Integration: loads the real TestModels/FactoryDemo.glb (262 MB, not in git) through the public
 * `loadModel` path with the recording mock viewer, and cross-checks the counts against the file's JSON.
 * Skips when the file is absent.
 */
import { describe, expect, it } from 'vitest';
import { createMockViewer } from './__tests__/mockViewer';
import { LoaderRegistry, loadModel, registerDefaultLoaders } from './index';

// node builtins without @types/node
const nodeRequire = (globalThis as any).process?.getBuiltinModule as ((id: string) => any) | undefined;
const fs = nodeRequire?.('node:fs');
const pathMod = nodeRequire?.('node:path');
const proc = (globalThis as any).process;
const FILE = fs && pathMod ? pathMod.resolve(proc.cwd(), 'TestModels/FactoryDemo.glb') : '';
const present = !!fs && fs.existsSync(FILE);

const mb = (n: number) => (n / 1048576).toFixed(1) + ' MB';

/** Expected counts straight from the JSON chunk (independent of the loader). */
function expectedFromJson() {
  const fd = fs.openSync(FILE, 'r');
  const head = new Uint8Array(20);
  fs.readSync(fd, head, 0, 20, 0);
  const jl = new DataView(head.buffer).getUint32(12, true);
  const jb = new Uint8Array(jl);
  fs.readSync(fd, jb, 0, jl, 20);
  fs.closeSync(fd);
  const j = JSON.parse(new TextDecoder().decode(jb));
  let pairs = 0, triangles = 0, meshNodes = 0;
  const geoms = new Set<string>();
  const mats = new Set<number>();
  const stack = [...j.scenes[j.scene ?? 0].nodes];
  while (stack.length) {
    const n = j.nodes[stack.pop()];
    if (n.mesh !== undefined) {
      meshNodes++;
      for (const p of j.meshes[n.mesh].primitives) {
        if ((p.mode ?? 4) !== 4) continue;
        pairs++;
        triangles += j.accessors[p.attributes.POSITION].count / 3;
        geoms.add(`${p.attributes.POSITION},${p.attributes.NORMAL},${p.indices}`);
        mats.add(p.material ?? -1);
      }
    }
    if (n.children) stack.push(...n.children);
  }
  return { pairs, triangles, meshNodes, geometries: geoms.size, materials: mats.size, nodes: j.nodes.length };
}

describe.skipIf(!present)('FactoryDemo.glb integration', () => {
  it(
    'loads through loadModel with the mock viewer',
    async () => {
      const expected = expectedFromJson();
      (globalThis as any).gc?.();
      const before = proc.memoryUsage();
      let peakRss = before.rss, peakAb = before.arrayBuffers;
      const sample = () => {
        const m = proc.memoryUsage();
        peakRss = Math.max(peakRss, m.rss);
        peakAb = Math.max(peakAb, m.arrayBuffers);
      };
      const stages = new Map<string, number>();
      const v = createMockViewer();
      const registry = registerDefaultLoaders(new LoaderRegistry());
      const t0 = performance.now();
      // Uint8Array input (Node's file-backed Blob keeps an internal second copy, which would blur the
      // numbers). The test drops its own reference right away, so after the load only what the loader
      // retains stays reachable.
      let buf: Uint8Array | null = fs.readFileSync(FILE);
      const fileSize = buf!.byteLength;
      const task = loadModel(v, buf!, {
        registry,
        name: 'FactoryDemo.glb',
        up: 'z',
        onProgress: (p) => {
          if (!stages.has(p.stage)) stages.set(p.stage, performance.now() - t0);
          sample();
        },
      });
      buf = null;
      const model = await task;
      const total = performance.now() - t0;
      sample();
      // let pending macrotasks finish, then collect (only effective with --expose-gc)
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 10));
        (globalThis as any).gc?.();
      }
      const after = proc.memoryUsage();

      const names: string[] = [];
      const h = model.hierarchy;
      const roots = h.roots();
      for (const r of roots) names.push(h.name(r)!);
      let n = roots[0];
      for (let d = 0; d < 4; d++) {
        const ch = h.children(n);
        if (!ch.length) break;
        n = ch[0];
        names.push(h.name(n)!);
      }
      const someObject = model.objectIds()[1000];

      console.log(
        [
          `FactoryDemo.glb: ${mb(fileSize)}, total ${total.toFixed(0)} ms (model.stats.loadMs ${model.stats.loadMs.toFixed(0)})`,
          `  stage start times (ms): ${[...stages].map(([s, t]) => `${s}@${t.toFixed(0)}`).join(', ')}`,
          `  geometries created ${v.calls.createGeometry}, meshes ${model.stats.meshes} (addMesh ${v.calls.addMesh} + addMeshes ${v.calls.addMeshes} calls), materials ${v.materials.length}`,
          `  triangles ${model.stats.triangles}, objects ${model.stats.objects}, hierarchy nodes ${model.stats.nodes}`,
          `  bounds ${Array.from(model.bounds!).map((x) => x.toFixed(3)).join(', ')}`,
          `  info ${JSON.stringify(model.info)}`,
          `  warnings ${JSON.stringify(model.warnings)}`,
          `  names: ${names.join(' / ')}`,
          `  properties(${someObject}): ${JSON.stringify(model.getProperties(someObject))}`,
          `  memory before: rss ${mb(before.rss)}, heap ${mb(before.heapUsed)}, arrayBuffers ${mb(before.arrayBuffers)}`,
          `  memory peak (sampled at progress): rss ${mb(peakRss)}, arrayBuffers ${mb(peakAb)}`,
          `  memory after${(globalThis as any).gc ? ' (gc)' : ''}: rss ${mb(after.rss)}, heap ${mb(after.heapUsed)}, arrayBuffers ${mb(after.arrayBuffers)}`,
          `  expected from JSON: ${JSON.stringify(expected)}`,
        ].join('\n'),
      );

      expect(model.stats.meshes).toBe(expected.pairs);
      expect(v.calls.createGeometry).toBe(expected.geometries);
      expect(v.materials.length).toBe(expected.materials);
      expect(model.stats.triangles).toBe(Math.round(expected.triangles));
      expect(model.stats.objects).toBe(expected.meshNodes);
      expect(model.stats.nodes).toBe(expected.nodes);
      expect(v.liveMeshes()).toBe(expected.pairs);
      expect(names[0]).toMatch(/\.nwc$/);
      expect(model.warnings.some((w) => /line primitive/.test(w))).toBe(true);
      expect(model.info.copiedAccessors).toBe(0);

      model.unload();
      expect(v.liveMeshes()).toBe(0);
      expect(v.liveGeometries()).toBe(0);
    },
    300_000,
  );
});

import { describe, expect, it } from 'vitest';
import { createMockViewer } from './__tests__/mockViewer';
import {
  DEFAULT_OBJECT_ID_BASE,
  defaultRegistry,
  gltfLoader,
  isAbortError,
  LoaderError,
  LoaderRegistry,
  loadModel,
  objLoader,
  registerDefaultLoaders,
  type LoadContext,
  type LoaderPlugin,
  type LoadProgress,
} from './index';

const TRI = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

/** A synthetic format: header 'BOXES', adds `count` meshes, yielding between them. */
function boxesPlugin(extra: Partial<LoaderPlugin<{ count: number }>> = {}): LoaderPlugin<{ count: number }> {
  return {
    name: 'boxes',
    extensions: ['boxes'],
    mimeTypes: ['application/x-boxes'],
    canLoad: ({ header }) => new TextDecoder().decode(header.subarray(0, 5)) === 'BOXES',
    async load(source, ctx: LoadContext<{ count: number }>) {
      await source.bytes();
      const g = ctx.createGeometry({ positions: TRI });
      const m = ctx.createMaterial({ color: [1, 0, 0] });
      const n = ctx.options.count ?? 10;
      for (let i = 0; i < n; i++) {
        ctx.addMesh({ geometry: g, material: m, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i, 0, 0, 1] });
        ctx.progress((i + 1) / n, 'boxes');
        await ctx.yieldIfNeeded();
      }
    },
    ...extra,
  };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('LoaderRegistry', () => {
  it('detects by extension, then mime type, then header', () => {
    const r = new LoaderRegistry();
    const p = boxesPlugin();
    r.register(p);
    expect(r.detect({ fileName: 'a/b/c.BOXES' })).toBe(p);
    expect(r.detect({ fileName: 'x.bin', mimeType: 'application/x-boxes; q=1' })).toBe(p);
    expect(r.detect({ fileName: 'x.bin', header: bytes('BOXES...') })).toBe(p);
    expect(r.detect({ fileName: 'x.bin', header: bytes('nope') })).toBeUndefined();
    expect(r.detect({ fileName: 'https://h/x.boxes?token=1' })).toBe(p);
  });

  it('later registration wins; canLoad disambiguates shared extensions; unregister', () => {
    const r = new LoaderRegistry();
    const a = boxesPlugin({ name: 'a', canLoad: ({ header }) => header[0] === 65 });
    const b = boxesPlugin({ name: 'b', canLoad: ({ header }) => header[0] === 66 });
    r.register(a);
    r.register(b);
    expect(r.detect({ fileName: 'f.boxes' })).toBe(b);
    expect(r.detect({ fileName: 'f.boxes', header: bytes('A') })).toBe(a);
    expect(r.detect({ fileName: 'f.boxes', header: bytes('B') })).toBe(b);
    expect(r.unregister('b')).toBe(true);
    expect(r.detect({ fileName: 'f.boxes' })).toBe(a);
    expect(r.list().map((p) => p.name)).toEqual(['a']);
    // same name replaces
    const a2 = boxesPlugin({ name: 'a' });
    const off = r.register(a2);
    expect(r.list()).toEqual([a2]);
    off();
    expect(r.list()).toEqual([]);
  });

  it('prefers the longest matching extension', () => {
    const r = new LoaderRegistry();
    const plain = boxesPlugin({ name: 'ifc', extensions: ['ifc', 'gz'] });
    const gz = boxesPlugin({ name: 'ifcgz', extensions: ['ifc.gz'] });
    r.register(gz);
    r.register(plain);
    expect(r.detect({ fileName: 'model.ifc.gz' })?.name).toBe('ifcgz');
  });

  it('registerDefaultLoaders registers gltf and obj explicitly', () => {
    const r = registerDefaultLoaders(new LoaderRegistry());
    expect(r.detect({ fileName: 'a.glb' })).toBe(gltfLoader);
    expect(r.detect({ fileName: 'a.gltf' })).toBe(gltfLoader);
    expect(r.detect({ fileName: 'a.obj' })).toBe(objLoader);
    expect(r.detect({ fileName: 'noext', header: bytes('glTF\x02\0\0\0') })).toBe(gltfLoader);
    expect(r.detect({ fileName: 'noext', header: bytes('{"asset":{"version":"2.0"}}') })).toBe(gltfLoader);
    expect(r.detect({ fileName: 'noext', header: bytes('# comment\nv 1 2 3\n') })).toBe(objLoader);
    expect(defaultRegistry.list().length).toBe(0); // nothing registered implicitly
  });
});

describe('loadModel', () => {
  it('loads through the registry and reports model stats, bounds and progress', async () => {
    const v = createMockViewer();
    const r = new LoaderRegistry();
    r.register(boxesPlugin());
    const events: LoadProgress[] = [];
    const task = loadModel(v, bytes('BOXES'), { registry: r, name: 'x.boxes', options: { count: 5 } });
    task.onProgress((p) => events.push(p));
    const model = await task;
    expect(model.loader).toBe('boxes');
    expect(model.name).toBe('x.boxes');
    expect(model.stats.meshes).toBe(5);
    expect(model.stats.triangles).toBe(5);
    expect(model.stats.geometries).toBe(1);
    expect(model.stats.materials).toBe(1);
    expect(model.stats.objects).toBe(5);
    expect(Array.from(model.bounds!)).toEqual([0, 0, 0, 5, 1, 0]);
    expect(model.meshIds().length).toBe(5);
    expect(events.length).toBeGreaterThan(1);
    for (let i = 1; i < events.length; i++) expect(events[i].fraction).toBeGreaterThanOrEqual(events[i - 1].fraction);
    expect(events[events.length - 1]).toMatchObject({ fraction: 1, stage: 'done' });
    expect(task.progress).toBe(1);
  });

  it('detects from header bytes when there is no usable name', async () => {
    const v = createMockViewer();
    const r = new LoaderRegistry();
    r.register(boxesPlugin());
    const model = await loadModel(v, new Blob([bytes('BOXES')]), { registry: r, options: { count: 1 } });
    expect(model.loader).toBe('boxes');
  });

  it('allocates scene-unique objectIds across models (never MeshIds)', async () => {
    const v = createMockViewer();
    const r = new LoaderRegistry();
    r.register(boxesPlugin());
    const [a, b] = await Promise.all([
      loadModel(v, bytes('BOXES'), { registry: r, options: { count: 3 } }),
      loadModel(v, bytes('BOXES'), { registry: r, options: { count: 3 } }),
    ]);
    const ids = [...a.objectIds(), ...b.objectIds()];
    expect(new Set(ids).size).toBe(6);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(DEFAULT_OBJECT_ID_BASE);
    expect(v.meshes.map((m) => m.objectId).sort()).toEqual(ids.slice().sort());
  });

  it('unknown format lists registered plugins', async () => {
    const r = registerDefaultLoaders(new LoaderRegistry());
    const err = await loadModel(createMockViewer(), bytes('garbage'), { registry: r, name: 'f.xyz' }).catch((e) => e);
    expect(err).toBeInstanceOf(LoaderError);
    expect(err.message).toMatch(/No loader plugin recognizes "f\.xyz"/);
    expect(err.message).toMatch(/gltf \(\.glb, \.gltf\)/);
    expect(err.message).toMatch(/obj \(\.obj\)/);
  });

  it('wraps plugin failures with the plugin name and cleans up', async () => {
    const v = createMockViewer();
    const r = new LoaderRegistry();
    r.register(
      boxesPlugin({
        name: 'broken',
        async load(_s, ctx) {
          const g = ctx.createGeometry({ positions: TRI });
          ctx.addMesh({ geometry: g, material: ctx.createMaterial() });
          throw new Error('bad header');
        },
      }),
    );
    const err = await loadModel(v, bytes('BOXES'), { registry: r, name: 'm.boxes' }).catch((e) => e);
    expect(err).toBeInstanceOf(LoaderError);
    expect(err.plugin).toBe('broken');
    expect(err.message).toBe('[broken] failed to load "m.boxes": bad header');
    expect(err.cause.message).toBe('bad header');
    expect(v.liveMeshes()).toBe(0);
    expect(v.liveGeometries()).toBe(0);
  });

  it('abort mid-load rejects with AbortError and leaves the scene clean', async () => {
    const v = createMockViewer();
    const r = new LoaderRegistry();
    r.register(boxesPlugin());
    const task = loadModel(v, bytes('BOXES'), { registry: r, sliceMs: 0, options: { count: 100000 } });
    task.onProgress((p) => {
      if (p.fraction > 0.001) task.abort();
    });
    const err = await task.catch((e) => e);
    expect(isAbortError(err)).toBe(true);
    expect(v.meshes.length).toBeGreaterThan(0); // something had been added…
    expect(v.meshes.length).toBeLessThan(100000);
    expect(v.liveMeshes()).toBe(0); // …and was removed again
    expect(v.liveGeometries()).toBe(0);
  });

  it('honours an external AbortSignal, also before start', async () => {
    const r = new LoaderRegistry();
    r.register(boxesPlugin());
    const ac = new AbortController();
    ac.abort();
    const err = await loadModel(createMockViewer(), bytes('BOXES'), { registry: r, signal: ac.signal }).catch((e) => e);
    expect(isAbortError(err)).toBe(true);
  });

  it('yieldIfNeeded yields macrotasks when the slice is used up', async () => {
    const r = new LoaderRegistry();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    r.register(
      boxesPlugin({
        async load(_s, ctx) {
          const end = Date.now() + 60;
          while (Date.now() < end) await ctx.yieldIfNeeded();
        },
      }),
    );
    await loadModel(createMockViewer(), bytes('BOXES'), { registry: r, sliceMs: 2 });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(3); // timers ran while the plugin was busy
  });

  it('unload removes meshes and releases geometries; setVisible uses objectIds', async () => {
    const v = createMockViewer();
    const r = new LoaderRegistry();
    r.register(boxesPlugin());
    const model = await loadModel(v, bytes('BOXES'), { registry: r, options: { count: 4 } });
    model.setVisible(false);
    expect(v.meshes.every((m) => !m.visible)).toBe(true);
    model.unload();
    model.unload();
    expect(model.unloaded).toBe(true);
    expect(v.liveMeshes()).toBe(0);
    expect(v.liveGeometries()).toBe(0);
    expect(v.calls.remove).toBe(1); // one bulk remove
  });

  it('applies up-axis conversion and the global transform in float64', async () => {
    const v = createMockViewer();
    const r = new LoaderRegistry();
    r.register(
      boxesPlugin({
        up: 'z',
        async load(_s, ctx) {
          const g = ctx.createGeometry({ positions: TRI });
          ctx.addMesh({ geometry: g, material: ctx.createMaterial(), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1] });
        },
      }),
    );
    // Z-up file into a Y-up scene, then translate by a large georeferenced offset
    const big = 6_500_000.25;
    const model = await loadModel(v, bytes('BOXES'), {
      registry: r,
      up: 'y',
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, big, 0, 0, 1],
    });
    const t = v.meshes[0].transform;
    // (1,2,3) z-up -> (1,3,-2) y-up, then + big on x
    expect([t[12], t[13], t[14]]).toEqual([1 + big, 3, -2]);
    expect(model.bounds![0]).toBe(1 + big);
    // sourceUp override: treat as y-up -> no rotation
    const v2 = createMockViewer();
    await loadModel(v2, bytes('BOXES'), { registry: r, sourceUp: 'y' });
    expect(Array.from(v2.meshes[0].transform.subarray(12, 15))).toEqual([1, 2, 3]);
  });

  it('forced loader by name; unknown forced loader errors', async () => {
    const r = new LoaderRegistry();
    r.register(boxesPlugin());
    const m = await loadModel(createMockViewer(), bytes('whatever'), { registry: r, loader: 'boxes', name: 'a.txt' });
    expect(m.loader).toBe('boxes');
    await expect(loadModel(createMockViewer(), bytes('x'), { registry: r, loader: 'nope' })).rejects.toThrow(/not registered/);
  });

  it('stores hierarchy and properties compactly', async () => {
    const v = createMockViewer();
    const r = new LoaderRegistry();
    r.register(
      boxesPlugin({
        async load(_s, ctx) {
          const id = ctx.allocObjectIds(2);
          const root = ctx.hierarchy.addNode(-1, 'site');
          ctx.hierarchy.addNode(root, 'wall', id);
          ctx.hierarchy.addNodes([root, root], [id + 1, NaN], (i) => `lazy${i}`);
          ctx.setProperties(id, { material: 'concrete' });
          ctx.setPropertyProvider((o) => (o === id + 1 ? { level: 2 } : undefined));
        },
      }),
    );
    const m = await loadModel(v, bytes('BOXES'), { registry: r });
    const h = m.hierarchy;
    expect(h.nodeCount).toBe(4);
    expect(Array.from(h.roots())).toEqual([0]);
    expect(Array.from(h.children(0))).toEqual([1, 2, 3]);
    expect(h.name(2)).toBe('lazy0');
    expect(h.name(3)).toBe('lazy1');
    const first = m.objectIdRange.first;
    expect(h.nodeOfObject(first)).toBe(1);
    expect(m.getProperties(first)).toEqual({ name: 'wall', material: 'concrete' });
    expect(m.getProperties(first + 1)).toEqual({ name: 'lazy0', level: 2 });
    expect(m.getProperties(12345)).toBeUndefined();
  });
});

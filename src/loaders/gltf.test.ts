import { describe, expect, it } from 'vitest';
import { GltfBuilder, TRI, TRI_N, xform } from './__tests__/gltfBuilder';
import { createMockViewer, type MockViewer } from './__tests__/mockViewer';
import { toTriangleList } from './gltf/GltfLoader';
import { linearToSrgb } from './gltf/materials';
import { createGltfLoader, LoaderError, LoaderRegistry, loadModel, registerDefaultLoaders, type LoadOptions } from './index';
import type { GltfLoaderOptions } from './index';

const registry = registerDefaultLoaders(new LoaderRegistry());

function load(v: MockViewer, input: Uint8Array | string | Blob, opts: LoadOptions<GltfLoaderOptions> = {}) {
  return loadModel<GltfLoaderOptions>(v, typeof input === 'string' ? new TextEncoder().encode(input) : input, {
    registry,
    name: typeof input === 'string' ? 'test.gltf' : 'test.glb',
    ...opts,
  });
}

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-9) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps);
};

describe('glTF loader: geometry', () => {
  it('non-indexed float positions are passed as zero-copy views; normals kept', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(TRI, 'VEC3');
    const nrm = b.accessor(TRI_N, 'VEC3');
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos, NORMAL: nrm } }]) }, true);
    const v = createMockViewer({ keepData: true });
    const m = await load(v, b.glb());
    expect(v.geometries.length).toBe(1);
    const g = v.geometries[0];
    expect(g.indexed).toBe(false);
    expect(g.hasNormals).toBe(true);
    expect(g.positionsWasView).toBe(true);
    close(g.positions!, TRI);
    expect(m.stats).toMatchObject({ meshes: 1, triangles: 1, geometries: 1 });
    expect(m.info.zeroCopyAccessors).toBe(2);
    expect(m.info.copiedAccessors).toBe(0);
  });

  it.each([
    ['u8', new Uint8Array([0, 1, 2, 2, 1, 3])],
    ['u16', new Uint16Array([0, 1, 2, 2, 1, 3])],
    ['u32', new Uint32Array([0, 1, 2, 2, 1, 3])],
  ])('indexed %s', async (_n, idx) => {
    const b = new GltfBuilder();
    const pos = b.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 'VEC3');
    const ia = b.accessor(idx, 'SCALAR');
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos }, indices: ia }]) }, true);
    const v = createMockViewer({ keepData: true });
    const m = await load(v, b.glb());
    expect(Array.from(v.geometries[0].indices!)).toEqual([0, 1, 2, 2, 1, 3]);
    expect(m.stats.triangles).toBe(2);
  });

  it('interleaved (byteStride) and misaligned accessors are copied correctly', async () => {
    const b = new GltfBuilder();
    // interleaved position+normal, stride 24
    const inter = new Float32Array(18);
    for (let i = 0; i < 3; i++) {
      inter.set(TRI.subarray(i * 3, i * 3 + 3), i * 6);
      inter.set(TRI_N.subarray(i * 3, i * 3 + 3), i * 6 + 3);
    }
    const bv = b.view(new Uint8Array(inter.buffer), { stride: 24 });
    const pos = b.rawAccessor({ bufferView: bv, componentType: 5126, count: 3, type: 'VEC3' });
    const nrm = b.rawAccessor({ bufferView: bv, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC3' });
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos, NORMAL: nrm } }]) }, true);
    // misaligned u16 indices (offset 2 within buffer is aligned for u16; use pad 1 for float -> copy)
    const pos2 = b.accessor(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), 'VEC3', { pad: 1 });
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos2 } }]) }, true);
    const v = createMockViewer({ keepData: true });
    const m = await load(v, b.glb());
    close(v.geometries[0].positions!, TRI);
    close(v.geometries[0].normals!, TRI_N);
    close(v.geometries[1].positions!, [0, 0, 0, 2, 0, 0, 0, 2, 0]);
    expect(m.info.copiedAccessors).toBe(3);
  });

  it('KHR_mesh_quantization: normalized int16 positions and int8 normals', async () => {
    const b = new GltfBuilder();
    b.json.extensionsUsed = ['KHR_mesh_quantization'];
    b.json.extensionsRequired = ['KHR_mesh_quantization'];
    const pos = b.accessor(new Int16Array([0, 0, 0, 32767, 0, 0, 0, -32767, 0, 0]), 'VEC3', { normalized: true });
    // 9 used values + 1 padding element would break count; build exact
    b.json.accessors[pos].count = 3;
    const nrm = b.accessor(new Int8Array([0, 0, 127, 0, 0, 0, 127, 0, 0, 0, -127, 0]), 'VEC4', { normalized: true });
    b.json.accessors[nrm].count = 3;
    b.json.accessors[nrm].type = 'VEC3';
    // VEC3 int8 normals must be padded to 4-byte stride in quantized glTF
    b.json.bufferViews[b.json.accessors[nrm].bufferView].byteStride = 4;
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos, NORMAL: nrm } }]), scale: [2, 2, 2] }, true);
    const v = createMockViewer({ keepData: true });
    await load(v, b.glb());
    close(v.geometries[0].positions!, [0, 0, 0, 1, 0, 0, 0, -1, 0], 1e-6);
    close(v.geometries[0].normals!, [0, 0, 1, 0, 0, 1, 0, 0, -1], 1e-6);
    expect(v.meshes[0].transform[0]).toBe(2);
  });

  it('sparse accessor overrides values on top of a base (and without a bufferView)', async () => {
    const b = new GltfBuilder();
    const base = b.view(new Uint8Array(TRI.buffer.slice(0)));
    const sidx = b.view(new Uint8Array(new Uint16Array([2, 0]).buffer));
    const sval = b.view(new Uint8Array(new Float32Array([5, 5, 5, 9, 9, 9]).buffer));
    const pos = b.rawAccessor({
      bufferView: base, componentType: 5126, count: 3, type: 'VEC3',
      sparse: { count: 2, indices: { bufferView: sidx, componentType: 5123 }, values: { bufferView: sval } },
    });
    const pos2 = b.rawAccessor({
      componentType: 5126, count: 3, type: 'VEC3',
      sparse: { count: 2, indices: { bufferView: sidx, componentType: 5123 }, values: { bufferView: sval } },
    });
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos } }]) }, true);
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos2 } }]) }, true);
    const v = createMockViewer({ keepData: true });
    await load(v, b.glb());
    close(v.geometries[0].positions!, [9, 9, 9, 1, 0, 0, 5, 5, 5]);
    close(v.geometries[1].positions!, [9, 9, 9, 0, 0, 0, 5, 5, 5]);
  });

  it('triangle strip and fan are converted to lists (glTF winding)', async () => {
    // p_i = {v_i, v_(i+1+i%2), v_(i+2-i%2)}: odd triangles flip to keep the winding
    expect(Array.from(toTriangleList(undefined, 5, 5))).toEqual([0, 1, 2, 1, 3, 2, 2, 3, 4]);
    expect(Array.from(toTriangleList(undefined, 5, 6))).toEqual([1, 2, 0, 2, 3, 0, 3, 4, 0]);
    // degenerate (restart) triangles dropped
    expect(Array.from(toTriangleList([0, 1, 2, 2, 3, 4], 5, 5))).toEqual([0, 1, 2, 2, 4, 3]);
    const b = new GltfBuilder();
    const pos = b.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 'VEC3');
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos }, mode: 5 }, { attributes: { POSITION: pos }, mode: 6 }]) }, true);
    const v = createMockViewer({ keepData: true });
    const m = await load(v, b.glb());
    expect(Array.from(v.geometries[0].indices!)).toEqual([0, 1, 2, 1, 3, 2]);
    expect(Array.from(v.geometries[1].indices!)).toEqual([1, 2, 0, 2, 3, 0]);
    expect(m.stats.triangles).toBe(4);
  });

  it('skips points/lines with one warning', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(TRI, 'VEC3');
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos }, mode: 1 }, { attributes: { POSITION: pos }, mode: 0 }, { attributes: { POSITION: pos } }]) }, true);
    const warnings: string[] = [];
    const v = createMockViewer();
    const m = await load(v, b.glb(), { onWarning: (w) => warnings.push(w) });
    expect(m.stats.meshes).toBe(1);
    expect(warnings).toEqual(['Skipped 2 point/line primitive(s): only triangles are rendered']);
    expect(m.warnings).toEqual(warnings);
  });
});

describe('glTF loader: scene', () => {
  it('composes TRS / matrix hierarchies in float64', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(TRI, 'VEC3');
    const mesh = b.mesh([{ attributes: { POSITION: pos } }]);
    const s = Math.SQRT1_2;
    const big = 4_000_000.125;
    const child = b.node({ mesh, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1] });
    // parent: translate(big, 0, 0) * rotate 90deg about Z * scale 2
    b.node({ name: 'parent', translation: [big, 0, 0], rotation: [0, 0, s, s], scale: [2, 2, 2], children: [child] }, true);
    const v = createMockViewer();
    const m = await load(v, b.glb());
    const t = v.meshes[0].transform;
    expect(t).toBeInstanceOf(Float64Array);
    // local point (1,0,0) -> child (1,0,1) -> scale (2,0,2) -> rot (0,2,2) -> +big
    close(xform(t, [1, 0, 0]), [big, 2, 2], 1e-9);
    close(xform(t, [0, 1, 0]), [big - 2, 0, 2], 1e-9);
    close(m.bounds!, [big - 2, 0, 2, big, 2, 2], 1e-9);
  });

  it('reuses one geometry for a primitive used by many nodes (one addMeshes call)', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(TRI, 'VEC3');
    const mesh = b.mesh([{ attributes: { POSITION: pos } }]);
    const mesh2 = b.mesh([{ attributes: { POSITION: pos } }]); // same accessors -> same geometry
    for (let i = 0; i < 10; i++) b.node({ mesh: i % 2 ? mesh : mesh2, translation: [i, 0, 0] }, true);
    const v = createMockViewer();
    const m = await load(v, b.glb());
    expect(v.calls.createGeometry).toBe(1);
    expect(v.calls.addMeshes).toBe(1);
    expect(v.calls.addMesh).toBe(0);
    expect(m.stats.meshes).toBe(10);
    expect(v.meshes.map((x) => x.transform[12]).sort((a, c) => a - c)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // one objectId per node
    expect(new Set(v.meshes.map((x) => x.objectId)).size).toBe(10);
  });

  it('EXT_mesh_gpu_instancing -> addMeshes with node x instance matrices', async () => {
    const b = new GltfBuilder();
    b.json.extensionsUsed = ['EXT_mesh_gpu_instancing'];
    const pos = b.accessor(TRI, 'VEC3');
    const T = b.accessor(new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0]), 'VEC3');
    const S = b.accessor(new Float32Array([1, 1, 1, 2, 2, 2, 3, 3, 3]), 'VEC3');
    const mesh = b.mesh([{ attributes: { POSITION: pos } }]);
    b.node({ mesh, translation: [0, 5, 0], extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: T, SCALE: S } } } }, true);
    const v = createMockViewer();
    const m = await load(v, b.glb());
    expect(v.calls.addMeshes).toBe(1);
    expect(m.stats.meshes).toBe(3);
    close(xform(v.meshes[2].transform, [1, 0, 0]), [23, 5, 0]);
    close(xform(v.meshes[1].transform, [0, 1, 0]), [10, 7, 0]);
  });

  it('hierarchy, lazy names, objectId grouping by depth, properties', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(TRI, 'VEC3');
    const mesh = b.mesh([{ attributes: { POSITION: pos } }], 'tri');
    const a = b.node({ name: 'Труба A', mesh });
    const c = b.node({ name: 'Труба B', mesh, extras: { tag: 7 } });
    const grp = b.node({ name: 'Группа', children: [a, c] });
    b.node({ name: 'Файл.nwc', children: [grp] }, true);
    b.node({ name: 'orphan' }); // not in scene

    const v = createMockViewer();
    const m = await load(v, b.glb());
    const h = m.hierarchy;
    expect(h.nodeCount).toBe(5);
    expect(Array.from(h.roots())).toEqual([3]);
    expect(Array.from(h.children(2))).toEqual([0, 1]);
    expect(h.parent(4)).toBe(-2);
    expect(h.name(0)).toBe('Труба A');
    expect(m.stats.objects).toBe(2);
    const oid = h.objectId(1);
    expect(m.getProperties(oid)).toEqual({ name: 'Труба B', gltfNode: 1, meshName: 'tri', extras: { tag: 7 } });
    expect(Number.isNaN(h.objectId(2))).toBe(true);

    // group by depth 1: both meshes share the objectId of 'Группа'
    const v2 = createMockViewer();
    const m2 = await load(v2, b.glb(), { options: { objectIds: 1 } });
    expect(m2.stats.objects).toBe(1);
    expect(new Set(v2.meshes.map((x) => x.objectId)).size).toBe(1);
    expect(m2.getProperties(v2.meshes[0].objectId)!.name).toBe('Группа');

    // callback: everything owned by the root
    const v3 = createMockViewer();
    const m3 = await load(v3, b.glb(), { options: { objectIds: (_n, path) => path[0] } });
    expect(m3.hierarchy.nodeOfObject(v3.meshes[0].objectId)).toBe(3);
  });
});

describe('glTF loader: materials', () => {
  it('maps pbrMetallicRoughness, BLEND, emissive strength; textures ignored with a warning', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(TRI, 'VEC3');
    const m0 = b.material({ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 1, 0.5], metallicFactor: 0.2, roughnessFactor: 0.7 } });
    const m1 = b.material({
      pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.3], baseColorTexture: { index: 0 } },
      alphaMode: 'BLEND',
      emissiveFactor: [0.5, 0.2, 0],
      extensions: { KHR_materials_emissive_strength: { emissiveStrength: 1.5 } },
    });
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos }, material: m0 }, { attributes: { POSITION: pos }, material: m1 }, { attributes: { POSITION: pos } }]) }, true);
    const v = createMockViewer();
    const model = await load(v, b.glb());
    const [a, c, d] = v.materials;
    close(a.color!, [linearToSrgb(0.5), linearToSrgb(0.25), 1, 1], 1e-12); // OPAQUE ignores alpha
    expect(a.metalness).toBe(0.2);
    expect(a.roughness).toBe(0.7);
    expect(c.color![3]).toBe(0.3);
    expect(c.emissive).toBeCloseTo(0.75);
    expect(d).toEqual({}); // viewer default
    expect(v.meshes.length).toBe(3);
    expect(model.warnings.some((w) => /textures are ignored/.test(w))).toBe(true);
    // geometry shared by three primitives with different materials
    expect(v.calls.createGeometry).toBe(1);
  });

  it('srgbColors option skips linear->sRGB conversion', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(TRI, 'VEC3');
    const mat = b.material({ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } });
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos }, material: mat }]) }, true);
    const v = createMockViewer();
    await load(v, b.glb(), { options: { srgbColors: true } });
    expect(v.materials[0].color).toEqual([0.5, 0.5, 0.5, 1]);
  });
});

describe('glTF loader: files and extensions', () => {
  it('.gltf with a data-URI buffer', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(TRI, 'VEC3');
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos } }]) }, true);
    const v = createMockViewer({ keepData: true });
    const m = await load(v, b.gltf());
    expect(m.stats.meshes).toBe(1);
    close(v.geometries[0].positions!, TRI);
  });

  it('.gltf with an external buffer through LoadOptions.resolve', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(TRI, 'VEC3');
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos } }]) }, true);
    const asked: string[] = [];
    const files: Record<string, Blob> = { 'my model.bin': new Blob([b.binary()]) };
    const v = createMockViewer({ keepData: true });
    const m = await load(v, new Blob([b.gltf('my%20model.bin')]), {
      name: 'scene.gltf',
      resolve: (uri) => {
        asked.push(uri);
        return files[uri];
      },
    });
    expect(asked).toEqual(['my model.bin']);
    expect(m.stats.meshes).toBe(1);
    close(v.geometries[0].positions!, TRI);
  });

  it('external buffer without resolver gives a clear error', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(TRI, 'VEC3');
    b.node({ mesh: b.mesh([{ attributes: { POSITION: pos } }]) }, true);
    await expect(load(createMockViewer(), b.gltf('x.bin'))).rejects.toThrow(/\[gltf\].*Cannot resolve "x\.bin".*LoadOptions\.resolve/);
  });

  it('unsupported required extension names the extension and suggests a plugin', async () => {
    const b = new GltfBuilder();
    b.json.extensionsRequired = ['KHR_draco_mesh_compression'];
    const err = await load(createMockViewer(), b.glb()).catch((e) => e);
    expect(err).toBeInstanceOf(LoaderError);
    expect(err.message).toMatch(/KHR_draco_mesh_compression/);
    expect(err.message).toMatch(/Draco/);
    expect(err.message).toMatch(/another plugin/);
  });

  it('primitiveDecoders make a compression extension loadable', async () => {
    const b = new GltfBuilder();
    b.json.extensionsRequired = ['KHR_draco_mesh_compression'];
    const raw = b.view(new Uint8Array(TRI.buffer.slice(0)));
    b.node({ mesh: b.mesh([{ attributes: {}, extensions: { KHR_draco_mesh_compression: { bufferView: raw } } }]) }, true);
    const r = new LoaderRegistry();
    r.register(
      createGltfLoader({
        primitiveDecoders: {
          KHR_draco_mesh_compression: ({ extension, bufferView }) => {
            const bytes = bufferView(extension.bufferView);
            return { positions: new Float32Array(bytes.slice().buffer) };
          },
        },
      }),
    );
    const v = createMockViewer({ keepData: true });
    const m = await loadModel(v, b.glb(), { registry: r, name: 'd.glb' });
    expect(m.stats.triangles).toBe(1);
    close(v.geometries[0].positions!, TRI);
  });

  it('abort during the build phase removes everything', async () => {
    const b = new GltfBuilder();
    for (let i = 0; i < 400; i++) {
      const pos = b.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, i]), 'VEC3');
      b.node({ mesh: b.mesh([{ attributes: { POSITION: pos } }]) }, true);
    }
    const v = createMockViewer();
    const task = load(v, b.glb(), { sliceMs: 0 });
    task.onProgress((p) => {
      if (p.stage === 'meshes' && p.fraction > 0.3) task.abort();
    });
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(v.meshes.length).toBeGreaterThan(0);
    expect(v.liveMeshes()).toBe(0);
    expect(v.liveGeometries()).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { createMockViewer } from './__tests__/mockViewer';
import { LoaderRegistry, loadModel, objLoader } from './index';

const OBJ = `# test
mtllib x.mtl
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vn 0 0 1
o Plate
usemtl red
f 1//1 2//1 3//1 4//1
g Corner piece
f -4 -3 -1
`;

describe('OBJ loader (reference plugin)', () => {
  it('parses objects, polygons, negative indices and normals', async () => {
    const r = new LoaderRegistry();
    r.register(objLoader);
    const v = createMockViewer({ keepData: true });
    const m = await loadModel(v, new Blob([OBJ]), { registry: r, name: 'part.obj', up: 'y', options: { color: [1, 0, 0] } });
    expect(m.loader).toBe('obj');
    expect(m.stats).toMatchObject({ meshes: 2, triangles: 3, geometries: 2, materials: 1, objects: 2, nodes: 3 });
    expect(v.geometries[0].hasNormals).toBe(true);
    expect(v.geometries[1].hasNormals).toBe(false); // no vn on that face -> viewer computes
    expect(Array.from(v.geometries[1].positions!)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(v.materials[0].color).toEqual([1, 0, 0]);
    const h = m.hierarchy;
    expect(h.name(h.roots()[0])).toBe('part.obj');
    const ids = m.objectIds();
    expect(m.getProperties(ids[0])).toEqual({ name: 'Plate' });
    expect(m.getProperties(ids[1])).toEqual({ name: 'Corner piece' });
    expect(Array.from(m.bounds!)).toEqual([0, 0, 0, 1, 1, 0]);
  });

  it('is rotated into a Z-up scene by the context, not by the plugin', async () => {
    const r = new LoaderRegistry();
    r.register(objLoader);
    const v = createMockViewer();
    const m = await loadModel(v, new TextEncoder().encode(OBJ), { registry: r, name: 'p.obj', up: 'z' });
    // y extent becomes z extent
    expect(Array.from(m.bounds!)).toEqual([0, 0, 0, 1, 0, 1]);
  });
});

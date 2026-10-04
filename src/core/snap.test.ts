/**
 * Snapping ("magnet") against the real core through the real Viewer (headless, no GL): vertex /
 * feature edge / surface priority, adjacency by position, transforms, large coordinates, radius,
 * hidden back faces, and the cost on a 200k-triangle mesh.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { box } from '../primitives';
import { createHeadlessViewer, type HeadlessViewer } from '../__tests__/headlessViewer';
import { snapConfig } from './snap';

let hv: HeadlessViewer | null = null;
afterEach(() => {
  hv?.dispose();
  hv = null;
});

function setup(): HeadlessViewer {
  hv = createHeadlessViewer();
  return hv;
}

/** The 12 triangles of an axis-aligned box as a non-indexed position list (flat faces). */
function nonIndexedBox(h = 1): Float64Array {
  const b = box([2 * h, 2 * h, 2 * h]);
  const out = new Float64Array(b.indices.length * 3);
  for (let i = 0; i < b.indices.length; i++) {
    const v = b.indices[i];
    out[i * 3] = b.positions[v * 3];
    out[i * 3 + 1] = b.positions[v * 3 + 1];
    out[i * 3 + 2] = b.positions[v * 3 + 2];
  }
  return out;
}

type V3 = [number, number, number];
const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6) =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;

/** Applies a column-major affine 4x4 to a point. */
function xf(m: number[], p: V3): V3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** The cube checks shared by the indexed and non-indexed variants (cube [-1, 1]^3, camera above). */
function checkCube(h: HeadlessViewer, mesh: number) {
  const v = h.viewer;
  v.setCamera({ eye: [0.5, 10, 0.3], target: [0, 0, 0] });
  const R = 0.2;
  // vertex near a corner of the top face
  let r = v.snapMesh(mesh, [0.93, 1, 0.9], R)!;
  expect(r.kind).toBe('vertex');
  expect(near(r.position, [1, 1, 1])).toBe(true);
  // edge near the middle of a top-face edge: the edge point under the view ray (camera above it)
  v.setCamera({ eye: [0.9, 10, 0.1], target: [0.9, 0, 0.1] });
  r = v.snapMesh(mesh, [0.9, 1, 0.1], R)!;
  expect(r.kind).toBe('edge');
  expect(near(r.position, [1, 1, 0.1])).toBe(true);
  v.setCamera({ eye: [0.5, 10, 0.3], target: [0, 0, 0] });
  expect(r.edge).toBeDefined();
  const ends = r.edge!.map((p) => p.map(Math.round).join(','));
  expect(ends.sort()).toEqual(['1,1,-1', '1,1,1']);
  // every one of the 12 cube edges attracts (hit on a face next to the edge's midpoint)
  const edgesFound = new Set<string>();
  for (let axis = 0; axis < 3; axis++) {
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
        // a point on the face a1 = s1, 0.1 inside from the edge a2 = s2
        const p: V3 = [0, 0, 0];
        p[axis] = 0.2;
        p[a1] = s1;
        p[a2] = s2 * 0.9;
        v.setCamera({ eye: [p[0] * 10 + 0.01, p[1] * 10 + 0.02, p[2] * 10 + 0.03], target: [0, 0, 0] });
        const e = v.snapMesh(mesh, p, R)!;
        expect(e.kind, `edge axis ${axis} ${s1} ${s2}`).toBe('edge');
        // on that edge, near the hit (the exact point depends on the view ray)
        const pos = e.position;
        expect(Math.abs(pos[a1] - s1) < 1e-6 && Math.abs(pos[a2] - s2) < 1e-6 && Math.abs(pos[axis] - 0.2) < 0.05, `edge point ${pos}`).toBe(true);
        edgesFound.add(`${axis}${s1}${s2}`);
      }
    }
  }
  expect(edgesFound.size).toBe(12);
  v.setCamera({ eye: [0.5, 10, 0.3], target: [0, 0, 0] });
  // surface in the middle of the face
  r = v.snapMesh(mesh, [0, 1, 0], R)!;
  expect(r.kind).toBe('surface');
  expect(near(r.position, [0, 1, 0])).toBe(true);
  // never on a face diagonal (x = z is the triangulation diagonal of the top face, x = -z is not an edge)
  for (const t of [-0.6, -0.3, 0.3, 0.6]) {
    expect(v.snapMesh(mesh, [t, 1, t], R)!.kind, `diagonal ${t}`).toBe('surface');
    expect(v.snapMesh(mesh, [t, 1, -t], R)!.kind).toBe('surface');
  }
}

describe('snap (magnet)', () => {
  it('indexed cube: vertex at corners, the 12 edges, surface in faces, not on diagonals', () => {
    const h = setup();
    const v = h.viewer;
    const g = v.primitives.box([2, 2, 2]);
    const mesh = v.addMesh({ geometry: g, material: v.createMaterial() });
    checkCube(h, mesh);
  });

  it('non-indexed cube: adjacency is found by position', () => {
    const h = setup();
    const v = h.viewer;
    const g = v.createGeometry({ positions: nonIndexedBox() });
    const mesh = v.addMesh({ geometry: g, material: v.createMaterial() });
    checkCube(h, mesh);
  });

  it('reports ids and the raw hit; resolves null for a removed mesh', () => {
    const h = setup();
    const v = h.viewer;
    const g = v.primitives.box([2, 2, 2]);
    const mesh = v.addMesh({ geometry: g, material: v.createMaterial(), objectId: 77 });
    v.setCamera({ eye: [0, 10, 0], target: [0, 0, 0] });
    const r = v.snapMesh(mesh, [0.95, 1, 0.95], 0.2)!;
    expect(r.meshId).toBe(mesh);
    expect(r.objectId).toBe(77);
    expect(r.hit).toEqual([0.95, 1, 0.95]);
    v.remove(mesh);
    expect(v.snapMesh(mesh, [0.95, 1, 0.95], 0.2)).toBeNull();
  });

  it('options: vertices / edges off, radius', () => {
    const h = setup();
    const v = h.viewer;
    const mesh = v.addMesh({ geometry: v.primitives.box([2, 2, 2]), material: v.createMaterial() });
    v.setCamera({ eye: [0.5, 10, 0.3], target: [0, 0, 0] });
    const p: V3 = [0.9, 1, 0.88]; // 0.1 from the x edge, 0.12 from the z edge, 0.156 from the corner
    expect(v.snapMesh(mesh, p, 0.2)!.kind).toBe('vertex');
    expect(v.snapMesh(mesh, p, 0.15)!.kind).toBe('edge'); // corner out of reach, nearest edge x = 1
    const ep = v.snapMesh(mesh, p, 0.15)!.position;
    expect(ep[0] === 1 && ep[1] === 1 && Math.abs(ep[2] - 0.88) < 0.02, `${ep}`).toBe(true);
    expect(v.snapMesh(mesh, p, 0.05)!.kind).toBe('surface');
    expect(v.snapMesh(mesh, p, 0.2, { vertices: false })!.kind).toBe('edge');
    expect(v.snapMesh(mesh, p, 0.2, { vertices: false, edges: false })!.kind).toBe('surface');
    expect(v.snapMesh(mesh, p, 0)!.kind).toBe('surface');
  });

  it('transformed, mirrored, non-uniformly scaled instances', () => {
    const h = setup();
    const v = h.viewer;
    const g = v.createGeometry({ positions: nonIndexedBox() });
    const mat = v.createMaterial();
    const c = Math.cos(0.7), s = Math.sin(0.7);
    // rotation about y, scale (3, 0.5, 2), mirror z, then translate
    const m = [3 * c, 0, -3 * s, 0, 0, 0.5, 0, 0, -2 * s, 0, -2 * c, 0, 5, -2, 7, 1];
    const plain = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -20, 0, 0, 1];
    const first = v.addMeshes({ geometry: g, material: mat, transforms: [...plain, ...m] });
    const mesh = first + 1;
    const top = xf(m, [0, 1, 0]);
    v.setCamera({ eye: [top[0] + 0.3, top[1] + 30, top[2] + 0.2], target: top });
    // near the local corner (1, 1, 1) on the top face
    let r = v.snapMesh(mesh, xf(m, [0.97, 1, 0.95]), 0.25)!;
    expect(r.kind).toBe('vertex');
    expect(near(r.position, xf(m, [1, 1, 1]), 1e-5)).toBe(true);
    // near the middle of the local edge y = 1, z = -1
    r = v.snapMesh(mesh, xf(m, [0.1, 1, -0.97]), 0.25)!;
    expect(r.kind).toBe('edge');
    const e0 = xf(m, [-1, 1, -1]), e1 = xf(m, [1, 1, -1]);
    const ends = r.edge!;
    expect((near(ends[0], e0, 1e-5) && near(ends[1], e1, 1e-5)) || (near(ends[0], e1, 1e-5) && near(ends[1], e0, 1e-5))).toBe(true);
    // the snapped point lies on that edge
    const d = [e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2]];
    const w = [r.position[0] - e0[0], r.position[1] - e0[1], r.position[2] - e0[2]];
    const cr = [d[1] * w[2] - d[2] * w[1], d[2] * w[0] - d[0] * w[2], d[0] * w[1] - d[1] * w[0]];
    expect(Math.hypot(cr[0], cr[1], cr[2]) / Math.hypot(d[0], d[1], d[2])).toBeLessThan(1e-5);
    // middle of the face, and the face diagonal: surface
    expect(v.snapMesh(mesh, top, 0.25)!.kind).toBe('surface');
    expect(v.snapMesh(mesh, xf(m, [0.4, 1, 0.4]), 0.25)!.kind).toBe('surface');
    // the radius is a world radius: the local x axis is stretched x3, so 0.2 world from the corner
    // along local x is only 0.067 local units
    r = v.snapMesh(mesh, xf(m, [1 - 0.2 / 3, 1, 1]), 0.25)!;
    expect(r.kind).toBe('vertex');
  });

  it('large coordinates (origin ~1e7): exact corners and edge points', () => {
    const h = setup();
    const v = h.viewer;
    const g = v.createGeometry({ positions: nonIndexedBox() });
    const mat = v.createMaterial();
    const X = 1.2e7, Y = -3.4e6, Z = 2.5e7;
    v.addMesh({ geometry: g, material: mat, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, X, Y, Z, 1] }); // sets the origin
    const mesh = v.addMesh({ geometry: g, material: mat, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, X + 10, Y, Z + 4, 1] });
    v.setCamera({ eye: [X + 10.3, Y + 20, Z + 4.2], target: [X + 10, Y, Z + 4] });
    let r = v.snapMesh(mesh, [X + 10.95, Y + 1, Z + 4.93], 0.2)!;
    expect(r.kind).toBe('vertex');
    expect(r.position).toEqual([X + 11, Y + 1, Z + 5]);
    // camera straight above the hit: the edge point is the hit moved onto the edge
    v.setCamera({ eye: [X + 10.25, Y + 20, Z + 4.92], target: [X + 10.25, Y, Z + 4.92] });
    r = v.snapMesh(mesh, [X + 10.25, Y + 1, Z + 4.92], 0.2)!;
    expect(r.kind).toBe('edge');
    expect(Math.abs(r.position[0] - (X + 10.25))).toBeLessThan(1e-6);
    expect(r.position[1]).toBe(Y + 1);
    expect(r.position[2]).toBe(Z + 5);
  });

  it('only geometry near the hit counts: no hidden back face, no far vertex of the same mesh', () => {
    const h = setup();
    const v = h.viewer;
    // a thin plate 2 x 0.05 x 2 (non-indexed) seen from above: the bottom face lies 0.05 below
    const b = nonIndexedBox();
    for (let i = 1; i < b.length; i += 3) b[i] *= 0.025;
    const mesh = v.addMesh({ geometry: v.createGeometry({ positions: b }), material: v.createMaterial() });
    v.setCamera({ eye: [0.2, 10, 0.1], target: [0, 0, 0] });
    // radius 1 reaches the bottom face's centre region but no corner: surface, not something below
    let r = v.snapMesh(mesh, [0, 0.025, 0], 0.9)!;
    expect(r.kind).toBe('surface');
    // near the plate's top edge the snapped point is on the top edge, not the bottom one
    r = v.snapMesh(mesh, [0.97, 0.025, 0.2], 0.1)!;
    expect(r.kind).toBe('edge');
    expect(r.position[1]).toBeCloseTo(0.025, 6);
    // a long bar: hitting one end never reaches the other end's vertices
    const bar = nonIndexedBox();
    for (let i = 0; i < bar.length; i += 3) bar[i] *= 50;
    const m2 = v.addMesh({ geometry: v.createGeometry({ positions: bar }), material: v.createMaterial(), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 10, 0, 1] });
    v.setCamera({ eye: [-49.5, 30, 0.1], target: [-49.5, 11, 0] });
    r = v.snapMesh(m2, [-49.5, 11, 0], 0.3)!;
    expect(r.kind).toBe('surface');
  });

  it('a T-junction of a non-conforming tessellation is not an edge; a real boundary is', () => {
    const h = setup();
    const v = h.viewer;
    // flat square z = 0: left triangle A spans (0,0)-(0,2)... the right half is split at (1,1):
    // A = (0,0) (2,2) (0,2); B = (0,0) (2,0) (1,1); C = (1,1) (2,0) (2,2). A's diagonal (0,0)-(2,2)
    // meets B's and C's edges only in part (T-junction at (1,1)).
    const pos = [0, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 1, 1, 0, 1, 1, 0, 2, 0, 0, 2, 2, 0];
    const mesh = v.addMesh({ geometry: v.createGeometry({ positions: pos }), material: v.createMaterial() });
    v.setCamera({ eye: [1, 1, 10], target: [1, 1, 0] });
    expect(v.snapMesh(mesh, [0.55, 0.45, 0], 0.15)!.kind).toBe('surface');
    expect(v.snapMesh(mesh, [1.55, 1.45, 0], 0.15)!.kind).toBe('surface');
    // the outer boundary of the square attracts
    v.setCamera({ eye: [0.5, 0.05, 10], target: [0.5, 0.05, 0] });
    const r = v.snapMesh(mesh, [0.5, 0.05, 0], 0.15)!;
    expect(r.kind).toBe('edge');
    expect(near(r.position, [0.5, 0, 0])).toBe(true);
  });

  it('the tolerance is in screen terms: a grazing view reaches as far on screen as a head-on one', () => {
    const h = setup();
    const v = h.viewer;
    const mesh = v.addMesh({ geometry: v.createGeometry({ positions: nonIndexedBox() }), material: v.createMaterial() });
    // top face seen at 60 degrees from head-on: 0.3 units towards the camera-facing edge (z = 1)
    // along the face look like 0.3 * cos(60) = 0.15 on screen
    const a = (60 * Math.PI) / 180;
    const P: V3 = [0, 1, 0.7];
    v.setCamera({ eye: [P[0], P[1] + 10 * Math.cos(a), P[2] + 10 * Math.sin(a)], target: P });
    expect(v.snapMesh(mesh, P, 0.2)!.kind).toBe('edge'); // 0.15 on screen < 0.2
    expect(v.snapMesh(mesh, P, 0.1)!.kind).toBe('surface');
    // without the screen metric (3D distance 0.3) it would need a radius of 0.3
    v.setCamera({ eye: [P[0], P[1] + 10, P[2]], target: P }); // head-on: 0.3 on screen
    expect(v.snapMesh(mesh, P, 0.2)!.kind).toBe('surface');
  });

  it('creases attract, a gentle fold below the angle does not', () => {
    const h = setup();
    const v = h.viewer;
    // two quads sharing the edge x = 0, folded by `deg` around it (non-indexed, 4 triangles)
    const fold = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      const fx = Math.cos(a), fz = Math.sin(a);
      // left quad in the plane z = 0 for x in [-1, 0]; right quad rises by angle a
      const P = (x: number, y: number): number[] => (x <= 0 ? [x, y, 0] : [x * fx, y, x * fz]);
      const q = (x0: number, x1: number) => [...P(x0, -1), ...P(x1, -1), ...P(x1, 1), ...P(x0, -1), ...P(x1, 1), ...P(x0, 1)];
      return [...q(-1, 0), ...q(0, 1)];
    };
    v.setCamera({ eye: [0.1, 0.2, 10], target: [0, 0, 0] });
    const sharp = v.addMesh({ geometry: v.createGeometry({ positions: fold(40) }), material: v.createMaterial() });
    const soft = v.addMesh({ geometry: v.createGeometry({ positions: fold(10) }), material: v.createMaterial() });
    expect(v.snapMesh(sharp, [-0.05, 0.3, 0], 0.1)!.kind).toBe('edge');
    expect(v.snapMesh(soft, [-0.05, 0.3, 0], 0.1)!.kind).toBe('surface');
    expect(v.snapMesh(soft, [-0.05, 0.3, 0], 0.1, { edgeAngle: 5 })!.kind).toBe('edge');
  });

  it('200k-triangle mesh: cheap enough for every pointer move (grid and linear scan)', () => {
    const h = setup();
    const v = h.viewer;
    // a wavy height field, 317 x 317 quads = 200978 triangles, indexed and non-indexed variants
    const n = 317;
    const pos = new Float64Array((n + 1) * (n + 1) * 3);
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const k = (j * (n + 1) + i) * 3;
        pos[k] = i;
        pos[k + 1] = j;
        pos[k + 2] = Math.sin(i * 0.3) * Math.cos(j * 0.2) * 3;
      }
    }
    const idx = new Uint32Array(n * n * 6);
    let o = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        idx[o++] = a; idx[o++] = a + 1; idx[o++] = a + n + 2;
        idx[o++] = a; idx[o++] = a + n + 2; idx[o++] = a + n + 1;
      }
    }
    const flat = new Float64Array(idx.length * 3);
    for (let t = 0; t < idx.length; t++) flat.set(pos.subarray(idx[t] * 3, idx[t] * 3 + 3), t * 3);
    const mat = v.createMaterial();
    const indexed = v.addMesh({ geometry: v.createGeometry({ positions: pos, indices: idx }), material: mat });
    const soup = v.addMesh({ geometry: v.createGeometry({ positions: flat }), material: mat });
    v.setCamera({ eye: [150, 150, 400], target: [150, 150, 0] });
    const hitAt = (x: number, y: number): V3 => [x, y, Math.sin(x * 0.3) * Math.cos(y * 0.2) * 3];
    const run = (mesh: number, label: string) => {
      const N = 200;
      // warm up (JIT, grid build)
      for (let i = 0; i < 20; i++) v.snapMesh(mesh, hitAt(10 + i, 20), 0.6);
      let worst = 0;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        const t1 = performance.now();
        const r = v.snapMesh(mesh, hitAt(5 + (i * 1.37) % 300, 7 + (i * 2.11) % 300), 0.6);
        worst = Math.max(worst, performance.now() - t1);
        expect(r).not.toBeNull();
      }
      const avg = (performance.now() - t0) / N;
      console.log(`snap ${label}: ${avg.toFixed(3)} ms avg, ${worst.toFixed(3)} ms worst, ${v.snapStats.scanned} scanned, ${v.snapStats.candidates} candidates`);
      return avg;
    };
    const gridIdx = run(indexed, 'indexed 201k tris, grid');
    const gridSoup = run(soup, 'non-indexed 201k tris, grid');
    expect(gridIdx).toBeLessThan(2);
    expect(gridSoup).toBeLessThan(2);
    // a vertex of the field is found exactly
    const r = v.snapMesh(indexed, hitAt(100.05, 50.04), 0.6)!;
    expect(r.kind).toBe('vertex');
    // within the u16 quantization step of the 317-unit extent (0.0048)
    expect(Math.abs(r.position[0] - 100)).toBeLessThan(0.0025);
    expect(Math.abs(r.position[1] - 50)).toBeLessThan(0.0025);
    // the linear scan alone (no grid) for reference
    const saved = snapConfig.gridMinTriangles;
    snapConfig.gridMinTriangles = Infinity;
    try {
      const lin = run(soup, 'non-indexed 201k tris, linear scan');
      expect(lin).toBeLessThan(30);
    } finally {
      snapConfig.gridMinTriangles = saved;
    }
  });
});

/**
 * Primitive geometry generators. Pure functions returning GeometryData with positions, normals
 * and u32 indices; counter-clockwise front faces and outward normals.
 *
 * Shapes with an axis (cylinder, cone, plane, torus, extrusion) are aligned with the world up axis
 * given by `up` (default 'y', matching ViewerOptions.up). Ground-plane coordinates map as
 * (u, v) -> (x, y) for up = 'z' and (u, v) -> (x, -z) for up = 'y', so outlines that are
 * counter-clockwise seen from above stay counter-clockwise.
 *
 * Placement: box, sphere, plane and torus are centred at the origin; cylinder, cone and extrusion
 * stand on the ground plane through the origin and extend `height` along up.
 */
import type { Vec3 } from '../types';
import { MeshBuilder, type PrimitiveGeometry, type UpAxis } from './builder';
import { cleanOutline, triangulate } from './triangulate';

const TAU = Math.PI * 2;

/** Axis-aligned box centred at the origin; `size` is [x, y, z] in world axes. 24 vertices, 12 triangles. */
export function box(size: Vec3 = [1, 1, 1]): PrimitiveGeometry {
  const hx = size[0] / 2, hy = size[1] / 2, hz = size[2] / 2;
  const b = new MeshBuilder();
  // normal n, tangent u, bitangent v with u x v = n
  const faces: number[][] = [
    [1, 0, 0, 0, 1, 0, 0, 0, 1],
    [-1, 0, 0, 0, 0, 1, 0, 1, 0],
    [0, 1, 0, 0, 0, 1, 1, 0, 0],
    [0, -1, 0, 1, 0, 0, 0, 0, 1],
    [0, 0, 1, 1, 0, 0, 0, 1, 0],
    [0, 0, -1, 0, 1, 0, 1, 0, 0],
  ];
  for (const f of faces) {
    const [nx, ny, nz, ux, uy, uz, vx, vy, vz] = f;
    const base = b.vertexCount;
    for (let k = 0; k < 4; k++) {
      const su = k === 1 || k === 2 ? 1 : -1;
      const sv = k >= 2 ? 1 : -1;
      b.vertex(
        (nx + su * ux + sv * vx) * hx,
        (ny + su * uy + sv * vy) * hy,
        (nz + su * uz + sv * vz) * hz,
        nx, ny, nz,
      );
    }
    b.tri(base, base + 1, base + 2);
    b.tri(base, base + 2, base + 3);
  }
  return b.build('z');
}

/** UV sphere centred at the origin, poles on the up axis. `segments` around, segments/2 rings. */
export function sphere(radius = 0.5, segments = 32, up: UpAxis = 'y'): PrimitiveGeometry {
  const segs = Math.max(3, Math.floor(segments));
  const rings = Math.max(2, Math.floor(segs / 2));
  const b = new MeshBuilder();
  for (let i = 0; i <= rings; i++) {
    const theta = (i / rings) * Math.PI;
    const st = i === rings ? 0 : Math.sin(theta), ct = Math.cos(theta);
    for (let j = 0; j <= segs; j++) {
      const phi = ((j % segs) / segs) * TAU;
      const nx = st * Math.cos(phi), ny = st * Math.sin(phi), nz = ct;
      b.vertex(nx * radius, ny * radius, nz * radius, nx, ny, nz);
    }
  }
  const row = segs + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * row + j, c = a + row;
      if (i !== rings - 1) b.tri(a, c, c + 1);
      if (i !== 0) b.tri(a, c + 1, a + 1);
    }
  }
  return b.build(up);
}

/** Closed cylinder standing on the ground plane, axis along up, from 0 to `height`. */
export function cylinder(radius = 0.5, height = 1, segments = 32, up: UpAxis = 'y'): PrimitiveGeometry {
  const segs = Math.max(3, Math.floor(segments));
  const b = new MeshBuilder();
  // side (smooth normals, seam duplicated)
  for (let j = 0; j <= segs; j++) {
    const phi = ((j % segs) / segs) * TAU;
    const c = Math.cos(phi), s = Math.sin(phi);
    b.vertex(c * radius, s * radius, 0, c, s, 0);
    b.vertex(c * radius, s * radius, height, c, s, 0);
  }
  for (let j = 0; j < segs; j++) {
    const b0 = 2 * j, t0 = b0 + 1, b1 = b0 + 2, t1 = b0 + 3;
    b.tri(b0, b1, t1);
    b.tri(b0, t1, t0);
  }
  cap(b, radius, height, segs, 1);
  cap(b, radius, 0, segs, -1);
  return b.build(up);
}

/** Cone standing on the ground plane, apex at `height` along up. */
export function cone(radius = 0.5, height = 1, segments = 32, up: UpAxis = 'y'): PrimitiveGeometry {
  const segs = Math.max(3, Math.floor(segments));
  const b = new MeshBuilder();
  const inv = 1 / Math.hypot(height, radius);
  const nh = height * inv, nr = radius * inv;
  for (let j = 0; j <= segs; j++) {
    const phi = ((j % segs) / segs) * TAU;
    const c = Math.cos(phi), s = Math.sin(phi);
    b.vertex(c * radius, s * radius, 0, c * nh, s * nh, nr);
  }
  const apex0 = b.vertexCount;
  for (let j = 0; j < segs; j++) {
    const phi = ((j + 0.5) / segs) * TAU;
    b.vertex(0, 0, height, Math.cos(phi) * nh, Math.sin(phi) * nh, nr);
  }
  for (let j = 0; j < segs; j++) b.tri(j, j + 1, apex0 + j);
  cap(b, radius, 0, segs, -1);
  return b.build(up);
}

/** Flat disc at height z facing +z (dir = 1) or -z (dir = -1). */
function cap(b: MeshBuilder, radius: number, z: number, segs: number, dir: 1 | -1): void {
  const centre = b.vertex(0, 0, z, 0, 0, dir);
  const first = b.vertexCount;
  for (let j = 0; j < segs; j++) {
    const phi = ((j % segs) / segs) * TAU;
    b.vertex(Math.cos(phi) * radius, Math.sin(phi) * radius, z, 0, 0, dir);
  }
  for (let j = 0; j < segs; j++) {
    const v0 = first + j, v1 = first + ((j + 1) % segs);
    if (dir > 0) b.tri(centre, v0, v1);
    else b.tri(centre, v1, v0);
  }
}

/** Single-sided rectangle in the ground plane centred at the origin, facing up. */
export function plane(width = 1, depth = 1, up: UpAxis = 'y'): PrimitiveGeometry {
  const hw = width / 2, hd = depth / 2;
  const b = new MeshBuilder();
  b.vertex(-hw, -hd, 0, 0, 0, 1);
  b.vertex(hw, -hd, 0, 0, 0, 1);
  b.vertex(hw, hd, 0, 0, 0, 1);
  b.vertex(-hw, hd, 0, 0, 0, 1);
  b.tri(0, 1, 2);
  b.tri(0, 2, 3);
  return b.build(up);
}

/**
 * Torus centred at the origin lying in the ground plane. `radius` is the ring radius (centre to
 * tube centre), `tube` the tube radius; `radialSegments` around the tube, `tubularSegments` around
 * the ring.
 */
export function torus(
  radius = 0.5,
  tube = 0.15,
  radialSegments = 16,
  tubularSegments = 48,
  up: UpAxis = 'y',
): PrimitiveGeometry {
  const rs = Math.max(3, Math.floor(radialSegments));
  const ts = Math.max(3, Math.floor(tubularSegments));
  const b = new MeshBuilder();
  for (let i = 0; i <= ts; i++) {
    const u = ((i % ts) / ts) * TAU;
    const cu = Math.cos(u), su = Math.sin(u);
    for (let j = 0; j <= rs; j++) {
      const v = ((j % rs) / rs) * TAU;
      const cv = Math.cos(v), sv = Math.sin(v);
      const nx = cv * cu, ny = cv * su, nz = sv;
      b.vertex(radius * cu + tube * nx, radius * su + tube * ny, tube * nz, nx, ny, nz);
    }
  }
  const row = rs + 1;
  for (let i = 0; i < ts; i++) {
    for (let j = 0; j < rs; j++) {
      const a = i * row + j, c = a + row;
      b.tri(a, c, c + 1);
      b.tri(a, c + 1, a + 1);
    }
  }
  return b.build(up);
}

/**
 * Extrudes a closed simple polygon (xy pairs; counter-clockwise preferred, clockwise is reversed
 * automatically; a repeated closing point is ignored) from the ground plane to `height` along up.
 * Concave outlines are supported (ear clipping). Side walls have flat per-edge normals.
 * A negative height extrudes downwards. Returns empty arrays for degenerate outlines.
 */
export function extrusion(outline: ArrayLike<number>, height: number, up: UpAxis = 'y'): PrimitiveGeometry {
  const pts = cleanOutline(outline);
  const n = pts.length >> 1;
  const b = new MeshBuilder();
  if (n < 3 || height === 0) return b.build(up);
  const z0 = Math.min(0, height), z1 = Math.max(0, height);
  const tris = triangulate(pts);

  // top cap (+z)
  const top = b.vertexCount;
  for (let i = 0; i < n; i++) b.vertex(pts[i * 2], pts[i * 2 + 1], z1, 0, 0, 1);
  for (let k = 0; k < tris.length; k += 3) b.tri(top + tris[k], top + tris[k + 1], top + tris[k + 2]);
  // bottom cap (-z), reversed winding
  const bot = b.vertexCount;
  for (let i = 0; i < n; i++) b.vertex(pts[i * 2], pts[i * 2 + 1], z0, 0, 0, -1);
  for (let k = 0; k < tris.length; k += 3) b.tri(bot + tris[k], bot + tris[k + 2], bot + tris[k + 1]);
  // side walls: outward normal of a ccw edge (dx, dy) is (dy, -dx)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[j * 2], y1 = pts[j * 2 + 1];
    const dx = x1 - x0, dy = y1 - y0;
    const l = Math.hypot(dx, dy);
    if (l === 0) continue;
    const nx = dy / l, ny = -dx / l;
    const v = b.vertexCount;
    b.vertex(x0, y0, z0, nx, ny, 0);
    b.vertex(x1, y1, z0, nx, ny, 0);
    b.vertex(x1, y1, z1, nx, ny, 0);
    b.vertex(x0, y0, z1, nx, ny, 0);
    b.tri(v, v + 1, v + 2);
    b.tri(v, v + 2, v + 3);
  }
  return b.build(up);
}

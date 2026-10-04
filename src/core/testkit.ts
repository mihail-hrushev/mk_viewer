/**
 * Test helpers for src/core unit tests (not exported from the barrel; not used at runtime).
 */
import type { CullView } from './DrawBVH';

/** Deterministic PRNG (mulberry32) returning [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Column-major translate * scale matrix. */
export function trs(tx: number, ty: number, tz: number, s = 1, out: Float32Array | number[] = new Float32Array(16), o = 0): Float32Array | number[] {
  for (let i = 0; i < 16; i++) out[o + i] = 0;
  out[o] = s;
  out[o + 5] = s;
  out[o + 10] = s;
  out[o + 12] = tx;
  out[o + 13] = ty;
  out[o + 14] = tz;
  out[o + 15] = 1;
  return out;
}

/** Unit-ish box (24 vertices, 36 indices, flat normals) centred at origin with given half size. */
export function boxGeometry(h = 0.5): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  const faces = [
    [0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1],
  ];
  for (const [a, b, c, s] of faces) {
    const base = p.length / 3;
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const q = [0, 0, 0];
      q[a] = s * h;
      q[b] = u * h;
      q[c] = v * h * s;
      p.push(q[0], q[1], q[2]);
      const nn = [0, 0, 0];
      nn[a] = s;
      n.push(nn[0], nn[1], nn[2]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/** Random small indexed mesh (jittered 8-vertex box, 12 triangles), unique per call. */
export function randomMesh(r: () => number, size = 1): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = ((i & 1) * 2 - 1) * size * (0.5 + r() * 0.5);
    positions[i * 3 + 1] = (((i >> 1) & 1) * 2 - 1) * size * (0.5 + r() * 0.5);
    positions[i * 3 + 2] = (((i >> 2) & 1) * 2 - 1) * size * (0.5 + r() * 0.5);
  }
  const indices = new Uint32Array([
    0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5,
  ]);
  return { positions, indices };
}

/** Perspective CullView looking from eye to target (y up). */
export function perspectiveView(
  eye: [number, number, number],
  target: [number, number, number],
  fovY: number,
  aspect: number,
  near: number,
  far: number,
  viewportHeight: number,
  pixelThreshold: number,
): CullView {
  const vp = mul(perspective(fovY, aspect, near, far), lookAt(eye, target, [0, 1, 0]));
  return {
    planes: planesFromViewProj(vp),
    eye: new Float32Array(eye),
    orthographic: false,
    pixelScale: viewportHeight / (2 * Math.tan(fovY / 2)),
    pixelThreshold,
  };
}

function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function lookAt(e: number[], t: number[], up: number[]): number[] {
  let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
  let l = Math.hypot(zx, zy, zz);
  zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz);
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return [
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1,
  ];
}

function mul(a: number[], b: number[]): number[] {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

/** Gribb-Hartmann plane extraction, inward normals, normalized. */
export function planesFromViewProj(m: number[]): Float32Array {
  const out = new Float32Array(24);
  const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const ps = [
    r3.map((v, i) => v + r0[i]), r3.map((v, i) => v - r0[i]),
    r3.map((v, i) => v + r1[i]), r3.map((v, i) => v - r1[i]),
    r3.map((v, i) => v + r2[i]), r3.map((v, i) => v - r2[i]),
  ];
  ps.forEach((p, k) => {
    const l = Math.hypot(p[0], p[1], p[2]);
    for (let i = 0; i < 4; i++) out[k * 4 + i] = p[i] / l;
  });
  return out;
}

/**
 * Private math helpers for src/core (AABB transform, Morton codes, frustum/AABB test, distances,
 * colour conversion). Deliberately independent of src/math.
 *
 * AABBs are 6 consecutive floats: minx, miny, minz, maxx, maxy, maxz.
 */

/**
 * World AABB of a local AABB under an affine column-major 4x4 matrix
 * (centre/extent form: e'_r = sum_c |M_rc| e_c).
 */
export function transformAabb(
  m: ArrayLike<number>,
  mo: number,
  local: Float32Array,
  lo: number,
  out: Float32Array,
  oo: number,
): void {
  const cx = (local[lo] + local[lo + 3]) * 0.5;
  const cy = (local[lo + 1] + local[lo + 4]) * 0.5;
  const cz = (local[lo + 2] + local[lo + 5]) * 0.5;
  const ex = (local[lo + 3] - local[lo]) * 0.5;
  const ey = (local[lo + 4] - local[lo + 1]) * 0.5;
  const ez = (local[lo + 5] - local[lo + 2]) * 0.5;
  for (let r = 0; r < 3; r++) {
    const a = m[mo + r];
    const b = m[mo + 4 + r];
    const c = m[mo + 8 + r];
    const centre = a * cx + b * cy + c * cz + m[mo + 12 + r];
    const ext = Math.abs(a) * ex + Math.abs(b) * ey + Math.abs(c) * ez;
    out[oo + r] = centre - ext;
    out[oo + 3 + r] = centre + ext;
  }
}

/** Spreads the low 10 bits of v so there are two zero bits between each. */
function part1by2(v: number): number {
  v &= 0x3ff;
  v = (v | (v << 16)) & 0x030000ff;
  v = (v | (v << 8)) & 0x0300f00f;
  v = (v | (v << 4)) & 0x030c30c3;
  v = (v | (v << 2)) & 0x09249249;
  return v;
}

/** 30-bit Morton code of 10-bit integer coordinates. */
export function morton3(x: number, y: number, z: number): number {
  return (part1by2(x) | (part1by2(y) << 1) | (part1by2(z) << 2)) >>> 0;
}

/**
 * Frustum test of an AABB against the planes enabled in `mask` (bit p = plane p; planes are
 * nx,ny,nz,d with inward normals, inside when n.p + d >= 0).
 * Returns -1 when outside, otherwise the mask of planes still intersecting (0 = fully inside).
 */
export function cullAabb(planes: Float32Array, b: Float32Array, o: number, mask: number): number {
  const x0 = b[o];
  const y0 = b[o + 1];
  const z0 = b[o + 2];
  const x1 = b[o + 3];
  const y1 = b[o + 4];
  const z1 = b[o + 5];
  for (let p = 0; p < 6; p++) {
    const bit = 1 << p;
    if ((mask & bit) === 0) continue;
    const q = p * 4;
    const nx = planes[q];
    const ny = planes[q + 1];
    const nz = planes[q + 2];
    const d = planes[q + 3];
    // positive vertex (farthest along the normal)
    const far =
      nx * (nx >= 0 ? x1 : x0) + ny * (ny >= 0 ? y1 : y0) + nz * (nz >= 0 ? z1 : z0) + d;
    if (far < 0) return -1;
    const near =
      nx * (nx >= 0 ? x0 : x1) + ny * (ny >= 0 ? y0 : y1) + nz * (nz >= 0 ? z0 : z1) + d;
    if (near >= 0) mask &= ~bit;
  }
  return mask;
}

/** Euclidean distance from point e to the closest point of the AABB (0 when inside). */
export function distToAabb(ex: number, ey: number, ez: number, b: Float32Array, o: number): number {
  const dx = Math.max(b[o] - ex, 0, ex - b[o + 3]);
  const dy = Math.max(b[o + 1] - ey, 0, ey - b[o + 4]);
  const dz = Math.max(b[o + 2] - ez, 0, ez - b[o + 5]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Length of the AABB diagonal (bounding-sphere diameter estimate). */
export function aabbDiag(b: Float32Array, o: number): number {
  const dx = b[o + 3] - b[o];
  const dy = b[o + 4] - b[o + 1];
  const dz = b[o + 5] - b[o + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** out[oo..] = union(out[oo..], b[o..]). */
export function unionAabb(out: Float32Array, oo: number, b: Float32Array, o: number): void {
  if (b[o] < out[oo]) out[oo] = b[o];
  if (b[o + 1] < out[oo + 1]) out[oo + 1] = b[o + 1];
  if (b[o + 2] < out[oo + 2]) out[oo + 2] = b[o + 2];
  if (b[o + 3] > out[oo + 3]) out[oo + 3] = b[o + 3];
  if (b[o + 4] > out[oo + 4]) out[oo + 4] = b[o + 4];
  if (b[o + 5] > out[oo + 5]) out[oo + 5] = b[o + 5];
}

/** Sets out[oo..oo+6) to an empty (inverted) box. */
export function emptyAabb(out: Float32Array, oo: number): void {
  out[oo] = out[oo + 1] = out[oo + 2] = Infinity;
  out[oo + 3] = out[oo + 4] = out[oo + 5] = -Infinity;
}

/** sRGB transfer function -> linear, input clamped to 0..1. */
export function srgbToLinear(c: number): number {
  c = c < 0 ? 0 : c > 1 ? 1 : c;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

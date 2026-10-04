/**
 * View frustum as 6 planes (a, b, c, d) packed into a 24-element array, normals pointing inward:
 * a point p is inside plane i when a*x + b*y + c*z + d >= 0. Plane order: left, right, bottom,
 * top, near, far. Planes are normalized, so the plane value is a signed distance.
 */
import type { ReadArray, WriteArray } from './common';

export const OUTSIDE = 0;
export const INTERSECTING = 1;
export const INSIDE = 2;
export type FrustumResult = typeof OUTSIDE | typeof INTERSECTING | typeof INSIDE;

/** Plane mask with all six planes active (start value for `testAABBMasked`). */
export const ALL_PLANES = 0b111111;

export function create(): Float64Array {
  return new Float64Array(24);
}

/** Extracts the planes of a column-major view-projection matrix (WebGL clip space, Gribb-Hartmann). */
export function fromViewProjection<T extends WriteArray>(out: T, m: ReadArray): T {
  // row r of m is (m[r], m[4+r], m[8+r], m[12+r])
  const r0x = m[0], r0y = m[4], r0z = m[8], r0w = m[12];
  const r1x = m[1], r1y = m[5], r1z = m[9], r1w = m[13];
  const r2x = m[2], r2y = m[6], r2z = m[10], r2w = m[14];
  const r3x = m[3], r3y = m[7], r3z = m[11], r3w = m[15];
  setPlane(out, 0, r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w);
  setPlane(out, 1, r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w);
  setPlane(out, 2, r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w);
  setPlane(out, 3, r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w);
  setPlane(out, 4, r3x + r2x, r3y + r2y, r3z + r2z, r3w + r2w);
  setPlane(out, 5, r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w);
  return out;
}

function setPlane(out: WriteArray, i: number, a: number, b: number, c: number, d: number): void {
  const l = Math.sqrt(a * a + b * b + c * c);
  const inv = l > 0 ? 1 / l : 0;
  const o = i * 4;
  out[o] = a * inv;
  out[o + 1] = b * inv;
  out[o + 2] = c * inv;
  // An infinite far plane yields a zero normal; make it accept everything.
  out[o + 3] = l > 0 ? d * inv : Infinity;
}

/**
 * Classifies box [minx, miny, minz, maxx, maxy, maxz] (at `offset` in `box`) against the frustum.
 * Conservative: a box near a frustum corner may be reported INTERSECTING although it is outside.
 */
export function testAABB(planes: ReadArray, box: ReadArray, offset = 0): FrustumResult {
  const r = testAABBMasked(planes, box, ALL_PLANES, offset);
  return r < 0 ? OUTSIDE : r === 0 ? INSIDE : INTERSECTING;
}

/**
 * Hierarchical variant for BVH traversal. `mask` has bit i set for planes the parent box still
 * straddles (pass ALL_PLANES at the root). Returns -1 when the box is outside, otherwise the
 * mask of planes this box straddles; 0 means fully inside, so children need no further tests.
 */
export function testAABBMasked(planes: ReadArray, box: ReadArray, mask: number, offset = 0): number {
  const minx = box[offset], miny = box[offset + 1], minz = box[offset + 2];
  const maxx = box[offset + 3], maxy = box[offset + 4], maxz = box[offset + 5];
  let outMask = 0;
  for (let i = 0; i < 6; i++) {
    const bit = 1 << i;
    if ((mask & bit) === 0) continue;
    const o = i * 4;
    const a = planes[o], b = planes[o + 1], c = planes[o + 2], d = planes[o + 3];
    // p-vertex: corner furthest along the plane normal
    const px = a >= 0 ? maxx : minx, py = b >= 0 ? maxy : miny, pz = c >= 0 ? maxz : minz;
    if (a * px + b * py + c * pz + d < 0) return -1;
    // n-vertex: corner furthest against the normal
    const nx = a >= 0 ? minx : maxx, ny = b >= 0 ? miny : maxy, nz = c >= 0 ? minz : maxz;
    if (a * nx + b * ny + c * nz + d < 0) outMask |= bit;
  }
  return outMask;
}

/** Classifies a sphere against the frustum. */
export function testSphere(planes: ReadArray, cx: number, cy: number, cz: number, radius: number): FrustumResult {
  let result: FrustumResult = INSIDE;
  for (let o = 0; o < 24; o += 4) {
    const dist = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3];
    if (dist < -radius) return OUTSIDE;
    if (dist < radius) result = INTERSECTING;
  }
  return result;
}

/** True if point is inside all planes. */
export function containsPoint(planes: ReadArray, p: ReadArray): boolean {
  for (let o = 0; o < 24; o += 4) {
    if (planes[o] * p[0] + planes[o + 1] * p[1] + planes[o + 2] * p[2] + planes[o + 3] < 0) return false;
  }
  return true;
}

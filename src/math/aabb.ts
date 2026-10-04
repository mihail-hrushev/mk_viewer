/**
 * Axis-aligned boxes stored as [minx, miny, minz, maxx, maxy, maxz]. An empty box has
 * min = +Infinity and max = -Infinity, so union/expand work without special cases.
 * `out` may alias inputs.
 */
import type { ReadArray, WriteArray } from './common';

export function create(): Float64Array {
  return empty(new Float64Array(6));
}

export function create32(): Float32Array {
  return empty(new Float32Array(6));
}

export function empty<T extends WriteArray>(out: T): T {
  out[0] = out[1] = out[2] = Infinity;
  out[3] = out[4] = out[5] = -Infinity;
  return out;
}

export function isEmpty(a: ReadArray): boolean {
  return !(a[0] <= a[3] && a[1] <= a[4] && a[2] <= a[5]);
}

export function set<T extends WriteArray>(
  out: T,
  minx: number,
  miny: number,
  minz: number,
  maxx: number,
  maxy: number,
  maxz: number,
): T {
  out[0] = minx; out[1] = miny; out[2] = minz;
  out[3] = maxx; out[4] = maxy; out[5] = maxz;
  return out;
}

export function copy<T extends WriteArray>(out: T, a: ReadArray): T {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
  out[3] = a[3]; out[4] = a[4]; out[5] = a[5];
  return out;
}

export function union<T extends WriteArray>(out: T, a: ReadArray, b: ReadArray): T {
  out[0] = Math.min(a[0], b[0]);
  out[1] = Math.min(a[1], b[1]);
  out[2] = Math.min(a[2], b[2]);
  out[3] = Math.max(a[3], b[3]);
  out[4] = Math.max(a[4], b[4]);
  out[5] = Math.max(a[5], b[5]);
  return out;
}

/** Union of `out` with the box stored at `src[offset .. offset + 6]` (for SoA bounds arrays). */
export function unionAt<T extends WriteArray>(out: T, src: ReadArray, offset: number): T {
  if (src[offset] < out[0]) out[0] = src[offset];
  if (src[offset + 1] < out[1]) out[1] = src[offset + 1];
  if (src[offset + 2] < out[2]) out[2] = src[offset + 2];
  if (src[offset + 3] > out[3]) out[3] = src[offset + 3];
  if (src[offset + 4] > out[4]) out[4] = src[offset + 4];
  if (src[offset + 5] > out[5]) out[5] = src[offset + 5];
  return out;
}

/** out = a expanded to contain point p. */
export function expandByPoint<T extends WriteArray>(out: T, a: ReadArray, p: ReadArray): T {
  const x = p[0], y = p[1], z = p[2];
  out[0] = Math.min(a[0], x);
  out[1] = Math.min(a[1], y);
  out[2] = Math.min(a[2], z);
  out[3] = Math.max(a[3], x);
  out[4] = Math.max(a[4], y);
  out[5] = Math.max(a[5], z);
  return out;
}

/** In-place expansion by a point given as scalars (no temporary vector needed). */
export function expandByXYZ<T extends WriteArray>(out: T, x: number, y: number, z: number): T {
  if (x < out[0]) out[0] = x;
  if (y < out[1]) out[1] = y;
  if (z < out[2]) out[2] = z;
  if (x > out[3]) out[3] = x;
  if (y > out[4]) out[4] = y;
  if (z > out[5]) out[5] = z;
  return out;
}

/** out = a grown by `margin` on every side. */
export function expandByScalar<T extends WriteArray>(out: T, a: ReadArray, margin: number): T {
  out[0] = a[0] - margin; out[1] = a[1] - margin; out[2] = a[2] - margin;
  out[3] = a[3] + margin; out[4] = a[4] + margin; out[5] = a[5] + margin;
  return out;
}

/** Bounds of xyz triples `positions[start .. end)` (vertex indices). */
export function fromPositions<T extends WriteArray>(out: T, positions: ReadArray, start = 0, end = positions.length / 3): T {
  empty(out);
  for (let i = start * 3, e = end * 3; i < e; i += 3) expandByXYZ(out, positions[i], positions[i + 1], positions[i + 2]);
  return out;
}

/**
 * Bounds of box `a` transformed by the affine matrix `m` (Arvo's method; exact AABB of the
 * transformed box). An empty input stays empty.
 */
export function transformAffine<T extends WriteArray>(out: T, a: ReadArray, m: ReadArray): T {
  if (isEmpty(a)) return empty(out);
  const amin0 = a[0], amin1 = a[1], amin2 = a[2], amax0 = a[3], amax1 = a[4], amax2 = a[5];
  for (let r = 0; r < 3; r++) {
    let lo = m[12 + r], hi = lo;
    // columns 0..2, row r
    let e = m[r] * amin0, f = m[r] * amax0;
    if (e < f) { lo += e; hi += f; } else { lo += f; hi += e; }
    e = m[4 + r] * amin1; f = m[4 + r] * amax1;
    if (e < f) { lo += e; hi += f; } else { lo += f; hi += e; }
    e = m[8 + r] * amin2; f = m[8 + r] * amax2;
    if (e < f) { lo += e; hi += f; } else { lo += f; hi += e; }
    out[r] = lo;
    out[r + 3] = hi;
  }
  return out;
}

export function center<T extends WriteArray>(out: T, a: ReadArray): T {
  out[0] = (a[0] + a[3]) * 0.5;
  out[1] = (a[1] + a[4]) * 0.5;
  out[2] = (a[2] + a[5]) * 0.5;
  return out;
}

export function size<T extends WriteArray>(out: T, a: ReadArray): T {
  out[0] = a[3] - a[0];
  out[1] = a[4] - a[1];
  out[2] = a[5] - a[2];
  return out;
}

/** Length of the box diagonal (0 for empty boxes). */
export function diagonal(a: ReadArray): number {
  if (isEmpty(a)) return 0;
  const x = a[3] - a[0], y = a[4] - a[1], z = a[5] - a[2];
  return Math.sqrt(x * x + y * y + z * z);
}

/** Radius of the bounding sphere centred at the box centre (half diagonal). */
export function radius(a: ReadArray): number {
  return diagonal(a) * 0.5;
}

export function containsPoint(a: ReadArray, p: ReadArray): boolean {
  return p[0] >= a[0] && p[0] <= a[3] && p[1] >= a[1] && p[1] <= a[4] && p[2] >= a[2] && p[2] <= a[5];
}

export function containsBox(a: ReadArray, b: ReadArray): boolean {
  return b[0] >= a[0] && b[1] >= a[1] && b[2] >= a[2] && b[3] <= a[3] && b[4] <= a[4] && b[5] <= a[5];
}

export function intersects(a: ReadArray, b: ReadArray): boolean {
  return a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2];
}

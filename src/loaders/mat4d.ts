/**
 * Float64 4x4 helpers (column-major) for loaders. Kept local to src/loaders so model transforms are
 * composed in double precision (georeferenced coordinates) before reaching the viewer.
 */
import type { Mat4 } from '../types';
import type { UpAxis as UpAxisLike } from './types';

export function identity(out: Float64Array = new Float64Array(16), o = 0): Float64Array {
  for (let i = 0; i < 16; i++) out[o + i] = 0;
  out[o] = out[o + 5] = out[o + 10] = out[o + 15] = 1;
  return out;
}

export function isIdentity(m: Mat4, o = 0): boolean {
  for (let i = 0; i < 16; i++) if (m[o + i] !== (i % 5 === 0 ? 1 : 0)) return false;
  return true;
}

/** out[oo..] = a[ao..] * b[bo..]. `out` may alias neither input region. */
export function multiply(out: Float64Array, oo: number, a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number): void {
  const a00 = a[ao], a01 = a[ao + 1], a02 = a[ao + 2], a03 = a[ao + 3];
  const a10 = a[ao + 4], a11 = a[ao + 5], a12 = a[ao + 6], a13 = a[ao + 7];
  const a20 = a[ao + 8], a21 = a[ao + 9], a22 = a[ao + 10], a23 = a[ao + 11];
  const a30 = a[ao + 12], a31 = a[ao + 13], a32 = a[ao + 14], a33 = a[ao + 15];
  for (let c = 0; c < 4; c++) {
    const b0 = b[bo + c * 4], b1 = b[bo + c * 4 + 1], b2 = b[bo + c * 4 + 2], b3 = b[bo + c * 4 + 3];
    out[oo + c * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[oo + c * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[oo + c * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[oo + c * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
}

/** Compose T * R * S (quaternion x, y, z, w) into out[o..]. Missing parts default to identity. */
export function fromTRS(
  out: Float64Array,
  o: number,
  t: ArrayLike<number> | undefined,
  r: ArrayLike<number> | undefined,
  s: ArrayLike<number> | undefined,
  to = 0,
  ro = 0,
  so = 0,
): void {
  let x = 0, y = 0, z = 0, w = 1;
  if (r) {
    x = r[ro]; y = r[ro + 1]; z = r[ro + 2]; w = r[ro + 3];
    // tolerate slightly denormalized quaternions (exporters write ~7 digits)
    const l = Math.sqrt(x * x + y * y + z * z + w * w);
    if (l > 0 && Math.abs(l - 1) > 1e-12) { x /= l; y /= l; z /= l; w /= l; }
  }
  const sx = s ? s[so] : 1, sy = s ? s[so + 1] : 1, sz = s ? s[so + 2] : 1;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[o] = (1 - (yy + zz)) * sx;
  out[o + 1] = (xy + wz) * sx;
  out[o + 2] = (xz - wy) * sx;
  out[o + 3] = 0;
  out[o + 4] = (xy - wz) * sy;
  out[o + 5] = (1 - (xx + zz)) * sy;
  out[o + 6] = (yz + wx) * sy;
  out[o + 7] = 0;
  out[o + 8] = (xz + wy) * sz;
  out[o + 9] = (yz - wx) * sz;
  out[o + 10] = (1 - (xx + yy)) * sz;
  out[o + 11] = 0;
  out[o + 12] = t ? t[to] : 0;
  out[o + 13] = t ? t[to + 1] : 0;
  out[o + 14] = t ? t[to + 2] : 0;
  out[o + 15] = 1;
}

/** Rotation taking `from`-up coordinates to `to`-up coordinates (null when equal). */
export function upConversion(from: UpAxisLike, to: UpAxisLike): Float64Array | null {
  if (from === to) return null;
  const m = identity();
  if (from === 'y') {
    // Y-up -> Z-up: +90 deg about X: (x, y, z) -> (x, -z, y)
    m[5] = 0; m[6] = 1; m[9] = -1; m[10] = 0;
  } else {
    // Z-up -> Y-up: -90 deg about X: (x, y, z) -> (x, z, -y)
    m[5] = 0; m[6] = -1; m[9] = 1; m[10] = 0;
  }
  return m;
}

/**
 * Expands `out` (min xyz, max xyz) by local box `b` transformed with m[mo..] (Arvo's method).
 */
export function expandTransformedAabb(out: Float64Array, b: ArrayLike<number>, m: ArrayLike<number>, mo: number): void {
  const cx = (b[0] + b[3]) * 0.5, cy = (b[1] + b[4]) * 0.5, cz = (b[2] + b[5]) * 0.5;
  const ex = (b[3] - b[0]) * 0.5, ey = (b[4] - b[1]) * 0.5, ez = (b[5] - b[2]) * 0.5;
  for (let r = 0; r < 3; r++) {
    const m0 = m[mo + r], m1 = m[mo + 4 + r], m2 = m[mo + 8 + r];
    const c = m0 * cx + m1 * cy + m2 * cz + m[mo + 12 + r];
    const e = Math.abs(m0) * ex + Math.abs(m1) * ey + Math.abs(m2) * ez;
    if (c - e < out[r]) out[r] = c - e;
    if (c + e > out[r + 3]) out[r + 3] = c + e;
  }
}

export function emptyAabb(): Float64Array {
  return new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
}

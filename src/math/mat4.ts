/**
 * Column-major 4x4 matrices on plain arrays (gl-matrix / glTF layout): element (row r, col c) is
 * m[c * 4 + r]; translation is m[12..14]. `out` may alias inputs in every function.
 * Projection matrices target WebGL clip space (NDC z in [-1, 1]).
 */
import type { ReadArray, WriteArray } from './common';

export function create(): Float64Array {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function create32(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function identity<T extends WriteArray>(out: T): T {
  for (let i = 0; i < 16; i++) out[i] = 0;
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function copy<T extends WriteArray>(out: T, a: ReadArray): T {
  for (let i = 0; i < 16; i++) out[i] = a[i];
  return out;
}

export function equals(a: ReadArray, b: ReadArray, eps = 1e-9): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > eps * Math.max(1, Math.abs(a[i]), Math.abs(b[i]))) return false;
  return true;
}

/** out = a * b (applies b first, then a). */
export function multiply<T extends WriteArray>(out: T, a: ReadArray, b: ReadArray): T {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let c = 0; c < 16; c += 4) {
    const b0 = b[c], b1 = b[c + 1], b2 = b[c + 2], b3 = b[c + 3];
    out[c] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[c + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[c + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[c + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

export function transpose<T extends WriteArray>(out: T, a: ReadArray): T {
  const a01 = a[1], a02 = a[2], a03 = a[3], a12 = a[6], a13 = a[7], a23 = a[11];
  out[0] = a[0]; out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
  out[4] = a01; out[5] = a[5]; out[6] = a[9]; out[7] = a[13];
  out[8] = a02; out[9] = a12; out[10] = a[10]; out[11] = a[14];
  out[12] = a03; out[13] = a13; out[14] = a23; out[15] = a[15];
  return out;
}

/** General inverse. Returns null (and leaves `out` untouched) when singular. */
export function invert<T extends WriteArray>(out: T, a: ReadArray): T | null {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** Inverse of an affine matrix (last row 0,0,0,1). Faster and more precise than `invert`. */
export function invertAffine<T extends WriteArray>(out: T, a: ReadArray): T | null {
  const m00 = a[0], m10 = a[1], m20 = a[2];
  const m01 = a[4], m11 = a[5], m21 = a[6];
  const m02 = a[8], m12 = a[9], m22 = a[10];
  const tx = a[12], ty = a[13], tz = a[14];
  const c00 = m11 * m22 - m12 * m21;
  const c01 = m12 * m20 - m10 * m22;
  const c02 = m10 * m21 - m11 * m20;
  let det = m00 * c00 + m01 * c01 + m02 * c02;
  if (!det || !Number.isFinite(det)) return null;
  det = 1 / det;
  // inverse 3x3 (row r, col c) = cofactor(c, r) / det
  const i00 = c00 * det;
  const i01 = (m02 * m21 - m01 * m22) * det;
  const i02 = (m01 * m12 - m02 * m11) * det;
  const i10 = c01 * det;
  const i11 = (m00 * m22 - m02 * m20) * det;
  const i12 = (m02 * m10 - m00 * m12) * det;
  const i20 = c02 * det;
  const i21 = (m01 * m20 - m00 * m21) * det;
  const i22 = (m00 * m11 - m01 * m10) * det;
  out[0] = i00; out[1] = i10; out[2] = i20; out[3] = 0;
  out[4] = i01; out[5] = i11; out[6] = i21; out[7] = 0;
  out[8] = i02; out[9] = i12; out[10] = i22; out[11] = 0;
  out[12] = -(i00 * tx + i01 * ty + i02 * tz);
  out[13] = -(i10 * tx + i11 * ty + i12 * tz);
  out[14] = -(i20 * tx + i21 * ty + i22 * tz);
  out[15] = 1;
  return out;
}

/**
 * Perspective projection, vertical field of view `fovy` in radians. `far` may be Infinity.
 */
export function perspective<T extends WriteArray>(out: T, fovy: number, aspect: number, near: number, far: number): T {
  const f = 1 / Math.tan(fovy / 2);
  for (let i = 0; i < 16; i++) out[i] = 0;
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  if (Number.isFinite(far)) {
    const nf = 1 / (near - far);
    out[10] = (far + near) * nf;
    out[14] = 2 * far * near * nf;
  } else {
    out[10] = -1;
    out[14] = -2 * near;
  }
  return out;
}

/** Orthographic projection. */
export function orthographic<T extends WriteArray>(
  out: T,
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): T {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  for (let i = 0; i < 16; i++) out[i] = 0;
  out[0] = -2 * lr;
  out[5] = -2 * bt;
  out[10] = 2 * nf;
  out[12] = (left + right) * lr;
  out[13] = (top + bottom) * bt;
  out[14] = (far + near) * nf;
  out[15] = 1;
  return out;
}

/**
 * View matrix looking from `eye` at `target`. If `up` is (nearly) parallel to the view direction a
 * perpendicular fallback is chosen, so the result is always a valid rigid transform.
 */
export function lookAt<T extends WriteArray>(out: T, eye: ReadArray, target: ReadArray, up: ReadArray): T {
  const ex = eye[0], ey = eye[1], ez = eye[2];
  // z axis points from target to eye
  let zx = ex - target[0], zy = ey - target[1], zz = ez - target[2];
  let l = Math.sqrt(zx * zx + zy * zy + zz * zz);
  if (l === 0) {
    zx = 0; zy = 0; zz = 1;
  } else {
    zx /= l; zy /= l; zz /= l;
  }
  let ux = up[0], uy = up[1], uz = up[2];
  // x = up cross z
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  l = Math.sqrt(xx * xx + xy * xy + xz * xz);
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (l <= 1e-9 * Math.max(ul, 1e-300)) {
    // degenerate: pick the world axis least aligned with z
    const ax = Math.abs(zx), ay = Math.abs(zy), az = Math.abs(zz);
    if (ay <= ax && ay <= az) { ux = 0; uy = 1; uz = 0; }
    else if (az <= ax) { ux = 0; uy = 0; uz = 1; }
    else { ux = 1; uy = 0; uz = 0; }
    xx = uy * zz - uz * zy; xy = uz * zx - ux * zz; xz = ux * zy - uy * zx;
    l = Math.sqrt(xx * xx + xy * xy + xz * xz);
  }
  xx /= l; xy /= l; xz /= l;
  // y = z cross x
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
  return out;
}

/**
 * Compose translation * rotation * scale. `rotation` is a unit quaternion [x, y, z, w].
 */
export function fromTRS<T extends WriteArray>(out: T, translation: ReadArray, rotation: ReadArray, scale: ReadArray): T {
  const x = rotation[0], y = rotation[1], z = rotation[2], w = rotation[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = scale[0], sy = scale[1], sz = scale[2];
  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = translation[0];
  out[13] = translation[1];
  out[14] = translation[2];
  out[15] = 1;
  return out;
}

export function fromTranslation<T extends WriteArray>(out: T, x: number, y: number, z: number): T {
  identity(out);
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}

export function fromScaling<T extends WriteArray>(out: T, x: number, y: number, z: number): T {
  identity(out);
  out[0] = x;
  out[5] = y;
  out[10] = z;
  return out;
}

/** Rotation around the unit vector `axis` by `angle` radians. */
export function fromAxisAngle<T extends WriteArray>(out: T, axis: ReadArray, angle: number): T {
  const x = axis[0], y = axis[1], z = axis[2];
  const s = Math.sin(angle), c = Math.cos(angle), t = 1 - c;
  out[0] = x * x * t + c;
  out[1] = y * x * t + z * s;
  out[2] = z * x * t - y * s;
  out[3] = 0;
  out[4] = x * y * t - z * s;
  out[5] = y * y * t + c;
  out[6] = z * y * t + x * s;
  out[7] = 0;
  out[8] = x * z * t + y * s;
  out[9] = y * z * t - x * s;
  out[10] = z * z * t + c;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

/** Quaternion [x, y, z, w] for a rotation around the unit `axis` (helper for fromTRS). */
export function quatFromAxisAngle<T extends WriteArray>(out: T, axis: ReadArray, angle: number): T {
  const s = Math.sin(angle / 2);
  out[0] = axis[0] * s;
  out[1] = axis[1] * s;
  out[2] = axis[2] * s;
  out[3] = Math.cos(angle / 2);
  return out;
}

/** Transforms point `p` (w = 1) including the perspective divide. */
export function transformPoint<T extends WriteArray>(out: T, m: ReadArray, p: ReadArray): T {
  const x = p[0], y = p[1], z = p[2];
  let w = m[3] * x + m[7] * y + m[11] * z + m[15];
  w = w !== 0 ? 1 / w : 1;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;
  return out;
}

/** Transforms direction `d` (w = 0) by the upper 3x3. The result is not normalized. */
export function transformDirection<T extends WriteArray>(out: T, m: ReadArray, d: ReadArray): T {
  const x = d[0], y = d[1], z = d[2];
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

export function getTranslation<T extends WriteArray>(out: T, m: ReadArray): T {
  out[0] = m[12];
  out[1] = m[13];
  out[2] = m[14];
  return out;
}

/** Largest axis scale factor of the upper 3x3 (scales bounding-sphere radii). */
export function maxScale(m: ReadArray): number {
  const sx = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  const sy = m[4] * m[4] + m[5] * m[5] + m[6] * m[6];
  const sz = m[8] * m[8] + m[9] * m[9] + m[10] * m[10];
  return Math.sqrt(Math.max(sx, sy, sz));
}

/** True if the bottom row is (0, 0, 0, 1). */
export function isAffine(m: ReadArray): boolean {
  return m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1;
}

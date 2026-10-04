/**
 * vec3 helpers on plain arrays with out-parameters (gl-matrix style). `out` may alias inputs.
 */
import type { ReadArray, WriteArray } from './common';

export function create(x = 0, y = 0, z = 0): Float64Array {
  const out = new Float64Array(3);
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function set<T extends WriteArray>(out: T, x: number, y: number, z: number): T {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function copy<T extends WriteArray>(out: T, a: ReadArray): T {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

export function add<T extends WriteArray>(out: T, a: ReadArray, b: ReadArray): T {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function sub<T extends WriteArray>(out: T, a: ReadArray, b: ReadArray): T {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function scale<T extends WriteArray>(out: T, a: ReadArray, s: number): T {
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  out[2] = a[2] * s;
  return out;
}

/** out = a + b * s */
export function scaleAndAdd<T extends WriteArray>(out: T, a: ReadArray, b: ReadArray, s: number): T {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  return out;
}

export function negate<T extends WriteArray>(out: T, a: ReadArray): T {
  out[0] = -a[0];
  out[1] = -a[1];
  out[2] = -a[2];
  return out;
}

export function dot(a: ReadArray, b: ReadArray): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross<T extends WriteArray>(out: T, a: ReadArray, b: ReadArray): T {
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}

export function length(a: ReadArray): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

export function lengthSq(a: ReadArray): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function distance(a: ReadArray, b: ReadArray): number {
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return Math.sqrt(x * x + y * y + z * z);
}

export function distanceSq(a: ReadArray, b: ReadArray): number {
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return x * x + y * y + z * z;
}

/** Normalizes `a` into `out`; a zero vector stays zero. */
export function normalize<T extends WriteArray>(out: T, a: ReadArray): T {
  const x = a[0], y = a[1], z = a[2];
  const l2 = x * x + y * y + z * z;
  const inv = l2 > 0 ? 1 / Math.sqrt(l2) : 0;
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
  return out;
}

export function lerp<T extends WriteArray>(out: T, a: ReadArray, b: ReadArray, t: number): T {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export function equals(a: ReadArray, b: ReadArray, eps = 1e-9): boolean {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;
}

/** Rotates `v` around the unit vector `axis` by `angle` radians (Rodrigues, right-hand rule). */
export function rotateAxis<T extends WriteArray>(out: T, v: ReadArray, axis: ReadArray, angle: number): T {
  const c = Math.cos(angle), s = Math.sin(angle);
  const kx = axis[0], ky = axis[1], kz = axis[2];
  const vx = v[0], vy = v[1], vz = v[2];
  const kd = (kx * vx + ky * vy + kz * vz) * (1 - c);
  out[0] = vx * c + (ky * vz - kz * vy) * s + kx * kd;
  out[1] = vy * c + (kz * vx - kx * vz) * s + ky * kd;
  out[2] = vz * c + (kx * vy - ky * vx) * s + kz * kd;
  return out;
}

/** Writes any unit vector perpendicular to the unit vector `a`. */
export function anyPerpendicular<T extends WriteArray>(out: T, a: ReadArray): T {
  const ax = Math.abs(a[0]), ay = Math.abs(a[1]), az = Math.abs(a[2]);
  // cross with the axis least aligned with a
  let x: number, y: number, z: number;
  if (ax <= ay && ax <= az) {
    x = 0; y = a[2]; z = -a[1];
  } else if (ay <= az) {
    x = -a[2]; y = 0; z = a[0];
  } else {
    x = a[1]; y = -a[0]; z = 0;
  }
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
  return out;
}

/**
 * Spherical interpolation between unit vectors `a` and `b`. Handles nearly opposite vectors by
 * rotating around a perpendicular axis (`hint` if given and usable, otherwise arbitrary).
 */
export function slerp<T extends WriteArray>(out: T, a: ReadArray, b: ReadArray, t: number, hint?: ReadArray): T {
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  let d = ax * bx + ay * by + az * bz;
  if (d > 0.9999995) {
    out[0] = ax + (bx - ax) * t;
    out[1] = ay + (by - ay) * t;
    out[2] = az + (bz - az) * t;
    return normalize(out, out);
  }
  if (d < -0.9999995) {
    // rotate a by t*pi around an axis perpendicular to a
    let px = 0, py = 0, pz = 0;
    if (hint) {
      const hd = hint[0] * ax + hint[1] * ay + hint[2] * az;
      px = hint[0] - ax * hd; py = hint[1] - ay * hd; pz = hint[2] - az * hd;
    }
    const pl = Math.sqrt(px * px + py * py + pz * pz);
    if (pl < 1e-6) {
      anyPerpendicular(out, a);
      px = out[0]; py = out[1]; pz = out[2];
    } else {
      px /= pl; py /= pl; pz /= pl;
    }
    // axis = a x p ; rotating a around it moves a toward p
    const kx = ay * pz - az * py, ky = az * px - ax * pz, kz = ax * py - ay * px;
    const ang = Math.PI * t;
    const c = Math.cos(ang), s = Math.sin(ang);
    // a is perpendicular to k, so Rodrigues reduces to a*c + (k x a)*s, and k x a = p
    out[0] = ax * c + (ky * az - kz * ay) * s;
    out[1] = ay * c + (kz * ax - kx * az) * s;
    out[2] = az * c + (kx * ay - ky * ax) * s;
    return out;
  }
  d = Math.min(1, Math.max(-1, d));
  const theta = Math.acos(d);
  const sinT = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinT;
  const wb = Math.sin(t * theta) / sinT;
  out[0] = ax * wa + bx * wb;
  out[1] = ay * wa + by * wb;
  out[2] = az * wa + bz * wb;
  return out;
}

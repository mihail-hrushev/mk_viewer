/**
 * Large world coordinates without a layout change.
 *
 * Fragment records, item bounds and the GPU matrices are float32. At |x| ~ 1e7 a float32 has a
 * resolution of 1 unit, so geometry would visibly quantize and jitter. The Viewer therefore works in
 * an origin-relative space internally:
 *
 *  - Geometry is recentred at creation: positions are shifted (in float64) so the local AABB centre
 *    is at 0, and the offset is remembered per geometry handle. Huge local coordinates (e.g. survey
 *    data baked into vertices) thus never reach the quantizer, whose dequant offset is float32.
 *  - A float64 scene origin is chosen from the first mesh added (its world AABB centre) and then
 *    kept. Every transform handed to the core is   T(-origin) * M * T(geometryOffset),   computed in
 *    float64, so the core only ever sees small numbers.
 *  - The camera runs in the same relative space; the Viewer converts at the API boundary
 *    (getCamera/setCamera, pick positions, getBounds, section planes).
 *
 * Pure functions, unit tested in origin.test.ts.
 */

/**
 * Writes the core transform for a mesh: out = T(-origin) * M * T(offset), column-major, affine.
 * `m` is read at `mo` (16 numbers; null = identity), `out` written at `oo`. All maths in float64;
 * `out` may be a Float32Array (the precision loss then only affects small relative values).
 */
export function foldTransform(
  m: ArrayLike<number> | null,
  mo: number,
  offset: ArrayLike<number>,
  origin: ArrayLike<number>,
  out: Float32Array | Float64Array | number[],
  oo: number,
): void {
  const ox = offset[0], oy = offset[1], oz = offset[2];
  if (m === null) {
    out[oo] = 1; out[oo + 1] = 0; out[oo + 2] = 0; out[oo + 3] = 0;
    out[oo + 4] = 0; out[oo + 5] = 1; out[oo + 6] = 0; out[oo + 7] = 0;
    out[oo + 8] = 0; out[oo + 9] = 0; out[oo + 10] = 1; out[oo + 11] = 0;
    out[oo + 12] = ox - origin[0];
    out[oo + 13] = oy - origin[1];
    out[oo + 14] = oz - origin[2];
    out[oo + 15] = 1;
    return;
  }
  const a0 = +m[mo], a1 = +m[mo + 1], a2 = +m[mo + 2];
  const b0 = +m[mo + 4], b1 = +m[mo + 5], b2 = +m[mo + 6];
  const c0 = +m[mo + 8], c1 = +m[mo + 9], c2 = +m[mo + 10];
  // translation = M3 * offset + t - origin  (float64: the large terms cancel before rounding)
  const tx = a0 * ox + b0 * oy + c0 * oz + (+m[mo + 12] - origin[0]);
  const ty = a1 * ox + b1 * oy + c1 * oz + (+m[mo + 13] - origin[1]);
  const tz = a2 * ox + b2 * oy + c2 * oz + (+m[mo + 14] - origin[2]);
  out[oo] = a0; out[oo + 1] = a1; out[oo + 2] = a2; out[oo + 3] = 0;
  out[oo + 4] = b0; out[oo + 5] = b1; out[oo + 6] = b2; out[oo + 7] = 0;
  out[oo + 8] = c0; out[oo + 9] = c1; out[oo + 10] = c2; out[oo + 11] = 0;
  out[oo + 12] = tx; out[oo + 13] = ty; out[oo + 14] = tz; out[oo + 15] = 1;
}

/**
 * World-space centre of the mesh's AABB centre point: M * offset (the geometry's local AABB
 * centre is at `offset` before recentring). Used to pick the scene origin.
 */
export function transformedCenter(m: ArrayLike<number> | null, mo: number, offset: ArrayLike<number>, out: Float64Array): void {
  const x = offset[0], y = offset[1], z = offset[2];
  if (m === null) {
    out[0] = x; out[1] = y; out[2] = z;
    return;
  }
  out[0] = +m[mo] * x + +m[mo + 4] * y + +m[mo + 8] * z + +m[mo + 12];
  out[1] = +m[mo + 1] * x + +m[mo + 5] * y + +m[mo + 9] * z + +m[mo + 13];
  out[2] = +m[mo + 2] * x + +m[mo + 6] * y + +m[mo + 10] * z + +m[mo + 14];
}

/** AABB centre of xyz positions in float64 into out (0,0,0 when empty). */
export function positionsCenter(positions: ArrayLike<number>, out: Float64Array): void {
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = +positions[i], y = +positions[i + 1], z = +positions[i + 2];
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
    if (z < minz) minz = z;
    if (z > maxz) maxz = z;
  }
  if (!(minx <= maxx)) {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  out[0] = (minx + maxx) * 0.5;
  out[1] = (miny + maxy) * 0.5;
  out[2] = (minz + maxz) * 0.5;
  // non-finite input is reported by the geometry store; do not shift by NaN
  if (!Number.isFinite(out[0] + out[1] + out[2])) out[0] = out[1] = out[2] = 0;
}

/**
 * Whether recentring by `c` is worth a copy: when the centre is far from 0 compared to the
 * geometry's float32 resolution needs. Small shifts are skipped to avoid copying every primitive.
 */
export function needsRecentre(c: ArrayLike<number>): boolean {
  return c[0] !== 0 || c[1] !== 0 || c[2] !== 0;
}

/** positions - c, in float64. */
export function shiftPositions(positions: ArrayLike<number>, c: ArrayLike<number>): Float64Array {
  const n = positions.length - (positions.length % 3);
  const out = new Float64Array(positions.length);
  for (let i = 0; i < n; i += 3) {
    out[i] = +positions[i] - c[0];
    out[i + 1] = +positions[i + 1] - c[1];
    out[i + 2] = +positions[i + 2] - c[2];
  }
  return out;
}

/**
 * Pure (context-free) helpers mirroring GLSL code in src/gl/shaders, so the maths can be unit tested
 * and reused by the renderer: id packing, depth bits, octahedral normals, cofactor normals,
 * unprojection, view-space section planes.
 */

// ---------------------------------------------------------------------------
// Id target: fragment index + 1 as a little-endian u32 in RGBA8 (0 = background)
// ---------------------------------------------------------------------------

/** Writes the RGBA8 bytes the shader writes for `fragmentIndex` (or background when < 0). */
export function encodeIdBytes(fragmentIndex: number, out: Uint8Array, offset = 0): void {
  const v = fragmentIndex < 0 ? 0 : (fragmentIndex + 1) >>> 0;
  out[offset] = v & 255;
  out[offset + 1] = (v >>> 8) & 255;
  out[offset + 2] = (v >>> 16) & 255;
  out[offset + 3] = (v >>> 24) & 255;
}

/** Decodes RGBA8 id bytes to a fragment index, or -1 for background. */
export function decodeIdBytes(bytes: Uint8Array, offset = 0): number {
  const v =
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  return v - 1;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Reassembles a float32 from 4 little-endian bytes (as written by the pick-resolve shader). */
export function decodeFloatBytes(bytes: Uint8Array, offset = 0): number {
  u32[0] =
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  return f32[0];
}

/** Inverse of decodeFloatBytes (tests). */
export function encodeFloatBytes(v: number, out: Uint8Array, offset = 0): void {
  f32[0] = v;
  const b = u32[0];
  out[offset] = b & 255;
  out[offset + 1] = (b >>> 8) & 255;
  out[offset + 2] = (b >>> 16) & 255;
  out[offset + 3] = (b >>> 24) & 255;
}

// ---------------------------------------------------------------------------
// Octahedral normals (2 x snorm8), mirror of octDecode() in GLSL
// ---------------------------------------------------------------------------

/** GL ES 3.0 signed-normalized conversion: max(c / 127, -1). */
export function snorm8ToFloat(c: number): number {
  return Math.max(c / 127, -1);
}

export function floatToSnorm8(f: number): number {
  return Math.round(Math.min(1, Math.max(-1, f)) * 127);
}

/**
 * Octahedral encoding (Cigolle et al. 2014) into two snorm8 values. Writes out[offset], out[offset+1].
 * This is the encoding the GLSL decoder expects; src/core must produce exactly this.
 */
export function octEncodeSnorm8(
  x: number,
  y: number,
  z: number,
  out: Int8Array | number[],
  offset = 0,
): void {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let px = x / l1;
  let py = y / l1;
  if (z < 0) {
    const ox = px;
    px = (1 - Math.abs(py)) * (ox >= 0 ? 1 : -1);
    py = (1 - Math.abs(ox)) * (py >= 0 ? 1 : -1);
  }
  out[offset] = floatToSnorm8(px);
  out[offset + 1] = floatToSnorm8(py);
}

/** Mirror of GLSL octDecode(vec2 e) for e in [-1, 1]^2. Returns a unit vector in out. */
export function octDecode(ex: number, ey: number, out: Float32Array | number[]): void {
  let x = ex;
  let y = ey;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const t = Math.max(-z, 0);
  x += x >= 0 ? -t : t;
  y += y >= 0 ? -t : t;
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
}

// ---------------------------------------------------------------------------
// Normal transform: cofactor of the 3x3 part of the fragment matrix (rows r0, r1, r2)
// ---------------------------------------------------------------------------

/**
 * Mirror of the vertex shader: n' = n * mat3(cross(r1,r2), cross(r2,r0), cross(r0,r1)), where r0..r2
 * are the matrix rows as stored in fragment record texels 0..2. Equals det(M) * inverse(M)^T * n.
 * `rows` is the 12-float row-major record prefix.
 */
export function cofactorTransformNormal(rows: ArrayLike<number>, n: ArrayLike<number>, out: Float32Array | number[]): void {
  const a0 = rows[0], a1 = rows[1], a2 = rows[2];
  const b0 = rows[4], b1 = rows[5], b2 = rows[6];
  const c0 = rows[8], c1 = rows[9], c2 = rows[10];
  // cross(r1, r2), cross(r2, r0), cross(r0, r1)
  const x0 = b1 * c2 - b2 * c1, x1 = b2 * c0 - b0 * c2, x2 = b0 * c1 - b1 * c0;
  const y0 = c1 * a2 - c2 * a1, y1 = c2 * a0 - c0 * a2, y2 = c0 * a1 - c1 * a0;
  const z0 = a1 * b2 - a2 * b1, z1 = a2 * b0 - a0 * b2, z2 = a0 * b1 - a1 * b0;
  const nx = n[0], ny = n[1], nz = n[2];
  out[0] = nx * x0 + ny * x1 + nz * x2;
  out[1] = nx * y0 + ny * y1 + nz * y2;
  out[2] = nx * z0 + ny * z1 + nz * z2;
}

// ---------------------------------------------------------------------------
// Depth / unprojection
// ---------------------------------------------------------------------------

/**
 * Unprojects a pick sample to world space.
 * @param px,py   pixel coordinates in the render target, GL convention (origin bottom-left), use
 *                pixel centres (x + 0.5).
 * @param depth   window-space depth in [0, 1] as returned by PixelReader (depthRange 0..1).
 * @param invViewProj  column-major inverse of (projection * view).
 * @returns false when the point is at infinity / invalid.
 */
export function unprojectDepth(
  px: number,
  py: number,
  width: number,
  height: number,
  depth: number,
  invViewProj: ArrayLike<number>,
  out: Float32Array | number[],
): boolean {
  const x = (px / width) * 2 - 1;
  const y = (py / height) * 2 - 1;
  const z = depth * 2 - 1;
  const m = invViewProj;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!(Math.abs(w) > 1e-30)) return false;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return true;
}

/** Positive view-space distance along -Z for a window depth (standard GL projection). */
export function linearizeDepth(depth: number, near: number, far: number, orthographic: boolean): number {
  const z = depth * 2 - 1;
  if (orthographic) return ((z + 1) * (far - near)) / 2 + near;
  return (2 * near * far) / (far + near - z * (far - near));
}

// ---------------------------------------------------------------------------
// Section planes
// ---------------------------------------------------------------------------

/**
 * Converts world-space planes (a, b, c, d) with "cut where a*x + b*y + c*z + d > 0" into view space
 * for the uber-shader uniform u_sectionPlanes. `view` is the column-major rigid view matrix.
 * `planes` and `out` hold `count` vec4s.
 */
export function planesToViewSpace(
  planes: ArrayLike<number>,
  count: number,
  view: ArrayLike<number>,
  out: Float32Array,
): void {
  // world plane p, world point X = V^-1 * Xv  =>  view plane = p * V^-1 = (V^-T p).
  // For a rigid V = [R t]: n_v = R n, d_v = d - dot(R n, t).
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const a = planes[o], b = planes[o + 1], c = planes[o + 2], d = planes[o + 3];
    const nx = view[0] * a + view[4] * b + view[8] * c;
    const ny = view[1] * a + view[5] * b + view[9] * c;
    const nz = view[2] * a + view[6] * b + view[10] * c;
    out[o] = nx;
    out[o + 1] = ny;
    out[o + 2] = nz;
    out[o + 3] = d - (nx * view[12] + ny * view[13] + nz * view[14]);
  }
}

/** World plane from a normal and a point: cut side is where dot(n, x - p) > 0. */
export function planeFromNormalPoint(
  nx: number, ny: number, nz: number,
  px: number, py: number, pz: number,
  out: Float32Array | number[],
  offset = 0,
): void {
  const l = Math.hypot(nx, ny, nz) || 1;
  const a = nx / l, b = ny / l, c = nz / l;
  out[offset] = a;
  out[offset + 1] = b;
  out[offset + 2] = c;
  out[offset + 3] = -(a * px + b * py + c * pz);
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

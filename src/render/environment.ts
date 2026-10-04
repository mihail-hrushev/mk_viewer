/**
 * Image-based lighting, CPU side (pure functions, no GL): Radiance .hdr parsing, the procedural
 * 'studio' preset, and preparation of an equirectangular HDR image for the uber-shader.
 *
 * Equirectangular convention (environment-local frame, +Y is the image's up / sky):
 *   u = 0.5 + atan(d.x, -d.z) / 2pi   (image centre column looks along -Z, u = 0.75 along +X)
 *   v = acos(d.y) / pi                (top row = zenith, bottom row = nadir)
 * Rows are stored top (sky) first, which is also the order of a standard `-Y h +X w` .hdr file.
 * The renderer maps the world up axis onto +Y (see Renderer.setEnvironment).
 *
 * Preparation (`prepareEnvironment`):
 *  1. area-averaged resampling to ENV_WIDTH x ENV_HEIGHT (solid-angle weighted between rows), so small
 *     bright sources keep their energy;
 *  2. 9 spherical-harmonic coefficients of the irradiance, pre-multiplied so the shader evaluates a
 *     plain polynomial that returns irradiance / pi (the "ambient colour" a white Lambertian surface
 *     reflects);
 *  3. auto-exposure: everything is scaled so the irradiance averaged over all normal directions has
 *     luminance ENV_TARGET_LUMINANCE (arbitrary HDR files then give a consistent exposure and the
 *     public `intensity` option is a relative control);
 *  4. the specular image is clamped to ENV_MAX_LUMINANCE (no fireflies from a sun, stays far inside
 *     half-float range) and a full mip chain is built, each level a solid-angle weighted 2x2 box
 *     downsample of the previous one followed by a 1 / sin(theta) wide horizontal blur that keeps
 *     texel footprints isotropic near the poles (both energy-conserving), for roughness-based
 *     lookups. This is a box-filter pyramid, not a GGX prefilter: blurred reflections are a little
 *     blockier / less accurate in lobe shape than a true split-sum prefiltered map.
 */

/** Linear RGB equirectangular pixels, 3 floats per pixel, rows top (sky) to bottom. */
export interface EnvironmentPixels {
  width: number;
  height: number;
  data: Float32Array;
}

/** One mip level of the prepared environment: RGBA floats (alpha 1), rows top to bottom. */
export interface EnvironmentLevel {
  width: number;
  height: number;
  data: Float32Array;
}

export interface PreparedEnvironment {
  /** Mip chain, level 0 = ENV_WIDTH x ENV_HEIGHT down to 1 x 1. */
  levels: EnvironmentLevel[];
  /**
   * 27 floats: 9 rgb coefficients of irradiance / pi in the environment-local frame, for the
   * polynomial basis 1, y, z, x, xy, yz, 3z^2 - 1, xz, x^2 - y^2 (see `evalIrradianceSH`).
   */
  sh: Float32Array;
  /** Shader mip selection: lod = log2(roughness^2 * lodScale), clamped to the chain. */
  lodScale: number;
  /** Scale applied to the input radiance by the auto-exposure. */
  exposure: number;
}

export const ENV_WIDTH = 512;
export const ENV_HEIGHT = 256;
/** Luminance of the mean irradiance / pi after auto-exposure. */
export const ENV_TARGET_LUMINANCE = 0.46;
/** Specular texels are clamped to this luminance (after exposure). */
export const ENV_MAX_LUMINANCE = 40;
/** Input values above this are treated as this (keeps sums finite). */
const INPUT_MAX = 1e9;
const HALF_MAX = 65000;

const HDR_ONLY =
  'only Radiance RGBE .hdr files are supported (OpenEXR and other formats are not; convert the image to .hdr)';

// -------------------------------------------------------------------------------------------------
// Radiance .hdr

/**
 * Parses a Radiance RGBE (.hdr / .pic) file: `#?RADIANCE` or `#?RGBE` header, FORMAT=32-bit_rle_rgbe,
 * resolution `-Y h +X w`, new-style adaptive run-length encoded or flat scanlines. Throws an Error
 * with a readable message for anything else.
 */
export function parseHdr(input: ArrayBuffer | Uint8Array): EnvironmentPixels {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const len = b.length;
  let p = 0;
  const line = (): string | null => {
    const s = p;
    while (p < len && b[p] !== 0x0a) p++;
    if (p >= len) return null;
    let str = '';
    for (let i = s; i < p; i++) str += String.fromCharCode(b[i]);
    p++;
    return str.endsWith('\r') ? str.slice(0, -1) : str;
  };
  const truncated = (): Error => new Error('mk-viewer: the .hdr file is truncated');

  // the magic must be at the very start: do not scan a large binary file for a newline first
  if (len < 2 || b[0] !== 0x23 || b[1] !== 0x3f) throw new Error(`mk-viewer: not a Radiance .hdr file; ${HDR_ONLY}`);
  const magic = line();
  if (magic === null || !/^#\?(RADIANCE|RGBE)\b/.test(magic)) {
    throw new Error(`mk-viewer: not a Radiance .hdr file; ${HDR_ONLY}`);
  }
  let format: string | null = null;
  for (;;) {
    const l = line();
    if (l === null) throw truncated();
    if (l === '') break;
    if (l.startsWith('FORMAT=')) format = l.slice(7).trim();
  }
  if (format !== null && format !== '32-bit_rle_rgbe') {
    throw new Error(`mk-viewer: unsupported .hdr pixel format '${format}' (only 32-bit_rle_rgbe; XYZE is not supported)`);
  }
  const res = line();
  if (res === null) throw truncated();
  const m = /^\s*-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/.exec(res);
  if (!m) {
    throw new Error(`mk-viewer: unsupported .hdr orientation '${res.trim()}' (only the standard '-Y height +X width')`);
  }
  const h = parseInt(m[1], 10);
  const w = parseInt(m[2], 10);
  if (!(w > 0 && h > 0) || w * h > 1 << 27) throw new Error(`mk-viewer: invalid .hdr size ${w} x ${h}`);

  const exp = new Float32Array(256);
  for (let e = 1; e < 256; e++) exp[e] = Math.pow(2, e - 136); // value = mantissa * 2^(e - 128 - 8)
  const out = new Float32Array(w * h * 3);
  const scan = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    if (w >= 8 && w < 0x8000 && p + 4 <= len && b[p] === 2 && b[p + 1] === 2 && ((b[p + 2] << 8) | b[p + 3]) === w) {
      // new-style RLE: the four channels one after another, each as runs / literal blocks
      p += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < w) {
          if (p >= len) throw truncated();
          let n = b[p++];
          if (n > 128) {
            n -= 128;
            if (x + n > w) throw new Error('mk-viewer: corrupt .hdr scanline (run too long)');
            if (p >= len) throw truncated();
            const v = b[p++];
            for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = v;
          } else {
            if (n === 0 || x + n > w) throw new Error('mk-viewer: corrupt .hdr scanline');
            if (p + n > len) throw truncated();
            for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = b[p++];
          }
        }
      }
    } else {
      // flat RGBE pixels
      if (p + w * 4 > len) throw truncated();
      scan.set(b.subarray(p, p + w * 4));
      p += w * 4;
    }
    let o = y * w * 3;
    for (let x = 0; x < w; x++) {
      const f = exp[scan[x * 4 + 3]];
      out[o++] = scan[x * 4] * f;
      out[o++] = scan[x * 4 + 1] * f;
      out[o++] = scan[x * 4 + 2] * f;
    }
  }
  return { width: w, height: h, data: out };
}

// -------------------------------------------------------------------------------------------------
// preparation

/** Direction of the centre of equirect pixel (x, y) of a w x h image, environment-local frame. */
export function equirectDirection(x: number, y: number, w: number, h: number, out: number[] | Float64Array): void {
  const theta = (Math.PI * (y + 0.5)) / h;
  const phi = 2 * Math.PI * ((x + 0.5) / w - 0.5);
  const s = Math.sin(theta);
  out[0] = s * Math.sin(phi);
  out[1] = Math.cos(theta);
  out[2] = -s * Math.cos(phi);
}

/** Solid angle of one pixel of row y in a w x h equirect image. */
function rowSolidAngle(y: number, w: number, h: number): number {
  return ((2 * Math.PI) / w) * (Math.cos((Math.PI * y) / h) - Math.cos((Math.PI * (y + 1)) / h));
}

function sanitize(v: number): number {
  return v > 0 ? (v < INPUT_MAX ? v : INPUT_MAX) : 0; // NaN and negatives -> 0
}

/** Validates raw pixels; throws for an inconsistent image. */
export function checkPixels(img: EnvironmentPixels): void {
  const { width, height, data } = img;
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) {
    throw new Error(`mk-viewer: invalid environment size ${width} x ${height}`);
  }
  if (!(data instanceof Float32Array) || data.length < width * height * 3) {
    throw new Error('mk-viewer: environment data must be a Float32Array of width * height * 3 linear RGB values');
  }
}

/**
 * Area-averaged resampling of an equirect image to w x h (RGB). Columns are averaged with their
 * coverage, rows additionally with their solid angle.
 */
export function resampleEquirect(src: EnvironmentPixels, w: number, h: number): Float32Array {
  checkPixels(src);
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;
  // horizontal pass: every source row to w columns
  const tmp = new Float32Array(sh * w * 3);
  const rx = sw / w;
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 3;
    for (let x = 0; x < w; x++) {
      const s0 = x * rx;
      const s1 = (x + 1) * rx;
      let r = 0, g = 0, bl = 0, ws = 0;
      for (let k = Math.floor(s0); k < s1 && k < sw; k++) {
        const wt = Math.min(s1, k + 1) - Math.max(s0, k);
        if (wt <= 0) continue;
        const i = row + k * 3;
        r += sanitize(sd[i]) * wt;
        g += sanitize(sd[i + 1]) * wt;
        bl += sanitize(sd[i + 2]) * wt;
        ws += wt;
      }
      const o = (y * w + x) * 3;
      tmp[o] = r / ws;
      tmp[o + 1] = g / ws;
      tmp[o + 2] = bl / ws;
    }
  }
  // vertical pass, weights = solid angle of the overlap (cos(theta_a) - cos(theta_b))
  const out = new Float32Array(w * h * 3);
  const ry = sh / h;
  for (let y = 0; y < h; y++) {
    const s0 = y * ry;
    const s1 = (y + 1) * ry;
    const k0 = Math.floor(s0);
    for (let k = k0; k < s1 && k < sh; k++) {
      const a = Math.max(s0, k);
      const c = Math.min(s1, k + 1);
      if (c <= a) continue;
      let wt = Math.cos((Math.PI * a) / sh) - Math.cos((Math.PI * c) / sh);
      if (!(wt > 0)) wt = 1e-12; // keep degenerate rows defined
      const ti = k * w * 3;
      const o = y * w * 3;
      for (let i = 0; i < w * 3; i++) out[o + i] += tmp[ti + i] * wt;
    }
    // normalise
    let wsum = 0;
    for (let k = k0; k < s1 && k < sh; k++) {
      const a = Math.max(s0, k);
      const c = Math.min(s1, k + 1);
      if (c <= a) continue;
      const wt = Math.cos((Math.PI * a) / sh) - Math.cos((Math.PI * c) / sh);
      wsum += wt > 0 ? wt : 1e-12;
    }
    const o = y * w * 3;
    for (let i = 0; i < w * 3; i++) out[o + i] /= wsum;
  }
  return out;
}

const K0 = 0.5 / Math.sqrt(Math.PI);
const K1 = Math.sqrt(3 / (4 * Math.PI));
const K2 = Math.sqrt(15 / (4 * Math.PI));
const K20 = Math.sqrt(5 / (16 * Math.PI));
const K22 = Math.sqrt(15 / (16 * Math.PI));
/** Real SH normalisation constants of the polynomial basis below. */
const SH_K = [K0, K1, K1, K1, K2, K2, K20, K2, K22];
/** Convolution with the clamped cosine, divided by pi: A_l / pi for l = 0, 1, 2. */
const SH_A = [1, 2 / 3, 2 / 3, 2 / 3, 0.25, 0.25, 0.25, 0.25, 0.25];

function shPoly(x: number, y: number, z: number, out: Float64Array): void {
  out[0] = 1;
  out[1] = y;
  out[2] = z;
  out[3] = x;
  out[4] = x * y;
  out[5] = y * z;
  out[6] = 3 * z * z - 1;
  out[7] = x * z;
  out[8] = x * x - y * y;
}

/**
 * Pre-multiplied irradiance SH (27 floats, see PreparedEnvironment.sh) of a w x h RGB equirect
 * image, solid-angle weighted. No exposure applied.
 */
export function irradianceSH(rgb: Float32Array, w: number, h: number): Float32Array {
  const acc = new Float64Array(27);
  const poly = new Float64Array(9);
  const d = new Float64Array(3);
  for (let y = 0; y < h; y++) {
    const dw = rowSolidAngle(y, w, h);
    for (let x = 0; x < w; x++) {
      equirectDirection(x, y, w, h, d);
      shPoly(d[0], d[1], d[2], poly);
      const i = (y * w + x) * 3;
      const r = rgb[i] * dw, g = rgb[i + 1] * dw, b = rgb[i + 2] * dw;
      for (let k = 0; k < 9; k++) {
        const yk = SH_K[k] * poly[k];
        acc[k * 3] += r * yk;
        acc[k * 3 + 1] += g * yk;
        acc[k * 3 + 2] += b * yk;
      }
    }
  }
  const out = new Float32Array(27);
  for (let k = 0; k < 9; k++) {
    const s = SH_A[k] * SH_K[k];
    for (let c = 0; c < 3; c++) out[k * 3 + c] = acc[k * 3 + c] * s;
  }
  return out;
}

/** Evaluates pre-multiplied SH for unit normal n (environment-local), like the shader. */
export function evalIrradianceSH(sh: ArrayLike<number>, x: number, y: number, z: number, out: number[] | Float64Array): void {
  const p = new Float64Array(9);
  shPoly(x, y, z, p);
  for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let k = 0; k < 9; k++) s += sh[k * 3 + c] * p[k];
    out[c] = Math.max(s, 0);
  }
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Solid-angle weighted 2x2 box downsample (energy conserving); 1-texel dimensions stay 1. */
export function downsampleLevel(src: EnvironmentLevel): EnvironmentLevel {
  const { width: w, height: h, data: s } = src;
  const w2 = Math.max(1, w >> 1);
  const h2 = Math.max(1, h >> 1);
  const fx = w2 < w ? 2 : 1;
  const fy = h2 < h ? 2 : 1;
  const out = new Float32Array(w2 * h2 * 4);
  for (let y2 = 0; y2 < h2; y2++) {
    for (let x2 = 0; x2 < w2; x2++) {
      let r = 0, g = 0, b = 0, ws = 0;
      for (let dy = 0; dy < fy; dy++) {
        const y = y2 * fy + dy;
        const wt = rowSolidAngle(y, w, h);
        for (let dx = 0; dx < fx; dx++) {
          const i = (y * w + x2 * fx + dx) * 4;
          r += s[i] * wt;
          g += s[i + 1] * wt;
          b += s[i + 2] * wt;
          ws += wt;
        }
      }
      const o = (y2 * w2 + x2) * 4;
      out[o] = r / ws;
      out[o + 1] = g / ws;
      out[o + 2] = b / ws;
      out[o + 3] = 1;
    }
  }
  return { width: w2, height: h2, data: out };
}

/**
 * In place: blurs each row horizontally (wrapping) over about 1 / sin(theta) texels, so a texel's
 * azimuthal footprint matches its polar height. Without this, texels near the poles are thin
 * slivers and a blurred (high-mip) reflection pinches to a point at the zenith. Row sums, and
 * therefore the level's energy, are unchanged.
 */
export function isotropizeLevel(l: EnvironmentLevel): void {
  const { width: w, height: h, data } = l;
  if (w < 3) return;
  const row = new Float64Array((w + 1) * 3);
  for (let y = 0; y < h; y++) {
    // footprint at the row's pole-side edge: the rows touching a pole become uniform, so the
    // texture is continuous at the pole (bilinear filtering there mixes all azimuths)
    const s = Math.sin((Math.PI * (y < h / 2 ? y : y + 1)) / h);
    const o = y * w * 4;
    if (s < 1e-6) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let x = 0; x < w; x++) sum += data[o + x * 4 + c];
        for (let x = 0; x < w; x++) data[o + x * 4 + c] = sum / w;
      }
      continue;
    }
    const r = Math.min(Math.floor(w / 2) - 1, Math.round(0.5 / s - 0.5));
    if (r < 1) continue;
    // prefix sums of the row
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) row[(x + 1) * 3 + c] = row[x * 3 + c] + data[o + x * 4 + c];
    }
    const total = [row[w * 3], row[w * 3 + 1], row[w * 3 + 2]];
    const n = 2 * r + 1;
    for (let x = 0; x < w; x++) {
      const a = x - r;
      const b = x + r + 1; // window [a, b), wrapped
      for (let c = 0; c < 3; c++) {
        let sum: number;
        if (a < 0) sum = row[b * 3 + c] + (total[c] - row[(a + w) * 3 + c]);
        else if (b > w) sum = (total[c] - row[a * 3 + c]) + row[(b - w) * 3 + c];
        else sum = row[b * 3 + c] - row[a * 3 + c];
        data[o + x * 4 + c] = sum / n;
      }
    }
  }
}

/** Radiant "energy" of a level: sum of luminance x texel solid angle (tests / diagnostics). */
export function levelEnergy(l: EnvironmentLevel): number {
  let e = 0;
  for (let y = 0; y < l.height; y++) {
    const dw = rowSolidAngle(y, l.width, l.height);
    for (let x = 0; x < l.width; x++) {
      const i = (y * l.width + x) * 4;
      e += luminance(l.data[i], l.data[i + 1], l.data[i + 2]) * dw;
    }
  }
  return e;
}

/** Prepares an equirect image for rendering (see the file comment). */
export function prepareEnvironment(img: EnvironmentPixels, width = ENV_WIDTH, height = ENV_HEIGHT): PreparedEnvironment {
  const rgb = resampleEquirect(img, width, height);
  const sh = irradianceSH(rgb, width, height);
  const meanLum = luminance(sh[0], sh[1], sh[2]);
  const exposure = meanLum > 1e-12 ? ENV_TARGET_LUMINANCE / meanLum : 1;
  for (let i = 0; i < 27; i++) sh[i] *= exposure;

  const n = width * height;
  const base = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    let r = rgb[i * 3] * exposure;
    let g = rgb[i * 3 + 1] * exposure;
    let b = rgb[i * 3 + 2] * exposure;
    const l = luminance(r, g, b);
    if (l > ENV_MAX_LUMINANCE) {
      const k = ENV_MAX_LUMINANCE / l;
      r *= k;
      g *= k;
      b *= k;
    }
    base[i * 4] = Math.min(r, HALF_MAX);
    base[i * 4 + 1] = Math.min(g, HALF_MAX);
    base[i * 4 + 2] = Math.min(b, HALF_MAX);
    base[i * 4 + 3] = 1;
  }
  const levels: EnvironmentLevel[] = [{ width, height, data: base }];
  isotropizeLevel(levels[0]);
  for (let l = levels[0]; l.width > 1 || l.height > 1; ) {
    l = downsampleLevel(l);
    isotropizeLevel(l);
    levels.push(l);
  }
  // The GGX lobe of roughness r spans about 2 r^2 radians around the reflection vector; level k has
  // texels of pi / (height / 2^k) radians: lod = log2(2 r^2 height / pi).
  const lodScale = (2 * height) / Math.PI;
  return { levels, sh, lodScale, exposure };
}

// -------------------------------------------------------------------------------------------------
// 'studio' preset

interface Softbox {
  /** Azimuth from the image centre (-Z) towards +X, radians. */
  az: number;
  /** Elevation above the horizon, radians. */
  el: number;
  /** Half extents in the box plane (tangent units: tan of the half angle). */
  hw: number;
  hh: number;
  /** Radiance. */
  power: number;
}

const DEG = Math.PI / 180;
const STUDIO_BOXES: Softbox[] = [
  { az: 15 * DEG, el: 68 * DEG, hw: 0.75, hh: 0.45, power: 2.2 }, // large overhead panel
  { az: -50 * DEG, el: 32 * DEG, hw: 0.32, hh: 0.45, power: 3 }, // key, front left
  { az: 130 * DEG, el: 28 * DEG, hw: 0.4, hh: 0.3, power: 1.6 }, // fill, back right
  { az: 50 * DEG, el: 24 * DEG, hw: 0.3, hh: 0.3, power: 1.2 }, // side, front right
  { az: 220 * DEG, el: 30 * DEG, hw: 0.25, hh: 0.4, power: 1.2 }, // rim, back left
];

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Procedural neutral studio environment (equirect, linear RGB): soft overhead and side softboxes, a
 * bright upper hemisphere and a darker floor, no colour cast. Deterministic.
 */
export function studioEnvironment(width = ENV_WIDTH, height = ENV_HEIGHT): EnvironmentPixels {
  const boxes = STUDIO_BOXES.map((s) => {
    const c = [Math.cos(s.el) * Math.sin(s.az), Math.sin(s.el), -Math.cos(s.el) * Math.cos(s.az)];
    // t1 = normalize(cross(c, up)) is horizontal, t2 = cross(t1, c) points up the box
    let t1 = [-c[2], 0, c[0]];
    const l = Math.hypot(t1[0], t1[2]) || 1;
    t1 = [t1[0] / l, 0, t1[2] / l];
    const t2 = [t1[1] * c[2] - t1[2] * c[1], t1[2] * c[0] - t1[0] * c[2], t1[0] * c[1] - t1[1] * c[0]];
    return { s, c, t1, t2 };
  });
  const data = new Float32Array(width * height * 3);
  const d = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      equirectDirection(x, y, width, height, d);
      const up = d[1];
      // walls brighten towards the ceiling; the floor is dark and slightly darker straight down
      const sky = 0.55 + 0.35 * Math.max(up, 0);
      const ground = 0.16 + 0.05 * (1 + Math.min(up, 0));
      let v = ground + (sky - ground) * smoothstep(-0.06, 0.06, up);
      for (const b of boxes) {
        const k = d[0] * b.c[0] + d[1] * b.c[1] + d[2] * b.c[2];
        if (k <= 0) continue;
        const u = Math.abs((d[0] * b.t1[0] + d[1] * b.t1[1] + d[2] * b.t1[2]) / k);
        const w = Math.abs((d[0] * b.t2[0] + d[1] * b.t2[1] + d[2] * b.t2[2]) / k);
        const m = (1 - smoothstep(b.s.hw * 0.7, b.s.hw * 1.15, u)) * (1 - smoothstep(b.s.hh * 0.7, b.s.hh * 1.15, w));
        v += b.s.power * m;
      }
      const o = (y * width + x) * 3;
      data[o] = data[o + 1] = data[o + 2] = v;
    }
  }
  return { width, height, data };
}

// -------------------------------------------------------------------------------------------------
// sources

/** The input forms of `ViewerApi.setEnvironment` (minus null). */
export type EnvironmentInput = string | Blob | ArrayBuffer | Uint8Array | EnvironmentPixels;

/** Reads any environment source into pixels plus a display name. */
export async function readEnvironmentSource(source: EnvironmentInput): Promise<{ pixels: EnvironmentPixels; name: string }> {
  if (source === 'studio') return { pixels: studioEnvironment(), name: 'studio' };
  if (typeof source === 'string') {
    let res: Response;
    try {
      res = await fetch(source);
    } catch (e) {
      throw new Error(`mk-viewer: could not load environment ${source}: ${(e as Error)?.message ?? e}`);
    }
    if (!res.ok) throw new Error(`mk-viewer: could not load environment ${source}: HTTP ${res.status}`);
    const name = urlName(source);
    return { pixels: parseNamed(name, await res.arrayBuffer()), name };
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const n = (source as { name?: unknown }).name;
    const name = typeof n === 'string' && n ? n : 'environment';
    return { pixels: parseNamed(name, await source.arrayBuffer()), name };
  }
  if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
    return { pixels: parseNamed('environment', source), name: 'environment' };
  }
  if (source && typeof source === 'object' && 'data' in source) {
    checkPixels(source);
    return { pixels: source, name: 'environment' };
  }
  throw new Error('mk-viewer: setEnvironment: unsupported source (expected "studio", a URL, a Blob/File, bytes of a .hdr file or { width, height, data })');
}

/** Parses .hdr bytes, prefixing errors with the source name. */
function parseNamed(name: string, bytes: ArrayBuffer | Uint8Array): EnvironmentPixels {
  try {
    return parseHdr(bytes);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    throw new Error(msg.replace(/^mk-viewer: /, `mk-viewer: ${name}: `));
  }
}

function urlName(url: string): string {
  const path = url.split(/[?#]/)[0];
  const seg = path.substring(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(seg) || url;
  } catch {
    return seg || url;
  }
}

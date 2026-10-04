import { describe, expect, it } from 'vitest';
import {
  ENV_MAX_LUMINANCE,
  ENV_TARGET_LUMINANCE,
  downsampleLevel,
  equirectDirection,
  evalIrradianceSH,
  irradianceSH,
  levelEnergy,
  parseHdr,
  prepareEnvironment,
  readEnvironmentSource,
  resampleEquirect,
  studioEnvironment,
  type EnvironmentPixels,
} from './environment';

// --- tiny test-side RGBE writer ----------------------------------------------------------------

function header(w: number, h: number, extra = ''): number[] {
  const s = `#?RADIANCE\n# test file\n${extra}FORMAT=32-bit_rle_rgbe\nEXPOSURE=1.0\n\n-Y ${h} +X ${w}\n`;
  return Array.from(s, (c) => c.charCodeAt(0));
}

function toRgbe(r: number, g: number, b: number): [number, number, number, number] {
  const v = Math.max(r, g, b);
  if (v < 1e-32) return [0, 0, 0, 0];
  const e = Math.floor(Math.log2(v)) + 1; // v = m * 2^e, m in [0.5, 1)
  const scale = 256 / Math.pow(2, e);
  return [Math.floor(r * scale), Math.floor(g * scale), Math.floor(b * scale), e + 128];
}

function rgbeImage(img: EnvironmentPixels): Uint8Array[] {
  const rows: Uint8Array[] = [];
  for (let y = 0; y < img.height; y++) {
    const row = new Uint8Array(img.width * 4);
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 3;
      row.set(toRgbe(img.data[i], img.data[i + 1], img.data[i + 2]), x * 4);
    }
    rows.push(row);
  }
  return rows;
}

function writeFlat(img: EnvironmentPixels): Uint8Array {
  const out = header(img.width, img.height);
  for (const r of rgbeImage(img)) out.push(...r);
  return new Uint8Array(out);
}

/** New-style RLE: runs of >= 3 equal bytes as run packets, the rest as literal packets. */
function writeRle(img: EnvironmentPixels): Uint8Array {
  const out = header(img.width, img.height);
  const w = img.width;
  for (const row of rgbeImage(img)) {
    out.push(2, 2, w >> 8, w & 255);
    for (let c = 0; c < 4; c++) {
      const ch = Array.from({ length: w }, (_, x) => row[x * 4 + c]);
      let x = 0;
      while (x < w) {
        let run = 1;
        while (x + run < w && run < 127 && ch[x + run] === ch[x]) run++;
        if (run >= 3) {
          out.push(128 + run, ch[x]);
          x += run;
          continue;
        }
        let n = 0;
        const start = x;
        while (x < w && n < 128) {
          let r = 1;
          while (x + r < w && r < 3 && ch[x + r] === ch[x]) r++;
          if (r >= 3) break;
          x++;
          n++;
        }
        out.push(n, ...ch.slice(start, start + n));
      }
    }
  }
  return new Uint8Array(out);
}

/** Pixels with exactly representable RGBE values (mantissa * 2^k). */
function patternImage(w: number, h: number): EnvironmentPixels {
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      // a run of equal pixels in the left half, varying values in the right half
      if (x < w / 2) {
        data[i] = 1;
        data[i + 1] = 0.5;
        data[i + 2] = 0.25;
      } else {
        const k = (x * 7 + y * 3) % 5;
        data[i] = [0, 2, 4, 0.125, 8][k];
        data[i + 1] = [0, 1, 2, 0.0625, 4][k];
        data[i + 2] = [0, 3, 1, 0.09375, 6][k];
      }
    }
  }
  return { width: w, height: h, data };
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function str(s: string): Uint8Array {
  return new Uint8Array(Array.from(s, (c) => c.charCodeAt(0)));
}

describe('parseHdr', () => {
  it('reads flat (uncompressed) scanlines', () => {
    const img = patternImage(6, 3); // width < 8: always flat
    const r = parseHdr(writeFlat(img));
    expect([r.width, r.height]).toEqual([6, 3]);
    expect(Array.from(r.data)).toEqual(Array.from(img.data));
  });

  it('reads new-style RLE scanlines', () => {
    const img = patternImage(40, 5);
    const bytes = writeRle(img);
    expect(bytes.length).toBeLessThan(header(40, 5).length + 40 * 5 * 4); // really compressed
    const r = parseHdr(bytes);
    expect([r.width, r.height]).toEqual([40, 5]);
    expect(Array.from(r.data)).toEqual(Array.from(img.data));
  });

  it('reads flat scanlines of a wide image and an ArrayBuffer input, CRLF header, #?RGBE magic', () => {
    const img = patternImage(12, 2);
    const flat = writeFlat(img);
    const text = new TextDecoder('latin1').decode(flat.subarray(0, header(12, 2).length));
    const hdr = text.replace('#?RADIANCE', '#?RGBE').replace(/\n/g, '\r\n').replace('\r\n\r\n-Y', '\n\n-Y');
    const bytes = new Uint8Array([...str(hdr), ...flat.subarray(header(12, 2).length)]);
    const r = parseHdr(bytes.buffer);
    expect(Array.from(r.data)).toEqual(Array.from(img.data));
  });

  it('rejects other formats and orientations with clear messages', () => {
    expect(() => parseHdr(new Uint8Array([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]))).toThrow(/OpenEXR/);
    expect(() => parseHdr(str('#?SOMETHING\n\n-Y 1 +X 1\n\0\0\0\0'))).toThrow(/not a Radiance/);
    expect(() => parseHdr(str('#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 1 +X 1\n\0\0\0\0'))).toThrow(/32-bit_rle_xyze/);
    expect(() => parseHdr(str('#?RADIANCE\n\n+Y 1 +X 1\n\0\0\0\0'))).toThrow(/orientation/);
    expect(() => parseHdr(str('#?RADIANCE\n\n-Y 2 +X 2\n\0\0\0\0'))).toThrow(/truncated/);
    expect(() => parseHdr(str('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n'))).toThrow(/truncated/);
  });
});

describe('equirect convention', () => {
  it('centre column looks along -Z, u = 0.75 along +X, top row is up (matches the shader formula)', () => {
    const d = [0, 0, 0];
    equirectDirection(255.5, 127.5, 512, 256, d); // pixel centre at u = v = 0.5
    expect(d[0]).toBeCloseTo(0, 6);
    expect(d[1]).toBeCloseTo(0, 6);
    expect(d[2]).toBeCloseTo(-1, 6);
    equirectDirection(383.5, 127.5, 512, 256, d);
    expect(d[0]).toBeCloseTo(1, 6);
    equirectDirection(0, 0, 512, 256, d);
    expect(d[1]).toBeGreaterThan(0.99);
    // shader: u = atan(d.x, -d.z) / 2pi + 0.5, v = acos(d.y) / pi
    for (const [x, y] of [[10, 20], [300, 200], [500, 100]]) {
      equirectDirection(x, y, 512, 256, d);
      const u = Math.atan2(d[0], -d[2]) / (2 * Math.PI) + 0.5;
      const v = Math.acos(d[1]) / Math.PI;
      expect(u * 512 - 0.5).toBeCloseTo(x, 4);
      expect(v * 256 - 0.5).toBeCloseTo(y, 4);
    }
  });
});

describe('irradiance SH', () => {
  it('constant environment gives constant irradiance / pi equal to the radiance', () => {
    const w = 64, h = 32;
    const rgb = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) rgb.set([0.5, 1, 2], i * 3);
    const sh = irradianceSH(rgb, w, h);
    const out = [0, 0, 0];
    for (const n of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, -1], [0.6, 0.48, 0.64]]) {
      evalIrradianceSH(sh, n[0], n[1], n[2], out);
      // within 0.1 % (midpoint quadrature over 64 x 32 pixels)
      expect(Math.abs(out[0] / 0.5 - 1)).toBeLessThan(1e-3);
      expect(Math.abs(out[1] / 1 - 1)).toBeLessThan(1e-3);
      expect(Math.abs(out[2] / 2 - 1)).toBeLessThan(1e-3);
    }
    expect(sh[0]).toBeCloseTo(0.5, 6); // the constant term is exact
    for (let k = 3; k < 27; k++) expect(Math.abs(sh[k])).toBeLessThan(2e-3);
  });

  it('a small directional source gives a cosine falloff', () => {
    const w = 256, h = 128;
    const rgb = new Float32Array(w * h * 3);
    const s = [0.3, 0.8, -0.52];
    const sl = Math.hypot(s[0], s[1], s[2]);
    for (let k = 0; k < 3; k++) s[k] /= sl;
    const d = [0, 0, 0];
    let power = 0; // integral of L over the source (for the exact irradiance)
    for (let y = 0; y < h; y++) {
      const dw = ((2 * Math.PI) / w) * (Math.cos((Math.PI * y) / h) - Math.cos((Math.PI * (y + 1)) / h));
      for (let x = 0; x < w; x++) {
        equirectDirection(x, y, w, h, d);
        if (d[0] * s[0] + d[1] * s[1] + d[2] * s[2] > Math.cos((4 * Math.PI) / 180)) {
          rgb.set([10, 10, 10], (y * w + x) * 3);
          power += 10 * dw;
        }
      }
    }
    const sh = irradianceSH(rgb, w, h);
    const peak = power / Math.PI; // exact irradiance / pi facing the source
    const out = [0, 0, 0];
    let maxErr = 0;
    for (const deg of [0, 30, 60, 90, 120, 180]) {
      // normal rotated away from s by deg (about an axis perpendicular to s)
      const t = [s[1], -s[0], 0];
      const tl = Math.hypot(t[0], t[1]);
      const a = (deg * Math.PI) / 180;
      const n = [0, 1, 2].map((k) => s[k] * Math.cos(a) + ((k < 2 ? t[k] : 0) / tl) * Math.sin(a));
      evalIrradianceSH(sh, n[0], n[1], n[2], out);
      const exact = peak * Math.max(0, Math.cos(a));
      maxErr = Math.max(maxErr, Math.abs(out[0] - exact) / peak);
      if (deg === 0) expect(out[0] / peak).toBeGreaterThan(0.9);
    }
    // order-2 SH approximates the clamped cosine to within ~9% of the peak (known ringing at the
    // terminator); 60 degrees must be about half of the peak
    expect(maxErr).toBeLessThan(0.1);
    const n60 = [0, 0, 0];
    {
      const t = [s[1], -s[0], 0];
      const tl = Math.hypot(t[0], t[1]);
      const a = Math.PI / 3;
      for (let k = 0; k < 3; k++) n60[k] = s[k] * Math.cos(a) + ((k < 2 ? t[k] : 0) / tl) * Math.sin(a);
    }
    evalIrradianceSH(sh, n60[0], n60[1], n60[2], out);
    expect(out[0] / peak).toBeGreaterThan(0.42);
    expect(out[0] / peak).toBeLessThan(0.58);
  });
});

describe('resampling and mips', () => {
  it('area-averaged resampling keeps the energy of a one-pixel bright source', () => {
    const w = 2048, h = 1024;
    const data = new Float32Array(w * h * 3);
    const px = 700, py = 300;
    data.set([5000, 4000, 3000], (py * w + px) * 3);
    const out = resampleEquirect({ width: w, height: h, data }, 512, 256);
    const omega = (W: number, H: number, y: number) =>
      ((2 * Math.PI) / W) * (Math.cos((Math.PI * y) / H) - Math.cos((Math.PI * (y + 1)) / H));
    const before = 5000 * omega(w, h, py);
    let after = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) after += out[(y * 512 + x) * 3] * omega(512, 256, y);
    expect(after / before).toBeCloseTo(1, 3);
  });

  it('every mip level carries the same energy', () => {
    const p = prepareEnvironment(studioEnvironment(256, 128), 256, 128);
    expect(p.levels.length).toBe(9); // 256x128 .. 1x1
    expect(p.levels[p.levels.length - 1].width).toBe(1);
    expect(p.levels[p.levels.length - 1].height).toBe(1);
    const e0 = levelEnergy(p.levels[0]);
    for (const l of p.levels) expect(levelEnergy(l) / e0).toBeCloseTo(1, 5);
    // a 2x1 level downsamples horizontally only
    const l = downsampleLevel({ width: 2, height: 1, data: new Float32Array([1, 2, 3, 1, 3, 4, 5, 1]) });
    expect(Array.from(l.data)).toEqual([2, 3, 4, 1]);
  });

  it('auto-exposure fixes the mean irradiance and makes the input scale irrelevant', () => {
    const img = studioEnvironment(128, 64);
    const a = prepareEnvironment(img, 128, 64);
    expect(luminance(a.sh[0], a.sh[1], a.sh[2])).toBeCloseTo(ENV_TARGET_LUMINANCE, 5);
    const scaled = { ...img, data: img.data.map((v) => v * 1000) };
    const b = prepareEnvironment(scaled, 128, 64);
    for (let i = 0; i < 27; i++) expect(b.sh[i]).toBeCloseTo(a.sh[i], 4);
    expect(b.levels[3].data[100] / a.levels[3].data[100]).toBeCloseTo(1, 4);
    expect(b.exposure * 1000).toBeCloseTo(a.exposure, 6);
  });

  it('clamps a sun for the specular image, keeps values finite and in half-float range', () => {
    const w = 256, h = 128;
    const data = new Float32Array(w * h * 3).fill(0.2);
    data.set([1e7, 1e7, 9e6], (20 * w + 40) * 3);
    data[5] = NaN;
    data[8] = -3;
    const p = prepareEnvironment({ width: w, height: h, data }, w, h);
    let maxLum = 0;
    for (const l of p.levels) {
      for (let i = 0; i < l.data.length; i += 4) {
        const v = luminance(l.data[i], l.data[i + 1], l.data[i + 2]);
        expect(Number.isFinite(v)).toBe(true);
        maxLum = Math.max(maxLum, v);
      }
    }
    expect(maxLum).toBeLessThanOrEqual(ENV_MAX_LUMINANCE * 1.0001);
    for (const v of p.sh) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('studio preset', () => {
  it('is deterministic, neutral, bright above and dark below', () => {
    const a = studioEnvironment(128, 64);
    const b = studioEnvironment(128, 64);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    let up = 0, down = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 128; x++) {
        const i = (y * 128 + x) * 3;
        expect(a.data[i]).toBe(a.data[i + 1]);
        expect(a.data[i]).toBe(a.data[i + 2]);
        if (y < 32) up += a.data[i];
        else down += a.data[i];
      }
    }
    expect(up / down).toBeGreaterThan(3);
    // irradiance from above is clearly stronger than from below
    const p = prepareEnvironment(a, 128, 64);
    const top = [0, 0, 0], bottom = [0, 0, 0];
    evalIrradianceSH(p.sh, 0, 1, 0, top);
    evalIrradianceSH(p.sh, 0, -1, 0, bottom);
    expect(top[0] / bottom[0]).toBeGreaterThan(2.5);
  });
});

describe('readEnvironmentSource', () => {
  it('accepts the preset, bytes, a named Blob and raw pixels; rejects garbage', async () => {
    const img = patternImage(16, 4);
    const bytes = writeRle(img);
    expect((await readEnvironmentSource('studio')).name).toBe('studio');
    const r1 = await readEnvironmentSource(bytes);
    expect(Array.from(r1.pixels.data)).toEqual(Array.from(img.data));
    const r2 = await readEnvironmentSource(bytes.buffer as ArrayBuffer);
    expect(r2.pixels.width).toBe(16);
    const file = new File([bytes as Uint8Array<ArrayBuffer>], 'room.hdr');
    const r3 = await readEnvironmentSource(file);
    expect(r3.name).toBe('room.hdr');
    expect(r3.pixels.height).toBe(4);
    const r4 = await readEnvironmentSource(img);
    expect(r4.pixels).toBe(img);
    await expect(readEnvironmentSource(new File([new Uint8Array([1, 2, 3, 4])], 'x.exr'))).rejects.toThrow(/x\.exr.*OpenEXR/);
    await expect(readEnvironmentSource({ width: 4, height: 4, data: new Float32Array(3) })).rejects.toThrow(/Float32Array/);
  });
});

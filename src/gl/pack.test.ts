import { describe, expect, it } from 'vitest';
import {
  cofactorTransformNormal,
  decodeFloatBytes,
  decodeIdBytes,
  encodeFloatBytes,
  encodeIdBytes,
  linearizeDepth,
  octDecode,
  octEncodeSnorm8,
  planeFromNormalPoint,
  planesToViewSpace,
  snorm8ToFloat,
  unprojectDepth,
} from './pack';

/** What the GPU does with u8 bytes written as k/255 floats into UNORM8: exact round trip. */
function unorm8RoundTrip(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes, (b) => Math.round((b / 255) * 255));
}

describe('id packing', () => {
  it('round-trips fragment indices, 0 bytes = background', () => {
    const buf = new Uint8Array(4);
    for (const id of [0, 1, 254, 255, 256, 65535, 65536, 0xffffff, 0x1000000, 123456789, 0xfffffffe]) {
      encodeIdBytes(id, buf);
      expect(decodeIdBytes(unorm8RoundTrip(buf))).toBe(id);
    }
    encodeIdBytes(-1, buf);
    expect(Array.from(buf)).toEqual([0, 0, 0, 0]);
    expect(decodeIdBytes(buf)).toBe(-1);
  });

  it('matches the GLSL packU32 byte order (little endian, r = low byte)', () => {
    const buf = new Uint8Array(4);
    encodeIdBytes(0x01020304 - 1, buf); // stored value = id + 1
    expect(Array.from(buf)).toEqual([4, 3, 2, 1]);
  });
});

describe('depth float bytes', () => {
  it('round-trips float32 exactly', () => {
    const buf = new Uint8Array(8);
    for (const v of [0, 1, 0.5, 0.999999, 1e-7, 0.123456789]) {
      encodeFloatBytes(v, buf, 4);
      expect(decodeFloatBytes(buf, 4)).toBe(Math.fround(v));
    }
  });
  it('1.0 is 00 00 80 3F (used by the pick resolve shader for out-of-range pixels)', () => {
    expect(decodeFloatBytes(Uint8Array.from([0, 0, 128, 63]))).toBe(1);
  });
});

describe('octahedral normals', () => {
  it('snorm8 conversion follows GL ES 3.0 (max(c/127, -1))', () => {
    expect(snorm8ToFloat(127)).toBe(1);
    expect(snorm8ToFloat(-127)).toBe(-1);
    expect(snorm8ToFloat(-128)).toBe(-1);
    expect(snorm8ToFloat(0)).toBe(0);
  });

  it('encode -> snorm8 -> decode stays within ~1.5 degrees', () => {
    const enc = new Int8Array(2);
    const out = [0, 0, 0];
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      // fibonacci sphere
      const y = 1 - (2 * (i + 0.5)) / 4000;
      const r = Math.sqrt(1 - y * y);
      const phi = i * Math.PI * (3 - Math.sqrt(5));
      const n = [Math.cos(phi) * r, y, Math.sin(phi) * r];
      octEncodeSnorm8(n[0], n[1], n[2], enc);
      octDecode(snorm8ToFloat(enc[0]), snorm8ToFloat(enc[1]), out);
      const d = Math.min(1, n[0] * out[0] + n[1] * out[1] + n[2] * out[2]);
      worst = Math.max(worst, Math.acos(d));
    }
    expect((worst * 180) / Math.PI).toBeLessThan(1.5);
  });

  it('decodes the axes exactly', () => {
    const enc = new Int8Array(2);
    const out = [0, 0, 0];
    const axes = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ];
    for (const a of axes) {
      octEncodeSnorm8(a[0], a[1], a[2], enc);
      octDecode(snorm8ToFloat(enc[0]), snorm8ToFloat(enc[1]), out);
      for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(a[k], 6);
    }
  });
});

describe('cofactor normal transform', () => {
  function rowsFrom(m3: number[][]): number[] {
    // 12-float record prefix: rows with translation in w
    return [...m3[0], 7, ...m3[1], 8, ...m3[2], 9];
  }
  function det3(m: number[][]): number {
    return (
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    );
  }
  function inverseTranspose(m: number[][]): number[][] {
    const d = det3(m);
    const c = (r: number, k: number) => {
      const rows = [0, 1, 2].filter((i) => i !== r);
      const cols = [0, 1, 2].filter((i) => i !== k);
      const minor = m[rows[0]][cols[0]] * m[rows[1]][cols[1]] - m[rows[0]][cols[1]] * m[rows[1]][cols[0]];
      return ((r + k) % 2 ? -1 : 1) * minor;
    };
    // inverse transpose = cofactor matrix / det
    return [0, 1, 2].map((r) => [0, 1, 2].map((k) => c(r, k) / d));
  }

  it('equals det * inverse-transpose for a general matrix', () => {
    const m = [
      [2, 0.3, -0.5],
      [0.1, 0.5, 0.2],
      [-0.4, 0.7, 3],
    ];
    const it = inverseTranspose(m);
    const d = det3(m);
    const n = [0.3, -0.8, 0.52];
    const out = [0, 0, 0];
    cofactorTransformNormal(rowsFrom(m), n, out);
    for (let r = 0; r < 3; r++) {
      const expected = d * (it[r][0] * n[0] + it[r][1] * n[1] + it[r][2] * n[2]);
      expect(out[r]).toBeCloseTo(expected, 10);
    }
  });

  it('keeps normals perpendicular to surfaces under non-uniform scale', () => {
    // plane x + y = 0 has normal (1,1,0); scale x by 4 => plane x/4 + y = 0, normal (1/4, 1, 0)
    const out = [0, 0, 0];
    cofactorTransformNormal(rowsFrom([[4, 0, 0], [0, 1, 0], [0, 0, 1]]), [1, 1, 0], out);
    expect(out[1] / out[0]).toBeCloseTo(4, 10);
    expect(out[2]).toBe(0);
  });
});

describe('unproject / depth', () => {
  // Perspective(fovy=90deg, aspect=1, near=1, far=100), view = identity
  const n = 1;
  const f = 100;
  const proj = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0];
  function invert(m: number[]): number[] {
    // generic 4x4 inverse (column-major) via Gauss-Jordan
    const a = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => m[c * 4 + r]));
    const inv = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => (r === c ? 1 : 0)));
    for (let c = 0; c < 4; c++) {
      let p = c;
      for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      [a[c], a[p]] = [a[p], a[c]];
      [inv[c], inv[p]] = [inv[p], inv[c]];
      const d = a[c][c];
      for (let k = 0; k < 4; k++) {
        a[c][k] /= d;
        inv[c][k] /= d;
      }
      for (let r = 0; r < 4; r++) {
        if (r === c) continue;
        const fct = a[r][c];
        for (let k = 0; k < 4; k++) {
          a[r][k] -= fct * a[c][k];
          inv[r][k] -= fct * inv[c][k];
        }
      }
    }
    const out: number[] = [];
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out.push(inv[r][c]);
    return out;
  }

  it('recovers a view-space point from window depth', () => {
    const p = [0.5, -0.25, -10];
    // project
    const cx = proj[0] * p[0];
    const cy = proj[5] * p[1];
    const cz = proj[10] * p[2] + proj[14];
    const cw = -p[2];
    const ndc = [cx / cw, cy / cw, cz / cw];
    const W = 200;
    const H = 200;
    const px = ((ndc[0] + 1) / 2) * W;
    const py = ((ndc[1] + 1) / 2) * H;
    const depth = (ndc[2] + 1) / 2;
    const out = [0, 0, 0];
    expect(unprojectDepth(px, py, W, H, depth, invert(proj), out)).toBe(true);
    for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(p[k], 6);
    expect(linearizeDepth(depth, n, f, false)).toBeCloseTo(10, 6);
  });

  it('linearizes orthographic depth', () => {
    expect(linearizeDepth(0, 1, 11, true)).toBeCloseTo(1);
    expect(linearizeDepth(1, 1, 11, true)).toBeCloseTo(11);
    expect(linearizeDepth(0.5, 1, 11, true)).toBeCloseTo(6);
  });
});

describe('section planes to view space', () => {
  it('preserves the side test', () => {
    // view: rotate 90deg about Y, then translate by (1, 2, 3)
    const c = 0;
    const s = 1;
    const view = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 1, 2, 3, 1];
    const plane = new Float32Array(4);
    planeFromNormalPoint(1, 0.5, -0.2, 3, -1, 2, plane);
    const out = new Float32Array(4);
    planesToViewSpace(plane, 1, view, out);
    const pts = [
      [0, 0, 0], [5, 1, 1], [-3, 4, 2], [3, -1, 2.0001],
    ];
    for (const w of pts) {
      const v = [
        view[0] * w[0] + view[4] * w[1] + view[8] * w[2] + view[12],
        view[1] * w[0] + view[5] * w[1] + view[9] * w[2] + view[13],
        view[2] * w[0] + view[6] * w[1] + view[10] * w[2] + view[14],
      ];
      const dw = plane[0] * w[0] + plane[1] * w[1] + plane[2] * w[2] + plane[3];
      const dv = out[0] * v[0] + out[1] * v[1] + out[2] * v[2] + out[3];
      expect(dv).toBeCloseTo(dw, 5);
    }
  });
});

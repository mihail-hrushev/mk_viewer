/**
 * Integration hazard: octahedral normals are encoded by src/core (GeometryStore) and decoded by the
 * GPU (GLSL octDecode, mirrored by src/gl/pack.ts octDecode after the GL ES snorm8 conversion).
 */
import { describe, expect, it } from 'vitest';
import { GeometryStore, octDecode as coreDecode, octEncode as coreEncode } from '../core';
import { octDecode as glDecode, octEncodeSnorm8, snorm8ToFloat } from '../gl/pack';
import { box, sphere, torus } from '../primitives';

function angleDeg(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI;
}

/** What the vertex shader computes from the two int8 bytes. */
function gpuDecode(a: number, b: number, out: number[]): void {
  glDecode(snorm8ToFloat(a), snorm8ToFloat(b), out);
}

describe('octahedral normals: core encoder vs. GPU decoder', () => {
  it('core-encoded normals decode correctly with the GL reference decoder', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const enc = [0, 0];
    const dec = [0, 0, 0];
    let worst = 0;
    for (let i = 0; i < 20000; i++) {
      const n = [rnd(), rnd(), rnd()];
      if (Math.hypot(n[0], n[1], n[2]) < 1e-3) continue;
      coreEncode(n[0], n[1], n[2], enc);
      gpuDecode(enc[0], enc[1], dec);
      worst = Math.max(worst, angleDeg(n, dec));
    }
    // 8-bit octahedral: < 1 degree everywhere
    expect(worst).toBeLessThan(1);
  });

  it('axis directions and the octahedron folds round-trip exactly (sign-not-zero convention)', () => {
    const enc = [0, 0];
    const dec = [0, 0, 0];
    const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const d of axes) {
      coreEncode(d[0], d[1], d[2], enc);
      gpuDecode(enc[0], enc[1], dec);
      expect(angleDeg(d, dec)).toBeLessThan(1e-3);
    }
    // lower hemisphere: decoded through the fold, signs must survive (a sign(0) = 0 bug flips these)
    const folds = [[1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1], [0, 1, -1], [1, 0, -1], [0, -1, -1], [-1, 0, -1]];
    for (const d of folds) {
      coreEncode(d[0], d[1], d[2], enc);
      gpuDecode(enc[0], enc[1], dec);
      expect(angleDeg(d, dec)).toBeLessThan(1);
    }
  });

  it('core and GL decoders agree on every possible code', () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    let worst = 0;
    for (let x = -128; x <= 127; x++) {
      for (let y = -128; y <= 127; y++) {
        coreDecode(x, y, a);
        gpuDecode(x, y, b);
        worst = Math.max(worst, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('core encoder is at least as accurate as the GL reference encoder', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const e1 = [0, 0];
    const e2 = [0, 0];
    const d = [0, 0, 0];
    let sumCore = 0;
    let sumGl = 0;
    for (let i = 0; i < 5000; i++) {
      const n = [rnd(), rnd(), rnd()];
      coreEncode(n[0], n[1], n[2], e1);
      octEncodeSnorm8(n[0], n[1], n[2], e2);
      gpuDecode(e1[0], e1[1], d);
      sumCore += angleDeg(n, d);
      gpuDecode(e2[0], e2[1], d);
      sumGl += angleDeg(n, d);
    }
    expect(sumCore).toBeLessThanOrEqual(sumGl * 1.0001);
  });

  it('vertex bytes written by GeometryStore decode on the GPU path to the source normals', () => {
    const gs = new GeometryStore();
    const dec = [0, 0, 0];
    for (const data of [box([1, 2, 3]), sphere(0.5, 24), torus(1, 0.3, 12, 24)]) {
      const g = gs.add(data);
      const bytes = gs.vertexBytes(g);
      const i8 = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const vc = gs.vertexCount[g];
      expect(vc).toBe(data.positions.length / 3);
      let worst = 0;
      for (let v = 0; v < vc; v++) {
        // layout.ts: bytes 6, 7 of the 8-byte vertex are the snorm8 octahedral normal
        gpuDecode(i8[v * 8 + 6], i8[v * 8 + 7], dec);
        worst = Math.max(worst, angleDeg([data.normals[v * 3], data.normals[v * 3 + 1], data.normals[v * 3 + 2]], dec));
      }
      expect(worst).toBeLessThan(1);
    }
  });
});

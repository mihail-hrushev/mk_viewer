import { describe, expect, it } from 'vitest';
import { foldTransform, positionsCenter, shiftPositions, transformedCenter } from './origin';
import { Scene } from '../core';
import { FRAG_FLOATS } from '../layout';

/** Applies the fragment record the way the vertex shader does, in float32 arithmetic. */
function shaderWorld(rec: Float32Array, o: number, local: number[]): number[] {
  const f = Math.fround;
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    const b = o + r * 4;
    out.push(f(f(f(f(rec[b] * f(local[0])) + f(rec[b + 1] * f(local[1]))) + f(rec[b + 2] * f(local[2]))) + rec[b + 3]));
  }
  return out;
}

describe('large world coordinates (origin-relative rendering)', () => {
  it('folds geometry offset and origin into the transform in float64', () => {
    // rotation about z by 30 degrees, translation near 1e7
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const m = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 1e7 + 0.123, 2e7 + 0.456, 50.789, 1];
    const offset = [1000.25, -2000.5, 3.75];
    const origin = [1e7, 2e7, 0];
    const out = new Float64Array(16);
    foldTransform(m, 0, offset, origin, out, 0);
    // a local point p (relative to the recentred geometry) must land at M * (p + offset) - origin
    const p = [0.5, -0.25, 1];
    const q = [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
    for (let r = 0; r < 3; r++) {
      const ref = m[r] * q[0] + m[4 + r] * q[1] + m[8 + r] * q[2] + m[12 + r] - origin[r];
      const got = out[r] * p[0] + out[4 + r] * p[1] + out[8 + r] * p[2] + out[12 + r];
      expect(got).toBeCloseTo(ref, 9);
    }
    expect(out[3]).toBe(0);
    expect(out[15]).toBe(1);
  });

  it('identity transform: only the offset minus the origin remains', () => {
    const out = new Float64Array(16);
    foldTransform(null, 0, [5, 6, 7], [1, 2, 3], out, 0);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 4, 4, 1]);
  });

  it('recentring keeps vertex precision for geometry with coordinates around 1e7', () => {
    const base = [1e7 + 0.37, 5e6 + 0.11, -1e7 + 0.73];
    const pos: number[] = [];
    // a 1 x 0.5 x 0.25 box worth of corners with sub-millimetre detail
    for (const dx of [0, 1]) for (const dy of [0, 0.5]) for (const dz of [0, 0.25, 0.0004]) pos.push(base[0] + dx, base[1] + dy, base[2] + dz);
    const c = new Float64Array(3);
    positionsCenter(pos, c);
    expect(c[0]).toBeCloseTo(base[0] + 0.5, 6);
    const local = shiftPositions(pos, c);
    for (let i = 0; i < local.length; i++) expect(Math.abs(local[i])).toBeLessThan(1);

    // full path through the core: geometry quantized + fragment record (float32), origin = first mesh centre
    const scene = new Scene();
    const g = scene.createGeometry({ positions: local, indices: [0, 1, 2] });
    const origin = new Float64Array(3);
    transformedCenter(null, 0, c, origin);
    const mtx = new Float64Array(16);
    foldTransform(null, 0, c, origin, mtx, 0);
    const f = scene.addMesh(g, scene.createMaterial(), mtx);
    const rec = scene.fragments.records;
    const o = f * FRAG_FLOATS;
    const dq = scene.geometries.dequant;
    const tmp = [0, 0, 0];
    let maxErr = 0;
    for (let v = 0; v < pos.length / 3; v++) {
      scene.geometries.decodePosition(g, v, tmp);
      void dq;
      const w = shaderWorld(rec, o, tmp);
      for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(w[k] + origin[k] - pos[v * 3 + k]));
    }
    // quantization of a ~1 unit box to u16 gives ~1e-5; float32 world at |x| ~ 1e7 would give ~1
    expect(maxErr).toBeLessThan(1e-4);
  });

  it('naive float32 at 1e7 would quantize to whole units (why the origin is needed)', () => {
    expect(Math.fround(1e7 + 0.37) - (1e7 + 0.37)).not.toBeCloseTo(0, 1);
  });
});

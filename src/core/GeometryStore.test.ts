import { describe, expect, it } from 'vitest';
import { GeometryStore, octDecode, octEncode } from './GeometryStore';
import { boxGeometry, randomMesh, rng } from './testkit';

describe('GeometryStore quantization', () => {
  it('round-trips positions within half a quantization step', () => {
    const r = rng(1);
    const gs = new GeometryStore();
    for (let t = 0; t < 50; t++) {
      const vc = 3 * (1 + Math.floor(r() * 70));
      const pos = new Float32Array(vc * 3);
      const scale = Math.pow(10, r() * 6 - 3);
      const off = (r() - 0.5) * 1000;
      for (let i = 0; i < pos.length; i++) pos[i] = off + (r() - 0.5) * scale;
      const id = gs.add({ positions: pos });
      const dq = gs.dequant.subarray(id * 6, id * 6 + 6);
      const p = [0, 0, 0];
      for (let v = 0; v < vc; v++) {
        gs.decodePosition(id, v, p);
        for (let a = 0; a < 3; a++) {
          const step = dq[a] / 65535;
          const tol = step * 0.5 + Math.abs(pos[v * 3 + a]) * 2.4e-7 + 1e-12;
          expect(Math.abs(p[a] - pos[v * 3 + a])).toBeLessThanOrEqual(tol);
        }
      }
      // local AABB contains every input point
      const bb = gs.aabb.subarray(id * 6, id * 6 + 6);
      for (let v = 0; v < vc; v++) {
        for (let a = 0; a < 3; a++) {
          expect(pos[v * 3 + a]).toBeGreaterThanOrEqual(bb[a]);
          expect(pos[v * 3 + a]).toBeLessThanOrEqual(bb[a + 3]);
        }
      }
    }
  });

  it('handles flat meshes (zero extent axis) and single points without NaN', () => {
    const gs = new GeometryStore();
    const id = gs.add({ positions: [0, 5, 0, 1, 5, 0, 0, 5, 1], indices: [0, 1, 2] });
    expect(gs.dequant[id * 6 + 1]).toBe(0);
    const p = [0, 0, 0];
    gs.decodePosition(id, 1, p);
    expect(p).toEqual([1, 5, 0]);
    const id2 = gs.add({ positions: [2, 2, 2, 2, 2, 2, 2, 2, 2] });
    gs.decodePosition(id2, 0, p);
    expect(p).toEqual([2, 2, 2]);
    for (let i = 0; i < 6; i++) expect(Number.isFinite(gs.dequant[id2 * 6 + i])).toBe(true);
  });

  it('produces the 8-byte shared vertex format and u32 indices', () => {
    const gs = new GeometryStore();
    const id = gs.add({ positions: [0, 0, 0, 2, 0, 0, 0, 4, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] });
    const bytes = gs.vertexBytes(id);
    expect(bytes.length).toBe(24);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint16(8, true)).toBe(65535); // vertex 1 x
    expect(dv.getUint16(16 + 2, true)).toBe(65535); // vertex 2 y
    expect(dv.getInt8(6)).toBe(0); // +Z normal encodes to (0,0)
    expect(dv.getInt8(7)).toBe(0);
    expect(Array.from(gs.indices(id))).toEqual([0, 1, 2]);
  });

  it('rejects malformed input', () => {
    const gs = new GeometryStore();
    expect(() => gs.add({ positions: [0, 0, 0, 1] })).toThrow();
    expect(() => gs.add({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 3] })).toThrow();
    expect(() => gs.add({ positions: [0, 0, 0, 1, 0, 0], indices: [0, 1] })).toThrow();
  });
});

describe('octahedral normals', () => {
  it('encodes unit vectors with < 1 degree error', () => {
    const r = rng(7);
    const o = [0, 0];
    const d = [0, 0, 0];
    let worst = 0;
    for (let i = 0; i < 100000; i++) {
      // uniform on the sphere
      const z = r() * 2 - 1;
      const a = r() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      const x = s * Math.cos(a), y = s * Math.sin(a);
      octEncode(x, y, z, o);
      expect(o[0]).toBeGreaterThanOrEqual(-127);
      expect(o[0]).toBeLessThanOrEqual(127);
      octDecode(o[0], o[1], d);
      const dot = Math.min(1, x * d[0] + y * d[1] + z * d[2]);
      worst = Math.max(worst, Math.acos(dot));
    }
    expect((worst * 180) / Math.PI).toBeLessThan(1.0);
  });

  it('handles axis and boundary normals exactly-ish', () => {
    const o = [0, 0];
    const d = [0, 0, 0];
    for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      octEncode(n[0], n[1], n[2], o);
      octDecode(o[0], o[1], d);
      expect(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]).toBeGreaterThan(0.9999);
    }
  });

  it('computes flat normals for non-indexed and smooth normals for indexed input', () => {
    const gs = new GeometryStore();
    const flat = gs.add({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, -1, 0, 1, 0] });
    const n = [0, 0, 0];
    gs.decodeNormal(flat, 0, n);
    expect(n[2]).toBeGreaterThan(0.999);
    gs.decodeNormal(flat, 3, n);
    expect(n[0]).toBeGreaterThan(0.999); // second triangle lies in x=0 plane, normal +X
    // indexed: two triangles sharing an edge at 90 degrees -> shared vertices get the average
    const smooth = gs.add({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, -1],
      indices: [0, 1, 2, 0, 2, 3],
    });
    gs.decodeNormal(smooth, 0, n);
    expect(n[0]).toBeCloseTo(-Math.SQRT1_2, 1);
    expect(n[2]).toBeCloseTo(Math.SQRT1_2, 1);
    gs.decodeNormal(smooth, 1, n);
    expect(n[2]).toBeGreaterThan(0.999);
  });
});

describe('dedup and reference counting', () => {
  it('returns the same id for identical geometry and frees on last release', () => {
    const gs = new GeometryStore();
    const box = boxGeometry();
    const a = gs.add(box);
    const b = gs.add({ positions: Array.from(box.positions), normals: box.normals, indices: Array.from(box.indices) });
    expect(b).toBe(a);
    expect(gs.handles[a]).toBe(2);
    expect(gs.liveCount).toBe(1);
    const c = gs.add(boxGeometry(0.7)); // same quantized bytes, different scale
    expect(c).not.toBe(a);
    gs.release(a);
    expect(gs.isAlive(a)).toBe(true);
    gs.addUse(a);
    gs.release(a);
    expect(gs.isAlive(a)).toBe(true); // still used by a fragment
    gs.removeUse(a);
    expect(gs.isAlive(a)).toBe(false);
    // recreating after free gives a valid fresh geometry
    const d = gs.add(box);
    expect(gs.isAlive(d)).toBe(true);
    expect(gs.vertexCount[d]).toBe(24);
  });

  it('dedups many meshes and keeps distinct ones apart', () => {
    const r = rng(3);
    const gs = new GeometryStore({ chunkWords: 4096 });
    const meshes = Array.from({ length: 500 }, () => randomMesh(r));
    const ids = meshes.map((m) => gs.add(m));
    expect(new Set(ids).size).toBe(500);
    const ids2 = meshes.map((m) => gs.add(m));
    expect(ids2).toEqual(ids);
    // free half and check arena integrity of the rest
    for (let i = 0; i < 500; i += 2) {
      gs.release(ids[i]);
      gs.release(ids[i]);
    }
    expect(gs.liveCount).toBe(250);
    const p = [0, 0, 0];
    for (let i = 1; i < 500; i += 2) {
      gs.decodePosition(ids[i], 7, p);
      expect(Math.abs(p[0] - meshes[i].positions[21])).toBeLessThan(1e-4);
    }
  });
});

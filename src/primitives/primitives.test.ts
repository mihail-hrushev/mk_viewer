import { describe, expect, it } from 'vitest';
import { box, sphere, cylinder, cone, plane, torus, extrusion } from './primitives';
import { triangulate, signedArea, cleanOutline } from './triangulate';
import type { PrimitiveGeometry } from './builder';

/** Checks array sizes, index range, unit normals, and that winding agrees with vertex normals. */
function validate(g: PrimitiveGeometry): void {
  const { positions: p, normals: n, indices: idx } = g;
  expect(p.length % 3).toBe(0);
  expect(n.length).toBe(p.length);
  expect(idx.length % 3).toBe(0);
  expect(idx.length).toBeGreaterThan(0);
  const vc = p.length / 3;
  for (const i of idx) expect(i).toBeLessThan(vc);
  for (let k = 0; k < n.length; k += 3) expect(Math.hypot(n[k], n[k + 1], n[k + 2])).toBeCloseTo(1, 5);
  for (const v of p) expect(Number.isFinite(v)).toBe(true);
  let degenerate = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-9) {
      degenerate++;
      continue;
    }
    const nx = n[a] + n[b] + n[c], ny = n[a + 1] + n[b + 1] + n[c + 1], nz = n[a + 2] + n[b + 2] + n[c + 2];
    // CCW face normal points the same way as the vertex normals
    expect((fx * nx + fy * ny + fz * nz) / fl).toBeGreaterThan(0);
  }
  expect(degenerate).toBe(0);
}

/** Signed volume by the divergence theorem; positive for closed meshes with outward CCW faces. */
function volume(g: PrimitiveGeometry): number {
  const { positions: p, indices: idx } = g;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** Every edge of a closed (watertight by position) mesh is used once in each direction. */
function expectClosed(g: PrimitiveGeometry): void {
  const { positions: p, indices: idx } = g;
  const q = (x: number): string => (Math.round(x * 1e5) + 0).toString();
  const key = (i: number): string => `${q(p[i * 3])},${q(p[i * 3 + 1])},${q(p[i * 3 + 2])}`;
  const edges = new Map<string, number>();
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(idx[t + e]), b = key(idx[t + ((e + 1) % 3)]);
      if (a === b) continue;
      edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  for (const [k, count] of edges) {
    const [a, b] = k.split('|');
    expect(edges.get(`${b}|${a}`) ?? 0).toBe(count);
  }
}

function bounds(g: PrimitiveGeometry): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < g.positions.length; k += 3) {
    for (let a = 0; a < 3; a++) {
      b[a] = Math.min(b[a], g.positions[k + a]);
      b[a + 3] = Math.max(b[a + 3], g.positions[k + a]);
    }
  }
  return b;
}

describe('primitives', () => {
  it('box', () => {
    const g = box([2, 3, 4]);
    validate(g);
    expectClosed(g);
    expect(g.positions.length / 3).toBe(24);
    expect(g.indices.length).toBe(36);
    expect(volume(g)).toBeCloseTo(24, 5);
    expect(bounds(g)).toEqual([-1, -1.5, -2, 1, 1.5, 2]);
    expect(volume(box())).toBeCloseTo(1, 6);
  });

  for (const up of ['y', 'z'] as const) {
    it(`sphere (${up}-up)`, () => {
      const g = sphere(2, 48, up);
      validate(g);
      expectClosed(g);
      const v = volume(g);
      expect(v).toBeGreaterThan(0);
      expect(v / ((4 / 3) * Math.PI * 8)).toBeGreaterThan(0.98);
      expect(v / ((4 / 3) * Math.PI * 8)).toBeLessThan(1);
    });

    it(`cylinder (${up}-up)`, () => {
      const g = cylinder(1, 3, 64, up);
      validate(g);
      expectClosed(g);
      expect(volume(g) / (Math.PI * 3)).toBeGreaterThan(0.99);
      const b = bounds(g);
      const ai = up === 'y' ? 1 : 2;
      expect(b[ai]).toBeCloseTo(0, 6);
      expect(b[ai + 3]).toBeCloseTo(3, 6);
    });

    it(`cone (${up}-up)`, () => {
      const g = cone(1, 2, 64, up);
      validate(g);
      expectClosed(g);
      expect(volume(g) / ((Math.PI * 2) / 3)).toBeGreaterThan(0.99);
      // side normals tilt upward
      const ai = up === 'y' ? 1 : 2;
      expect(g.normals[ai]).toBeGreaterThan(0);
      const b = bounds(g);
      expect(b[ai + 3]).toBeCloseTo(2, 6);
    });

    it(`plane (${up}-up) faces up`, () => {
      const g = plane(4, 2, up);
      validate(g);
      const ai = up === 'y' ? 1 : 2;
      for (let k = 0; k < g.normals.length; k += 3) expect(g.normals[k + ai]).toBe(1);
      const b = bounds(g);
      expect(b[0]).toBe(-2);
      expect(b[3]).toBe(2);
      expect(b[ai]).toBe(0);
      expect(b[ai + 3]).toBe(0);
      // face normal of first triangle is +up
      const p = g.positions, i = g.indices;
      const ux = p[i[1] * 3] - p[i[0] * 3], uy = p[i[1] * 3 + 1] - p[i[0] * 3 + 1], uz = p[i[1] * 3 + 2] - p[i[0] * 3 + 2];
      const vx = p[i[2] * 3] - p[i[0] * 3], vy = p[i[2] * 3 + 1] - p[i[0] * 3 + 1], vz = p[i[2] * 3 + 2] - p[i[0] * 3 + 2];
      const f = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      expect(f[ai]).toBeGreaterThan(0);
    });

    it(`torus (${up}-up)`, () => {
      const g = torus(2, 0.5, 32, 96, up);
      validate(g);
      expectClosed(g);
      const exact = 2 * Math.PI * Math.PI * 2 * 0.25;
      expect(volume(g) / exact).toBeGreaterThan(0.98);
      expect(volume(g) / exact).toBeLessThan(1.01);
      const b = bounds(g);
      const ai = up === 'y' ? 1 : 2;
      expect(b[ai + 3]).toBeCloseTo(0.5, 5);
    });
  }

  const lShape = [0, 0, 4, 0, 4, 1, 1, 1, 1, 3, 0, 3]; // area 4*1 + 1*2 = 6
  const star: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 2 : 0.8;
    const a = (i / 10) * Math.PI * 2;
    star.push(Math.cos(a) * r, Math.sin(a) * r);
  }

  for (const up of ['y', 'z'] as const) {
    it(`extrusion of a concave outline (${up}-up)`, () => {
      const g = extrusion(lShape, 2.5, up);
      validate(g);
      expectClosed(g);
      expect(volume(g)).toBeCloseTo(15, 5);
      const b = bounds(g);
      if (up === 'z') {
        expect(b).toEqual([0, 0, 0, 4, 3, 2.5]);
      } else {
        // (u, v) -> (x, -z), extruded along +y
        expect(b).toEqual([0, 0, -3, 4, 2.5, 0]);
      }
    });
  }

  it('extrusion: clockwise input, closing point, star, negative height', () => {
    const cw: number[] = [];
    for (let i = lShape.length - 2; i >= 0; i -= 2) cw.push(lShape[i], lShape[i + 1]);
    cw.push(cw[0], cw[1]); // closing point
    const g = extrusion(cw, 1, 'z');
    validate(g);
    expectClosed(g);
    expect(volume(g)).toBeCloseTo(6, 5);

    const s = extrusion(star, 1, 'z');
    validate(s);
    expectClosed(s);
    expect(volume(s)).toBeCloseTo(signedArea(star), 5);

    const neg = extrusion(lShape, -2, 'z');
    validate(neg);
    expect(volume(neg)).toBeCloseTo(12, 5);
    expect(bounds(neg)[2]).toBe(-2);

    const empty = extrusion([0, 0, 1, 1], 1);
    expect(empty.indices.length).toBe(0);
  });
});

describe('triangulate', () => {
  function triArea(xy: number[], t: number[]): number {
    let a = 0;
    for (let k = 0; k < t.length; k += 3) {
      const [i, j, l] = [t[k], t[k + 1], t[k + 2]];
      const area = ((xy[j * 2] - xy[i * 2]) * (xy[l * 2 + 1] - xy[i * 2 + 1]) - (xy[j * 2 + 1] - xy[i * 2 + 1]) * (xy[l * 2] - xy[i * 2])) / 2;
      expect(area).toBeGreaterThan(0);
      a += area;
    }
    return a;
  }

  it('covers the polygon with ccw triangles', () => {
    const square = [0, 0, 1, 0, 1, 1, 0, 1];
    expect(triArea(square, triangulate(square))).toBeCloseTo(1, 12);
    const l = [0, 0, 4, 0, 4, 1, 1, 1, 1, 3, 0, 3];
    const tl = triangulate(l);
    expect(tl.length).toBe((6 - 2) * 3);
    expect(triArea(l, tl)).toBeCloseTo(6, 12);
    // comb shape (many reflex vertices)
    const comb = [0, 0, 7, 0, 7, 3, 6, 3, 6, 1, 5, 1, 5, 3, 4, 3, 4, 1, 3, 1, 3, 3, 2, 3, 2, 1, 1, 1, 1, 3, 0, 3];
    expect(triArea(comb, triangulate(comb))).toBeCloseTo(signedArea(comb), 9);
  });

  it('skips collinear points and cleans outlines', () => {
    const sq = [0, 0, 0.5, 0, 1, 0, 1, 1, 0, 1];
    const t = triangulate(sq);
    expect(triArea(sq, t)).toBeCloseTo(1, 12);
    expect(cleanOutline([0, 0, 0, 0, 1, 0, 1, 1, 0, 0])).toEqual([0, 0, 1, 0, 1, 1]);
    expect(cleanOutline([0, 0, 0, 1, 1, 0])).toEqual([1, 0, 0, 1, 0, 0]);
    expect(triangulate([0, 0, 1, 1])).toEqual([]);
  });
});

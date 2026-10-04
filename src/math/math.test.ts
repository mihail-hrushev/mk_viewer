import { describe, expect, it } from 'vitest';
import * as vec3 from './vec3';
import * as mat4 from './mat4';
import * as aabb from './aabb';
import * as frustum from './frustum';
import {
  projectedSphereSizePx,
  projectedAABBSizePx,
  perspectivePixelFactor,
  orthographicPixelFactor,
  rayFromNDC,
  unproject,
  cssToNdc,
  depthToNdcZ,
  rayPlaneDistance,
} from './projection';

function close(a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-9): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(eps * Math.max(1, Math.abs(b[i])));
}

function sampleAffine(): Float64Array {
  const q = mat4.quatFromAxisAngle([0, 0, 0, 0], vec3.normalize([0, 0, 0], [1, 2, 3]), 0.7);
  return mat4.fromTRS(mat4.create(), [10, -5, 3], q, [2, 0.5, 3]);
}

describe('vec3', () => {
  it('basic ops', () => {
    const o = vec3.create();
    close(vec3.add(o, [1, 2, 3], [4, 5, 6]), [5, 7, 9]);
    close(vec3.cross(o, [1, 0, 0], [0, 1, 0]), [0, 0, 1]);
    expect(vec3.dot([1, 2, 3], [4, 5, 6])).toBe(32);
    close(vec3.normalize(o, [0, 3, 4]), [0, 0.6, 0.8]);
    close(vec3.normalize(o, [0, 0, 0]), [0, 0, 0]);
    expect(vec3.distance([1, 1, 1], [4, 5, 1])).toBe(5);
  });
  it('cross aliasing', () => {
    const a = new Float64Array([1, 0, 0]);
    vec3.cross(a, a, [0, 1, 0]);
    close(a, [0, 0, 1]);
  });
  it('rotateAxis follows the right-hand rule', () => {
    close(vec3.rotateAxis(vec3.create(), [1, 0, 0], [0, 0, 1], Math.PI / 2), [0, 1, 0], 1e-12);
  });
  it('slerp, including opposite vectors', () => {
    const o = vec3.create();
    close(vec3.slerp(o, [1, 0, 0], [0, 1, 0], 0.5), [Math.SQRT1_2, Math.SQRT1_2, 0], 1e-12);
    vec3.slerp(o, [1, 0, 0], [-1, 0, 0], 0.5, [0, 0, 1]);
    close(o, [0, 0, 1], 1e-12);
    vec3.slerp(o, [1, 0, 0], [-1, 0, 0], 1);
    close(o, [-1, 0, 0], 1e-12);
    expect(vec3.length(vec3.slerp(o, [0, 1, 0], [0, -1, 0], 0.3))).toBeCloseTo(1, 12);
  });
});

describe('mat4', () => {
  it('multiply with identity and aliasing', () => {
    const m = sampleAffine();
    close(mat4.multiply(mat4.create(), m, mat4.create()), m);
    const a = mat4.copy(mat4.create(), m);
    mat4.multiply(a, a, m);
    close(a, mat4.multiply(mat4.create(), m, m));
    const b = mat4.copy(mat4.create(), m);
    mat4.multiply(b, m, b);
    close(b, a);
  });
  it('invert and invertAffine agree and give identity', () => {
    const m = sampleAffine();
    const inv = mat4.invert(mat4.create(), m)!;
    const invA = mat4.invertAffine(mat4.create(), m)!;
    close(inv, invA, 1e-12);
    close(mat4.multiply(mat4.create(), m, inv), mat4.create(), 1e-12);
    expect(mat4.invert(mat4.create(), new Float64Array(16))).toBeNull();
    expect(mat4.invertAffine(mat4.create(), new Float64Array(16))).toBeNull();
  });
  it('invert of a projection matrix', () => {
    const p = mat4.perspective(mat4.create(), 1, 1.5, 0.1, 100);
    const inv = mat4.invert(mat4.create(), p)!;
    close(mat4.multiply(mat4.create(), p, inv), mat4.create(), 1e-9);
  });
  it('lookAt maps eye to origin and target to -Z', () => {
    const v = mat4.lookAt(mat4.create(), [1, 2, 3], [4, 6, 3], [0, 0, 1]);
    close(mat4.transformPoint(vec3.create(), v, [1, 2, 3]), [0, 0, 0], 1e-12);
    close(mat4.transformPoint(vec3.create(), v, [4, 6, 3]), [0, 0, -5], 1e-12);
    // up stays up
    const u = mat4.transformDirection(vec3.create(), v, [0, 0, 1]);
    close(u, [0, 1, 0], 1e-12);
  });
  it('lookAt with up parallel to view direction is still orthonormal', () => {
    const v = mat4.lookAt(mat4.create(), [0, 10, 0], [0, 0, 0], [0, 1, 0]);
    for (const x of v) expect(Number.isFinite(x)).toBe(true);
    close(mat4.transformPoint(vec3.create(), v, [0, 0, 0]), [0, 0, -10], 1e-12);
    const r = [v[0], v[4], v[8]];
    expect(vec3.length(r)).toBeCloseTo(1, 12);
  });
  it('perspective maps near/far to -1/+1', () => {
    const p = mat4.perspective(mat4.create(), Math.PI / 2, 2, 1, 100);
    expect(mat4.transformPoint(vec3.create(), p, [0, 0, -1])[2]).toBeCloseTo(-1, 12);
    expect(mat4.transformPoint(vec3.create(), p, [0, 0, -100])[2]).toBeCloseTo(1, 12);
    // top edge at 45 degrees
    expect(mat4.transformPoint(vec3.create(), p, [0, 5, -5])[1]).toBeCloseTo(1, 12);
    expect(mat4.transformPoint(vec3.create(), p, [10, 0, -5])[0]).toBeCloseTo(1, 12);
    const inf = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, Infinity);
    expect(mat4.transformPoint(vec3.create(), inf, [0, 0, -1])[2]).toBeCloseTo(-1, 12);
    expect(mat4.transformPoint(vec3.create(), inf, [0, 0, -1e9])[2]).toBeCloseTo(1, 6);
  });
  it('orthographic maps the box to the unit cube', () => {
    const o = mat4.orthographic(mat4.create(), -2, 4, -1, 3, -5, 10);
    close(mat4.transformPoint(vec3.create(), o, [-2, -1, 5]), [-1, -1, -1], 1e-12);
    close(mat4.transformPoint(vec3.create(), o, [4, 3, -10]), [1, 1, 1], 1e-12);
  });
  it('fromTRS composes T * R * S', () => {
    const q = mat4.quatFromAxisAngle([0, 0, 0, 0], [0, 0, 1], Math.PI / 2);
    const m = mat4.fromTRS(mat4.create(), [1, 2, 3], q, [2, 2, 2]);
    close(mat4.transformPoint(vec3.create(), m, [1, 0, 0]), [1, 4, 3], 1e-12);
    const r = mat4.fromAxisAngle(mat4.create(), [0, 0, 1], Math.PI / 2);
    close(mat4.transformDirection(vec3.create(), r, [1, 0, 0]), [0, 1, 0], 1e-12);
    expect(mat4.maxScale(m)).toBeCloseTo(2, 12);
    expect(mat4.isAffine(m)).toBe(true);
  });
});

describe('aabb', () => {
  it('empty, union, expand', () => {
    const b = aabb.create();
    expect(aabb.isEmpty(b)).toBe(true);
    expect(aabb.diagonal(b)).toBe(0);
    aabb.expandByXYZ(b, 1, 2, 3);
    expect(aabb.isEmpty(b)).toBe(false);
    aabb.expandByPoint(b, b, [-1, 0, 5]);
    close(b, [-1, 0, 3, 1, 2, 5]);
    const u = aabb.union(aabb.create(), b, [0, -3, 0, 0, 0, 0]);
    close(u, [-1, -3, 0, 1, 2, 5]);
    close(aabb.union(aabb.create(), aabb.create(), b), b);
    close(aabb.center(vec3.create(), u), [0, -0.5, 2.5]);
    expect(aabb.diagonal([0, 0, 0, 3, 4, 0])).toBe(5);
    const soa = new Float32Array([9, 9, 9, 9, 9, 9, -2, 0, 0, 0, 0, 1]);
    close(aabb.unionAt(aabb.copy(aabb.create(), b), soa, 6), [-2, 0, 0, 1, 2, 5]);
  });
  it('transformAffine equals brute-force corner transform', () => {
    const m = sampleAffine();
    const box = [-1, 2, -3, 4, 5, 0.5];
    const got = aabb.transformAffine(aabb.create(), box, m);
    const ref = aabb.create();
    const p = vec3.create();
    for (let i = 0; i < 8; i++) {
      mat4.transformPoint(p, m, [i & 1 ? box[3] : box[0], i & 2 ? box[4] : box[1], i & 4 ? box[5] : box[2]]);
      aabb.expandByPoint(ref, ref, p);
    }
    close(got, ref, 1e-12);
    expect(aabb.isEmpty(aabb.transformAffine(aabb.create(), aabb.create(), m))).toBe(true);
  });
  it('fromPositions and predicates', () => {
    const b = aabb.fromPositions(aabb.create(), [0, 0, 0, 1, 2, 3, -1, 5, 0]);
    close(b, [-1, 0, 0, 1, 5, 3]);
    expect(aabb.containsPoint(b, [0, 1, 1])).toBe(true);
    expect(aabb.containsPoint(b, [0, 6, 1])).toBe(false);
    expect(aabb.intersects(b, [1, 5, 3, 9, 9, 9])).toBe(true);
    expect(aabb.intersects(b, [1.1, 5, 3, 9, 9, 9])).toBe(false);
    expect(aabb.containsBox(b, [0, 0, 0, 1, 1, 1])).toBe(true);
  });
});

describe('frustum', () => {
  // camera at origin looking down -Z, 90 degree fov, aspect 1, near 1, far 100
  const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 100);
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
  const vp = mat4.multiply(mat4.create(), proj, view);
  const planes = frustum.fromViewProjection(frustum.create(), vp);

  it('planes are normalized and inward', () => {
    for (let i = 0; i < 6; i++) expect(Math.hypot(planes[i * 4], planes[i * 4 + 1], planes[i * 4 + 2])).toBeCloseTo(1, 12);
    expect(frustum.containsPoint(planes, [0, 0, -10])).toBe(true);
    expect(frustum.containsPoint(planes, [0, 0, 10])).toBe(false);
    expect(frustum.containsPoint(planes, [0, 0, -0.5])).toBe(false);
    expect(frustum.containsPoint(planes, [0, 0, -101])).toBe(false);
    // near plane signed distance
    expect(planes[16] * 0 + planes[17] * 0 + planes[18] * -3 + planes[19]).toBeCloseTo(2, 9);
  });
  it('classifies boxes', () => {
    expect(frustum.testAABB(planes, [-1, -1, -11, 1, 1, -9])).toBe(frustum.INSIDE);
    expect(frustum.testAABB(planes, [-1, -1, -1.5, 1, 1, 0.5])).toBe(frustum.INTERSECTING);
    expect(frustum.testAABB(planes, [-1, -1, 2, 1, 1, 3])).toBe(frustum.OUTSIDE);
    expect(frustum.testAABB(planes, [20, -1, -11, 22, 1, -9])).toBe(frustum.OUTSIDE);
    expect(frustum.testAABB(planes, [-1, -1, -200, 1, 1, -150])).toBe(frustum.OUTSIDE);
    expect(frustum.testAABB(planes, [-1e4, -1e4, -1e4, 1e4, 1e4, 1e4])).toBe(frustum.INTERSECTING);
    // offset into SoA array
    const soa = new Float32Array([0, 0, 0, 0, 0, 0, -1, -1, -11, 1, 1, -9]);
    expect(frustum.testAABB(planes, soa, 6)).toBe(frustum.INSIDE);
  });
  it('masked test narrows the plane set', () => {
    const parent = frustum.testAABBMasked(planes, [-15, -1, -11, 15, 1, -9], frustum.ALL_PLANES);
    expect(parent).toBe(0b000011); // straddles left and right only
    expect(frustum.testAABBMasked(planes, [-1, -1, -11, 1, 1, -9], parent)).toBe(0);
    expect(frustum.testAABBMasked(planes, [-30, -1, -11, -20, 1, -9], parent)).toBe(-1);
    // inside parent: no planes tested at all
    expect(frustum.testAABBMasked(planes, [100, 100, 100, 101, 101, 101], 0)).toBe(0);
  });
  it('spheres', () => {
    expect(frustum.testSphere(planes, 0, 0, -10, 1)).toBe(frustum.INSIDE);
    expect(frustum.testSphere(planes, 0, 0, -1, 1)).toBe(frustum.INTERSECTING);
    expect(frustum.testSphere(planes, 0, 0, 5, 1)).toBe(frustum.OUTSIDE);
  });
  it('orthographic frustum and infinite far plane', () => {
    const o = mat4.orthographic(mat4.create(), -1, 1, -1, 1, -10, 10);
    const pl = frustum.fromViewProjection(frustum.create(), o);
    expect(frustum.testAABB(pl, [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5])).toBe(frustum.INSIDE);
    expect(frustum.testAABB(pl, [2, 0, 0, 3, 1, 1])).toBe(frustum.OUTSIDE);
    const inf = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, Infinity);
    const pi = frustum.fromViewProjection(frustum.create(), inf);
    expect(frustum.testAABB(pi, [-1, -1, -1e12, 1, 1, -1e12 + 1])).toBe(frustum.INSIDE);
  });
});

describe('projection', () => {
  it('screen size estimates', () => {
    const pf = perspectivePixelFactor(Math.PI / 2, 1000); // = 500
    expect(pf).toBeCloseTo(500, 9);
    // sphere radius 1 at distance 100: ~ 2 * 500 / 100 = 10 px
    expect(projectedSphereSizePx(0, 0, -100, 1, [0, 0, 0], pf, false)).toBeCloseTo(10, 2);
    expect(projectedSphereSizePx(0, 0, -0.5, 1, [0, 0, 0], pf, false)).toBe(Infinity);
    // twice as far, half as big
    const a = projectedAABBSizePx([-1, -1, -101, 1, 1, -99], [0, 0, 0], pf, false);
    const b = projectedAABBSizePx([-1, -1, -201, 1, 1, -199], [0, 0, 0], pf, false);
    expect(a / b).toBeCloseTo(2, 2);
    const of = orthographicPixelFactor(10, 1000); // 100 px per unit
    expect(projectedSphereSizePx(0, 0, -1e6, 1, [0, 0, 0], of, true)).toBe(200);
    expect(projectedAABBSizePx([0, 0, 0, 3, 4, 0], [0, 0, 0], of, true)).toBeCloseTo(500, 9);
  });
  it('unproject inverts projection, rays pass through points', () => {
    const proj = mat4.perspective(mat4.create(), 0.8, 1.6, 0.5, 500);
    const view = mat4.lookAt(mat4.create(), [10, 20, 30], [0, 0, 0], [0, 1, 0]);
    const vp = mat4.multiply(mat4.create(), proj, view);
    const inv = mat4.invert(mat4.create(), vp)!;
    const world = [1, 2, -3];
    const ndc = mat4.transformPoint(vec3.create(), vp, world);
    close(unproject(vec3.create(), inv, ndc[0], ndc[1], ndc[2]), world, 1e-8);
    const o = vec3.create(), d = vec3.create();
    rayFromNDC(o, d, inv, ndc[0], ndc[1]);
    expect(vec3.length(d)).toBeCloseTo(1, 12);
    // origin on near plane: distance to eye ~ 0.5 / cos(angle)
    expect(vec3.distance(o, [10, 20, 30])).toBeLessThan(1);
    // world point lies on the ray
    const t = vec3.dot(vec3.sub(vec3.create(), world, o), d);
    const closest = vec3.scaleAndAdd(vec3.create(), o, d, t);
    close(closest, world, 1e-7);
    // ortho ray direction equals view direction
    const op = mat4.orthographic(mat4.create(), -5, 5, -5, 5, 0.1, 100);
    const ovp = mat4.multiply(mat4.create(), op, view);
    rayFromNDC(o, d, mat4.invert(mat4.create(), ovp)!, 0.3, -0.7);
    close(d, vec3.normalize(vec3.create(), [-10, -20, -30]), 1e-9);
  });
  it('helpers', () => {
    close(cssToNdc([0, 0], 0, 0, 200, 100), [-1, 1]);
    close(cssToNdc([0, 0], 200, 100, 200, 100), [1, -1]);
    expect(depthToNdcZ(0.5)).toBe(0);
    expect(rayPlaneDistance([0, 0, 0], [0, 0, -1], [0, 0, -7], [0, 0, 1])).toBe(7);
    expect(rayPlaneDistance([0, 0, 0], [1, 0, 0], [0, 0, -7], [0, 0, 1])).toBeNaN();
  });
});

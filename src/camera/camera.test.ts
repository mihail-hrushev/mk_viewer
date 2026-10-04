import { describe, expect, it } from 'vitest';
import { Camera } from './Camera';
import { CameraTransition, fly, levelCamera, orbit, pan, zoomAt, worldUpVector, POLE_EPSILON } from './orbitMath';
import * as mat4 from '../math/mat4';
import * as vec3 from '../math/vec3';
import * as frustum from '../math/frustum';

function ndcOf(cam: Camera, p: ArrayLike<number>): Float64Array {
  return mat4.transformPoint(vec3.create(), cam.viewProjection64, p);
}

function corners(b: number[]): number[][] {
  const r: number[][] = [];
  for (let i = 0; i < 8; i++) r.push([i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]]);
  return r;
}

function expectInsideNdc(cam: Camera, box: number[], tol = 1e-9): void {
  for (const c of corners(box)) {
    const n = ndcOf(cam, c);
    for (let k = 0; k < 3; k++) {
      expect(n[k]).toBeGreaterThanOrEqual(-1 - tol);
      expect(n[k]).toBeLessThanOrEqual(1 + tol);
    }
  }
}

describe('Camera', () => {
  it('defaults and state round trip', () => {
    const cam = new Camera({ up: 'z' });
    const s = cam.getState();
    expect(s.up).toEqual([0, 0, 1]);
    cam.setState({ eye: [1, 2, 3], target: [0, 0, 0], fov: 0.5, orthographic: true });
    const s2 = cam.getState();
    expect(s2.eye).toEqual([1, 2, 3]);
    expect(s2.fov).toBe(0.5);
    expect(s2.orthographic).toBe(true);
  });

  it('version bumps on changes only, matrices are lazy', () => {
    const cam = new Camera();
    const v0 = cam.version;
    cam.set([10, 10, 10], [0, 0, 0], [0, 1, 0]);
    const v1 = cam.version;
    expect(v1).toBeGreaterThanOrEqual(v0);
    cam.set([10, 10, 10], [0, 0, 0], [0, 2, 0]); // same normalized up
    expect(cam.version).toBe(v1);
    cam.set([10, 10, 11]);
    expect(cam.version).toBeGreaterThan(v1);
    const v2 = cam.version;
    cam.setViewport(800, 600);
    expect(cam.version).toBeGreaterThan(v2);
    const v3 = cam.version;
    void cam.viewProjection; // reading does not bump
    expect(cam.version).toBe(v3);
    cam.fov = cam.fov;
    expect(cam.version).toBe(v3);
    cam.setSceneBounds([0, 0, 0, 1, 1, 1]);
    expect(cam.version).toBeGreaterThan(v3);
    const v4 = cam.version;
    cam.setSceneBounds([0, 0, 0, 1, 1, 1]);
    expect(cam.version).toBe(v4);
  });

  it('matrices are consistent; f32 mirrors f64', () => {
    const cam = new Camera();
    cam.setViewport(1000, 500);
    cam.set([5, 6, 7], [1, 0, -1], [0, 1, 0]);
    const vp = mat4.multiply(mat4.create(), cam.projection64, cam.view64);
    for (let i = 0; i < 16; i++) expect(cam.viewProjection64[i]).toBeCloseTo(vp[i], 12);
    const id = mat4.multiply(mat4.create(), cam.viewProjection64, cam.inverseViewProjection64);
    for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 9);
    expect(cam.viewProjection).toBeInstanceOf(Float32Array);
    expect(cam.viewProjection[0]).toBeCloseTo(cam.viewProjection64[0], 6);
    // forward/right/up are orthonormal
    const f = cam.getForward(vec3.create()), r = cam.getRight(vec3.create()), u = cam.getUpOrtho(vec3.create());
    expect(vec3.dot(f, r)).toBeCloseTo(0, 12);
    expect(vec3.dot(f, u)).toBeCloseTo(0, 12);
    const expected = vec3.normalize(vec3.create(), [-4, -6, -8]);
    for (let k = 0; k < 3; k++) expect(f[k]).toBeCloseTo(expected[k], 12);
    expect(cam.aspect).toBe(2);
  });

  it('auto near/far encloses the scene tightly (perspective, outside)', () => {
    const cam = new Camera();
    cam.setViewport(800, 600);
    const box = [-1, -1, -1, 1, 1, 1];
    cam.setSceneBounds(box);
    cam.set([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    expect(cam.near).toBeGreaterThan(8.5);
    expect(cam.near).toBeLessThanOrEqual(9);
    expect(cam.far).toBeGreaterThanOrEqual(11);
    expect(cam.far).toBeLessThan(11.5);
  });

  it('auto near/far when the eye is inside a huge scene', () => {
    const cam = new Camera({ minNearFarRatio: 1e-5 });
    cam.setSceneBounds([-5000, -5000, -5000, 5000, 5000, 5000]);
    cam.set([0, 0, 2], [0, 0, 0], [0, 1, 0]);
    expect(cam.near).toBeGreaterThan(0);
    expect(cam.near).toBeLessThanOrEqual(0.1 + 1e-12);
    expect(cam.far).toBeGreaterThan(5000);
    expect(cam.near / cam.far).toBeGreaterThanOrEqual(1e-5 - 1e-12);
  });

  it('orthographic near/far may be negative and encloses the scene', () => {
    const cam = new Camera();
    cam.orthographic = true;
    cam.setSceneBounds([-10, -10, -10, 10, 10, 10]);
    cam.set([0, 0, 1], [0, 0, 0], [0, 1, 0]);
    expect(cam.near).toBeLessThan(-9);
    expect(cam.far).toBeGreaterThan(11);
  });

  it('fitToBounds frames the box (perspective and ortho, various aspects)', () => {
    const box = [10, -3, 100, 14, 5, 101];
    for (const ortho of [false, true]) {
      for (const [w, h] of [[1000, 500], [400, 900], [500, 500]]) {
        const cam = new Camera();
        cam.orthographic = ortho;
        cam.setViewport(w, h);
        cam.set([0, 0, 0], [1, 2, 3], [0, 1, 0]);
        cam.setSceneBounds(box);
        expect(cam.fitToBounds(box)).toBe(true);
        expectInsideNdc(cam, box, 1e-6);
        // the target is the box centre
        expect(Array.from(cam.target)).toEqual([12, 1, 100.5]);
        // reasonably tight: the box covers a good part of the viewport
        let maxN = 0;
        for (const c of corners(box)) {
          const n = ndcOf(cam, c);
          maxN = Math.max(maxN, Math.abs(n[0]), Math.abs(n[1]));
        }
        expect(maxN).toBeGreaterThan(0.4);
      }
    }
    const cam = new Camera();
    expect(cam.fitToBounds([1, 1, 1, 0, 0, 0])).toBe(false);
  });

  it('frustum from camera culls correctly', () => {
    const cam = new Camera();
    cam.setViewport(800, 600);
    cam.set([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    cam.setSceneBounds([-100, -100, -100, 100, 100, 100]);
    const pl = frustum.fromViewProjection(frustum.create(), cam.viewProjection64);
    expect(frustum.testAABB(pl, [-1, -1, -1, 1, 1, 1])).toBe(frustum.INSIDE);
    expect(frustum.testAABB(pl, [-1, -1, 20, 1, 1, 21])).toBe(frustum.OUTSIDE);
  });

  it('pixelFactor matches projection', () => {
    const cam = new Camera({ fov: Math.PI / 2 });
    cam.setViewport(800, 1000);
    cam.set([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    expect(cam.pixelFactor).toBeCloseTo(500, 9);
    cam.orthographic = true; // view height = 2 * 10 * tan(45deg) = 20
    expect(cam.pixelFactor).toBeCloseTo(50, 9);
    expect(cam.orthoHeight).toBeCloseTo(20, 9);
  });
});

describe('orbit math', () => {
  function makeCam(ortho = false): Camera {
    const cam = new Camera();
    cam.orthographic = ortho;
    cam.setViewport(800, 600);
    cam.setSceneBounds([-10, -10, -10, 10, 10, 10]);
    cam.set([0, 5, 20], [1, 2, 3], [0, 1, 0]);
    return cam;
  }

  it('orbit preserves distance to the pivot and keeps the target', () => {
    const cam = makeCam();
    const d0 = cam.distance;
    orbit(cam, 0.7, 0.3, worldUpVector('y'));
    expect(cam.distance).toBeCloseTo(d0, 9);
    expect(Array.from(cam.target)).toEqual([1, 2, 3]);
    // yaw only keeps the height of the eye
    const cam2 = makeCam();
    orbit(cam2, 1.2, 0, worldUpVector('y'));
    expect(cam2.eye[1]).toBeCloseTo(5, 9);
  });

  it('orbit around a separate pivot', () => {
    const cam = makeCam();
    const pivot = [0, 0, 0];
    const de = vec3.distance(cam.eye, pivot), dt = vec3.distance(cam.target, pivot);
    orbit(cam, 0.4, -0.2, worldUpVector('y'), pivot);
    expect(vec3.distance(cam.eye, pivot)).toBeCloseTo(de, 9);
    expect(vec3.distance(cam.target, pivot)).toBeCloseTo(dt, 9);
  });

  it('pitch is clamped at the poles, and works from an exact top view', () => {
    const cam = makeCam();
    orbit(cam, 0, 10, worldUpVector('y')); // try to go way over the top
    const f = cam.getForward(vec3.create());
    const polar = Math.acos(vec3.dot(f, [0, 1, 0]));
    expect(polar).toBeCloseTo(Math.PI - POLE_EPSILON, 6);
    for (const v of cam.view64) expect(Number.isFinite(v)).toBe(true);

    // exact top view in a z-up world, then yaw and pitch away
    const top = new Camera({ up: 'z' });
    top.set([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    orbit(top, 0.5, 0, worldUpVector('z'));
    for (const v of top.view64) expect(Number.isFinite(v)).toBe(true);
    expect(top.eye[2]).toBeCloseTo(10, 9);
    orbit(top, 0, -0.3, worldUpVector('z'));
    const f2 = top.getForward(vec3.create());
    expect(Math.acos(-f2[2])).toBeCloseTo(0.3, 6);
  });

  it('never rolls: the horizon stays level after retargeting and orbiting', () => {
    const up = worldUpVector('z');
    const right = vec3.create();
    const rollOf = (c: Camera) => Math.abs(vec3.dot(c.getRight(right), up));

    const cam = new Camera({ up: 'z' });
    cam.set([20, -15, 9], [0, 0, 0], [0, 0, 1]);
    cam.update();
    // retarget keeping the old up vector (what a pivot change does): this view is rolled
    cam.set(null, [7, 4, -3], cam.getUpOrtho(vec3.create()));
    expect(rollOf(cam)).toBeGreaterThan(1e-3);
    levelCamera(cam, up);
    expect(rollOf(cam)).toBeLessThan(1e-12);

    // orbiting a rolled camera levels it and keeps it level
    cam.set(null, [-5, 2, 6], null);
    for (let i = 0; i < 500; i++) orbit(cam, 0.013 * ((i % 7) - 3), 0.009 * ((i % 5) - 2), up);
    expect(rollOf(cam)).toBeLessThan(1e-12);
    expect(vec3.dot(cam.getUpOrtho(vec3.create()), up)).toBeGreaterThan(0);

    // an exact top view keeps its heading
    const top = new Camera({ up: 'z' });
    top.set([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    levelCamera(top, up);
    expect(Array.from(top.up)).toEqual([0, 1, 0]);
  });

  it('fly moves eye and target together along the view and right vectors', () => {
    const cam = makeCam();
    const f = cam.getForward(vec3.create()), r = cam.getRight(vec3.create());
    const e0 = cam.eye.slice(0), t0 = cam.target.slice(0), d0 = cam.distance;
    fly(cam, 3, -2);
    for (let i = 0; i < 3; i++) {
      expect(cam.eye[i]).toBeCloseTo(e0[i] + 3 * f[i] - 2 * r[i], 9);
      expect(cam.target[i]).toBeCloseTo(t0[i] + 3 * f[i] - 2 * r[i], 9);
    }
    expect(cam.distance).toBeCloseTo(d0, 9);
    // vertical movement follows the world up axis, not the camera's
    const z0 = cam.eye[2], tz0 = cam.target[2], x0 = cam.eye[0];
    fly(cam, 0, 0, 0, Infinity, 2.5, worldUpVector('z'));
    expect(cam.eye[2]).toBeCloseTo(z0 + 2.5, 9);
    expect(cam.target[2]).toBeCloseTo(tz0 + 2.5, 9);
    expect(cam.eye[0]).toBeCloseTo(x0, 9);
    // orthographic: forward zooms (view height shrinks), sideways still translates
    const ortho = makeCam(true);
    const h0 = ortho.orthoHeight;
    fly(ortho, 3, 0);
    expect(ortho.orthoHeight).toBeLessThan(h0);
  });

  it('drag down moves the camera up (positive pitch)', () => {
    const cam = makeCam();
    const h0 = cam.eye[1];
    orbit(cam, 0, 0.2, worldUpVector('y'));
    expect(cam.eye[1]).toBeGreaterThan(h0);
  });

  for (const ortho of [false, true]) {
    it(`pan keeps target-depth points under the cursor (${ortho ? 'ortho' : 'persp'})`, () => {
      const cam = makeCam(ortho);
      const p = cam.target.slice(0);
      const n0 = ndcOf(cam, p);
      pan(cam, 40, -25, 600);
      const n1 = ndcOf(cam, p);
      // 40 css px right on 800 px = 0.1 NDC; 25 px up on 600 = 0.0833 NDC
      expect(n1[0] - n0[0]).toBeCloseTo(0.1, 9);
      expect(n1[1] - n0[1]).toBeCloseTo(50 / 600, 9);
    });

    it(`zoomAt keeps the cursor point fixed and scales distance (${ortho ? 'ortho' : 'persp'})`, () => {
      const cam = makeCam(ortho);
      const d0 = cam.distance;
      // the world point under ndc (0.4, -0.3) on the target plane
      const inv = cam.inverseViewProjection64;
      const f = cam.getForward(vec3.create());
      const o = vec3.create(), dir = vec3.create();
      // compute through a ray manually
      const a = mat4.transformPoint(vec3.create(), inv, [0.4, -0.3, -1]);
      const b = mat4.transformPoint(vec3.create(), inv, [0.4, -0.3, 0]);
      vec3.copy(o, a);
      vec3.normalize(dir, vec3.sub(dir, b, a));
      const t = vec3.dot(vec3.sub(vec3.create(), cam.target, o), f) / vec3.dot(dir, f);
      const P = vec3.scaleAndAdd(vec3.create(), o, dir, t);
      zoomAt(cam, 0.5, 0.4, -0.3);
      expect(cam.distance).toBeCloseTo(d0 * 0.5, 9);
      const n = ndcOf(cam, P);
      expect(n[0]).toBeCloseTo(0.4, 9);
      expect(n[1]).toBeCloseTo(-0.3, 9);
      zoomAt(cam, 2, 0.4, -0.3);
      expect(cam.distance).toBeCloseTo(d0, 9);
    });
  }

  it('zoom is scale independent (millimetres to kilometres)', () => {
    for (const s of [1e-3, 1, 1e4]) {
      const cam = new Camera();
      cam.setViewport(800, 600);
      cam.set([0, 0, 10 * s], [0, 0, 0], [0, 1, 0]);
      zoomAt(cam, 0.8, 0, 0);
      expect(cam.distance / s).toBeCloseTo(8, 9);
    }
  });

  it('zoom dollies through below minDistance and respects maxDistance', () => {
    const cam = new Camera();
    cam.set([0, 0, 1], [0, 0, 0], [0, 1, 0]);
    zoomAt(cam, 0.5, 0, 0, 0.9);
    expect(cam.distance).toBeCloseTo(1, 9);
    expect(cam.eye[2]).toBeCloseTo(0.5, 9);
    expect(cam.target[2]).toBeCloseTo(-0.5, 9);
    zoomAt(cam, 100, 0, 0, 0, 10);
    expect(cam.distance).toBeCloseTo(10, 9);
  });

  it('CameraTransition eases to the destination', () => {
    const cam = makeCam();
    const tr = new CameraTransition();
    tr.start(cam, { eye: [0, 0, -50], target: [5, 5, 5], fov: 1 }, 400);
    expect(tr.active).toBe(true);
    let steps = 0;
    let prevDist = cam.distance;
    let monotonic = true;
    while (tr.step(cam, 16)) {
      steps++;
      const d = cam.distance;
      // distance goes from ~17.5 to ~55.7 monotonically in log space
      if (d < prevDist - 1e-9) monotonic = false;
      prevDist = d;
      expect(steps).toBeLessThan(100);
    }
    expect(monotonic).toBe(true);
    expect(steps).toBeGreaterThan(20);
    expect(tr.active).toBe(false);
    for (let k = 0; k < 3; k++) expect(cam.eye[k]).toBeCloseTo([0, 0, -50][k], 9);
    expect(Array.from(cam.target)).toEqual([5, 5, 5]);
    expect(cam.fov).toBe(1);
    expect(tr.step(cam, 16)).toBe(false);
  });

  it('CameraTransition handles a 180 degree turn and zero duration', () => {
    const cam = makeCam();
    cam.set([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    const tr = new CameraTransition();
    tr.start(cam, { eye: [0, 0, -10] }, 100);
    tr.step(cam, 50);
    expect(cam.distance).toBeCloseTo(10, 9);
    for (const v of cam.view64) expect(Number.isFinite(v)).toBe(true);
    tr.step(cam, 60);
    expect(cam.eye[2]).toBeCloseTo(-10, 9);
    tr.start(cam, { target: [1, 1, 1] }, 0);
    expect(tr.active).toBe(false);
    expect(Array.from(cam.target)).toEqual([1, 1, 1]);
  });
});

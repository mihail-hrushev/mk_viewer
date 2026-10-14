/**
 * The viewer's camera API (field of view, projection, standard views, navigation settings) and the
 * camera plugin's headless API, on the real Viewer (headless, no DOM / GL).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from './__tests__/headlessViewer';
import { Camera, STANDARD_VIEWS, standardView } from './camera';
import { box } from './primitives';
import { cameraPlugin, type CameraPlugin } from './plugins/camera/cameraPlugin';
import * as mat4 from './math/mat4';
import * as vec3 from './math/vec3';
import type { CameraState } from './types';

let hv: HeadlessViewer | null = null;
afterEach(() => {
  hv?.dispose();
  hv = null;
});

/** Unit direction target -> eye of a camera state. */
function viewDir(s: CameraState): number[] {
  const d = [s.eye[0] - s.target[0], s.eye[1] - s.target[1], s.eye[2] - s.target[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return d.map((x) => x / l);
}

function dist(s: CameraState): number {
  return Math.hypot(s.eye[0] - s.target[0], s.eye[1] - s.target[1], s.eye[2] - s.target[2]);
}

function expectVec(a: ArrayLike<number>, b: ArrayLike<number>, digits = 9): void {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], digits);
}

/** A 4 x 2 x 6 box centred on (10, 20, 30). */
function addBox(h: HeadlessViewer): void {
  const v = h.viewer;
  const g = v.createGeometry(box([4, 2, 6]));
  const m = v.createMaterial();
  v.addMesh({ geometry: g, material: m, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1] });
  h.frame();
}

describe('standard views', () => {
  it('directions and image up vectors for Z up and Y up', () => {
    const d = [0, 0, 0], u = [0, 0, 0];
    standardView('front', 'z', d, u);
    expectVec(d, [0, -1, 0]);
    expectVec(u, [0, 0, 1]);
    standardView('front', 'y', d, u);
    expectVec(d, [0, 0, 1]);
    expectVec(u, [0, 1, 0]);
    standardView('top', 'z', d, u);
    expectVec(d, [0, 0, 1]);
    expectVec(u, [0, 1, 0]); // back at the top of the image
    standardView('top', 'y', d, u);
    expectVec(d, [0, 1, 0]);
    expectVec(u, [0, 0, -1]);
    standardView('right', 'y', d, u);
    expectVec(d, [1, 0, 0]);
    // iso is the direction of the initial camera
    for (const up of ['y', 'z'] as const) {
      standardView('iso', up, d, u);
      const s = new Camera({ up }).getState();
      expectVec(d, viewDir(s));
      expectVec(u, s.up);
    }
    // every view: unit direction, up perpendicular to it (iso uses the world up, like the initial camera)
    for (const view of STANDARD_VIEWS) {
      for (const up of ['y', 'z'] as const) {
        standardView(view, up, d, u);
        expect(vec3.length(d)).toBeCloseTo(1, 12);
        if (view !== 'iso') expect(vec3.dot(d, u)).toBeCloseTo(0, 12);
      }
    }
    expect(() => standardView('side' as never, 'z', d, u)).toThrow(TypeError);
    expect(() => standardView('toString' as never, 'z', d, u)).toThrow(/unknown standard view/);
  });

  it('computeFitStateFrom frames the box from the given side', () => {
    const cam = new Camera({ up: 'z' });
    cam.setViewport(800, 600);
    const b = [-1, -2, -3, 5, 4, 1];
    for (const ortho of [false, true]) {
      cam.orthographic = ortho;
      for (const view of STANDARD_VIEWS) {
        const d = [0, 0, 0], u = [0, 0, 0];
        standardView(view, 'z', d, u);
        cam.setState(cam.computeFitStateFrom(b, d, u)!);
        expectVec(viewDir(cam.getState()), d);
        for (let i = 0; i < 8; i++) {
          const p = [i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]];
          const n = mat4.transformPoint(vec3.create(), cam.viewProjection64, p);
          for (let k = 0; k < 3; k++) expect(Math.abs(n[k])).toBeLessThanOrEqual(1 + 1e-9);
        }
      }
    }
    expect(cam.computeFitStateFrom([1, 1, 1, -1, -1, -1], [0, 0, 1], [0, 1, 0])).toBeNull();
  });
});

describe('viewer camera API', () => {
  it('setFieldOfView keeps the target and the view height there', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    v.setCamera({ eye: [10, 10, 10], target: [1, 2, 3] });
    const s0 = v.getCamera();
    const h0 = 2 * dist(s0) * Math.tan(s0.fov / 2);
    v.setFieldOfView(Math.PI / 2);
    const s1 = v.getCamera();
    expect(s1.fov).toBe(Math.PI / 2);
    expectVec(s1.target, s0.target);
    expectVec(viewDir(s1), viewDir(s0));
    expect(2 * dist(s1) * Math.tan(s1.fov / 2)).toBeCloseTo(h0, 9);
    expect(dist(s1)).toBeLessThan(dist(s0)); // wider lens, closer
    // orthographic: the image does not change (the view height is kept)
    v.setProjection('orthographic');
    const h1 = v.camera.orthoHeight;
    v.setFieldOfView(0.2);
    expect(v.camera.orthoHeight).toBeCloseTo(h1, 9);
    for (const bad of [0, Math.PI, -1, NaN, Infinity, '1' as unknown as number]) {
      expect(() => v.setFieldOfView(bad)).toThrow(RangeError);
    }
    expect(v.getCamera().fov).toBe(0.2);
  });

  it('setProjection switches without moving the camera, with a camera event', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    expect(v.getProjection()).toBe('perspective');
    const events: boolean[] = [];
    v.on('camera', (c) => events.push(c.orthographic));
    const s0 = v.getCamera();
    v.setProjection('orthographic');
    (v as unknown as { cameraChanged(): void }).cameraChanged(); // what the frame loop does
    expect(v.getProjection()).toBe('orthographic');
    expect(v.getCamera()).toEqual({ ...s0, orthographic: true });
    expect(events).toEqual([true]);
    v.setProjection('perspective');
    expect(v.getProjection()).toBe('perspective');
    expect(() => v.setProjection('fisheye' as never)).toThrow(RangeError);
  });

  it('setStandardView frames the scene or the given objects from that side', () => {
    hv = createHeadlessViewer({ up: 'z' });
    const v = hv.viewer;
    addBox(hv);
    v.setStandardView('front', undefined, false);
    let s = v.getCamera();
    expectVec(s.target, [10, 20, 30]);
    expectVec(viewDir(s), [0, -1, 0]);
    expectVec(s.up, [0, 0, 1]);
    v.setStandardView('top', undefined, false);
    s = v.getCamera();
    expectVec(viewDir(s), [0, 0, 1]);
    expectVec(s.up, [0, 1, 0]);
    // the fit distance follows the projection and fov like fitToView
    v.fitToView();
    const fitDist = dist(v.getCamera());
    v.setStandardView('iso', undefined, false);
    expect(dist(v.getCamera())).toBeCloseTo(fitDist, 9);
    expect(() => v.setStandardView('side' as never)).toThrow(TypeError);
  });

  it('setStandardView on an empty scene turns about the target', () => {
    hv = createHeadlessViewer({ up: 'y' });
    const v = hv.viewer;
    v.setCamera({ eye: [0, 0, 5], target: [1, 1, 1] });
    const d0 = dist(v.getCamera());
    v.setStandardView('right', undefined, false);
    const s = v.getCamera();
    expectVec(s.target, [1, 1, 1]);
    expectVec(viewDir(s), [1, 0, 0]);
    expect(dist(s)).toBeCloseTo(d0, 9);
  });

  it('navigation settings: defaults, partial updates, checks', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const d = v.getNavigation();
    expect(d).toEqual({ rotateSpeed: 1, panSpeed: 1, zoomSpeed: 1, moveSpeed: 1, animationMs: 400 });
    d.panSpeed = 9; // a copy
    expect(v.getNavigation().panSpeed).toBe(1);
    v.setNavigation({ zoomSpeed: 2, animationMs: 0 });
    expect(v.getNavigation()).toEqual({ rotateSpeed: 1, panSpeed: 1, zoomSpeed: 2, moveSpeed: 1, animationMs: 0 });
    // all or nothing
    expect(() => v.setNavigation({ rotateSpeed: 3, panSpeed: -1 })).toThrow(/panSpeed must be a finite number >= 0/);
    expect(() => v.setNavigation({ moveSpeed: NaN })).toThrow(RangeError);
    expect(() => v.setNavigation({ animationMs: Infinity })).toThrow(RangeError);
    expect(v.getNavigation().rotateSpeed).toBe(1);
    // animationMs 0: an animated move jumps
    v.setCamera({ eye: [3, 4, 5] }, true);
    expectVec(v.getCamera().eye, [3, 4, 5]);
  });

  it('viewer options: fov, projection, navigation', () => {
    hv = createHeadlessViewer({ fov: 1, projection: 'orthographic', navigation: { panSpeed: 0.5 } });
    const v = hv.viewer;
    expect(v.getCamera().fov).toBe(1);
    expect(v.getProjection()).toBe('orthographic');
    expect(v.getNavigation().panSpeed).toBe(0.5);
    expect(() => createHeadlessViewer({ fov: 4 })).toThrow(RangeError);
    expect(() => createHeadlessViewer({ projection: 'iso' as never })).toThrow(RangeError);
    expect(() => createHeadlessViewer({ navigation: { zoomSpeed: -2 } })).toThrow(RangeError);
  });
});

describe('camera plugin', () => {
  it('projection, field of view in degrees and reset', () => {
    hv = createHeadlessViewer({ plugins: [cameraPlugin()] });
    const v = hv.viewer;
    const p = v.getPlugin<CameraPlugin>('camera')!;
    expect(p.defaults).toEqual({ fov: Math.PI / 4, projection: 'perspective', navigation: v.getNavigation() });
    expect(p.fovDegrees).toBeCloseTo(45, 12);
    const s0 = v.getCamera();
    p.fovDegrees = 60;
    expect(v.getCamera().fov).toBeCloseTo(Math.PI / 3, 12);
    p.projection = 'orthographic';
    expect(v.getProjection()).toBe('orthographic');
    expect(p.projection).toBe('orthographic');
    v.setNavigation({ rotateSpeed: 3 });
    p.reset(false);
    expect(v.getProjection()).toBe('perspective');
    expect(v.getNavigation().rotateSpeed).toBe(1);
    const s1 = v.getCamera();
    expect(s1.fov).toBeCloseTo(s0.fov, 12);
    expectVec(s1.eye, s0.eye);
  });

  it('options are checked; name and removal', () => {
    expect(() => cameraPlugin({ minFov: 0 })).toThrow(RangeError);
    expect(() => cameraPlugin({ maxFov: 180 })).toThrow(RangeError);
    expect(() => cameraPlugin({ minFov: 50, maxFov: 40 })).toThrow(RangeError);
    hv = createHeadlessViewer({ plugins: [cameraPlugin({ name: 'cam' })] });
    expect(hv.viewer.plugins).toEqual(['cam']);
    expect(hv.viewer.removePlugin('cam')).toBe(true);
  });
});

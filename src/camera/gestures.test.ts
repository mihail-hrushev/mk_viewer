import { describe, expect, it } from 'vitest';
import { Camera } from './Camera';
import { GestureMode, GestureRecognizer, PointerKind, TapKind, type GestureSink } from './gestures';
import { twoFingerStep } from './orbitMath';
import * as mat4 from '../math/mat4';
import * as vec3 from '../math/vec3';
import { rayFromNDC, rayPlaneDistance } from '../math/projection';

type Call = [string, ...number[]];

class Recorder implements GestureSink {
  calls: Call[] = [];
  orbit(dx: number, dy: number): void {
    this.calls.push(['orbit', dx, dy]);
  }
  pan(dx: number, dy: number): void {
    this.calls.push(['pan', dx, dy]);
  }
  pinch(dx: number, dy: number, scale: number, mx: number, my: number): void {
    this.calls.push(['pinch', dx, dy, scale, mx, my]);
  }
}

const T = PointerKind.Touch;
const M = PointerKind.Mouse;

function setup() {
  const sink = new Recorder();
  return { sink, g: new GestureRecognizer(sink) };
}

/** Touch tap helper: down at (x, y), optional moves, up at the last position. */
function touchTap(g: GestureRecognizer, x: number, y: number, t: number, moves: [number, number][] = [], dur = 80, id = 1) {
  g.down(id, T, x, y, t, 0, false, true, 0);
  let lx = x, ly = y;
  for (const [mx, my] of moves) {
    g.move(id, mx, my);
    lx = mx;
    ly = my;
  }
  return g.up(id, lx, ly, t + dur, false);
}

describe('GestureRecognizer: tap / drag classification', () => {
  it('a slightly shaky touch tap is a tap, and does not move the camera', () => {
    const { g, sink } = setup();
    expect(touchTap(g, 100, 100, 0, [[104, 103], [107, 105], [103, 106]])).toBe(TapKind.Tap);
    expect(sink.calls).toEqual([]);
    expect(g.tapX).toBe(100);
    expect(g.tapY).toBe(100);
    expect(g.dragged).toBe(false);
  });

  it('a short touch drag beyond the slop is not a tap', () => {
    const { g } = setup();
    expect(touchTap(g, 100, 100, 0, [[106, 100], [112, 100]])).toBe(TapKind.None);
    expect(g.dragged).toBe(true);
    // the release position counts too
    const r = setup();
    r.g.down(1, T, 100, 100, 0, 0, false, true);
    expect(r.g.up(1, 115, 100, 50, false)).toBe(TapKind.None);
  });

  it('touch tolerance is larger than the mouse one', () => {
    const { g } = setup();
    expect(g.slopFor(T)).toBeGreaterThan(g.slopFor(M));
    // 6 px: tap for touch, drag for mouse
    expect(touchTap(g, 10, 10, 0, [[16, 10]])).toBe(TapKind.Tap);
    g.down(1, M, 10, 10, 1000, 0, false, true);
    g.move(1, 16, 10);
    expect(g.up(1, 16, 10, 1100, false)).toBe(TapKind.None);
  });

  it('touch slop scales with the contact size (capped at twice the base)', () => {
    const { g } = setup();
    expect(g.slopFor(T, 0)).toBe(10);
    expect(g.slopFor(T, 1)).toBe(10);
    expect(g.slopFor(T, 30)).toBe(15);
    expect(g.slopFor(T, 200)).toBe(20);
    g.down(1, T, 0, 0, 0, 0, false, true, 36); // slop 18
    g.move(1, 15, 0);
    expect(g.up(1, 15, 0, 100, false)).toBe(TapKind.Tap);
  });

  it('a long press is not a tap (touch only); a slow mouse click is', () => {
    const { g } = setup();
    expect(touchTap(g, 0, 0, 0, [], 700)).toBe(TapKind.None);
    g.down(1, M, 0, 0, 5000, 0, false, true);
    expect(g.up(1, 0, 0, 7000, false)).toBe(TapKind.Tap);
  });

  it('cancelled gestures and non-primary mouse buttons are never taps', () => {
    const { g } = setup();
    g.down(1, T, 0, 0, 0, 0, false, true);
    expect(g.up(1, 0, 0, 50, true)).toBe(TapKind.None);
    expect(g.pointerCount).toBe(0);
    g.down(1, M, 0, 0, 1000, 2, false, true);
    expect(g.mode).toBe(GestureMode.Pan);
    expect(g.up(1, 0, 0, 1050, false)).toBe(TapKind.None);
  });

  it('two-finger taps are not taps', () => {
    const { g } = setup();
    g.down(1, T, 0, 0, 0, 0, false, true);
    g.down(2, T, 50, 0, 10, 0, false, false);
    expect(g.up(2, 50, 0, 60, false)).toBe(TapKind.None);
    expect(g.up(1, 0, 0, 70, false)).toBe(TapKind.None);
  });

  it('double tap: close in time and place, same pointer kind', () => {
    const { g } = setup();
    expect(touchTap(g, 100, 100, 0)).toBe(TapKind.Tap);
    expect(touchTap(g, 110, 95, 300)).toBe(TapKind.DoubleTap); // 220 ms after the first release
    expect(touchTap(g, 110, 95, 600)).toBe(TapKind.Tap); // a third tap starts a new pair
    expect(touchTap(g, 110, 95, 1500)).toBe(TapKind.Tap); // too late
    expect(touchTap(g, 200, 95, 1700)).toBe(TapKind.Tap); // too far
    // mouse: tighter distance
    g.down(1, M, 0, 0, 5000, 0, false, true);
    expect(g.up(1, 0, 0, 5050, false)).toBe(TapKind.Tap);
    g.down(1, M, 2, 1, 5200, 0, false, true);
    expect(g.up(1, 2, 1, 5250, false)).toBe(TapKind.DoubleTap);
  });
});

describe('GestureRecognizer: drags and finger transitions', () => {
  it('mouse drag orbits from the first move; shift / right drag pans', () => {
    const { g, sink } = setup();
    g.down(1, M, 0, 0, 0, 0, false, true);
    g.move(1, 2, 1);
    g.up(1, 2, 1, 10, false);
    g.down(1, M, 0, 0, 100, 0, true, true);
    g.move(1, 3, 0);
    g.up(1, 3, 0, 110, false);
    expect(sink.calls).toEqual([['orbit', 2, 1], ['pan', 3, 0]]);
  });

  it('one-finger orbit starts after the slop without a jump', () => {
    const { g, sink } = setup();
    g.down(1, T, 100, 100, 0, 0, false, true);
    g.move(1, 105, 100);
    g.move(1, 109, 100); // still inside 10 px
    expect(sink.calls).toEqual([]);
    g.move(1, 112, 100); // leaves the slop: arms, no delta applied
    expect(sink.calls).toEqual([]);
    g.move(1, 115, 102);
    g.move(1, 120, 102);
    expect(sink.calls).toEqual([['orbit', 3, 2], ['orbit', 5, 0]]);
  });

  it('second finger: no jump on landing, then combined pan + pinch about the midpoint, no twist', () => {
    const { g, sink } = setup();
    g.down(1, T, 100, 100, 0, 0, false, true);
    g.move(1, 120, 100); // arms orbit
    g.move(1, 125, 100); // orbit 5
    sink.calls.length = 0;
    expect(g.down(2, T, 225, 100, 10, 0, false, false)).toBe(true);
    expect(g.mode).toBe(GestureMode.Touch2);
    expect(sink.calls).toEqual([]); // landing emits nothing
    // spread finger 2 by 100 px: distance 100 -> 200, midpoint 175 -> 225
    g.move(2, 325, 100);
    expect(sink.calls.length).toBe(1);
    const [name, dx, dy, scale, mx, my] = sink.calls[0];
    expect(name).toBe('pinch');
    expect(dx).toBeCloseTo(50);
    expect(dy).toBeCloseTo(0);
    expect(scale).toBeCloseTo(0.5);
    expect(mx).toBeCloseTo(225);
    expect(my).toBeCloseTo(100);
    // twist: rotate both fingers 30 degrees about the midpoint at constant distance
    sink.calls.length = 0;
    const a = Math.PI / 6;
    g.move(1, 225 - 100 * Math.cos(a), 100 - 100 * Math.sin(a));
    g.move(2, 225 + 100 * Math.cos(a), 100 + 100 * Math.sin(a));
    // two events: the first moves one finger only (midpoint shifts), the second restores it
    let sx = 0, sy = 0, sScale = 1;
    for (const c of sink.calls) {
      sx += c[1];
      sy += c[2];
      sScale *= c[3];
    }
    expect(sx).toBeCloseTo(0, 9);
    expect(sy).toBeCloseTo(0, 9);
    expect(sScale).toBeCloseTo(1, 9);
  });

  it('lifting one of two fingers continues as orbit after the slop (either finger)', () => {
    for (const lift of [1, 2]) {
      const { g, sink } = setup();
      g.down(1, T, 100, 100, 0, 0, false, true);
      g.down(2, T, 200, 100, 5, 0, false, false);
      g.move(2, 210, 100);
      sink.calls.length = 0;
      expect(g.up(lift, lift === 1 ? 100 : 210, 100, 50, false)).toBe(TapKind.None);
      expect(g.mode).toBe(GestureMode.Orbit);
      expect(g.pointerCount).toBe(1);
      const rest = lift === 1 ? 2 : 1;
      const x0 = rest === 2 ? 210 : 100;
      g.move(rest, x0 + 4, 100); // jitter of the lift: ignored
      expect(sink.calls).toEqual([]);
      g.move(rest, x0 + 12, 100); // arms
      g.move(rest, x0 + 15, 100);
      expect(sink.calls).toEqual([['orbit', 3, 0]]);
      expect(g.up(rest, x0 + 15, 100, 100, false)).toBe(TapKind.None);
      expect(g.mode).toBe(GestureMode.None);
    }
  });

  it('a third finger is ignored; the two-finger gesture continues', () => {
    const { g, sink } = setup();
    g.down(1, T, 0, 0, 0, 0, false, true);
    g.down(2, T, 100, 0, 1, 0, false, false);
    expect(g.down(3, T, 50, 50, 2, 0, false, false)).toBe(false);
    expect(g.move(3, 60, 60)).toBe(false);
    expect(g.up(3, 60, 60, 20, false)).toBe(TapKind.None);
    expect(g.pointerCount).toBe(2);
    g.move(2, 200, 0);
    expect(sink.calls.length).toBe(1);
    expect(sink.calls[0][3]).toBeCloseTo(0.5);
  });

  it('a mouse cannot join a touch gesture and vice versa', () => {
    const { g } = setup();
    g.down(1, T, 0, 0, 0, 0, false, true);
    expect(g.down(9, M, 5, 5, 1, 0, false, false)).toBe(false);
    expect(g.pointerCount).toBe(1);
  });

  it('cancel of one finger keeps the other usable; the gesture is no tap', () => {
    const { g, sink } = setup();
    g.down(1, T, 0, 0, 0, 0, false, true);
    g.down(2, T, 100, 0, 1, 0, false, false);
    g.up(2, 100, 0, 10, true);
    g.move(1, 20, 0); // arms
    g.move(1, 25, 0);
    expect(sink.calls).toEqual([['orbit', 5, 0]]);
    expect(g.up(1, 25, 0, 30, false)).toBe(TapKind.None);
    // next gesture works normally
    expect(touchTap(g, 0, 0, 1000)).toBe(TapKind.Tap);
  });

  it('a new primary pointer resets pointers whose up event was lost', () => {
    const { g } = setup();
    g.down(1, T, 0, 0, 0, 0, false, true);
    g.down(2, T, 100, 0, 1, 0, false, false);
    // both ups lost; a new touch sequence starts with a primary pointer
    expect(g.down(7, T, 30, 30, 1000, 0, false, true)).toBe(true);
    expect(g.pointerCount).toBe(1);
    expect(g.mode).toBe(GestureMode.Orbit);
    expect(g.up(7, 30, 30, 1050, false)).toBe(TapKind.Tap);
  });
});

// ---------------------------------------------------------------------------------------------
// two-finger camera maths

const W = 800, H = 600;

function makeCamera(ortho = false): Camera {
  const cam = new Camera();
  cam.setViewport(W, H);
  cam.orthographic = ortho;
  cam.setSceneBounds([-50, -50, -50, 50, 50, 50]);
  cam.set([10, 12, 30], [1, 2, -3], [0, 1, 0]);
  return cam;
}

/** CSS pixel of a world point. */
function screenOf(cam: Camera, p: ArrayLike<number>): [number, number] {
  const n = mat4.transformPoint(vec3.create(), cam.viewProjection64, p);
  return [((n[0] + 1) / 2) * W, ((1 - n[1]) / 2) * H];
}

/** World point at depth fraction `t` along the view ray through CSS pixel (x, y). */
function worldOnRay(cam: Camera, x: number, y: number, t: number | 'target'): Float64Array {
  const o = vec3.create(), d = vec3.create();
  rayFromNDC(o, d, cam.inverseViewProjection64, (x / W) * 2 - 1, 1 - (y / H) * 2);
  let s: number;
  if (t === 'target') {
    const f = cam.getForward(vec3.create());
    s = rayPlaneDistance(o, d, cam.target, f);
  } else s = t;
  return vec3.scaleAndAdd(vec3.create(), o, d, s);
}

describe('two-finger camera maths', () => {
  for (const ortho of [false, true]) {
    const label = ortho ? 'orthographic' : 'perspective';

    it(`${label}: pure pinch scales the distance and keeps the midpoint's world points fixed`, () => {
      const cam = makeCamera(ortho);
      const mx = 530, my = 210;
      const pTarget = worldOnRay(cam, mx, my, 'target');
      const d0 = cam.distance;
      twoFingerStep(cam, 0, 0, 0.5, mx, my, W, H);
      expect(cam.distance / d0).toBeCloseTo(0.5, 9);
      const s = screenOf(cam, pTarget);
      expect(s[0]).toBeCloseTo(mx, 6);
      expect(s[1]).toBeCloseTo(my, 6);
    });

    it(`${label}: pan + pinch moves the target-plane point under the old midpoint to the new one`, () => {
      const cam = makeCamera(ortho);
      const p = worldOnRay(cam, 300, 350, 'target');
      twoFingerStep(cam, 60, -40, 0.8, 360, 310, W, H);
      const s = screenOf(cam, p);
      expect(s[0]).toBeCloseTo(360, 6);
      expect(s[1]).toBeCloseTo(310, 6);
    });
  }

  it('perspective pinch keeps a point in front of / behind the target plane on the midpoint too', () => {
    const cam = makeCamera(false);
    const mx = 250, my = 420;
    const near = worldOnRay(cam, mx, my, cam.distance * 0.6);
    const far = worldOnRay(cam, mx, my, cam.distance * 1.7);
    twoFingerStep(cam, 0, 0, 0.7, mx, my, W, H);
    for (const p of [near, far]) {
      const s = screenOf(cam, p);
      expect(s[0]).toBeCloseTo(mx, 6);
      expect(s[1]).toBeCloseTo(my, 6);
    }
  });

  it('recognizer + camera: a full pinch-and-drag gesture is smooth and anchored', () => {
    const cam = makeCamera(false);
    const sink: GestureSink = {
      orbit: () => {
        throw new Error('no orbit expected');
      },
      pan: () => {
        throw new Error('no pan expected');
      },
      pinch: (dx, dy, s, mx, my) => twoFingerStep(cam, dx, dy, s, mx, my, W, H),
    };
    const g = new GestureRecognizer(sink);
    // fingers at 350 and 450 (midpoint 400, 300)
    g.down(1, T, 350, 300, 0, 0, false, true);
    g.down(2, T, 450, 300, 5, 0, false, false);
    const anchor = worldOnRay(cam, 400, 300, 'target');
    const d0 = cam.distance;
    // 20 interleaved finger events: spread to 300 px apart while the midpoint moves to (480, 250)
    const N = 10;
    let prevDist = cam.distance;
    for (let i = 1; i <= N; i++) {
      const k = i / N;
      const cx = 400 + 80 * k, cy = 300 - 50 * k, half = 50 + 100 * k;
      g.move(1, cx - half, cy);
      g.move(2, cx + half, cy);
      // monotonic, no jumps: each step changes the distance by a bounded factor
      const r = cam.distance / prevDist;
      expect(r).toBeLessThan(1.0001);
      expect(r).toBeGreaterThan(0.6);
      prevDist = cam.distance;
    }
    expect(cam.distance / d0).toBeCloseTo(100 / 300, 6);
    const s = screenOf(cam, anchor);
    expect(s[0]).toBeCloseTo(480, 4);
    expect(s[1]).toBeCloseTo(250, 4);
  });
});

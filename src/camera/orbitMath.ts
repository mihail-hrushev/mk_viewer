/**
 * Pure camera-navigation maths used by OrbitControls (no DOM). All functions modify the camera
 * in place and allocate nothing.
 */
import type { CameraState } from '../types';
import type { ReadArray } from '../math/common';
import * as vec3 from '../math/vec3';
import { rayFromNDC, rayPlaneDistance } from '../math/projection';
import type { Camera } from './Camera';

const Y_UP: ReadArray = Object.freeze([0, 1, 0]);
const Z_UP: ReadArray = Object.freeze([0, 0, 1]);

export function worldUpVector(up: 'y' | 'z'): ReadArray {
  return up === 'z' ? Z_UP : Y_UP;
}

const sEye = new Float64Array(3);
const sTarget = new Float64Array(3);
const sUp = new Float64Array(3);
const sOff = new Float64Array(3);
const sFwd = new Float64Array(3);
const sRight = new Float64Array(3);
const sCamUp = new Float64Array(3);
const sOrigin = new Float64Array(3);
const sDir = new Float64Array(3);
const sP = new Float64Array(3);

/** Minimum angle (radians) kept between the view direction and the world up/down axis. */
export const POLE_EPSILON = 1e-4;

/**
 * Turntable orbit around `pivot` (default: the camera target).
 * `dYaw` rotates around the world up axis (right-hand rule); `dPitch` > 0 moves the camera up
 * (looking down more). Pitch is clamped so the view never crosses the world poles.
 */
export function orbit(camera: Camera, dYaw: number, dPitch: number, worldUp: ReadArray, pivot?: ReadArray): void {
  const p = pivot ?? camera.target;
  vec3.copy(sEye, camera.eye);
  vec3.copy(sTarget, camera.target);
  vec3.copy(sUp, camera.up);

  // yaw around world up through the pivot
  if (dYaw !== 0) {
    rotateAround(sEye, p, worldUp, dYaw);
    rotateAround(sTarget, p, worldUp, dYaw);
    vec3.rotateAxis(sUp, sUp, worldUp, dYaw);
  }

  vec3.sub(sFwd, sTarget, sEye);
  vec3.normalize(sFwd, sFwd);
  // a turntable camera never rolls: the pitch axis is always horizontal
  levelRight(sRight, sFwd, sUp, worldUp);

  if (dPitch !== 0) {
    // polar angle of the forward vector measured from world up (0 = looking straight up)
    const polar = Math.acos(Math.max(-1, Math.min(1, vec3.dot(sFwd, worldUp))));
    let newPolar = polar + dPitch;
    newPolar = Math.max(POLE_EPSILON, Math.min(Math.PI - POLE_EPSILON, newPolar));
    // never move further into a pole the camera is already past (e.g. exact top views)
    if (dPitch > 0 && newPolar < polar) newPolar = polar;
    if (dPitch < 0 && newPolar > polar) newPolar = polar;
    const a = newPolar - polar;
    if (a !== 0) {
      // rotating by -a around right = forward moves away from up by a
      rotateAround(sEye, p, sRight, -a);
      rotateAround(sTarget, p, sRight, -a);
      vec3.rotateAxis(sFwd, sFwd, sRight, -a);
    }
  }
  vec3.cross(sUp, sRight, sFwd);
  vec3.normalize(sUp, sUp);
  camera.set(sEye, sTarget, sUp);
}

/**
 * Removes any roll from the camera: its up vector is replaced by the one that keeps the horizon
 * level for the current view direction. At an exact top/bottom view the heading given by the
 * current up vector is kept.
 */
export function levelCamera(camera: Camera, worldUp: ReadArray): void {
  vec3.sub(sFwd, camera.target, camera.eye);
  if (vec3.lengthSq(sFwd) === 0) return;
  vec3.normalize(sFwd, sFwd);
  levelRight(sRight, sFwd, camera.up, worldUp);
  vec3.cross(sUp, sRight, sFwd);
  vec3.normalize(sUp, sUp);
  if (!vec3.equals(sUp, camera.up)) camera.set(null, null, sUp);
}

/** Unit right vector perpendicular to both `fwd` and `worldUp` (horizontal, upright camera). */
function levelRight(out: Float64Array, fwd: ReadArray, up: ReadArray, worldUp: ReadArray): void {
  vec3.cross(out, fwd, worldUp);
  if (vec3.lengthSq(out) < 1e-12) {
    // looking straight along the up axis: take the heading from the current up vector
    vec3.cross(out, fwd, up);
    vec3.scaleAndAdd(out, out, worldUp, -vec3.dot(out, worldUp));
    if (vec3.lengthSq(out) < 1e-24) vec3.anyPerpendicular(out, worldUp);
  }
  vec3.normalize(out, out);
}

function rotateAround(point: Float64Array, pivot: ReadArray, axis: ReadArray, angle: number): void {
  vec3.sub(sOff, point, pivot);
  vec3.rotateAxis(sOff, sOff, axis, angle);
  vec3.add(point, pivot, sOff);
}

/**
 * Pans so that geometry at the target depth follows the cursor: dragging by (dxPx, dyPx) CSS
 * pixels (y down) moves the scene by the same amount on screen. `viewportHeightPx` is the
 * height of the element the pixel deltas are measured in.
 */
export function pan(camera: Camera, dxPx: number, dyPx: number, viewportHeightPx: number): void {
  camera.getForward(sFwd);
  camera.getRight(sRight);
  camera.getUpOrtho(sCamUp);
  vec3.sub(sOff, camera.target, camera.eye);
  const depth = Math.max(vec3.dot(sOff, sFwd), 0);
  const unitsPerPx = camera.viewHeightAt(depth) / Math.max(1, viewportHeightPx);
  const mx = -dxPx * unitsPerPx;
  const my = dyPx * unitsPerPx;
  vec3.scaleAndAdd(sEye, camera.eye, sRight, mx);
  vec3.scaleAndAdd(sEye, sEye, sCamUp, my);
  vec3.scaleAndAdd(sTarget, camera.target, sRight, mx);
  vec3.scaleAndAdd(sTarget, sTarget, sCamUp, my);
  camera.set(sEye, sTarget, null);
}

/**
 * Zooms by `scale` (< 1 zooms in, > 1 out) toward the point under NDC (ndcX, ndcY) on the plane
 * through the target facing the camera; that point stays fixed on screen. Works for both
 * projections (orthographic view height is proportional to the eye-target distance).
 *
 * When zooming in would bring the eye closer to the target than `minDistance`, the camera instead
 * moves forward along the cursor ray together with its target (dolly through), so the user never
 * gets stuck. `maxDistance` caps zooming out.
 */
export function zoomAt(
  camera: Camera,
  scale: number,
  ndcX: number,
  ndcY: number,
  minDistance = 0,
  maxDistance = Infinity,
): void {
  if (!(scale > 0) || scale === 1) return;
  const dist = camera.distance;
  camera.getForward(sFwd);
  rayFromNDC(sOrigin, sDir, camera.inverseViewProjection64, ndcX, ndcY);
  let t = rayPlaneDistance(sOrigin, sDir, camera.target, sFwd);
  if (!Number.isFinite(t)) t = 0;
  vec3.scaleAndAdd(sP, sOrigin, sDir, t);

  let s = scale;
  if (dist * s > maxDistance) s = maxDistance / Math.max(dist, 1e-300);
  if (s < 1 && dist * s < minDistance) {
    // dolly through: move eye and target forward along the cursor ray
    const step = Math.max(dist, minDistance) * (1 - scale);
    vec3.scaleAndAdd(sEye, camera.eye, sDir, step);
    vec3.scaleAndAdd(sTarget, camera.target, sDir, step);
    camera.set(sEye, sTarget, null);
    return;
  }
  // eye' = P + (eye - P) * s ; target' = P + (target - P) * s
  vec3.sub(sOff, camera.eye, sP);
  vec3.scaleAndAdd(sEye, sP, sOff, s);
  vec3.sub(sOff, camera.target, sP);
  vec3.scaleAndAdd(sTarget, sP, sOff, s);
  camera.set(sEye, sTarget, null);
}

/**
 * Fly step: moves eye and target together by `forward` world units along the view direction and
 * `right` units along the camera's right vector. An orthographic view has no depth cue, so there
 * the forward part zooms instead (same on-screen effect as approaching in perspective).
 */
export function fly(camera: Camera, forward: number, right: number, minDistance = 0, maxDistance = Infinity): void {
  if (forward !== 0 && camera.orthographic) {
    zoomAt(camera, Math.exp(-forward / Math.max(camera.distance, 1e-300)), 0, 0, minDistance, maxDistance);
    forward = 0;
  }
  if (forward === 0 && right === 0) return;
  camera.getForward(sFwd);
  camera.getRight(sRight);
  vec3.scaleAndAdd(sEye, camera.eye, sFwd, forward);
  vec3.scaleAndAdd(sEye, sEye, sRight, right);
  vec3.scaleAndAdd(sTarget, camera.target, sFwd, forward);
  vec3.scaleAndAdd(sTarget, sTarget, sRight, right);
  camera.set(sEye, sTarget, null);
}

/**
 * One two-finger step (see GestureSink.pinch): pan by the midpoint motion (dxPx, dyPx), then zoom
 * by `scale` about the new midpoint (midX, midY), all in CSS pixels of a viewWidth x viewHeight
 * element. A point on the plane through the target under the old midpoint ends up under the new
 * midpoint; a pure pinch keeps every point on the midpoint's view ray under the midpoint.
 */
export function twoFingerStep(
  camera: Camera,
  dxPx: number,
  dyPx: number,
  scale: number,
  midX: number,
  midY: number,
  viewWidth: number,
  viewHeight: number,
  minDistance = 0,
  maxDistance = Infinity,
): void {
  if (dxPx !== 0 || dyPx !== 0) pan(camera, dxPx, dyPx, viewHeight);
  if (scale !== 1) {
    const ndcX = (midX / Math.max(1, viewWidth)) * 2 - 1;
    const ndcY = 1 - (midY / Math.max(1, viewHeight)) * 2;
    zoomAt(camera, scale, ndcX, ndcY, minDistance, maxDistance);
  }
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Animated camera transition. Interpolates the target linearly, the viewing direction spherically
 * and the distance logarithmically, so large zoom changes and turns look natural.
 */
export class CameraTransition {
  private readonly fromTarget = new Float64Array(3);
  private readonly toTarget = new Float64Array(3);
  private readonly fromDir = new Float64Array(3);
  private readonly toDir = new Float64Array(3);
  private readonly fromUp = new Float64Array(3);
  private readonly toUp = new Float64Array(3);
  private fromLogDist = 0;
  private toLogDist = 0;
  private fromFov = 0;
  private toFov = 0;
  private elapsed = 0;
  private duration = 0;
  private _active = false;

  get active(): boolean {
    return this._active;
  }

  /**
   * Starts a transition from the camera's current state to `to` (missing fields keep their
   * current values). `orthographic` is applied immediately. A duration <= 0 applies `to` at once.
   */
  start(camera: Camera, to: Partial<CameraState>, durationMs: number): void {
    if (to.orthographic !== undefined) camera.orthographic = to.orthographic;
    vec3.copy(this.fromTarget, camera.target);
    vec3.copy(this.fromUp, camera.up);
    vec3.sub(this.fromDir, camera.eye, camera.target);
    const d0 = vec3.length(this.fromDir);
    if (d0 > 0) vec3.scale(this.fromDir, this.fromDir, 1 / d0);
    else vec3.copy(this.fromDir, camera.up);

    const toEye = to.eye ?? camera.eye;
    vec3.copy(this.toTarget, to.target ?? camera.target);
    vec3.normalize(this.toUp, to.up ?? camera.up);
    vec3.sub(this.toDir, toEye, this.toTarget);
    const d1 = vec3.length(this.toDir);
    if (d1 > 0) vec3.scale(this.toDir, this.toDir, 1 / d1);
    else vec3.copy(this.toDir, this.fromDir);

    const minD = 1e-12;
    this.fromLogDist = Math.log(Math.max(d0, minD));
    this.toLogDist = Math.log(Math.max(d1 > 0 ? d1 : d0, minD));
    this.fromFov = camera.fov;
    this.toFov = to.fov ?? camera.fov;
    this.elapsed = 0;
    this.duration = durationMs;
    this._active = true;
    if (durationMs <= 0) this.step(camera, 0);
  }

  cancel(): void {
    this._active = false;
  }

  /** Advances by `dtMs` and applies the interpolated state. Returns true while still running. */
  step(camera: Camera, dtMs: number): boolean {
    if (!this._active) return false;
    this.elapsed += dtMs;
    const raw = this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1;
    const done = raw >= 1;
    const t = done ? 1 : easeInOutCubic(raw);
    vec3.lerp(sTarget, this.fromTarget, this.toTarget, t);
    vec3.slerp(sDir, this.fromDir, this.toDir, t, this.fromUp);
    const dist = done ? Math.exp(this.toLogDist) : Math.exp(this.fromLogDist + (this.toLogDist - this.fromLogDist) * t);
    vec3.scaleAndAdd(sEye, sTarget, sDir, dist);
    vec3.slerp(sUp, this.fromUp, this.toUp, t, sDir);
    camera.set(sEye, sTarget, sUp);
    camera.fov = this.fromFov + (this.toFov - this.fromFov) * t;
    if (done) this._active = false;
    return !done;
  }
}

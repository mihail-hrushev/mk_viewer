/**
 * Camera: eye/target/up + vertical fov, perspective or orthographic.
 *
 * - All state and matrices are kept in Float64 internally; Float32 copies are exposed for upload.
 * - Matrices are recomputed lazily on first access after a change.
 * - `version` increases on every change, so the renderer can detect motion with one comparison.
 * - Near/far are fitted automatically to the scene bounds supplied with `setSceneBounds`.
 * - Orthographic view height is derived from the eye-target distance and fov
 *   (height = 2 * distance * tan(fov / 2)), so switching projection keeps the framing at the
 *   target, and dollying the eye zooms an orthographic view as well.
 */
import type { CameraState } from '../types';
import type { ReadArray } from '../math/common';
import * as mat4 from '../math/mat4';
import * as vec3 from '../math/vec3';
import * as aabb from '../math/aabb';
import { perspectivePixelFactor, orthographicPixelFactor } from '../math/projection';

export interface CameraOptions {
  /** World up; sets the initial up vector and the default view. Default 'y'. */
  up?: 'y' | 'z';
  /** Vertical field of view in radians. Default PI/4. */
  fov?: number;
  orthographic?: boolean;
  /**
   * Smallest allowed near/far ratio for perspective auto clipping. Smaller means less clipping of
   * close geometry but worse depth precision far away. Default 1e-5.
   */
  minNearFarRatio?: number;
}

const DEFAULT_FOV = Math.PI / 4;

const tmpA = new Float64Array(3);
const tmpB = new Float64Array(3);

export class Camera {
  private readonly _eye = new Float64Array(3);
  private readonly _target = new Float64Array(3);
  private readonly _up = new Float64Array(3);
  private _fov = DEFAULT_FOV;
  private _ortho = false;
  private _width = 1;
  private _height = 1;
  private _near = 0.1;
  private _far = 1000;
  private _autoClip = true;
  private _minNearFarRatio = 1e-5;
  private readonly _bounds = aabb.create();
  private _version = 1;
  private _dirty = true;

  private readonly _view64 = mat4.create();
  private readonly _proj64 = mat4.create();
  private readonly _viewProj64 = mat4.create();
  private readonly _invView64 = mat4.create();
  private readonly _invViewProj64 = mat4.create();
  private readonly _view32 = mat4.create32();
  private readonly _proj32 = mat4.create32();
  private readonly _viewProj32 = mat4.create32();
  private readonly _invViewProj32 = mat4.create32();

  constructor(options: CameraOptions = {}) {
    const zUp = options.up === 'z';
    if (zUp) {
      vec3.set(this._up, 0, 0, 1);
      vec3.set(this._eye, 10, -10, 10);
    } else {
      vec3.set(this._up, 0, 1, 0);
      vec3.set(this._eye, 10, 10, 10);
    }
    if (options.fov !== undefined) this._fov = options.fov;
    if (options.orthographic !== undefined) this._ortho = options.orthographic;
    if (options.minNearFarRatio !== undefined) this._minNearFarRatio = options.minNearFarRatio;
  }

  // ---------------------------------------------------------------------------------------------
  // state

  /** Increases on every change of any camera parameter (pose, projection, viewport, clip planes). */
  get version(): number {
    return this._version;
  }

  /** Internal eye position. Do not mutate; use `set` / `setState`. */
  get eye(): Readonly<Float64Array> {
    return this._eye;
  }
  get target(): Readonly<Float64Array> {
    return this._target;
  }
  get up(): Readonly<Float64Array> {
    return this._up;
  }

  get fov(): number {
    return this._fov;
  }
  set fov(v: number) {
    if (v !== this._fov) {
      this._fov = v;
      this.changed();
    }
  }

  get orthographic(): boolean {
    return this._ortho;
  }
  set orthographic(v: boolean) {
    if (v !== this._ortho) {
      this._ortho = v;
      this.changed();
    }
  }

  /** Distance from eye to target. */
  get distance(): number {
    return vec3.distance(this._eye, this._target);
  }

  /** Sets the pose. Any argument may be omitted (null/undefined) to keep its value. */
  set(eye?: ReadArray | null, target?: ReadArray | null, up?: ReadArray | null): void {
    let c = false;
    if (eye && !sameVec(this._eye, eye)) {
      vec3.copy(this._eye, eye);
      c = true;
    }
    if (target && !sameVec(this._target, target)) {
      vec3.copy(this._target, target);
      c = true;
    }
    if (up) {
      vec3.normalize(tmpA, up);
      if (vec3.lengthSq(tmpA) > 0 && !sameVec(this._up, tmpA)) {
        vec3.copy(this._up, tmpA);
        c = true;
      }
    }
    if (c) this.changed();
  }

  setState(state: Partial<CameraState>): void {
    this.set(state.eye, state.target, state.up);
    if (state.fov !== undefined) this.fov = state.fov;
    if (state.orthographic !== undefined) this.orthographic = state.orthographic;
  }

  /** Current state as plain arrays (allocates when `out` is not given). */
  getState(out?: CameraState): CameraState {
    const s = out ?? { eye: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: DEFAULT_FOV, orthographic: false };
    s.eye[0] = this._eye[0]; s.eye[1] = this._eye[1]; s.eye[2] = this._eye[2];
    s.target[0] = this._target[0]; s.target[1] = this._target[1]; s.target[2] = this._target[2];
    s.up[0] = this._up[0]; s.up[1] = this._up[1]; s.up[2] = this._up[2];
    s.fov = this._fov;
    s.orthographic = this._ortho;
    return s;
  }

  /** Viewport size in pixels (drawing-buffer pixels or CSS pixels; used for aspect and pixel sizes). */
  setViewport(width: number, height: number): void {
    width = Math.max(1, width);
    height = Math.max(1, height);
    if (width !== this._width || height !== this._height) {
      this._width = width;
      this._height = height;
      this.changed();
    }
  }

  get width(): number {
    return this._width;
  }
  get height(): number {
    return this._height;
  }
  get aspect(): number {
    return this._width / this._height;
  }

  /**
   * World bounds of the scene used for automatic near/far. Pass null (or an empty box) when the
   * scene is empty. Call whenever the scene bounds change notably.
   */
  setSceneBounds(bounds: ReadArray | null): void {
    if (!bounds || aabb.isEmpty(bounds)) {
      if (aabb.isEmpty(this._bounds)) return;
      aabb.empty(this._bounds);
    } else {
      let same = true;
      for (let i = 0; i < 6; i++) if (this._bounds[i] !== bounds[i]) same = false;
      if (same) return;
      aabb.copy(this._bounds, bounds);
    }
    if (this._autoClip) this.changed();
  }

  get sceneBounds(): Readonly<Float64Array> {
    return this._bounds;
  }

  /** Disables auto clipping and uses fixed planes (orthographic near may be negative). */
  setClipPlanes(near: number, far: number): void {
    this._autoClip = false;
    this._near = near;
    this._far = far;
    this.changed();
  }

  /** Re-enables automatic near/far from the scene bounds (default). */
  setAutoClip(): void {
    if (!this._autoClip) {
      this._autoClip = true;
      this.changed();
    }
  }

  get near(): number {
    this.update();
    return this._near;
  }
  get far(): number {
    this.update();
    return this._far;
  }

  /** Call after mutating internal state externally (not normally needed). */
  changed(): void {
    this._version++;
    this._dirty = true;
  }

  // ---------------------------------------------------------------------------------------------
  // derived values

  /** World height of the view at the given depth in front of the eye. */
  viewHeightAt(depth: number): number {
    const t = Math.tan(this._fov / 2);
    return 2 * t * (this._ortho ? this.distance : depth);
  }

  /** Orthographic view height (world units); also meaningful in perspective (height at target). */
  get orthoHeight(): number {
    return 2 * this.distance * Math.tan(this._fov / 2);
  }

  /**
   * Pixel factor for `projectedSphereSizePx` / `projectedAABBSizePx` from math/projection
   * (with `orthographic` = this.orthographic and eye = this.eye).
   */
  get pixelFactor(): number {
    return this._ortho
      ? orthographicPixelFactor(Math.max(this.orthoHeight, 1e-300), this._height)
      : perspectivePixelFactor(this._fov, this._height);
  }

  /** Unit view direction (eye -> target) into `out`. */
  getForward<T extends Float64Array | Float32Array | number[]>(out: T): T {
    this.update();
    const v = this._view64;
    out[0] = -v[2]; out[1] = -v[6]; out[2] = -v[10];
    return out;
  }

  /** Unit camera right vector into `out`. */
  getRight<T extends Float64Array | Float32Array | number[]>(out: T): T {
    this.update();
    const v = this._view64;
    out[0] = v[0]; out[1] = v[4]; out[2] = v[8];
    return out;
  }

  /** Unit camera up vector (orthogonal to forward) into `out`. */
  getUpOrtho<T extends Float64Array | Float32Array | number[]>(out: T): T {
    this.update();
    const v = this._view64;
    out[0] = v[1]; out[1] = v[5]; out[2] = v[9];
    return out;
  }

  // Float32 matrices for upload ------------------------------------------------------------------

  get view(): Float32Array {
    this.update();
    return this._view32;
  }
  get projection(): Float32Array {
    this.update();
    return this._proj32;
  }
  get viewProjection(): Float32Array {
    this.update();
    return this._viewProj32;
  }
  get inverseViewProjection(): Float32Array {
    this.update();
    return this._invViewProj32;
  }

  // Float64 matrices for CPU work (frustum extraction, unproject, picking) ------------------------

  get view64(): Readonly<Float64Array> {
    this.update();
    return this._view64;
  }
  get projection64(): Readonly<Float64Array> {
    this.update();
    return this._proj64;
  }
  get viewProjection64(): Readonly<Float64Array> {
    this.update();
    return this._viewProj64;
  }
  get inverseView64(): Readonly<Float64Array> {
    this.update();
    return this._invView64;
  }
  get inverseViewProjection64(): Readonly<Float64Array> {
    this.update();
    return this._invViewProj64;
  }

  // ---------------------------------------------------------------------------------------------
  // fitting

  /**
   * Computes a state that frames `box` with the current view direction, up and projection,
   * without applying it. Returns null when the box is empty. `padding` > 1 leaves extra margin.
   */
  computeFitState(box: ReadArray, padding = 1, out?: CameraState): CameraState | null {
    if (aabb.isEmpty(box)) return null;
    const s = this.getState(out);
    aabb.center(tmpA, box);
    let r = aabb.radius(box) * padding;
    if (!(r > 0)) r = Math.max(1e-6, this.distance * 0.1);
    // keep the view direction
    vec3.sub(tmpB, this._eye, this._target);
    if (vec3.lengthSq(tmpB) === 0) vec3.set(tmpB, 0, 0, 1);
    vec3.normalize(tmpB, tmpB);
    const t = Math.tan(this._fov / 2);
    const aspect = this.aspect;
    let dist: number;
    if (this._ortho) {
      dist = r / (t * Math.min(1, aspect));
    } else {
      const halfFovMin = Math.min(Math.atan(t), Math.atan(t * aspect));
      dist = r / Math.sin(halfFovMin);
    }
    s.target[0] = tmpA[0]; s.target[1] = tmpA[1]; s.target[2] = tmpA[2];
    s.eye[0] = tmpA[0] + tmpB[0] * dist;
    s.eye[1] = tmpA[1] + tmpB[1] * dist;
    s.eye[2] = tmpA[2] + tmpB[2] * dist;
    return s;
  }

  /** Frames `box` immediately. Returns false if the box is empty. */
  fitToBounds(box: ReadArray, padding = 1): boolean {
    const s = this.computeFitState(box, padding, fitScratch);
    if (!s) return false;
    this.setState(s);
    return true;
  }

  // ---------------------------------------------------------------------------------------------

  /** Recomputes matrices if anything changed. Called implicitly by every matrix getter. */
  update(): void {
    if (!this._dirty) return;
    this._dirty = false;
    mat4.lookAt(this._view64, this._eye, this._target, this._up);
    if (this._autoClip) this.computeClip();
    const aspect = this.aspect;
    if (this._ortho) {
      const h = this.orthoHeight * 0.5 || 1e-6;
      const w = h * aspect;
      mat4.orthographic(this._proj64, -w, w, -h, h, this._near, this._far);
    } else {
      mat4.perspective(this._proj64, this._fov, aspect, this._near, this._far);
    }
    mat4.multiply(this._viewProj64, this._proj64, this._view64);
    mat4.invertAffine(this._invView64, this._view64);
    if (!mat4.invert(this._invViewProj64, this._viewProj64)) mat4.identity(this._invViewProj64);
    this._view32.set(this._view64);
    this._proj32.set(this._proj64);
    this._viewProj32.set(this._viewProj64);
    this._invViewProj32.set(this._invViewProj64);
  }

  private computeClip(): void {
    const v = this._view64;
    const dist = Math.max(this.distance, 1e-9);
    const b = this._bounds;
    if (aabb.isEmpty(b)) {
      if (this._ortho) {
        this._near = -dist * 100;
        this._far = dist * 100;
      } else {
        this._near = dist * 1e-3;
        this._far = dist * 1e3;
      }
      return;
    }
    // view-space depth (positive in front) of the box: -z of the view transform, min/max over corners
    const fz0 = -v[2], fz1 = -v[6], fz2 = -v[10], fz3 = -v[14];
    let dmin = fz3, dmax = fz3;
    let e = fz0 * b[0], f = fz0 * b[3];
    if (e < f) { dmin += e; dmax += f; } else { dmin += f; dmax += e; }
    e = fz1 * b[1]; f = fz1 * b[4];
    if (e < f) { dmin += e; dmax += f; } else { dmin += f; dmax += e; }
    e = fz2 * b[2]; f = fz2 * b[5];
    if (e < f) { dmin += e; dmax += f; } else { dmin += f; dmax += e; }
    const extent = Math.max(dmax - dmin, dist * 1e-6, 1e-9);
    const margin = extent * 0.01;
    if (this._ortho) {
      // linear depth: precision is uniform, so simply enclose the scene (may extend behind the eye)
      this._near = dmin - margin;
      this._far = dmax + margin;
      return;
    }
    let far = dmax + margin;
    if (far <= 0) {
      // scene entirely behind the camera
      this._near = dist * 1e-3;
      this._far = dist * 1e3;
      return;
    }
    let near: number;
    if (dmin > 0) {
      near = dmin - margin;
      if (near <= 0) near = dmin * 0.5;
    } else {
      // eye inside the scene bounds: use the target distance as a hint for what matters
      near = dist * 0.05;
    }
    near = Math.max(near, far * this._minNearFarRatio);
    if (near >= far) far = near * 2;
    this._near = near;
    this._far = far;
  }
}

const fitScratch: CameraState = { eye: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: DEFAULT_FOV, orthographic: false };

function sameVec(a: ReadArray, b: ReadArray): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

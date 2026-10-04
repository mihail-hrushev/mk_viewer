/**
 * Pointer-event orbit/pan/zoom controls. DOM wiring only; the maths lives in orbitMath.ts.
 *
 * Mouse: left drag orbits around the camera target, right/middle drag or shift+left pans, wheel
 * zooms toward the cursor, double click sets the pivot through `pickPivot`.
 * Touch: one finger orbits, two fingers pinch-zoom and pan, double tap sets the pivot.
 *
 * The owner calls `update(dtMs)` every frame; there is no internal animation loop.
 * Event handlers do not allocate.
 */
import type { CameraState } from '../types';
import type { ReadArray } from '../math/common';
import * as aabb from '../math/aabb';
import * as vec3 from '../math/vec3';
import type { Camera } from './Camera';
import { CameraTransition, orbit, pan, worldUpVector, zoomAt } from './orbitMath';

export interface OrbitControlsOptions {
  /** World up axis for turntable orbiting. Default 'y'. */
  up?: 'y' | 'z';
  /** Multiplier on orbit speed. Default 1 (dragging across the element height turns by PI). */
  rotateSpeed?: number;
  /** Multiplier on pan speed. Default 1 (geometry at the target depth follows the cursor). */
  panSpeed?: number;
  /** Multiplier on wheel/pinch zoom speed. Default 1. */
  zoomSpeed?: number;
  /** Duration of animated transitions in ms. Default 400. */
  animationMs?: number;
  /**
   * Distance below which zooming in moves the target forward instead (dolly through).
   * Default: 1e-3 of the camera's scene-bounds diagonal (or 1e-6 without bounds).
   */
  minDistance?: number;
  /** Maximum eye-target distance. Default: 100x the scene diagonal (Infinity without bounds). */
  maxDistance?: number;
  /**
   * Resolves the world position under CSS pixel (x, y) relative to the element, or null for
   * background (GPU picking). Used for double click / double tap pivot selection.
   */
  pickPivot?: (x: number, y: number) => Promise<ArrayLike<number> | null>;
  /** Called when the user starts interacting (drag, pinch, wheel). */
  onInteractionStart?: () => void;
  /** Called when the interaction ends (all pointers up, wheel idle for ~150 ms). */
  onInteractionEnd?: () => void;
}

const enum Mode {
  None = 0,
  Orbit = 1,
  Pan = 2,
  Touch2 = 3,
}

const CLICK_TOLERANCE_PX = 4;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 20;
const WHEEL_IDLE_MS = 150;

const sPoint = new Float64Array(3);

export class OrbitControls {
  readonly camera: Camera;
  readonly element: HTMLElement;
  /** When false all input is ignored. */
  enabled = true;
  rotateSpeed: number;
  panSpeed: number;
  zoomSpeed: number;
  animationMs: number;
  minDistance: number | undefined;
  maxDistance: number | undefined;
  pickPivot: OrbitControlsOptions['pickPivot'];
  onInteractionStart: (() => void) | undefined;
  onInteractionEnd: (() => void) | undefined;

  private worldUp: ReadArray;
  private _up: 'y' | 'z';
  private readonly transition = new CameraTransition();
  private mode = Mode.None;
  private _interacting = false;
  private _dragged = false;
  private wheelTimer = 0;
  private disposed = false;

  // up to two tracked pointers
  private readonly ids = [-1, -1];
  private readonly px = new Float64Array(2);
  private readonly py = new Float64Array(2);
  private pointerCount = 0;
  private downX = 0;
  private downY = 0;
  private pinchDist = 0;
  private midX = 0;
  private midY = 0;
  private lastTapTime = -1e9;
  private lastTapX = 0;
  private lastTapY = 0;
  private readonly prevTouchAction: string;

  constructor(element: HTMLElement, camera: Camera, options: OrbitControlsOptions = {}) {
    this.element = element;
    this.camera = camera;
    this._up = options.up ?? 'y';
    this.worldUp = worldUpVector(this._up);
    this.rotateSpeed = options.rotateSpeed ?? 1;
    this.panSpeed = options.panSpeed ?? 1;
    this.zoomSpeed = options.zoomSpeed ?? 1;
    this.animationMs = options.animationMs ?? 400;
    this.minDistance = options.minDistance;
    this.maxDistance = options.maxDistance;
    this.pickPivot = options.pickPivot;
    this.onInteractionStart = options.onInteractionStart;
    this.onInteractionEnd = options.onInteractionEnd;

    this.prevTouchAction = element.style.touchAction;
    element.style.touchAction = 'none';
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('lostpointercapture', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.onContextMenu);
    element.addEventListener('dblclick', this.onDblClick);
  }

  // ---------------------------------------------------------------------------------------------
  // public API

  get up(): 'y' | 'z' {
    return this._up;
  }
  set up(v: 'y' | 'z') {
    this._up = v;
    this.worldUp = worldUpVector(v);
  }

  /** True between onInteractionStart and onInteractionEnd. */
  get interacting(): boolean {
    return this._interacting;
  }

  /**
   * True if the current/last pointer gesture moved more than a few pixels. A click handler can
   * use it to ignore the click that ends a drag.
   */
  get dragged(): boolean {
    return this._dragged;
  }

  get animating(): boolean {
    return this.transition.active;
  }

  /** Moves the camera to `state` (missing fields keep current values), optionally animated. */
  setCamera(state: Partial<CameraState>, animate = false): void {
    if (animate && this.animationMs > 0) {
      this.transition.start(this.camera, state, this.animationMs);
    } else {
      this.transition.cancel();
      this.camera.setState(state);
    }
  }

  /** Frames `box`, keeping the view direction. Returns false if the box is empty. */
  fitToBounds(box: ReadArray, animate = false, padding = 1): boolean {
    const s = this.camera.computeFitState(box, padding, fitScratch);
    if (!s) return false;
    this.setCamera(s, animate);
    return true;
  }

  /** Makes `point` the orbit pivot (camera target), turning the camera toward it. */
  setPivot(point: ReadArray, animate = true): void {
    pivotScratch.target[0] = point[0];
    pivotScratch.target[1] = point[1];
    pivotScratch.target[2] = point[2];
    this.setCamera(pivotScratch, animate);
  }

  /** Stops a running transition where it is. */
  cancelAnimation(): void {
    this.transition.cancel();
  }

  /**
   * Advances animations and idle timers. Call once per frame. Returns true while a camera
   * transition is running.
   */
  update(dtMs: number): boolean {
    if (this.wheelTimer > 0) {
      this.wheelTimer -= dtMs;
      if (this.wheelTimer <= 0) {
        this.wheelTimer = 0;
        this.maybeEndInteraction();
      }
    }
    return this.transition.step(this.camera, dtMs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const el = this.element;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerUp);
    el.removeEventListener('lostpointercapture', this.onPointerUp);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('contextmenu', this.onContextMenu);
    el.removeEventListener('dblclick', this.onDblClick);
    el.style.touchAction = this.prevTouchAction;
    this.transition.cancel();
    if (this._interacting) {
      this._interacting = false;
      this.onInteractionEnd?.();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // internals

  private viewHeight(): number {
    return this.element.clientHeight || this.camera.height;
  }

  private viewWidth(): number {
    return this.element.clientWidth || this.camera.width;
  }

  private effectiveMinDistance(): number {
    if (this.minDistance !== undefined) return this.minDistance;
    const d = aabb.diagonal(this.camera.sceneBounds);
    return d > 0 ? d * 1e-3 : 1e-6;
  }

  private effectiveMaxDistance(): number {
    if (this.maxDistance !== undefined) return this.maxDistance;
    const d = aabb.diagonal(this.camera.sceneBounds);
    return d > 0 ? d * 100 : Infinity;
  }

  private startInteraction(): void {
    this.transition.cancel();
    if (!this._interacting) {
      this._interacting = true;
      this.onInteractionStart?.();
    }
  }

  private maybeEndInteraction(): void {
    if (this._interacting && this.pointerCount === 0 && this.wheelTimer <= 0) {
      this._interacting = false;
      this.onInteractionEnd?.();
    }
  }

  private slotOf(id: number): number {
    return this.ids[0] === id ? 0 : this.ids[1] === id ? 1 : -1;
  }

  private zoom(scale: number, cssX: number, cssY: number): void {
    const w = this.viewWidth(), h = this.viewHeight();
    const ndcX = (cssX / w) * 2 - 1;
    const ndcY = 1 - (cssY / h) * 2;
    zoomAt(this.camera, scale, ndcX, ndcY, this.effectiveMinDistance(), this.effectiveMaxDistance());
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    let slot = this.slotOf(e.pointerId);
    if (slot < 0) {
      slot = this.ids[0] === -1 ? 0 : this.ids[1] === -1 ? 1 : -1;
      if (slot < 0) return; // a third finger is ignored
      this.ids[slot] = e.pointerId;
      this.pointerCount++;
    }
    this.px[slot] = e.offsetX;
    this.py[slot] = e.offsetY;
    try {
      this.element.setPointerCapture(e.pointerId);
    } catch {
      // ignore (e.g. synthetic events)
    }

    if (this.pointerCount === 1) {
      this._dragged = false;
      this.downX = e.offsetX;
      this.downY = e.offsetY;
      if (e.pointerType === 'touch') {
        this.mode = Mode.Orbit;
      } else if (e.button === 0 && !e.shiftKey) {
        this.mode = Mode.Orbit;
      } else if (e.button === 0 || e.button === 1 || e.button === 2) {
        this.mode = Mode.Pan;
      } else {
        this.mode = Mode.None;
      }
    } else if (this.pointerCount === 2) {
      this.mode = Mode.Touch2;
      this.beginTwoFinger();
    }
    if (this.mode !== Mode.None) {
      e.preventDefault();
      this.startInteraction();
    }
  };

  private beginTwoFinger(): void {
    const dx = this.px[1] - this.px[0], dy = this.py[1] - this.py[0];
    this.pinchDist = Math.sqrt(dx * dx + dy * dy);
    this.midX = (this.px[0] + this.px[1]) * 0.5;
    this.midY = (this.py[0] + this.py[1]) * 0.5;
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const slot = this.slotOf(e.pointerId);
    if (slot < 0 || !this.enabled) return;
    const x = e.offsetX, y = e.offsetY;
    const dx = x - this.px[slot], dy = y - this.py[slot];
    this.px[slot] = x;
    this.py[slot] = y;
    if (dx === 0 && dy === 0) return;
    if (!this._dragged && Math.abs(x - this.downX) + Math.abs(y - this.downY) > CLICK_TOLERANCE_PX) this._dragged = true;
    const h = this.viewHeight();

    switch (this.mode) {
      case Mode.Orbit: {
        const k = (Math.PI / h) * this.rotateSpeed;
        orbit(this.camera, -dx * k, dy * k, this.worldUp);
        break;
      }
      case Mode.Pan:
        pan(this.camera, dx * this.panSpeed, dy * this.panSpeed, h);
        break;
      case Mode.Touch2: {
        const ddx = this.px[1] - this.px[0], ddy = this.py[1] - this.py[0];
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        const mx = (this.px[0] + this.px[1]) * 0.5;
        const my = (this.py[0] + this.py[1]) * 0.5;
        pan(this.camera, (mx - this.midX) * this.panSpeed, (my - this.midY) * this.panSpeed, h);
        if (this.pinchDist > 0 && dist > 0) {
          const ratio = this.pinchDist / dist;
          this.zoom(Math.pow(ratio, this.zoomSpeed), mx, my);
        }
        this.pinchDist = dist;
        this.midX = mx;
        this.midY = my;
        break;
      }
      default:
        break;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const slot = this.slotOf(e.pointerId);
    if (slot < 0) return;
    this.ids[slot] = -1;
    this.pointerCount--;
    if (this.element.hasPointerCapture?.(e.pointerId)) {
      try {
        this.element.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }

    if (this.pointerCount === 1) {
      // continue with the remaining finger as a one-finger orbit, without a jump
      const rest = this.ids[0] !== -1 ? 0 : 1;
      if (rest === 1) {
        this.ids[0] = this.ids[1];
        this.px[0] = this.px[1];
        this.py[0] = this.py[1];
        this.ids[1] = -1;
      }
      this.mode = Mode.Orbit;
      return;
    }
    if (this.pointerCount === 0) {
      const wasTap = !this._dragged && this.mode !== Mode.Touch2;
      this.mode = Mode.None;
      if (e.pointerType === 'touch' && wasTap && e.type === 'pointerup') this.handleTap(e);
      this.maybeEndInteraction();
    }
  };

  private handleTap(e: PointerEvent): void {
    const t = e.timeStamp;
    const near = Math.abs(e.offsetX - this.lastTapX) + Math.abs(e.offsetY - this.lastTapY) < DOUBLE_TAP_PX;
    if (t - this.lastTapTime < DOUBLE_TAP_MS && near) {
      this.lastTapTime = -1e9;
      this.requestPivot(e.offsetX, e.offsetY);
    } else {
      this.lastTapTime = t;
      this.lastTapX = e.offsetX;
      this.lastTapY = e.offsetY;
    }
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= 100;
    if (delta === 0) return;
    delta = Math.max(-250, Math.min(250, delta));
    this.startInteraction();
    this.wheelTimer = WHEEL_IDLE_MS;
    this.zoom(Math.exp(delta * 0.0015 * this.zoomSpeed), e.offsetX, e.offsetY);
  };

  private readonly onContextMenu = (e: Event): void => {
    if (this.enabled) e.preventDefault();
  };

  private readonly onDblClick = (e: MouseEvent): void => {
    if (!this.enabled) return;
    this.requestPivot(e.offsetX, e.offsetY);
  };

  private requestPivot(x: number, y: number): void {
    const pick = this.pickPivot;
    if (!pick) return;
    const version = this.camera.version;
    pick(x, y).then(
      (p) => {
        if (this.disposed || !p || !this.enabled) return;
        // ignore stale results if the user moved the camera meanwhile
        if (this.camera.version !== version && this._interacting) return;
        vec3.copy(sPoint, p);
        if (Number.isFinite(sPoint[0]) && Number.isFinite(sPoint[1]) && Number.isFinite(sPoint[2])) {
          this.setPivot(sPoint, true);
        }
      },
      () => undefined,
    );
  }
}

const fitScratch: CameraState = { eye: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: Math.PI / 4, orthographic: false };
const pivotScratch: { target: [number, number, number] } = { target: [0, 0, 0] };

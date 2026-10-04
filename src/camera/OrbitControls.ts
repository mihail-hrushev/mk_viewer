/**
 * Pointer-event orbit/pan/zoom controls. DOM wiring only: gesture recognition (drag vs tap,
 * finger transitions) lives in gestures.ts, camera maths in orbitMath.ts.
 *
 * Mouse / pen: left drag orbits around the camera target, right/middle drag or shift+left pans,
 * wheel zooms toward the cursor, double click sets the pivot through `pickPivot`.
 * Touch: one finger orbits, two fingers pinch-zoom about their midpoint and pan (no twist),
 * double tap sets the pivot. A click / tap (no drag) is reported through `onTap`.
 * Keyboard: W / S fly forward / backward along the view direction, A / D strafe left / right,
 * E / C move up / down along the world up axis (physical key positions, so any keyboard layout works); Shift moves faster. Keys act while the
 * pointer is over the element or the element has focus, and never while typing in a form field.
 * Moving with the keys switches to first-person mode: a left drag then looks around from the eye
 * instead of orbiting. Setting a pivot (double click / double tap) or the camera (fit, setCamera)
 * returns to orbiting.
 *
 * The element gets `touch-action: none` and no text selection / touch callout, so the browser does
 * not scroll, zoom or open menus on it; pointers are captured so drags continue outside it.
 *
 * The owner calls `update(dtMs)` every frame; there is no internal animation loop.
 * Event handlers do not allocate.
 */
import type { CameraState } from '../types';
import type { ReadArray } from '../math/common';
import * as aabb from '../math/aabb';
import * as vec3 from '../math/vec3';
import type { Camera } from './Camera';
import { CameraTransition, fly, levelCamera, orbit, pan, twoFingerStep, worldUpVector, zoomAt } from './orbitMath';
import { GestureMode, GestureRecognizer, TapKind, pointerKindOf, type GestureOptions, type GestureSink } from './gestures';

export interface OrbitControlsOptions {
  /** World up axis for turntable orbiting. Default 'y'. */
  up?: 'y' | 'z';
  /** Multiplier on orbit speed. Default 1 (dragging across the element height turns by PI). */
  rotateSpeed?: number;
  /** Multiplier on pan speed. Default 1 (geometry at the target depth follows the cursor). */
  panSpeed?: number;
  /** Multiplier on wheel/pinch zoom speed. Default 1. */
  zoomSpeed?: number;
  /**
   * Multiplier on W/A/S/D speed. Default 1: the camera covers its distance to the orbit target
   * per second (so speed follows the zoom level); Shift multiplies by 4. 0 disables the keys.
   */
  moveSpeed?: number;
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
  /**
   * Handles a double click / double tap at CSS pixel (x, y) itself, replacing the default
   * `pickPivot` behaviour (the handler typically calls `setCamera`).
   */
  onDoubleTap?: (x: number, y: number) => void;
  /** Called when the user starts interacting (drag, pinch, wheel). */
  onInteractionStart?: () => void;
  /** Called when the interaction ends (all pointers up, wheel idle for ~150 ms). */
  onInteractionEnd?: () => void;
  /**
   * Called for a click / tap that was not a drag (primary button, within the tap slop and, for
   * touch, the max tap duration), at CSS pixel (x, y) of the press. `toggle` is true when ctrl,
   * meta or shift was held. The second tap of a double tap is not reported (it sets the pivot).
   * Reported even while `enabled` is false.
   */
  onTap?: (x: number, y: number, pointerType: string, toggle: boolean) => void;
  /** Tap / double-tap tolerances (see GestureOptions). */
  gestures?: GestureOptions;
  /**
   * Called when the controls changed the camera outside of an input event or `update()` call
   * (the pivot transition started by an asynchronous double-click / double-tap pick), so the
   * owner's frame loop can be woken.
   */
  requestFrame?: () => void;
}

const WHEEL_IDLE_MS = 150;

const KEY_FORWARD = 1, KEY_BACK = 2, KEY_LEFT = 4, KEY_RIGHT = 8, KEY_UP = 16, KEY_DOWN = 32;
const SHIFT_MOVE_FACTOR = 4;
/** Look-around turn rate relative to orbiting (a full-height drag turns by PI * LOOK_SPEED). */
const LOOK_SPEED = 0.5;
/** Longest frame time a key step is integrated over, so a stalled frame cannot jump the camera. */
const MAX_MOVE_DT_MS = 100;

function moveKeyBit(code: string): number {
  switch (code) {
    case 'KeyW': return KEY_FORWARD;
    case 'KeyS': return KEY_BACK;
    case 'KeyA': return KEY_LEFT;
    case 'KeyD': return KEY_RIGHT;
    case 'KeyE': return KEY_UP;
    case 'KeyC': return KEY_DOWN;
    default: return 0;
  }
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/** Inline styles set on the element (and restored on dispose). */
const ELEMENT_STYLES: [string, string][] = [
  ['touch-action', 'none'],
  ['user-select', 'none'],
  ['-webkit-user-select', 'none'],
  ['-webkit-touch-callout', 'none'],
  ['-webkit-tap-highlight-color', 'transparent'],
];

const sPoint = new Float64Array(3);

export class OrbitControls implements GestureSink {
  readonly camera: Camera;
  readonly element: HTMLElement;
  /** When false all input is ignored. */
  enabled = true;
  /**
   * When false, the second tap of a double tap is reported through `onTap` like any other tap
   * (no pivot / `onDoubleTap`), e.g. while a tool needs every click.
   */
  doubleTapEnabled = true;
  rotateSpeed: number;
  panSpeed: number;
  zoomSpeed: number;
  moveSpeed: number;
  animationMs: number;
  minDistance: number | undefined;
  maxDistance: number | undefined;
  pickPivot: OrbitControlsOptions['pickPivot'];
  onDoubleTap: OrbitControlsOptions['onDoubleTap'];
  onInteractionStart: (() => void) | undefined;
  onInteractionEnd: (() => void) | undefined;
  onTap: OrbitControlsOptions['onTap'];
  requestFrame: (() => void) | undefined;
  /** Gesture state machine (tolerances are adjustable on it). */
  readonly gestures: GestureRecognizer;

  private worldUp: ReadArray;
  private _up: 'y' | 'z';
  private readonly transition = new CameraTransition();
  private _interacting = false;
  private wheelTimer = 0;
  private disposed = false;
  private toggleKey = false;
  /** Bitmask of held movement keys (KEY_*). */
  private moveKeys = 0;
  private moveFast = false;
  private moveFresh = false;
  /**
   * First-person mode: entered by moving with the keyboard, left when a pivot or camera is set
   * (double click, fit, setCamera). While walking, a left drag looks around from the eye.
   */
  private walking = false;
  private pointerInside = false;
  private readonly prevStyles: string[] = [];

  constructor(element: HTMLElement, camera: Camera, options: OrbitControlsOptions = {}) {
    this.element = element;
    this.camera = camera;
    this._up = options.up ?? 'y';
    this.worldUp = worldUpVector(this._up);
    this.rotateSpeed = options.rotateSpeed ?? 1;
    this.panSpeed = options.panSpeed ?? 1;
    this.zoomSpeed = options.zoomSpeed ?? 1;
    this.moveSpeed = options.moveSpeed ?? 1;
    this.animationMs = options.animationMs ?? 400;
    this.minDistance = options.minDistance;
    this.maxDistance = options.maxDistance;
    this.pickPivot = options.pickPivot;
    this.onDoubleTap = options.onDoubleTap;
    this.onInteractionStart = options.onInteractionStart;
    this.onInteractionEnd = options.onInteractionEnd;
    this.onTap = options.onTap;
    this.requestFrame = options.requestFrame;
    this.gestures = new GestureRecognizer(this, options.gestures);

    const st = element.style;
    for (const [k, v] of ELEMENT_STYLES) {
      this.prevStyles.push(st.getPropertyValue(k));
      st.setProperty(k, v);
    }
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('lostpointercapture', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.onContextMenu);
    // Belt and braces for browsers that do not fully honour touch-action (older iOS Safari):
    // no page scroll / pinch zoom starting on the canvas. Pointer events are unaffected.
    element.addEventListener('touchmove', this.onTouchMove, { passive: false });
    element.addEventListener('gesturestart', this.onPreventDefault);
    element.addEventListener('pointerenter', this.onPointerEnter);
    element.addEventListener('pointerleave', this.onPointerLeave);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.onWindowBlur);
    }
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
   * True if the current/last pointer gesture moved beyond the tap slop or used two fingers. A
   * click handler can use it to ignore the click that ends a drag.
   */
  get dragged(): boolean {
    return this.gestures.dragged;
  }

  /** True while a transition runs or a movement key is held (the owner must keep calling update). */
  get animating(): boolean {
    return this.transition.active || this.moveKeys !== 0;
  }

  /** Moves the camera to `state` (missing fields keep current values), optionally animated. */
  setCamera(state: Partial<CameraState>, animate = false): void {
    this.walking = false;
    if (animate && this.animationMs > 0) {
      this.transition.start(this.camera, state, this.animationMs);
    } else {
      this.transition.cancel();
      this.camera.setState(state);
      levelCamera(this.camera, this.worldUp);
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
    const keys = this.moveKeys;
    if (keys !== 0 && this.enabled) {
      const step =
        Math.max(this.camera.distance, this.effectiveMinDistance()) *
        this.moveSpeed *
        (this.moveFast ? SHIFT_MOVE_FACTOR : 1) *
        // the first frame after a key press may carry the idle time before it: use one nominal frame
        (Math.min(Math.max(dtMs, 0), this.moveFresh ? 16 : MAX_MOVE_DT_MS) / 1000);
      this.moveFresh = false;
      const forward = ((keys & KEY_FORWARD) !== 0 ? 1 : 0) - ((keys & KEY_BACK) !== 0 ? 1 : 0);
      const right = ((keys & KEY_RIGHT) !== 0 ? 1 : 0) - ((keys & KEY_LEFT) !== 0 ? 1 : 0);
      const up = ((keys & KEY_UP) !== 0 ? 1 : 0) - ((keys & KEY_DOWN) !== 0 ? 1 : 0);
      fly(this.camera, forward * step, right * step, this.effectiveMinDistance(), this.effectiveMaxDistance(), up * step, this.worldUp);
    }
    if (!this.transition.active) return keys !== 0;
    const running = this.transition.step(this.camera, dtMs);
    levelCamera(this.camera, this.worldUp);
    return running || keys !== 0;
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
    el.removeEventListener('touchmove', this.onTouchMove);
    el.removeEventListener('gesturestart', this.onPreventDefault);
    el.removeEventListener('pointerenter', this.onPointerEnter);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onWindowBlur);
    }
    this.moveKeys = 0;
    for (let i = 0; i < ELEMENT_STYLES.length; i++) {
      const prev = this.prevStyles[i];
      if (prev) el.style.setProperty(ELEMENT_STYLES[i][0], prev);
      else el.style.removeProperty(ELEMENT_STYLES[i][0]);
    }
    this.gestures.reset();
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
    if (this._interacting && this.gestures.pointerCount === 0 && this.wheelTimer <= 0 && this.moveKeys === 0) {
      this._interacting = false;
      this.onInteractionEnd?.();
    }
  }

  private zoom(scale: number, cssX: number, cssY: number): void {
    const w = this.viewWidth(), h = this.viewHeight();
    const ndcX = (cssX / w) * 2 - 1;
    const ndcY = 1 - (cssY / h) * 2;
    zoomAt(this.camera, scale, ndcX, ndcY, this.effectiveMinDistance(), this.effectiveMaxDistance());
  }

  // --- GestureSink (called by the recognizer from pointer moves) ---------------------------------

  /** @internal */
  orbit(dx: number, dy: number): void {
    if (!this.enabled) return;
    const k = (Math.PI / this.viewHeight()) * this.rotateSpeed;
    if (this.walking) {
      // first-person look: turn the view about the eye, which stays where it is
      const l = k * LOOK_SPEED;
      orbit(this.camera, -dx * l, dy * l, this.worldUp, this.camera.eye);
    } else {
      orbit(this.camera, -dx * k, dy * k, this.worldUp);
    }
  }

  /** @internal */
  pan(dx: number, dy: number): void {
    if (!this.enabled) return;
    pan(this.camera, dx * this.panSpeed, dy * this.panSpeed, this.viewHeight());
  }

  /** @internal */
  pinch(dx: number, dy: number, scale: number, midX: number, midY: number): void {
    if (!this.enabled) return;
    twoFingerStep(
      this.camera,
      dx * this.panSpeed,
      dy * this.panSpeed,
      Math.pow(scale, this.zoomSpeed),
      midX,
      midY,
      this.viewWidth(),
      this.viewHeight(),
      this.effectiveMinDistance(),
      this.effectiveMaxDistance(),
    );
  }

  // --- DOM events ------------------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    const g = this.gestures;
    const contact = Math.max(e.width || 0, e.height || 0);
    if (!g.down(e.pointerId, pointerKindOf(e.pointerType), e.offsetX, e.offsetY, e.timeStamp, e.button, e.shiftKey, e.isPrimary, contact)) {
      return; // ignored pointer (third finger, second mouse button press, ...)
    }
    if (g.pointerCount === 1) this.toggleKey = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!this.enabled) return; // taps are still recognized; the page keeps default handling
    try {
      this.element.setPointerCapture(e.pointerId);
    } catch {
      // ignore (e.g. synthetic events)
    }
    e.preventDefault();
    if (g.mode !== GestureMode.None) this.startInteraction();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.gestures.move(e.pointerId, e.offsetX, e.offsetY);
  };

  /** pointerup, pointercancel and lostpointercapture. */
  private readonly onPointerUp = (e: PointerEvent): void => {
    const g = this.gestures;
    if (!g.tracks(e.pointerId)) return; // e.g. lostpointercapture that follows a pointerup
    let tap = g.up(e.pointerId, e.offsetX, e.offsetY, e.timeStamp, e.type !== 'pointerup');
    if (tap === TapKind.DoubleTap && !this.doubleTapEnabled) tap = TapKind.Tap;
    if (this.element.hasPointerCapture?.(e.pointerId)) {
      try {
        this.element.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    if (tap === TapKind.DoubleTap) {
      if (this.enabled) {
        if (this.onDoubleTap) this.onDoubleTap(g.tapX, g.tapY);
        else this.requestPivot(g.tapX, g.tapY);
      }
    } else if (tap === TapKind.Tap) {
      this.onTap?.(g.tapX, g.tapY, e.pointerType, this.toggleKey);
    }
    if (g.pointerCount === 0) this.maybeEndInteraction();
  };

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

  /** Also suppresses the long-press menu on touch devices. */
  private readonly onContextMenu = (e: Event): void => {
    if (this.enabled) e.preventDefault();
  };

  private readonly onTouchMove = (e: Event): void => {
    if (this.enabled && e.cancelable) e.preventDefault();
  };

  private readonly onPreventDefault = (e: Event): void => {
    if (this.enabled) e.preventDefault();
  };

  private readonly onPointerEnter = (): void => {
    this.pointerInside = true;
  };

  private readonly onPointerLeave = (): void => {
    this.pointerInside = false;
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const bit = moveKeyBit(e.code);
    if (bit === 0) {
      if (this.moveKeys !== 0) this.moveFast = e.shiftKey;
      return;
    }
    if (!this.enabled || this.moveSpeed <= 0 || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
    if (this.moveKeys === 0 && !this.pointerInside && document.activeElement !== this.element) return;
    e.preventDefault();
    this.moveFast = e.shiftKey;
    if ((this.moveKeys & bit) !== 0) return; // key repeat
    if (this.moveKeys === 0) this.moveFresh = true;
    this.moveKeys |= bit;
    this.walking = true;
    this.startInteraction();
    this.requestFrame?.();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (this.moveKeys === 0) return;
    this.moveFast = e.shiftKey;
    this.moveKeys &= ~moveKeyBit(e.code);
    if (this.moveKeys === 0) this.maybeEndInteraction();
  };

  /** Key-up events are lost when the window loses focus: stop moving. */
  private readonly onWindowBlur = (): void => {
    if (this.moveKeys === 0) return;
    this.moveKeys = 0;
    this.maybeEndInteraction();
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
          this.requestFrame?.();
        }
      },
      () => undefined,
    );
  }
}

const fitScratch: CameraState = { eye: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: Math.PI / 4, orthographic: false };
const pivotScratch: { target: [number, number, number] } = { target: [0, 0, 0] };

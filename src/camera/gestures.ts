/**
 * Pointer gesture recognition for OrbitControls, free of DOM types so it runs (and is tested) in
 * node. The DOM wiring (OrbitControls) feeds it plain numbers from pointer events; it turns them
 * into camera operations on a `GestureSink` and classifies taps / double taps.
 *
 *  - Mouse / pen: left drag orbits, right / middle / shift+left drag pans. Camera motion starts
 *    with the first move (no dead zone), as users expect from a mouse.
 *  - Touch, one finger: orbits once the finger has left the tap slop circle (so a shaky tap does
 *    not nudge the camera); the orbit starts from where the slop was exceeded, so there is no jump.
 *  - Touch, two fingers: every move yields one `pinch(dx, dy, scale, midX, midY)` step: pan by the
 *    midpoint motion, then zoom by the change of finger distance about the new midpoint. Finger
 *    rotation (twist) is ignored, so the horizon stays put. When the second finger lands, the
 *    reference distance/midpoint are taken from the current positions (no jump). When one of two
 *    fingers lifts, the remaining finger continues as a one-finger orbit, again after the slop,
 *    measured from where it was when the other finger lifted (no jump, no jitter from the lift).
 *  - Further fingers are ignored.
 *  - A gesture is a tap when it used one pointer, did not move further than the slop (touch: larger
 *    and scaled with the reported contact size), was not cancelled, used the primary button, and
 *    (touch only) was released within `touchTapMaxMs`. A tap close in time and place to the
 *    previous tap of the same pointer kind is a double tap.
 *
 * Allocation-free after construction.
 */

/** Pointer kinds, from PointerEvent.pointerType. */
export const enum PointerKind {
  Mouse = 0,
  Pen = 1,
  Touch = 2,
}

export function pointerKindOf(pointerType: string): PointerKind {
  return pointerType === 'touch' ? PointerKind.Touch : pointerType === 'pen' ? PointerKind.Pen : PointerKind.Mouse;
}

export const enum GestureMode {
  None = 0,
  Orbit = 1,
  Pan = 2,
  /** Two-finger pinch zoom + pan. */
  Touch2 = 3,
}

export const enum TapKind {
  None = 0,
  Tap = 1,
  DoubleTap = 2,
}

/** Receives the camera operations of a gesture, in CSS pixels relative to the element. */
export interface GestureSink {
  /** One-pointer orbit drag by (dx, dy). */
  orbit(dxPx: number, dyPx: number): void;
  /** One-pointer pan drag by (dx, dy). */
  pan(dxPx: number, dyPx: number): void;
  /**
   * Two-finger step: pan by the midpoint motion (dx, dy), then zoom by `scale` (< 1 = in, i.e.
   * fingers spread) about the new midpoint (midX, midY).
   */
  pinch(dxPx: number, dyPx: number, scale: number, midX: number, midY: number): void;
}

export interface GestureOptions {
  /** Max movement (CSS px) of a mouse click that still counts as a click. Default 4. */
  mouseTapSlopPx?: number;
  /** Same for a pen. Default 6. */
  penTapSlopPx?: number;
  /**
   * Base movement tolerance (CSS px) of a touch tap; grows with the reported contact size up to
   * twice this value. Default 10.
   */
  touchTapSlopPx?: number;
  /** A touch held longer than this (ms) is not a tap (long press). Default 500. */
  touchTapMaxMs?: number;
  /** Max time (ms) between the release of the first tap and the press of the second. Mouse/pen: 500, touch: 350. */
  doubleTapMs?: number;
  /** Max distance (CSS px) between the two taps of a double tap. Mouse/pen: 6, touch: 30. */
  doubleTapPx?: number;
}

/** Below this finger distance (CSS px) pinch scaling is not evaluated (unstable ratio). */
const MIN_PINCH_DIST = 8;

export class GestureRecognizer {
  mouseTapSlopPx: number;
  penTapSlopPx: number;
  touchTapSlopPx: number;
  touchTapMaxMs: number;
  doubleTapMs: number | undefined;
  doubleTapPx: number | undefined;

  /** Current mode. */
  mode = GestureMode.None;
  /** Tracked pointers (at most two). */
  pointerCount = 0;
  /** Position of the last classified tap (valid after up() returned Tap / DoubleTap). */
  tapX = 0;
  tapY = 0;
  /** Pointer kind of the current / last gesture. */
  kind = PointerKind.Mouse;

  private readonly ids = [-1, -1];
  private readonly px = new Float64Array(2);
  private readonly py = new Float64Array(2);

  // gesture (first down .. last up)
  private downX = 0;
  private downY = 0;
  private downT = 0;
  private maxDist2 = 0;
  private slop = 4;
  private multi = false;
  private cancelled = false;
  private tapButton = true;
  // one-pointer orbit dead zone (touch)
  private armed = true;
  private anchorX = 0;
  private anchorY = 0;
  // two-finger reference
  private pinchDist = 0;
  private midX = 0;
  private midY = 0;
  // previous tap
  private lastTapT = -1e15;
  private lastTapX = 0;
  private lastTapY = 0;
  private lastTapKind = -1;

  constructor(
    private readonly sink: GestureSink,
    options: GestureOptions = {},
  ) {
    this.mouseTapSlopPx = options.mouseTapSlopPx ?? 4;
    this.penTapSlopPx = options.penTapSlopPx ?? 6;
    this.touchTapSlopPx = options.touchTapSlopPx ?? 10;
    this.touchTapMaxMs = options.touchTapMaxMs ?? 500;
    this.doubleTapMs = options.doubleTapMs;
    this.doubleTapPx = options.doubleTapPx;
  }

  /** True when the current / last gesture moved beyond the tap slop or used two pointers. */
  get dragged(): boolean {
    return this.multi || this.maxDist2 > this.slop * this.slop;
  }

  /** Tap slop (CSS px) of the current / last gesture. */
  get tapSlop(): number {
    return this.slop;
  }

  /** True when `id` is one of the tracked pointers. */
  tracks(id: number): boolean {
    return this.ids[0] === id || this.ids[1] === id;
  }

  /**
   * Slop for a pointer kind; `contactPx` is the larger of PointerEvent.width/height (1 for mice).
   */
  slopFor(kind: PointerKind, contactPx = 0): number {
    if (kind === PointerKind.Mouse) return this.mouseTapSlopPx;
    if (kind === PointerKind.Pen) return this.penTapSlopPx;
    const base = this.touchTapSlopPx;
    const c = contactPx > 0 && Number.isFinite(contactPx) ? contactPx * 0.5 : 0;
    return Math.min(2 * base, Math.max(base, c));
  }

  /**
   * A pointer went down. `button` is PointerEvent.button, `primary` PointerEvent.isPrimary.
   * Returns true when the pointer is tracked (false: ignored, e.g. a third finger).
   */
  down(
    id: number,
    kind: PointerKind,
    x: number,
    y: number,
    t: number,
    button: number,
    shift: boolean,
    primary: boolean,
    contactPx = 0,
  ): boolean {
    // A primary pointer starts a new interaction: anything still tracked lost its up event.
    if (primary && this.pointerCount > 0 && !this.tracks(id)) this.reset();
    let slot = this.ids[0] === id ? 0 : this.ids[1] === id ? 1 : -1;
    if (slot < 0) {
      if (this.pointerCount === 2) return false;
      // a second pointer only joins a touch gesture as another finger
      if (this.pointerCount === 1 && (kind !== PointerKind.Touch || this.kind !== PointerKind.Touch)) return false;
      slot = this.ids[0] === -1 ? 0 : 1;
      this.ids[slot] = id;
      this.pointerCount++;
    }
    this.px[slot] = x;
    this.py[slot] = y;

    if (this.pointerCount === 1) {
      this.kind = kind;
      this.downX = x;
      this.downY = y;
      this.downT = t;
      this.maxDist2 = 0;
      this.slop = this.slopFor(kind, contactPx);
      this.multi = false;
      this.cancelled = false;
      this.tapButton = kind === PointerKind.Touch || button === 0;
      this.anchorX = x;
      this.anchorY = y;
      if (kind === PointerKind.Touch) {
        this.mode = GestureMode.Orbit;
        this.armed = false;
      } else {
        this.armed = true;
        if (button === 0 && !shift) this.mode = GestureMode.Orbit;
        else if (button === 0 || button === 1 || button === 2) this.mode = GestureMode.Pan;
        else this.mode = GestureMode.None;
      }
    } else {
      this.multi = true;
      this.mode = GestureMode.Touch2;
      this.beginTwo();
    }
    return true;
  }

  /** A tracked pointer moved. Returns true when a camera operation was emitted. */
  move(id: number, x: number, y: number): boolean {
    const slot = this.ids[0] === id ? 0 : this.ids[1] === id ? 1 : -1;
    if (slot < 0) return false;
    const dx = x - this.px[slot];
    const dy = y - this.py[slot];
    this.px[slot] = x;
    this.py[slot] = y;
    if (dx === 0 && dy === 0) return false;
    if (this.pointerCount === 1 && !this.multi) {
      const ex = x - this.downX, ey = y - this.downY;
      const d2 = ex * ex + ey * ey;
      if (d2 > this.maxDist2) this.maxDist2 = d2;
    }
    switch (this.mode) {
      case GestureMode.Orbit:
        if (!this.armed) {
          const ax = x - this.anchorX, ay = y - this.anchorY;
          if (ax * ax + ay * ay <= this.slop * this.slop) return false;
          this.armed = true; // start from here: the slop distance is not applied (no jump)
          return false;
        }
        this.sink.orbit(dx, dy);
        return true;
      case GestureMode.Pan:
        this.sink.pan(dx, dy);
        return true;
      case GestureMode.Touch2: {
        const ddx = this.px[1] - this.px[0], ddy = this.py[1] - this.py[0];
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        const mx = (this.px[0] + this.px[1]) * 0.5;
        const my = (this.py[0] + this.py[1]) * 0.5;
        const scale = this.pinchDist >= MIN_PINCH_DIST && dist >= MIN_PINCH_DIST ? this.pinchDist / dist : 1;
        const pdx = mx - this.midX, pdy = my - this.midY;
        this.pinchDist = dist;
        this.midX = mx;
        this.midY = my;
        if (pdx === 0 && pdy === 0 && scale === 1) return false;
        this.sink.pinch(pdx, pdy, scale, mx, my);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * A tracked pointer went up (`cancel` = pointercancel / lost capture: the gesture ends without a
   * tap). Returns the tap classification; for Tap / DoubleTap the position is in tapX / tapY.
   */
  up(id: number, x: number, y: number, t: number, cancel: boolean): TapKind {
    const slot = this.ids[0] === id ? 0 : this.ids[1] === id ? 1 : -1;
    if (slot < 0) return TapKind.None;
    if (cancel) this.cancelled = true;
    else if (this.pointerCount === 1 && !this.multi) {
      // the release position counts towards the movement too
      const ex = x - this.downX, ey = y - this.downY;
      const d2 = ex * ex + ey * ey;
      if (d2 > this.maxDist2) this.maxDist2 = d2;
    }
    this.ids[slot] = -1;
    this.pointerCount--;

    if (this.pointerCount === 1) {
      // continue with the remaining finger as a one-finger orbit, without a jump
      if (slot === 0) {
        this.ids[0] = this.ids[1];
        this.px[0] = this.px[1];
        this.py[0] = this.py[1];
        this.ids[1] = -1;
      }
      this.mode = GestureMode.Orbit;
      this.armed = false;
      this.anchorX = this.px[0];
      this.anchorY = this.py[0];
      return TapKind.None;
    }

    this.mode = GestureMode.None;
    const kind = this.kind;
    const isTap =
      !this.cancelled &&
      !this.multi &&
      this.tapButton &&
      this.maxDist2 <= this.slop * this.slop &&
      (kind !== PointerKind.Touch || t - this.downT <= this.touchTapMaxMs);
    if (!isTap) return TapKind.None;
    this.tapX = this.downX;
    this.tapY = this.downY;
    const touch = kind === PointerKind.Touch;
    const dblMs = this.doubleTapMs ?? (touch ? 350 : 500);
    const dblPx = this.doubleTapPx ?? (touch ? 30 : 6);
    const ddx = this.downX - this.lastTapX, ddy = this.downY - this.lastTapY;
    if (this.lastTapKind === kind && this.downT - this.lastTapT <= dblMs && ddx * ddx + ddy * ddy <= dblPx * dblPx) {
      this.lastTapT = -1e15; // a third tap starts a new pair
      this.lastTapKind = -1;
      return TapKind.DoubleTap;
    }
    this.lastTapT = t;
    this.lastTapX = this.downX;
    this.lastTapY = this.downY;
    this.lastTapKind = kind;
    return TapKind.Tap;
  }

  /** Forgets all pointers (e.g. after the controls were disabled or a pointer stream broke). */
  reset(): void {
    this.ids[0] = this.ids[1] = -1;
    this.pointerCount = 0;
    this.mode = GestureMode.None;
    this.cancelled = true;
  }

  private beginTwo(): void {
    const dx = this.px[1] - this.px[0], dy = this.py[1] - this.py[0];
    this.pinchDist = Math.sqrt(dx * dx + dy * dy);
    this.midX = (this.px[0] + this.px[1]) * 0.5;
    this.midY = (this.py[0] + this.py[1]) * 0.5;
  }
}

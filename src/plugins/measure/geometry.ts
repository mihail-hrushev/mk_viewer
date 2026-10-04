/**
 * Pure screen-space helpers of the measurement overlay (unit tested, no DOM).
 */

/**
 * Parameter t in [0, 1] along a segment whose end points have view depths d0, d1 where the depth
 * reaches `eps` (the near cut), for clipping the part behind the eye away before projecting.
 */
export function depthCutT(d0: number, d1: number, eps: number): number {
  return (eps - d0) / (d1 - d0);
}

/**
 * Liang-Barsky: clips the 2D segment seg = [x0, y0, x1, y1] (in place) to the rectangle. Returns false
 * when nothing of it is inside.
 */
export function clipSegment2D(seg: Float64Array, xmin: number, ymin: number, xmax: number, ymax: number): boolean {
  const x0 = seg[0], y0 = seg[1];
  const dx = seg[2] - x0, dy = seg[3] - y0;
  const t = tRange;
  t[0] = 0;
  t[1] = 1;
  if (!clipEdge(-dx, x0 - xmin, t) || !clipEdge(dx, xmax - x0, t) || !clipEdge(-dy, y0 - ymin, t) || !clipEdge(dy, ymax - y0, t)) {
    return false;
  }
  if (!(Number.isFinite(t[0]) && Number.isFinite(t[1]))) return false;
  seg[0] = x0 + dx * t[0];
  seg[1] = y0 + dy * t[0];
  seg[2] = x0 + dx * t[1];
  seg[3] = y0 + dy * t[1];
  return true;
}

const tRange = new Float64Array(2);

/** One Liang-Barsky boundary: narrows [t[0], t[1]]; false when the segment is outside. */
function clipEdge(p: number, q: number, t: Float64Array): boolean {
  if (p === 0) return q >= 0;
  const r = q / p;
  if (p < 0) {
    if (r > t[1]) return false;
    if (r > t[0]) t[0] = r;
  } else {
    if (r < t[0]) return false;
    if (r < t[1]) t[1] = r;
  }
  return true;
}

/**
 * Where to put a w x h label for a screen segment (dx, dy) of length len, relative to its midpoint:
 * centred on the line when the line is long enough to show beside the label, else beside the line
 * (perpendicular, on the upper side) so it does not hide the end markers. Writes [ox, oy].
 */
export function labelOffset(dx: number, dy: number, w: number, h: number, gap: number, out: Float64Array): void {
  const len = Math.hypot(dx, dy);
  // the label centred on the line covers this much of it
  const cover = len > 0 ? (Math.abs(dx) * w + Math.abs(dy) * h) / len : 0;
  if (len >= cover + 4 * gap) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  let nx = 0, ny = -1;
  if (len > 0) {
    nx = -dy / len;
    ny = dx / len;
    if (ny > 0 || (ny === 0 && nx > 0)) {
      nx = -nx;
      ny = -ny;
    }
  }
  const d = Math.abs(nx) * w * 0.5 + Math.abs(ny) * h * 0.5 + gap;
  out[0] = nx * d;
  out[1] = ny * d;
}

/** Default distance format: fixed decimals, optional unit. */
export function formatDistance(d: number, decimals: number, unit: string): string {
  const s = d.toFixed(decimals);
  return unit ? `${s} ${unit}` : s;
}

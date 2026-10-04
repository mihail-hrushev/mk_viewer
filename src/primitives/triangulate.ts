/**
 * Ear-clipping triangulation of a simple polygon (no holes), possibly concave.
 */

/** Signed area of polygon `xy` (pairs); positive when counter-clockwise. */
export function signedArea(xy: ArrayLike<number>): number {
  const n = xy.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += xy[j * 2] * xy[i * 2 + 1] - xy[i * 2] * xy[j * 2 + 1];
  return a * 0.5;
}

/**
 * Removes a closing point equal to the first one and consecutive duplicates; returns
 * counter-clockwise xy pairs (reversed if the input was clockwise).
 */
export function cleanOutline(outline: ArrayLike<number>): number[] {
  const pts: number[] = [];
  const n = outline.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = outline[i * 2], y = outline[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const m = pts.length;
    if (m >= 2 && pts[m - 2] === x && pts[m - 1] === y) continue;
    pts.push(x, y);
  }
  while (pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.length -= 2;
  if (signedArea(pts) < 0) {
    const r: number[] = [];
    for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i], pts[i + 1]);
    return r;
  }
  return pts;
}

/**
 * Triangulates a counter-clockwise simple polygon given as xy pairs. Returns vertex indices,
 * three per triangle, all counter-clockwise. Collinear vertices are skipped. For degenerate or
 * self-intersecting input a fan of the remaining vertices is emitted instead of failing.
 */
export function triangulate(xy: ArrayLike<number>): number[] {
  const n = xy.length >> 1;
  const out: number[] = [];
  if (n < 3) return out;
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n;
    next[i] = (i + 1) % n;
  }
  // tolerance relative to the polygon size
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  const ext = Math.max(maxx - minx, maxy - miny);
  const eps = ext * ext * 1e-14;

  const cross = (a: number, b: number, c: number): number =>
    (xy[b * 2] - xy[a * 2]) * (xy[c * 2 + 1] - xy[a * 2 + 1]) - (xy[b * 2 + 1] - xy[a * 2 + 1]) * (xy[c * 2] - xy[a * 2]);

  const isEar = (a: number, b: number, c: number): boolean => {
    const ax = xy[a * 2], ay = xy[a * 2 + 1];
    const bx = xy[b * 2], by = xy[b * 2 + 1];
    const cx = xy[c * 2], cy = xy[c * 2 + 1];
    for (let p = next[c]; p !== a; p = next[p]) {
      const px = xy[p * 2], py = xy[p * 2 + 1];
      if ((px === ax && py === ay) || (px === bx && py === by) || (px === cx && py === cy)) continue;
      // inside or on the edge of triangle abc (ccw)
      const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      if (d1 >= -eps && d2 >= -eps && d3 >= -eps) return false;
    }
    return true;
  };

  let remaining = n;
  let cur = 0;
  let guard = 0;
  while (remaining > 3) {
    const a = prev[cur], c = next[cur];
    const cr = cross(a, cur, c);
    let clip = false;
    if (Math.abs(cr) <= eps) {
      // collinear or duplicate vertex: drop without emitting a triangle
      clip = true;
    } else if (cr > 0 && isEar(a, cur, c)) {
      out.push(a, cur, c);
      clip = true;
    }
    if (clip) {
      next[a] = c;
      prev[c] = a;
      remaining--;
      cur = c;
      guard = 0;
    } else {
      cur = c;
      if (++guard > remaining) {
        // no ear found: fall back to a fan so we always produce a closed cap
        const start = cur;
        for (let p = next[start]; next[p] !== start; p = next[p]) out.push(start, p, next[p]);
        return out;
      }
    }
  }
  const a = prev[cur], c = next[cur];
  if (Math.abs(cross(a, cur, c)) > eps) out.push(a, cur, c);
  return out;
}

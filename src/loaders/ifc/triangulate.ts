/**
 * Ear-clipping triangulation of a polygon with holes (2D), the method of the well-known "earcut"
 * algorithm: holes are bridged into the outer ring, ears are clipped, and self-touching or
 * degenerate rings fall back to curing local intersections and splitting. Robust enough for the
 * profiles and planar faces of building models; not meant for huge polygons (O(n²) worst case).
 */

class Node {
  prev!: Node;
  next!: Node;
  steiner = false;
  constructor(readonly i: number, readonly x: number, readonly y: number) {}
}

/**
 * Triangulates `xy` (x, y pairs: the outer ring, then the holes; `holeStarts` = vertex index of
 * each hole's first point). Appends vertex index triples to `out` and returns it. Winding of the
 * input rings does not matter; the triangles' winding is not specified.
 */
export function triangulate(xy: ArrayLike<number>, holeStarts: ArrayLike<number> | null, out: number[] = []): number[] {
  const hasHoles = !!holeStarts && holeStarts.length > 0;
  const outerLen = hasHoles ? holeStarts![0] * 2 : xy.length;
  let outer = linkedList(xy, 0, outerLen, true);
  if (!outer || outer.next === outer.prev) return out;
  if (hasHoles) outer = eliminateHoles(xy, holeStarts!, outer);
  earcutLinked(outer, out, 0);
  return out;
}

/** Twice the signed area of a ring (positive = counter-clockwise). */
export function ringArea(xy: ArrayLike<number>, start = 0, end = xy.length): number {
  let s = 0;
  for (let i = start, j = end - 2; i < end; j = i, i += 2) s += (xy[j] - xy[i]) * (xy[j + 1] + xy[i + 1]);
  return s;
}

function linkedList(xy: ArrayLike<number>, start: number, end: number, clockwise: boolean): Node | null {
  let last: Node | null = null;
  if (clockwise === ringArea(xy, start, end) > 0) {
    for (let i = start; i < end; i += 2) last = insertNode(i / 2, xy[i], xy[i + 1], last);
  } else {
    for (let i = end - 2; i >= start; i -= 2) last = insertNode(i / 2, xy[i], xy[i + 1], last);
  }
  if (last && equals(last, last.next)) {
    removeNode(last);
    last = last.next;
  }
  return last;
}

function filterPoints(start: Node | null, end?: Node): Node | null {
  if (!start) return start;
  if (!end) end = start;
  let p = start;
  let again: boolean;
  do {
    again = false;
    if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else p = p.next;
  } while (again || p !== end);
  return end;
}

function earcutLinked(ear: Node | null, out: number[], pass: number): void {
  if (!ear) return;
  let stop = ear;
  while (ear.prev !== ear.next) {
    const prev: Node = ear.prev;
    const next: Node = ear.next;
    if (isEar(ear)) {
      out.push(prev.i, ear.i, next.i);
      removeNode(ear);
      ear = next.next;
      stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (pass === 0) earcutLinked(filterPoints(ear), out, 1);
      else if (pass === 1) earcutLinked(cureLocalIntersections(filterPoints(ear)!, out), out, 2);
      else splitEarcut(ear, out);
      break;
    }
  }
}

function isEar(ear: Node): boolean {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false; // reflex
  let p = c.next;
  while (p !== a) {
    if (pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && !(p.x === a.x && p.y === a.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}

function cureLocalIntersections(start: Node, out: number[]): Node | null {
  let p = start;
  do {
    const a = p.prev, b = p.next.next;
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      out.push(a.i, p.i, b.i);
      removeNode(p);
      removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}

function splitEarcut(start: Node, out: number[]): void {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c: Node | null = splitPolygon(a, b);
        const a2 = filterPoints(a, a.next);
        c = filterPoints(c, c.next);
        earcutLinked(a2, out, 0);
        earcutLinked(c, out, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

function eliminateHoles(xy: ArrayLike<number>, holeStarts: ArrayLike<number>, outer: Node): Node {
  const queue: Node[] = [];
  for (let k = 0; k < holeStarts.length; k++) {
    const s = holeStarts[k] * 2;
    const e = k < holeStarts.length - 1 ? holeStarts[k + 1] * 2 : xy.length;
    const list = linkedList(xy, s, e, false);
    if (!list) continue;
    if (list === list.next) list.steiner = true;
    queue.push(leftmost(list));
  }
  queue.sort((a, b) => a.x - b.x || a.y - b.y);
  for (const h of queue) outer = eliminateHole(h, outer);
  return outer;
}

function eliminateHole(hole: Node, outer: Node): Node {
  const bridge = findHoleBridge(hole, outer);
  if (!bridge) return outer;
  const bridgeReverse = splitPolygon(bridge, hole);
  filterPoints(bridgeReverse, bridgeReverse.next);
  return filterPoints(bridge, bridge.next)!;
}

function findHoleBridge(hole: Node, outer: Node): Node | null {
  let p = outer;
  const hx = hole.x, hy = hole.y;
  let qx = -Infinity;
  let m: Node | null = null;
  // a ray from the hole's leftmost point to the left: the nearest outer edge it hits
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m;
      }
    }
    p = p.next;
  } while (p !== outer);
  if (!m) return null;
  // the closest visible reflex vertex inside the triangle (hole, hit, m), if any
  const stop = m, mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x && pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
        m = p;
        tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

const sectorContainsSector = (m: Node, p: Node) => area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;

function leftmost(start: Node): Node {
  let p = start, l = start;
  do {
    if (p.x < l.x || (p.x === l.x && p.y < l.y)) l = p;
    p = p.next;
  } while (p !== start);
  return l;
}

function pointInTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

function isValidDiagonal(a: Node, b: Node): boolean {
  return (
    a.next.i !== b.i &&
    a.prev.i !== b.i &&
    !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) && (area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0)) ||
      (equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0))
  );
}

const area = (p: Node, q: Node, r: Node) => (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
const equals = (a: Node, b: Node) => a.x === b.x && a.y === b.y;
const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const onSegment = (p: Node, q: Node, r: Node) =>
  q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);

function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
  const o1 = sign(area(p1, q1, p2)), o2 = sign(area(p1, q1, q2)), o3 = sign(area(p2, q2, p1)), o4 = sign(area(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function intersectsPolygon(a: Node, b: Node): boolean {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}

function locallyInside(a: Node, b: Node): boolean {
  return area(a.prev, a, a.next) < 0 ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

function middleInside(a: Node, b: Node): boolean {
  let p = a;
  let inside = false;
  const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if (p.y > py !== p.next.y > py && p.next.y !== p.y && px < ((p.next.x - p.x) * (py - p.y)) / (p.next.y - p.y) + p.x) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}

function splitPolygon(a: Node, b: Node): Node {
  const a2 = new Node(a.i, a.x, a.y), b2 = new Node(b.i, b.x, b.y);
  const an = a.next, bp = b.prev;
  a.next = b;
  b.prev = a;
  a2.next = an;
  an.prev = a2;
  b2.next = a2;
  a2.prev = b2;
  bp.next = b2;
  b2.prev = bp;
  return b2;
}

function insertNode(i: number, x: number, y: number, last: Node | null): Node {
  const p = new Node(i, x, y);
  if (!last) {
    p.prev = p;
    p.next = p;
  } else {
    p.next = last.next;
    p.prev = last;
    last.next.prev = p;
    last.next = p;
  }
  return p;
}

function removeNode(p: Node): void {
  p.next.prev = p.prev;
  p.prev.next = p.next;
}

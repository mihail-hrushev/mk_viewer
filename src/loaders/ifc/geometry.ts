/**
 * IFC geometry: placements, curves, profiles and representation items -> triangles.
 *
 * Supported items: extruded / revolved area solids (all parameterised profiles, arbitrary profiles
 * with voids, derived, mirrored and composite profiles), swept disk solids, faceted and planar
 * advanced B-reps, shell / face based surface models, triangulated and polygonal face sets, mapped
 * items, CSG primitives (block, cylinder, cone, sphere), and boolean results whose subtracted
 * operand is a half space (clipped and capped). Other booleans keep their first operand; curved
 * advanced faces and the remaining sweeps are reported through `warn`. Fillet radii of
 * parameterised profiles are ignored.
 *
 * Everything is computed in file units; the loader scales to metres when it creates the geometry.
 */
import { TriMesh } from './mesh';
import { Ref, Typed, enumOf, list, num, refId, refList, type Arg, type StepFile } from './step';
import { ringArea, triangulate } from './triangulate';

export interface GeometrySettings {
  /** Most segments of a full circle (large radii); small circles get fewer, down to 8. */
  circleSegments: number;
  /** Metres per length unit of the file. */
  lengthScale: number;
  /** Radians per plane angle unit of the file. */
  angleScale: number;
  /** Subtract solids in boolean differences (half spaces are always clipped). */
  solidCuts: boolean;
  /** Reports an unsupported construct (aggregated by the caller). */
  unsupported(what: string): void;
}

/** A planar area: outer ring counter-clockwise and holes clockwise, as x, y pairs. */
export interface Area {
  outer: Float64Array;
  holes: Float64Array[];
}

type Vec3 = [number, number, number];

const TAU = Math.PI * 2;
/** Largest gap between a tessellated circle and the true one, metres. */
const CHORD_TOLERANCE = 0.001;
const MIN_CIRCLE_SEGMENTS = 8;
/** Adjacent side faces closer than this (cosine of ~37°) share a smooth normal. */
const SMOOTH_COS = 0.8;

export function identity(): Float64Array {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function mul(a: ArrayLike<number>, b: ArrayLike<number>, out = new Float64Array(16)): Float64Array {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
  return out;
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Rotates v about the unit axis u by angle (Rodrigues). */
function rotate(v: ArrayLike<number>, u: ArrayLike<number>, c: number, s: number): Vec3 {
  const k = dot(u, v) * (1 - c);
  return [v[0] * c + (u[1] * v[2] - u[2] * v[1]) * s + u[0] * k, v[1] * c + (u[2] * v[0] - u[0] * v[2]) * s + u[1] * k, v[2] * c + (u[0] * v[1] - u[1] * v[0]) * s + u[2] * k];
}

/** Column-major matrix from axes and origin. */
function fromAxes(x: Vec3, y: Vec3, z: Vec3, o: ArrayLike<number>): Float64Array {
  return new Float64Array([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1]);
}

/** Right-handed frame with z along `z` and x as close as possible to `x`. */
function frame(z: Vec3, x: Vec3 | null): [Vec3, Vec3, Vec3] {
  z = norm(z);
  if (!z[0] && !z[1] && !z[2]) z = [0, 0, 1];
  let xx: Vec3 = x ?? [1, 0, 0];
  let d = dot(xx, z);
  let xp = norm([xx[0] - d * z[0], xx[1] - d * z[1], xx[2] - d * z[2]]);
  if (!xp[0] && !xp[1] && !xp[2]) {
    xx = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    d = dot(xx, z);
    xp = norm([xx[0] - d * z[0], xx[1] - d * z[1], xx[2] - d * z[2]]);
  }
  return [xp, cross(z, xp), z];
}

export class IfcGeometry {
  private placements = new Map<number, Float64Array>();
  private pool: TriMesh[] = [];
  private profiles = new Map<number, Area[]>();
  private nums = { a: new Float64Array(64) };
  private ints = { a: new Int32Array(64) };

  constructor(
    readonly step: StepFile,
    readonly opt: GeometrySettings,
  ) {}

  // --- points, directions, placements -----------------------------------------------------------

  /** Cartesian point (2D points get z = 0). */
  point(id: number): Vec3 {
    const n = this.step.numbers(id, 0, this.nums);
    const a = this.nums.a;
    return [n > 0 ? a[0] : 0, n > 1 ? a[1] : 0, n > 2 ? a[2] : 0];
  }

  /** Normalised direction (IfcDirection, or the orientation of an IfcVector), or null. */
  direction(id: number): Vec3 | null {
    if (!id) return null;
    if (this.step.type(id) === 'IFCVECTOR') return this.direction(refId(this.step.args(id)[0]));
    const v = norm(this.point(id));
    return v[0] || v[1] || v[2] ? v : null;
  }

  /**
   * Matrix of a placement-like instance: IfcAxis2Placement2D/3D, IfcLocalPlacement (resolved to
   * the world), IfcCartesianTransformationOperator2D/3D (uniform or not). Identity for 0 / unknown.
   */
  placement(id: number): Float64Array {
    if (!id) return identity();
    let m = this.placements.get(id);
    if (m) return m;
    const s = this.step;
    const t = s.type(id);
    const a = s.args(id);
    switch (t) {
      case 'IFCAXIS2PLACEMENT3D': {
        const [x, y, z] = frame(this.direction(refId(a[1])) ?? [0, 0, 1], this.direction(refId(a[2])));
        m = fromAxes(x, y, z, this.point(refId(a[0])));
        break;
      }
      case 'IFCAXIS2PLACEMENT2D': {
        const [x, y, z] = frame([0, 0, 1], this.direction(refId(a[1])));
        m = fromAxes(x, y, z, this.point(refId(a[0])));
        break;
      }
      case 'IFCLOCALPLACEMENT': {
        const rel = this.placement(refId(a[1]));
        m = refId(a[0]) ? mul(this.placement(refId(a[0])), rel) : rel;
        break;
      }
      case 'IFCCARTESIANTRANSFORMATIONOPERATOR3D':
      case 'IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM':
      case 'IFCCARTESIANTRANSFORMATIONOPERATOR2D':
      case 'IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM': {
        const is3 = t.includes('3D');
        const z: Vec3 = (is3 && this.direction(refId(a[4]))) || [0, 0, 1];
        const [x] = frame(z, this.direction(refId(a[0])));
        // the second axis may point against z × x: a mirroring operator
        const zz = norm(z);
        let y: Vec3 = this.direction(refId(a[1])) ?? cross(zz, x);
        let d = dot(y, zz);
        y = [y[0] - d * zz[0], y[1] - d * zz[1], y[2] - d * zz[2]];
        d = dot(y, x);
        y = norm([y[0] - d * x[0], y[1] - d * x[1], y[2] - d * x[2]]);
        if (!y[0] && !y[1] && !y[2]) y = cross(zz, x);
        const s1 = num(a[3], 1);
        const s2 = t.endsWith('NONUNIFORM') ? num(a[is3 ? 5 : 4], s1) : s1;
        const s3 = is3 && t.endsWith('NONUNIFORM') ? num(a[6], s1) : s1;
        m = fromAxes([x[0] * s1, x[1] * s1, x[2] * s1], [y[0] * s2, y[1] * s2, y[2] * s2], [zz[0] * s3, zz[1] * s3, zz[2] * s3], this.point(refId(a[2])));
        break;
      }
      default:
        if (t) this.opt.unsupported(t);
        m = identity();
    }
    this.placements.set(id, m);
    return m;
  }

  // --- curves -----------------------------------------------------------------------------------

  /** Appends the points of a curve (x, y, z triples) to `out`, skipping repeated points. */
  curve(id: number, out: number[]): void {
    const s = this.step;
    const t = s.type(id);
    const a = s.args(id);
    switch (t) {
      case 'IFCPOLYLINE': {
        const n = s.refs(id, 0, this.ints);
        const ids = this.ints.a.slice(0, n);
        for (let i = 0; i < n; i++) push(out, this.point(ids[i]));
        return;
      }
      case 'IFCINDEXEDPOLYCURVE': {
        const pl = refId(a[0]);
        const dim = s.type(pl).endsWith('2D') ? 2 : 3;
        const n = s.numbers(pl, 0, this.nums) / dim;
        const c = this.nums.a.slice(0, n * dim);
        const p = (i: number): Vec3 => [c[(i - 1) * dim], c[(i - 1) * dim + 1], dim === 3 ? c[(i - 1) * dim + 2] : 0];
        const segs = list(a[1]);
        if (!segs.length) {
          for (let i = 1; i <= n; i++) push(out, p(i));
          return;
        }
        for (const seg of segs) {
          if (!(seg instanceof Typed)) continue;
          const ix = list(seg.value).map((v) => num(v));
          if (seg.type === 'IFCARCINDEX' && ix.length === 3) this.arc3(p(ix[0]), p(ix[1]), p(ix[2]), out);
          else for (const i of ix) push(out, p(i));
        }
        return;
      }
      case 'IFCCOMPOSITECURVE':
      case 'IFCCOMPOSITECURVEONSURFACE':
        for (const seg of refList(a[0])) {
          const sa = s.args(seg);
          const sub: number[] = [];
          this.curve(refId(sa[2]), sub);
          if (enumOf(sa[1]) === 'F') reversePoints(sub);
          for (let i = 0; i < sub.length; i += 3) push(out, [sub[i], sub[i + 1], sub[i + 2]]);
        }
        return;
      case 'IFCTRIMMEDCURVE':
        this.trimmed(a, out);
        return;
      case 'IFCCIRCLE':
      case 'IFCELLIPSE': {
        const m = this.placement(refId(a[0]));
        const r1 = num(a[1]);
        this.ellipse(m, r1, t === 'IFCCIRCLE' ? r1 : num(a[2]), 0, TAU, out);
        return;
      }
      case 'IFCBSPLINECURVEWITHKNOTS':
      case 'IFCRATIONALBSPLINECURVEWITHKNOTS':
      case 'IFCBEZIERCURVE':
        // approximated by its control polygon
        for (const p of refList(a[1])) push(out, this.point(p));
        return;
      default:
        if (t) this.opt.unsupported(t);
    }
  }

  private trimmed(a: Arg[], out: number[]): void {
    const s = this.step;
    const basis = refId(a[0]);
    const bt = s.type(basis);
    const ba = s.args(basis);
    const sense = enumOf(a[3]) !== 'F';
    const preferParam = enumOf(a[4]) === 'PARAMETER';
    const trim = (sel: Arg): { p: Vec3 | null; t: number | null } => {
      let p: Vec3 | null = null;
      let t: number | null = null;
      for (const v of list(sel)) {
        if (v instanceof Ref) p = this.point(v.id);
        else if (v instanceof Typed && typeof v.value === 'number') t = v.value;
        else if (typeof v === 'number') t = v;
      }
      if (p && t !== null) return preferParam ? { p: null, t } : { p, t: null };
      return { p, t };
    };
    const t1 = trim(a[1]), t2 = trim(a[2]);
    if (bt === 'IFCCIRCLE' || bt === 'IFCELLIPSE') {
      const m = this.placement(refId(ba[0]));
      const r1 = num(ba[1]);
      const r2 = bt === 'IFCCIRCLE' ? r1 : num(ba[2]);
      const angle = (tr: { p: Vec3 | null; t: number | null }) => {
        if (tr.p) {
          const dx = tr.p[0] - m[12], dy = tr.p[1] - m[13], dz = tr.p[2] - m[14];
          return Math.atan2((dx * m[4] + dy * m[5] + dz * m[6]) / r2, (dx * m[0] + dy * m[1] + dz * m[2]) / r1);
        }
        return (tr.t ?? 0) * this.opt.angleScale;
      };
      const a1 = angle(t1);
      let sweep = angle(t2) - a1;
      if (sense) {
        sweep = ((sweep % TAU) + TAU) % TAU;
        if (sweep < 1e-9) sweep = TAU;
      } else {
        sweep = -(((-sweep % TAU) + TAU) % TAU);
        if (sweep > -1e-9) sweep = -TAU;
      }
      this.ellipse(m, r1, r2, a1, sweep, out);
      return;
    }
    if (bt === 'IFCLINE') {
      const o = this.point(refId(ba[0]));
      const va = s.args(refId(ba[1]));
      const d = this.direction(refId(va[0])) ?? [1, 0, 0];
      const mag = num(va[1], 1);
      const at = (tr: { p: Vec3 | null; t: number | null }): Vec3 =>
        tr.p ?? [o[0] + d[0] * mag * (tr.t ?? 0), o[1] + d[1] * mag * (tr.t ?? 0), o[2] + d[2] * mag * (tr.t ?? 0)];
      const p1 = at(t1), p2 = at(t2);
      if (sense) {
        push(out, p1);
        push(out, p2);
      } else {
        push(out, p2);
        push(out, p1);
      }
      return;
    }
    // trimmed polylines and others: the whole basis curve
    const sub: number[] = [];
    this.curve(basis, sub);
    if (!sense) reversePoints(sub);
    for (let i = 0; i < sub.length; i += 3) push(out, [sub[i], sub[i + 1], sub[i + 2]]);
  }

  /** Segments of a full circle of radius r (file units): within the chord tolerance, capped. */
  private full(r: number): number {
    const max = this.opt.circleSegments;
    const rel = (CHORD_TOLERANCE / this.opt.lengthScale) / Math.abs(r);
    if (!(rel < 1)) return Math.min(max, MIN_CIRCLE_SEGMENTS);
    return Math.max(Math.min(max, MIN_CIRCLE_SEGMENTS), Math.min(max, Math.ceil(Math.PI / Math.acos(1 - rel))));
  }

  /** Segments of an arc of radius r sweeping `sweep` radians. */
  private segments(sweep: number, r: number): number {
    return Math.max(1, Math.ceil((Math.abs(sweep) / TAU) * this.full(r)));
  }

  private ellipse(m: Float64Array, r1: number, r2: number, a0: number, sweep: number, out: number[]): void {
    const n = this.segments(sweep, Math.max(Math.abs(r1), Math.abs(r2)));
    const full = Math.abs(sweep) >= TAU - 1e-9;
    for (let i = 0; i <= (full ? n - 1 : n); i++) {
      const t = a0 + (sweep * i) / n;
      const x = r1 * Math.cos(t), y = r2 * Math.sin(t);
      push(out, [m[12] + m[0] * x + m[4] * y, m[13] + m[1] * x + m[5] * y, m[14] + m[2] * x + m[6] * y]);
    }
  }

  /** Arc through three points. */
  private arc3(p1: Vec3, p2: Vec3, p3: Vec3, out: number[]): void {
    const u: Vec3 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const v: Vec3 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
    const w = cross(u, v);
    const ww = dot(w, w);
    if (ww < 1e-18 * dot(u, u) * dot(v, v) || ww === 0) {
      push(out, p1);
      push(out, p3);
      return;
    }
    const uu = dot(u, u), vv = dot(v, v);
    const a = cross(v, w), b = cross(w, u);
    const c: Vec3 = [p1[0] + (uu * a[0] + vv * b[0]) / (2 * ww), p1[1] + (uu * a[1] + vv * b[1]) / (2 * ww), p1[2] + (uu * a[2] + vv * b[2]) / (2 * ww)];
    const r = Math.hypot(p1[0] - c[0], p1[1] - c[1], p1[2] - c[2]);
    const x = norm([p1[0] - c[0], p1[1] - c[1], p1[2] - c[2]]);
    const z = norm(w);
    const y = cross(z, x);
    const e: Vec3 = [p3[0] - c[0], p3[1] - c[1], p3[2] - c[2]];
    let sweep = Math.atan2(dot(e, y), dot(e, x));
    if (sweep <= 0) sweep += TAU;
    const m = fromAxes(x, y, z, c);
    this.ellipse(m, r, r, 0, sweep, out);
  }

  // --- profiles ---------------------------------------------------------------------------------

  /** The areas of a profile definition (empty for open or unsupported profiles). */
  profile(id: number): Area[] {
    let p = this.profiles.get(id);
    if (!p) this.profiles.set(id, (p = this.buildProfile(id)));
    return p;
  }

  private buildProfile(id: number): Area[] {
    const s = this.step;
    const t = s.type(id);
    const a = s.args(id);
    const N = (r: number) => this.full(r);
    const pos = () => (refId(a[2]) ? this.placement(refId(a[2])) : null);
    const poly = (pts: number[], holes: number[][] = []): Area[] => areaOf(pts, holes, pos());
    switch (t) {
      case 'IFCARBITRARYCLOSEDPROFILEDEF':
      case 'IFCARBITRARYPROFILEDEFWITHVOIDS': {
        const outer = this.ring2(refId(a[2]));
        if (!outer) return [];
        const holes: Float64Array[] = [];
        if (t === 'IFCARBITRARYPROFILEDEFWITHVOIDS') for (const c of refList(a[3])) {
          const h = this.ring2(c);
          if (h) holes.push(h);
        }
        return [orient(outer, holes)];
      }
      case 'IFCRECTANGLEPROFILEDEF': {
        const x = num(a[3]) / 2, y = num(a[4]) / 2;
        return poly([-x, -y, x, -y, x, y, -x, y]);
      }
      case 'IFCROUNDEDRECTANGLEPROFILEDEF': {
        const x = num(a[3]) / 2, y = num(a[4]) / 2;
        const r = Math.min(num(a[5]), x, y);
        const pts: number[] = [];
        const q = Math.max(1, Math.round(N(r) / 4));
        const corners = [[x - r, -y + r, -Math.PI / 2], [x - r, y - r, 0], [-x + r, y - r, Math.PI / 2], [-x + r, -y + r, Math.PI]];
        for (const [cx, cy, a0] of corners) for (let i = 0; i <= q; i++) {
          const t = a0 + ((Math.PI / 2) * i) / q;
          pts.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
        }
        return poly(pts);
      }
      case 'IFCRECTANGLEHOLLOWPROFILEDEF': {
        const x = num(a[3]) / 2, y = num(a[4]) / 2, w = num(a[5]);
        return poly([-x, -y, x, -y, x, y, -x, y], [[-x + w, -y + w, x - w, -y + w, x - w, y - w, -x + w, y - w]]);
      }
      case 'IFCCIRCLEPROFILEDEF':
        return poly(circle(num(a[3]), num(a[3]), N(num(a[3]))));
      case 'IFCCIRCLEHOLLOWPROFILEDEF': {
        const r = num(a[3]);
        return poly(circle(r, r, N(r)), [circle(r - num(a[4]), r - num(a[4]), N(r))]);
      }
      case 'IFCELLIPSEPROFILEDEF':
        return poly(circle(num(a[3]), num(a[4]), N(Math.max(num(a[3]), num(a[4])))));
      case 'IFCISHAPEPROFILEDEF':
      case 'IFCASYMMETRICISHAPEPROFILEDEF': {
        const bw = num(a[3]) / 2, d = num(a[4]) / 2, tw = num(a[5]) / 2, tfb = num(a[6]);
        const asym = t === 'IFCASYMMETRICISHAPEPROFILEDEF';
        const top = asym ? num(a[8], bw * 2) / 2 : bw;
        const tft = asym ? num(a[9], tfb) : tfb;
        return poly([-bw, -d, bw, -d, bw, -d + tfb, tw, -d + tfb, tw, d - tft, top, d - tft, top, d, -top, d, -top, d - tft, -tw, d - tft, -tw, -d + tfb, -bw, -d + tfb]);
      }
      case 'IFCLSHAPEPROFILEDEF': {
        const d = num(a[3]) / 2, w = num(a[4], d * 2) / 2, th = num(a[5]);
        return poly([-w, -d, w, -d, w, -d + th, -w + th, -d + th, -w + th, d, -w, d]);
      }
      case 'IFCUSHAPEPROFILEDEF': {
        const d = num(a[3]) / 2, b = num(a[4]) / 2, tw = num(a[5]), tf = num(a[6]);
        return poly([-b, -d, b, -d, b, -d + tf, -b + tw, -d + tf, -b + tw, d - tf, b, d - tf, b, d, -b, d]);
      }
      case 'IFCTSHAPEPROFILEDEF': {
        const d = num(a[3]) / 2, b = num(a[4]) / 2, tw = num(a[5]) / 2, tf = num(a[6]);
        return poly([-tw, -d, tw, -d, tw, d - tf, b, d - tf, b, d, -b, d, -b, d - tf, -tw, d - tf]);
      }
      case 'IFCCSHAPEPROFILEDEF': {
        const d = num(a[3]) / 2, w = num(a[4]) / 2, th = num(a[5]), g = Math.max(num(a[6]), th);
        return poly([-w, -d, w, -d, w, -d + g, w - th, -d + g, w - th, -d + th, -w + th, -d + th, -w + th, d - th, w - th, d - th, w - th, d - g, w, d - g, w, d, -w, d]);
      }
      case 'IFCZSHAPEPROFILEDEF': {
        const d = num(a[3]) / 2, b = num(a[4]), tw = num(a[5]) / 2, tf = num(a[6]);
        return poly([-tw, -d, b - tw, -d, b - tw, -d + tf, tw, -d + tf, tw, d, -b + tw, d, -b + tw, d - tf, -tw, d - tf]);
      }
      case 'IFCDERIVEDPROFILEDEF':
      case 'IFCMIRROREDPROFILEDEF': {
        const parent = this.profile(refId(a[2]));
        const m = t === 'IFCMIRROREDPROFILEDEF' ? new Float64Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) : this.placement(refId(a[3]));
        return parent.map((ar) => orient(xform2(ar.outer, m), ar.holes.map((h) => xform2(h, m))));
      }
      case 'IFCCOMPOSITEPROFILEDEF':
        return refList(a[2]).flatMap((p) => this.profile(p));
      default:
        this.opt.unsupported(t || 'profile');
        return [];
    }
  }

  /** A closed curve as a 2D ring (closing duplicate removed), or null when degenerate. */
  private ring2(curve: number): Float64Array | null {
    const pts: number[] = [];
    this.curve(curve, pts);
    let n = pts.length / 3;
    if (n > 1 && near(pts, 0, (n - 1) * 3)) n--;
    if (n < 3) return null;
    const r = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      r[i * 2] = pts[i * 3];
      r[i * 2 + 1] = pts[i * 3 + 1];
    }
    return r;
  }

  // --- representation items ---------------------------------------------------------------------

  /** Appends the triangles of a representation item, in the item's coordinate frame. */
  item(id: number, mesh: TriMesh): void {
    const s = this.step;
    const t = s.type(id);
    const a = s.args(id);
    const v0 = mesh.nv, i0 = mesh.ni;
    switch (t) {
      case 'IFCEXTRUDEDAREASOLID':
      case 'IFCEXTRUDEDAREASOLIDTAPERED': {
        const d = this.direction(refId(a[2])) ?? [0, 0, 1];
        this.extrude(this.profile(refId(a[0])), d, num(a[3]), mesh);
        mesh.transformFrom(v0, i0, refId(a[1]) ? this.placement(refId(a[1])) : null);
        return;
      }
      case 'IFCREVOLVEDAREASOLID':
      case 'IFCREVOLVEDAREASOLIDTAPERED': {
        const ax = s.args(refId(a[2]));
        const o = this.point(refId(ax[0]));
        const u = this.direction(refId(ax[1])) ?? [0, 0, 1];
        this.revolve(this.profile(refId(a[0])), o, u, num(a[3]) * this.opt.angleScale, mesh);
        mesh.transformFrom(v0, i0, refId(a[1]) ? this.placement(refId(a[1])) : null);
        return;
      }
      case 'IFCSWEPTDISKSOLID':
      case 'IFCSWEPTDISKSOLIDPOLYGONAL': {
        const pts: number[] = [];
        this.curve(refId(a[0]), pts);
        this.sweptDisk(pts, num(a[1]), num(a[2]), mesh);
        return;
      }
      case 'IFCFACETEDBREP':
      case 'IFCFACETEDBREPWITHVOIDS':
      case 'IFCADVANCEDBREP':
      case 'IFCADVANCEDBREPWITHVOIDS':
        this.shell(refId(a[0]), mesh);
        return;
      case 'IFCCLOSEDSHELL':
      case 'IFCOPENSHELL':
      case 'IFCCONNECTEDFACESET':
        this.shell(id, mesh);
        return;
      case 'IFCSHELLBASEDSURFACEMODEL':
      case 'IFCFACEBASEDSURFACEMODEL':
        for (const sh of refList(a[0])) this.shell(sh, mesh);
        return;
      case 'IFCTRIANGULATEDFACESET':
      case 'IFCTRIANGULATEDIRREGULARNETWORK':
        this.triangulatedFaceSet(id, a, mesh);
        return;
      case 'IFCPOLYGONALFACESET':
        this.polygonalFaceSet(id, a, mesh);
        return;
      case 'IFCMAPPEDITEM': {
        const map = s.args(refId(a[0]));
        const m = mul(this.placement(refId(a[1])), this.placement(refId(map[0])));
        for (const it of this.representationItems(refId(map[1]))) this.item(it, mesh);
        mesh.transformFrom(v0, i0, m);
        return;
      }
      case 'IFCBOOLEANRESULT':
      case 'IFCBOOLEANCLIPPINGRESULT':
        this.boolean(a, mesh);
        return;
      case 'IFCCSGSOLID':
        this.item(refId(a[0]), mesh);
        return;
      case 'IFCBLOCK': {
        const x = num(a[1]), y = num(a[2]);
        this.extrude([{ outer: new Float64Array([0, 0, x, 0, x, y, 0, y]), holes: [] }], [0, 0, 1], num(a[3]), mesh);
        mesh.transformFrom(v0, i0, this.placement(refId(a[0])));
        return;
      }
      case 'IFCRIGHTCIRCULARCYLINDER': {
        const r = num(a[2]);
        this.extrude([{ outer: new Float64Array(circle(r, r, this.full(r))), holes: [] }], [0, 0, 1], num(a[1]), mesh);
        mesh.transformFrom(v0, i0, this.placement(refId(a[0])));
        return;
      }
      case 'IFCRIGHTCIRCULARCONE': {
        const h = num(a[1]), r = num(a[2]);
        // profile in the x/z half plane, revolved about z
        this.revolve([{ outer: new Float64Array([0, 0, r, 0, 0, h]), holes: [] }], [0, 0, 0], [0, 1, 0], TAU, mesh);
        mesh.transformFrom(v0, i0, mul(this.placement(refId(a[0])), new Float64Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1])));
        return;
      }
      case 'IFCSPHERE':
        this.sphere(num(a[1]), mesh);
        mesh.transformFrom(v0, i0, this.placement(refId(a[0])));
        return;
      default:
        this.opt.unsupported(t || 'item');
    }
  }

  /** Items of an IfcShapeRepresentation (or any representation). */
  representationItems(rep: number): number[] {
    return refList(this.step.args(rep)[3]);
  }

  // --- solids -----------------------------------------------------------------------------------

  /** Extrudes areas (in the XY plane) along unit direction d by depth. */
  extrude(areas: Area[], d: Vec3, depth: number, mesh: TriMesh): void {
    const ex = d[0] * depth, ey = d[1] * depth, ez = d[2] * depth;
    if (!(Math.abs(ez) > 0)) return;
    const sz = ez > 0 ? 1 : -1;
    for (const ar of areas) {
      const { xy, holes } = joined(ar);
      const tris = triangulate(xy, holes, []);
      const n = xy.length / 2;
      for (let cap = 0; cap < 2; cap++) {
        const base = mesh.nv;
        const nz = cap ? sz : -sz;
        for (let i = 0; i < n; i++) mesh.vertex(xy[i * 2] + ex * cap, xy[i * 2 + 1] + ey * cap, ez * cap, 0, 0, nz);
        for (let i = 0; i < tris.length; i += 3) mesh.orientedTri(base + tris[i], base + tris[i + 1], base + tris[i + 2], 0, 0, nz);
      }
      for (const ring of [ar.outer, ...ar.holes]) {
        const m = ring.length / 2;
        // outward edge normals: edge × extrusion
        const en = new Float64Array(m * 3);
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m;
          const tx = ring[j * 2] - ring[i * 2], ty = ring[j * 2 + 1] - ring[i * 2 + 1];
          const c = norm([(ty * ez) * sz, (-tx * ez) * sz, (tx * ey - ty * ex) * sz]);
          en.set(c, i * 3);
        }
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m;
          const ni = vertexNormal(en, i, m, i), nj = vertexNormal(en, j, m, i);
          const x0 = ring[i * 2], y0 = ring[i * 2 + 1], x1 = ring[j * 2], y1 = ring[j * 2 + 1];
          const a = mesh.vertex(x0, y0, 0, ni[0], ni[1], ni[2]);
          const b = mesh.vertex(x1, y1, 0, nj[0], nj[1], nj[2]);
          const c = mesh.vertex(x1 + ex, y1 + ey, ez, nj[0], nj[1], nj[2]);
          const e = mesh.vertex(x0 + ex, y0 + ey, ez, ni[0], ni[1], ni[2]);
          mesh.orientedTri(a, b, c, en[i * 3], en[i * 3 + 1], en[i * 3 + 2]);
          mesh.orientedTri(a, c, e, en[i * 3], en[i * 3 + 1], en[i * 3 + 2]);
        }
      }
    }
  }

  /** Revolves areas (in the XY plane) about the axis through o along unit u by angle (radians). */
  revolve(areas: Area[], o: Vec3, u: Vec3, angle: number, mesh: TriMesh): void {
    if (!angle) return;
    const full = Math.abs(angle) >= TAU - 1e-6;
    if (full) angle = Math.sign(angle) * TAU;
    let radius = 0;
    for (const ar of areas) for (let i = 0; i < ar.outer.length; i += 2) {
      const v: Vec3 = [ar.outer[i] - o[0], ar.outer[i + 1] - o[1], -o[2]];
      const along = dot(v, u);
      radius = Math.max(radius, Math.hypot(v[0] - along * u[0], v[1] - along * u[1], v[2] - along * u[2]));
    }
    const n = this.segments(angle, radius);
    const cs: number[] = [], sn: number[] = [];
    for (let k = 0; k <= n; k++) {
      cs.push(Math.cos((angle * k) / n));
      sn.push(Math.sin((angle * k) / n));
    }
    const at = (x: number, y: number, k: number): Vec3 => {
      const r = rotate([x - o[0], y - o[1], -o[2]], u, cs[k], sn[k]);
      return [r[0] + o[0], r[1] + o[1], r[2] + o[2]];
    };
    for (const ar of areas) {
      for (const ring of [ar.outer, ...ar.holes]) {
        const m = ring.length / 2;
        const en = new Float64Array(m * 3);
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m;
          en.set(norm([ring[j * 2 + 1] - ring[i * 2 + 1], ring[i * 2] - ring[j * 2], 0]), i * 3);
        }
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m;
          const ni = vertexNormal(en, i, m, i), nj = vertexNormal(en, j, m, i);
          const edge = en.subarray(i * 3, i * 3 + 3);
          for (let k = 0; k < n; k++) {
            const pa = at(ring[i * 2], ring[i * 2 + 1], k), pb = at(ring[j * 2], ring[j * 2 + 1], k);
            const pc = at(ring[j * 2], ring[j * 2 + 1], k + 1), pd = at(ring[i * 2], ring[i * 2 + 1], k + 1);
            const na = rotate(ni, u, cs[k], sn[k]), nb = rotate(nj, u, cs[k], sn[k]);
            const nc = rotate(nj, u, cs[k + 1], sn[k + 1]), nd = rotate(ni, u, cs[k + 1], sn[k + 1]);
            const fm = rotate(edge, u, Math.cos((angle * (k + 0.5)) / n), Math.sin((angle * (k + 0.5)) / n));
            const a = mesh.vertex(pa[0], pa[1], pa[2], na[0], na[1], na[2]);
            const b = mesh.vertex(pb[0], pb[1], pb[2], nb[0], nb[1], nb[2]);
            const c = mesh.vertex(pc[0], pc[1], pc[2], nc[0], nc[1], nc[2]);
            const d = mesh.vertex(pd[0], pd[1], pd[2], nd[0], nd[1], nd[2]);
            mesh.orientedTri(a, b, c, fm[0], fm[1], fm[2]);
            mesh.orientedTri(a, c, d, fm[0], fm[1], fm[2]);
          }
        }
      }
      if (full) continue;
      // end caps: the profile at both ends, facing away from the swept volume
      const { xy, holes } = joined(ar);
      const tris = triangulate(xy, holes, []);
      let cx = 0, cy = 0;
      for (let i = 0; i < ar.outer.length; i += 2) {
        cx += ar.outer[i];
        cy += ar.outer[i + 1];
      }
      cx /= ar.outer.length / 2;
      cy /= ar.outer.length / 2;
      const motion = cross(u, [cx - o[0], cy - o[1], -o[2]]);
      const fwd = (motion[2] >= 0 ? 1 : -1) * Math.sign(angle);
      for (const k of [0, n]) {
        const nn = rotate([0, 0, k === 0 ? -fwd : fwd], u, cs[k], sn[k]);
        const base = mesh.nv;
        for (let i = 0; i < xy.length; i += 2) {
          const p = at(xy[i], xy[i + 1], k);
          mesh.vertex(p[0], p[1], p[2], nn[0], nn[1], nn[2]);
        }
        for (let i = 0; i < tris.length; i += 3) mesh.orientedTri(base + tris[i], base + tris[i + 1], base + tris[i + 2], nn[0], nn[1], nn[2]);
      }
    }
  }

  /** A tube of radius r (hollow when ri > 0) along a polyline (x, y, z triples). */
  sweptDisk(pts: number[], r: number, ri: number, mesh: TriMesh): void {
    const m = pts.length / 3;
    if (m < 2 || !(r > 0)) return;
    const P = (i: number): Vec3 => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
    const T: Vec3[] = [];
    for (let i = 0; i + 1 < m; i++) T.push(norm([pts[i * 3 + 3] - pts[i * 3], pts[i * 3 + 4] - pts[i * 3 + 1], pts[i * 3 + 5] - pts[i * 3 + 2]]));
    const N = this.full(r);
    const closed = m > 2 && near(pts, 0, (m - 1) * 3);
    let [ux, uy] = frame(T[0], null);
    const rings: [number, number][] = ri > 0 ? [[r, 1], [ri, -1]] : [[r, 1]];
    const miter = (i: number): Vec3 => {
      if (i === 0) return closed ? norm(add(T[m - 2], T[0])) : T[0];
      if (i === m - 1) return closed ? norm(add(T[m - 2], T[0])) : T[m - 2];
      const b = norm(add(T[i - 1], T[i]));
      return b[0] || b[1] || b[2] ? b : T[i];
    };
    let startFrame: [Vec3, Vec3] = [ux, uy];
    for (let j = 0; j + 1 < m; j++) {
      const t = T[j];
      if (j > 0) {
        // parallel transport of the frame from the previous segment
        const ax = cross(T[j - 1], t);
        const sl = Math.hypot(ax[0], ax[1], ax[2]);
        if (sl > 1e-12) {
          const c = dot(T[j - 1], t);
          const axn: Vec3 = [ax[0] / sl, ax[1] / sl, ax[2] / sl];
          ux = rotate(ux, axn, c, sl);
          uy = rotate(uy, axn, c, sl);
        }
      } else startFrame = [ux, uy];
      const b0 = miter(j), b1 = miter(j + 1);
      const p0 = P(j), p1 = P(j + 1);
      const t0 = dot(t, b0) || 1, t1 = dot(t, b1) || 1;
      for (const [rad, side] of rings) {
        const base = mesh.nv;
        for (let k = 0; k < N; k++) {
          const ph = (TAU * k) / N;
          const c = Math.cos(ph), sn = Math.sin(ph);
          const dx = ux[0] * c + uy[0] * sn, dy = ux[1] * c + uy[1] * sn, dz = ux[2] * c + uy[2] * sn;
          const ox = dx * rad, oy = dy * rad, oz = dz * rad;
          const k0 = (ox * b0[0] + oy * b0[1] + oz * b0[2]) / t0;
          const k1 = (ox * b1[0] + oy * b1[1] + oz * b1[2]) / t1;
          mesh.vertex(p0[0] + ox - t[0] * k0, p0[1] + oy - t[1] * k0, p0[2] + oz - t[2] * k0, dx * side, dy * side, dz * side);
          mesh.vertex(p1[0] + ox - t[0] * k1, p1[1] + oy - t[1] * k1, p1[2] + oz - t[2] * k1, dx * side, dy * side, dz * side);
        }
        for (let k = 0; k < N; k++) {
          const a = base + k * 2, b = base + ((k + 1) % N) * 2;
          const fx = (ux[0] * Math.cos((TAU * (k + 0.5)) / N) + uy[0] * Math.sin((TAU * (k + 0.5)) / N)) * side;
          const fy = (ux[1] * Math.cos((TAU * (k + 0.5)) / N) + uy[1] * Math.sin((TAU * (k + 0.5)) / N)) * side;
          const fz = (ux[2] * Math.cos((TAU * (k + 0.5)) / N) + uy[2] * Math.sin((TAU * (k + 0.5)) / N)) * side;
          mesh.orientedTri(a, b, b + 1, fx, fy, fz);
          mesh.orientedTri(a, b + 1, a + 1, fx, fy, fz);
        }
      }
    }
    if (closed) return;
    // end caps (discs or annuli)
    const caps: [Vec3, Vec3, Vec3, number][] = [
      [P(0), startFrame[0], startFrame[1], -1],
      [P(m - 1), ux, uy, 1],
    ];
    for (const [p, a, b, sgn] of caps) {
      const t = sgn < 0 ? T[0] : T[m - 2];
      const nx = t[0] * sgn, ny = t[1] * sgn, nz = t[2] * sgn;
      const base = mesh.nv;
      for (let k = 0; k < N; k++) {
        const ph = (TAU * k) / N;
        const c = Math.cos(ph), sn = Math.sin(ph);
        const dx = a[0] * c + b[0] * sn, dy = a[1] * c + b[1] * sn, dz = a[2] * c + b[2] * sn;
        mesh.vertex(p[0] + dx * r, p[1] + dy * r, p[2] + dz * r, nx, ny, nz);
        if (ri > 0) mesh.vertex(p[0] + dx * ri, p[1] + dy * ri, p[2] + dz * ri, nx, ny, nz);
      }
      if (ri > 0) {
        for (let k = 0; k < N; k++) {
          const o0 = base + k * 2, o1 = base + ((k + 1) % N) * 2;
          mesh.orientedTri(o0, o1, o1 + 1, nx, ny, nz);
          mesh.orientedTri(o0, o1 + 1, o0 + 1, nx, ny, nz);
        }
      } else {
        for (let k = 1; k + 1 < N; k++) mesh.orientedTri(base, base + k, base + k + 1, nx, ny, nz);
      }
    }
  }

  private sphere(r: number, mesh: TriMesh): void {
    const N = this.full(r);
    const rows = Math.max(2, Math.round(N / 2));
    const base = mesh.nv;
    for (let i = 0; i <= rows; i++) {
      const th = (Math.PI * i) / rows;
      for (let k = 0; k <= N; k++) {
        const ph = (TAU * k) / N;
        const x = Math.sin(th) * Math.cos(ph), y = Math.sin(th) * Math.sin(ph), z = Math.cos(th);
        mesh.vertex(x * r, y * r, z * r, x, y, z);
      }
    }
    for (let i = 0; i < rows; i++) {
      for (let k = 0; k < N; k++) {
        const a = base + i * (N + 1) + k, b = a + N + 1;
        if (i > 0) mesh.tri(a, b, a + 1);
        if (i < rows - 1) mesh.tri(a + 1, b, b + 1);
      }
    }
  }

  // --- B-reps and face sets ---------------------------------------------------------------------

  private shell(id: number, mesh: TriMesh): void {
    const s = this.step;
    const n = s.refs(id, 0, this.ints);
    const faces = this.ints.a.slice(0, n);
    for (let i = 0; i < n; i++) this.face(faces[i], mesh);
  }

  private face(id: number, mesh: TriMesh): void {
    const s = this.step;
    const t = s.type(id);
    if (t === 'IFCADVANCEDFACE' || t === 'IFCFACESURFACE') {
      const surf = refId(s.args(id)[1]);
      const st = s.type(surf);
      if (t === 'IFCADVANCEDFACE' && st !== 'IFCPLANE') {
        this.opt.unsupported(`IFCADVANCEDFACE on ${st || 'surface'}`);
        return;
      }
    }
    const nb = s.refs(id, 0, this.ints);
    const bounds = Array.from(this.ints.a.subarray(0, nb));
    const loops: number[][] = [];
    for (const b of bounds) {
      const ba = s.args(b);
      const loop = refId(ba[0]);
      const pts: number[] = [];
      const lt = s.type(loop);
      if (lt === 'IFCPOLYLOOP') {
        const np = s.refs(loop, 0, this.ints);
        const ids = this.ints.a.slice(0, np);
        for (let i = 0; i < np; i++) push(pts, this.point(ids[i]));
      } else if (lt === 'IFCEDGELOOP') this.edgeLoop(loop, pts);
      else continue;
      let n = pts.length / 3;
      if (n > 1 && near(pts, 0, (n - 1) * 3)) pts.length = --n * 3;
      if (n < 3) continue;
      if (enumOf(ba[1]) === 'F') reversePoints(pts);
      if (s.type(b) === 'IFCFACEOUTERBOUND') loops.unshift(pts);
      else loops.push(pts);
    }
    if (loops.length) mesh.polygon(loops);
  }

  private edgeLoop(loop: number, out: number[]): void {
    const s = this.step;
    for (const oe of refList(s.args(loop)[0])) {
      const oa = s.args(oe);
      const edge = refId(oa[2]);
      const ea = s.args(edge);
      const fwd = enumOf(oa[3]) !== 'F';
      const vs = s.args(refId(ea[fwd ? 0 : 1]));
      const ve = s.args(refId(ea[fwd ? 1 : 0]));
      const ps = this.point(refId(vs[0]));
      const geom = refId(ea[2]);
      const gt = s.type(geom);
      if (gt && gt !== 'IFCLINE' && gt !== 'IFCPOLYLINE') {
        // curved edge: sample it, oriented to run from the start vertex
        const pe = this.point(refId(ve[0]));
        const sub: number[] = [];
        this.curve(geom, sub);
        if (sub.length >= 6) {
          const ds = Math.hypot(sub[0] - ps[0], sub[1] - ps[1], sub[2] - ps[2]);
          const de = Math.hypot(sub[0] - pe[0], sub[1] - pe[1], sub[2] - pe[2]);
          if (de < ds) reversePoints(sub);
          for (let i = 0; i + 3 < sub.length; i += 3) push(out, [sub[i], sub[i + 1], sub[i + 2]]);
          continue;
        }
      }
      push(out, ps);
    }
  }

  private coordList(id: number): Float64Array {
    const n = this.step.numbers(id, 0, this.nums);
    return this.nums.a.slice(0, n);
  }

  private triangulatedFaceSet(id: number, a: Arg[], mesh: TriMesh): void {
    const s = this.step;
    const c = this.coordList(refId(a[0]));
    const ni = s.numbers(id, 3, this.nums);
    const ix = this.nums.a.slice(0, ni);
    const np = s.numbers(id, 4, this.nums);
    const pn = np ? this.nums.a.slice(0, np) : null;
    const vi = (k: number) => (pn ? pn[k - 1] : k) - 1;
    const nn = a[1] ? s.numbers(id, 1, this.nums) : 0;
    const nv = c.length / 3;
    if (nn && nn === (pn ? pn.length * 3 : c.length)) {
      // normals per (index-mapped) vertex: shared vertices, smooth shading
      const nrm = this.nums.a.slice(0, nn);
      const count = nn / 3;
      const base = mesh.nv;
      for (let k = 0; k < count; k++) {
        const v = pn ? pn[k] - 1 : k;
        mesh.vertex(c[v * 3], c[v * 3 + 1], c[v * 3 + 2], nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]);
      }
      for (let i = 0; i + 2 < ni; i += 3) {
        const p = ix[i] - 1, q = ix[i + 1] - 1, r = ix[i + 2] - 1;
        if (p >= 0 && q >= 0 && r >= 0 && p < count && q < count && r < count) mesh.tri(base + p, base + q, base + r);
      }
      return;
    }
    for (let i = 0; i + 2 < ni; i += 3) {
      const p = vi(ix[i]), q = vi(ix[i + 1]), r = vi(ix[i + 2]);
      if (p < 0 || q < 0 || r < 0 || p >= nv || q >= nv || r >= nv) continue;
      flatTri(mesh, c, p, q, r);
    }
  }

  private polygonalFaceSet(id: number, a: Arg[], mesh: TriMesh): void {
    const s = this.step;
    const c = this.coordList(refId(a[0]));
    const np = s.numbers(id, 3, this.nums);
    const pn = np ? this.nums.a.slice(0, np) : null;
    const nv = c.length / 3;
    const ring = (ix: ArrayLike<number>): number[] | null => {
      const pts: number[] = [];
      for (let i = 0; i < ix.length; i++) {
        const v = (pn ? pn[ix[i] - 1] : ix[i]) - 1;
        if (!(v >= 0 && v < nv)) return null;
        pts.push(c[v * 3], c[v * 3 + 1], c[v * 3 + 2]);
      }
      return pts;
    };
    for (const f of refList(a[2])) {
      if (s.type(f) === 'IFCINDEXEDPOLYGONALFACEWITHVOIDS') {
        const fa = s.args(f);
        const loops = [list(fa[0]).map((v) => num(v)), ...list(fa[1]).map((l) => list(l).map((v) => num(v)))].map(ring);
        if (loops.every((l) => l)) mesh.polygon(loops as number[][]);
        continue;
      }
      const n = s.numbers(f, 0, this.nums);
      if (n === 3 && !pn) {
        const p = this.nums.a[0] - 1, q = this.nums.a[1] - 1, r = this.nums.a[2] - 1;
        if (p >= 0 && q >= 0 && r >= 0 && p < nv && q < nv && r < nv) flatTri(mesh, c, p, q, r);
        continue;
      }
      const pts = ring(this.nums.a.subarray(0, n));
      if (pts) mesh.polygon([pts]);
    }
  }

  // --- booleans ---------------------------------------------------------------------------------

  private boolean(a: Arg[], mesh: TriMesh): void {
    const s = this.step;
    const op = enumOf(a[0]);
    const first = refId(a[1]), second = refId(a[2]);
    const tmp = new TriMesh();
    this.item(first, tmp);
    const st = s.type(second);
    const halfSpace = st === 'IFCHALFSPACESOLID' || st === 'IFCPOLYGONALBOUNDEDHALFSPACE' || st === 'IFCBOXEDHALFSPACE';
    if (op === 'UNION') this.item(second, tmp);
    else if (halfSpace) {
      if (op === 'DIFFERENCE') this.clipHalfSpace(tmp, second, st);
      else this.opt.unsupported(`${op} with a half space`);
    } else if (op === 'DIFFERENCE') {
      if (!this.opt.solidCuts) {
        mesh.append(tmp);
        return;
      }
      const parts = this.convexParts(second);
      if (parts) for (const planes of parts) tmp.subtractConvex(planes, this.pool);
      else this.opt.unsupported('boolean difference with a non-convex solid (first operand kept)');
    } else this.opt.unsupported(`boolean ${op} (first operand kept)`);
    mesh.append(tmp);
  }

  /**
   * A bolt (head, shank, nut, washers as extrusions along one axis) reduced to its shank and its
   * hexagonal head and nut: one matrix per part, in the items' frame, that places the unit
   * hexagonal prism (`unitHexPrism`) there. Null when the items do not look like a bolt.
   */
  boltParts(items: number[]): Float64Array[] | null {
    const s = this.step;
    type Part = { m: Float64Array; z0: number; z1: number; r: number; round: boolean; axis: Vec3; o: Vec3 };
    const parts: Part[] = [];
    for (const it of items) {
      if (s.type(it) !== 'IFCEXTRUDEDAREASOLID') return null;
      const a = s.args(it);
      const prof = refId(a[0]);
      const areas = this.profile(prof);
      if (areas.length !== 1) return null;
      const ring = areas[0].outer;
      // profile centre and circumradius
      let cx = 0, cy = 0;
      for (let i = 0; i < ring.length; i += 2) {
        cx += ring[i];
        cy += ring[i + 1];
      }
      cx /= ring.length / 2;
      cy /= ring.length / 2;
      let r = 0;
      for (let i = 0; i < ring.length; i += 2) r = Math.max(r, Math.hypot(ring[i] - cx, ring[i + 1] - cy));
      const m = refId(a[1]) ? this.placement(refId(a[1])) : identity();
      const d = this.direction(refId(a[2])) ?? [0, 0, 1];
      const depth = num(a[3]);
      const axis = norm([m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]]);
      const o: Vec3 = [m[12] + m[0] * cx + m[4] * cy, m[13] + m[1] * cx + m[5] * cy, m[14] + m[2] * cx + m[6] * cy];
      const len = depth * Math.hypot(m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]);
      parts.push({ m, z0: 0, z1: len, r, round: s.type(prof) === 'IFCCIRCLEPROFILEDEF', axis, o });
    }
    if (!parts.length) return null;
    const shank = parts.reduce((x, y) => (y.round && (!x.round || y.z1 > x.z1) ? y : x));
    if (!shank.round) return null;
    const axis = shank.axis;
    const base = shank.o;
    // all parts on the shank's axis, positions measured along it
    for (const p of parts) {
      if (Math.abs(dot(p.axis, axis)) < 0.999) return null;
      const v: Vec3 = [p.o[0] - base[0], p.o[1] - base[1], p.o[2] - base[2]];
      const t = dot(v, axis);
      const off = Math.hypot(v[0] - t * axis[0], v[1] - t * axis[1], v[2] - t * axis[2]);
      if (off > shank.r * 0.5) return null;
      const dir = dot(p.axis, axis) > 0 ? 1 : -1;
      p.z0 = Math.min(t, t + dir * p.z1);
      p.z1 = Math.max(t, t + dir * p.z1);
    }
    const hexes = parts.filter((p) => !p.round).sort((x, y) => x.z0 - y.z0);
    const keep = [shank, ...(hexes.length ? [hexes[0]] : []), ...(hexes.length > 1 ? [hexes[hexes.length - 1]] : [])];
    const [x, y, z] = frame(axis, null);
    return keep.map((p) => {
      const o: Vec3 = [base[0] + axis[0] * p.z0, base[1] + axis[1] * p.z0, base[2] + axis[2] * p.z0];
      const h = p.z1 - p.z0;
      return fromAxes([x[0] * p.r, x[1] * p.r, x[2] * p.r], [y[0] * p.r, y[1] * p.r, y[2] * p.r], [z[0] * h, z[1] * h, z[2] * h], o);
    });
  }

  /** Hexagonal prism of circumradius 1 from z = 0 to z = 1 (the shared bolt part). */
  unitHexPrism(mesh: TriMesh): void {
    const ring = new Float64Array(12);
    for (let i = 0; i < 6; i++) {
      ring[i * 2] = Math.cos((TAU * i) / 6);
      ring[i * 2 + 1] = Math.sin((TAU * i) / 6);
    }
    this.extrude([{ outer: ring, holes: [] }], [0, 0, 1], 1, mesh);
  }

  /**
   * A solid as convex volumes (nx, ny, nz, d per bounding plane, in the item's frame) for
   * subtraction: extrusions split into convex prisms, other solids only when already convex.
   * Null when that is not possible.
   */
  convexParts(id: number): Float64Array[] | null {
    const s = this.step;
    const t = s.type(id);
    const a = s.args(id);
    if (t === 'IFCEXTRUDEDAREASOLID') {
      const d = this.direction(refId(a[2])) ?? [0, 0, 1];
      const depth = num(a[3]);
      const e: Vec3 = [d[0] * depth, d[1] * depth, d[2] * depth];
      if (!(Math.abs(e[2]) > 0)) return null;
      const parts: Float64Array[] = [];
      for (const ar of this.profile(refId(a[0]))) {
        if (!ar.holes.length && isConvex(ar.outer)) parts.push(prism(ar.outer, e));
        else {
          const { xy, holes } = joined(ar);
          const tris = triangulate(xy, holes, []);
          for (let i = 0; i < tris.length; i += 3) {
            const r = new Float64Array(6);
            for (let k = 0; k < 3; k++) r.set([xy[tris[i + k] * 2], xy[tris[i + k] * 2 + 1]], k * 2);
            parts.push(prism(ringArea(r) < 0 ? reverseRing(r) : r, e));
          }
        }
      }
      const m = refId(a[1]) ? this.placement(refId(a[1])) : null;
      return m ? parts.map((pl) => transformPlanes(pl, m)) : parts;
    }
    if (t === 'IFCMAPPEDITEM') {
      const map = s.args(refId(a[0]));
      const m = mul(this.placement(refId(a[1])), this.placement(refId(map[0])));
      const parts: Float64Array[] = [];
      for (const it of this.representationItems(refId(map[1]))) {
        const sub = this.convexParts(it);
        if (!sub) return null;
        for (const pl of sub) parts.push(transformPlanes(pl, m));
      }
      return parts;
    }
    const mesh = new TriMesh();
    this.item(id, mesh);
    const planes = convexPlanes(mesh);
    return planes ? [planes] : null;
  }

  private clipHalfSpace(mesh: TriMesh, id: number, type: string): void {
    const s = this.step;
    const a = s.args(id);
    const surf = refId(a[0]);
    if (s.type(surf) !== 'IFCPLANE') {
      this.opt.unsupported(`half space on ${s.type(surf)}`);
      return;
    }
    const p = this.placement(refId(s.args(surf)[0]));
    let nx = p[8], ny = p[9], nz = p[10];
    let d = nx * p[12] + ny * p[13] + nz * p[14];
    // AgreementFlag TRUE: the plane normal points away from the half space (the removed material)
    if (enumOf(a[1]) !== 'F') {
      nx = -nx; ny = -ny; nz = -nz; d = -d;
    }
    if (type === 'IFCPOLYGONALBOUNDEDHALFSPACE') {
      // only exact when the boundary prism contains the whole operand: otherwise keep it uncut
      const m = this.placement(refId(a[2]));
      const pts: number[] = [];
      this.curve(refId(a[3]), pts);
      const ring: number[] = [];
      for (let i = 0; i < pts.length; i += 3) ring.push(pts[i], pts[i + 1]);
      const pos = mesh.pos;
      // only the vertices on the removed side matter
      for (let v = 0; v < mesh.nv; v++) {
        const x = pos[v * 3] - m[12], y = pos[v * 3 + 1] - m[13], z = pos[v * 3 + 2] - m[14];
        if (pos[v * 3] * nx + pos[v * 3 + 1] * ny + pos[v * 3 + 2] * nz - d <= 0) continue;
        const lx = x * m[0] + y * m[1] + z * m[2], ly = x * m[4] + y * m[5] + z * m[6];
        if (!insideRing(ring, lx, ly)) {
          this.opt.unsupported('IFCPOLYGONALBOUNDEDHALFSPACE cutting part of a solid (kept uncut)');
          return;
        }
      }
    }
    mesh.clip(nx, ny, nz, d, new TriMesh());
  }
}

// --- helpers ------------------------------------------------------------------------------------

/** Inverse of an affine column-major matrix. */
export function invert(m: ArrayLike<number>): Float64Array {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], k = m[10];
  const c00 = e * k - f * h, c01 = f * g - d * k, c02 = d * h - e * g;
  const det = a * c00 + b * c01 + c * c02;
  const id = det ? 1 / det : 0;
  const o = new Float64Array(16);
  o[0] = c00 * id; o[1] = (c * h - b * k) * id; o[2] = (b * f - c * e) * id;
  o[4] = c01 * id; o[5] = (a * k - c * g) * id; o[6] = (c * d - a * f) * id;
  o[8] = c02 * id; o[9] = (b * g - a * h) * id; o[10] = (a * e - b * d) * id;
  o[12] = -(o[0] * m[12] + o[4] * m[13] + o[8] * m[14]);
  o[13] = -(o[1] * m[12] + o[5] * m[13] + o[9] * m[14]);
  o[14] = -(o[2] * m[12] + o[6] * m[13] + o[10] * m[14]);
  o[15] = 1;
  return o;
}

/** Planes (nx, ny, nz, d per plane) given in a local frame, expressed in the parent frame (m: local -> parent). */
export function transformPlanes(planes: ArrayLike<number>, m: ArrayLike<number>): Float64Array {
  const inv = invert(m);
  const out = new Float64Array(planes.length);
  for (let i = 0; i < planes.length; i += 4) {
    const nx = planes[i], ny = planes[i + 1], nz = planes[i + 2];
    // n·(L x + t) <= d  =>  (Lᵀ n)·x <= d - n·t, with x_local = inv · x_parent
    let ax = inv[0] * nx + inv[1] * ny + inv[2] * nz;
    let ay = inv[4] * nx + inv[5] * ny + inv[6] * nz;
    let az = inv[8] * nx + inv[9] * ny + inv[10] * nz;
    let d = planes[i + 3] - (nx * inv[12] + ny * inv[13] + nz * inv[14]);
    const l = Math.hypot(ax, ay, az) || 1;
    ax /= l; ay /= l; az /= l; d /= l;
    out[i] = ax; out[i + 1] = ay; out[i + 2] = az; out[i + 3] = d;
  }
  return out;
}

function isConvex(r: Float64Array): boolean {
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = ((i + 1) % n) * 2, c = ((i + 2) % n) * 2;
    const cr = (r[b] - r[a]) * (r[c + 1] - r[b + 1]) - (r[b + 1] - r[a + 1]) * (r[c] - r[b]);
    if (cr < -1e-12 * (Math.abs(r[a]) + Math.abs(r[a + 1]) + 1)) return false;
  }
  return true;
}

/** Bounding planes of a counter-clockwise convex ring extruded by e (e.z != 0). */
function prism(r: Float64Array, e: Vec3): Float64Array {
  const n = r.length / 2;
  const sz = e[2] > 0 ? 1 : -1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const tx = r[j * 2] - r[i * 2], ty = r[j * 2 + 1] - r[i * 2 + 1];
    const c = norm([ty * e[2] * sz, -tx * e[2] * sz, (tx * e[1] - ty * e[0]) * sz]);
    if (!c[0] && !c[1] && !c[2]) continue;
    out.push(c[0], c[1], c[2], c[0] * r[i * 2] + c[1] * r[i * 2 + 1]);
  }
  out.push(0, 0, -sz, 0, 0, 0, sz, sz * e[2]);
  return new Float64Array(out);
}

/** The face planes of a mesh when it is a convex solid, else null. */
function convexPlanes(mesh: TriMesh): Float64Array | null {
  if (!mesh.ni) return null;
  const p = mesh.pos, idx = mesh.idx;
  const b = mesh.bounds()!;
  const size = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2], 1e-9);
  const tol = 1e-6 * size;
  const planes: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < mesh.ni; i += 3) {
    const a = idx[i] * 3, bb = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const n = norm(cross([p[bb] - p[a], p[bb + 1] - p[a + 1], p[bb + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]));
    if (!n[0] && !n[1] && !n[2]) continue;
    const d = n[0] * p[a] + n[1] * p[a + 1] + n[2] * p[a + 2];
    const key = `${Math.round(n[0] * 1e5)},${Math.round(n[1] * 1e5)},${Math.round(n[2] * 1e5)},${Math.round(d / tol)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (let v = 0; v < mesh.nv * 3; v += 3) if (n[0] * p[v] + n[1] * p[v + 1] + n[2] * p[v + 2] - d > tol * 10) return null;
    planes.push(n[0], n[1], n[2], d);
    if (planes.length > 4 * 128) return null;
  }
  return planes.length >= 16 ? new Float64Array(planes) : null;
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function push(out: number[], p: ArrayLike<number>): void {
  const n = out.length;
  if (n >= 3) {
    const tol = 1e-9 * (Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]) + 1);
    if (Math.abs(out[n - 3] - p[0]) <= tol && Math.abs(out[n - 2] - p[1]) <= tol && Math.abs(out[n - 1] - p[2]) <= tol) return;
  }
  out.push(p[0], p[1], p[2]);
}

function near(pts: ArrayLike<number>, i: number, j: number): boolean {
  const tol = 1e-9 * (Math.abs(pts[i]) + Math.abs(pts[i + 1]) + Math.abs(pts[i + 2]) + 1);
  return Math.abs(pts[i] - pts[j]) <= tol && Math.abs(pts[i + 1] - pts[j + 1]) <= tol && Math.abs(pts[i + 2] - pts[j + 2]) <= tol;
}

function reversePoints(p: number[]): void {
  for (let i = 0, j = p.length - 3; i < j; i += 3, j -= 3) {
    for (let k = 0; k < 3; k++) {
      const t = p[i + k];
      p[i + k] = p[j + k];
      p[j + k] = t;
    }
  }
}

function circle(rx: number, ry: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rx * Math.cos((TAU * i) / n), ry * Math.sin((TAU * i) / n));
  return out;
}

function xform2(r: Float64Array, m: ArrayLike<number> | null): Float64Array {
  if (!m) return r;
  const o = new Float64Array(r.length);
  for (let i = 0; i < r.length; i += 2) {
    o[i] = m[0] * r[i] + m[4] * r[i + 1] + m[12];
    o[i + 1] = m[1] * r[i] + m[5] * r[i + 1] + m[13];
  }
  return o;
}

function reverseRing(r: Float64Array): Float64Array {
  const o = new Float64Array(r.length);
  for (let i = 0, j = r.length - 2; i < r.length; i += 2, j -= 2) {
    o[i] = r[j];
    o[i + 1] = r[j + 1];
  }
  return o;
}

/** Outer ring counter-clockwise, holes clockwise. */
function orient(outer: Float64Array, holes: Float64Array[]): Area {
  return {
    outer: ringArea(outer) < 0 ? reverseRing(outer) : outer,
    holes: holes.filter((h) => h.length >= 6).map((h) => (ringArea(h) > 0 ? reverseRing(h) : h)),
  };
}

function areaOf(pts: number[], holes: number[][], m: Float64Array | null): Area[] {
  if (pts.length < 6 || pts.some((v) => !Number.isFinite(v))) return [];
  return [orient(xform2(new Float64Array(pts), m), holes.map((h) => xform2(new Float64Array(h), m)))];
}

/** Outer ring and holes as one coordinate array plus hole start indices (for `triangulate`). */
function joined(ar: Area): { xy: Float64Array; holes: number[] | null } {
  if (!ar.holes.length) return { xy: ar.outer, holes: null };
  let n = ar.outer.length;
  for (const h of ar.holes) n += h.length;
  const xy = new Float64Array(n);
  xy.set(ar.outer);
  const holes: number[] = [];
  let o = ar.outer.length;
  for (const h of ar.holes) {
    holes.push(o / 2);
    xy.set(h, o);
    o += h.length;
  }
  return { xy, holes };
}

/** Normal at ring vertex v for the side face of edge e: smooth with the neighbouring face when close. */
function vertexNormal(en: Float64Array, v: number, m: number, e: number): Vec3 {
  const other = v === e ? (e + m - 1) % m : (e + 1) % m;
  const a = en.subarray(e * 3, e * 3 + 3), b = en.subarray(other * 3, other * 3 + 3);
  if (dot(a, b) > SMOOTH_COS) return norm([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
  return [a[0], a[1], a[2]];
}

function flatTri(mesh: TriMesh, c: ArrayLike<number>, p: number, q: number, r: number): void {
  const ax = c[p * 3], ay = c[p * 3 + 1], az = c[p * 3 + 2];
  const ux = c[q * 3] - ax, uy = c[q * 3 + 1] - ay, uz = c[q * 3 + 2] - az;
  const vx = c[r * 3] - ax, vy = c[r * 3 + 1] - ay, vz = c[r * 3 + 2] - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 0)) return;
  nx /= l; ny /= l; nz /= l;
  const a = mesh.vertex(ax, ay, az, nx, ny, nz);
  mesh.vertex(c[q * 3], c[q * 3 + 1], c[q * 3 + 2], nx, ny, nz);
  mesh.vertex(c[r * 3], c[r * 3 + 1], c[r * 3 + 2], nx, ny, nz);
  mesh.tri(a, a + 1, a + 2);
}

function insideRing(xy: number[], px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = xy.length - 2; i < xy.length; j = i, i += 2) {
    const yi = xy[i + 1], yj = xy[j + 1];
    if (yi > py !== yj > py && px < ((xy[j] - xy[i]) * (py - yi)) / (yj - yi) + xy[i]) inside = !inside;
  }
  return inside;
}

/**
 * Snapping ("magnet") of a picked point to a vertex or feature edge of one fragment, on the CPU
 * copy of the quantized geometry (GeometryStore) and the fragment's 3x4 matrix (FragmentList).
 *
 * Space: the fragment matrix maps geometry-local positions to the viewer's origin-relative space
 * (small numbers even for georeferenced scenes); all maths here is float64 in that space.
 *
 * The radius R is the magnet tolerance in world units at the hit depth. With a view direction the
 * magnet works in screen terms: distances are measured perpendicular to the view ray through P (so a
 * corner 10 px away on screen is 10 px away also on a face seen at a grazing angle), within a 3D
 * neighbourhood of GATHER * R around P; without one, plain 3D distances within R are used.
 *
 * 1. The neighbourhood sphere is mapped into the geometry's quantized u16 space as a conservative
 *    box (half-extent along local axis i = radius * |row i of M^-1|, so non-uniform scale, shear and
 *    mirroring are handled).
 * 2. Every triangle is tested against that box on its raw u16 coordinates (no decode, no
 *    allocation); a triangle whose box overlaps is transformed and kept when its exact distance to
 *    P is within the neighbourhood. Only these candidates are looked at further, so far-away parts of
 *    the same mesh are never chosen; points behind the plane of the hit face (as seen from the
 *    camera) are ignored, so the back side of a thin part does not attract either.
 * 3. Nearest candidate vertex within R wins. Otherwise the nearest point on a feature edge within R
 *    (the edge point closest to the view ray): edges are matched across candidate triangles by their
 *    quantized end points (exact keys, so non-indexed meshes work), an edge is a feature when it is a
 *    boundary (one triangle) or a crease (adjacent normals differ by more than the angle). Flat-quad
 *    diagonals and polygon fans are therefore not features. A "boundary" edge lying inside a
 *    coplanar neighbour (a T-junction of a non-conforming CAD tessellation) is not a feature either.
 *    Otherwise the surface point.
 *
 * Big geometries get a lazily built uniform grid of triangle ids (cached per geometry, bounded in
 * total memory), so step 2 only scans the cells the query box touches.
 */
import { FRAG_FLOATS, FRAG_MATRIX } from '../layout';
import type { FragmentList } from './FragmentList';
import type { GeometryStore } from './GeometryStore';

export const SNAP_SURFACE = 0;
export const SNAP_EDGE = 1;
export const SNAP_VERTEX = 2;

export interface SnapQuery {
  /** Snap to vertices / edges. */
  vertices: boolean;
  edges: boolean;
  /** cos of the crease angle: adjacent faces with a normal dot product below it form a feature edge. */
  cosAngle: number;
  /**
   * Unit vector from the hit point towards the camera (origin-relative space), or zero. When given,
   * vertices and edge points lying behind the plane of the hit face (as seen from the camera) by
   * more than a fraction of the radius are ignored: the back side of a thin part does not attract.
   */
  viewX: number;
  viewY: number;
  viewZ: number;
}

/** Tunables (exported for tests). */
export const snapConfig = {
  /** Triangles from which a geometry gets a spatial grid. */
  gridMinTriangles: 50000,
  /** Total memory budget of all cached grids (bytes); least recently used grids are dropped. */
  gridBudgetBytes: 64 << 20,
  /** Points behind the hit face plane by more than this fraction of the radius are hidden. */
  behindTolerance: 0.25,
  /**
   * With a view direction: candidates come from this many radii around the hit in 3D, so faces
   * seen at up to ~70 degrees from head-on keep the full screen-space tolerance.
   */
  gatherFactor: 3,
};

interface Grid {
  /** Cells per axis. */
  n: number;
  /** Cell size in q units per axis (65536 / n rounded up). */
  cell: number;
  /** cellStart[c] .. cellStart[c + 1] index into tris. */
  cellStart: Uint32Array;
  tris: Uint32Array;
  bytes: number;
  /** Store data identity: the grid is rebuilt when the slot was reused for another geometry. */
  chunk: Uint32Array;
  word: number;
  stamp: number;
}

export class Snapper {
  /** Candidate triangles of the last query (diagnostics). */
  lastCandidates = 0;
  /** Triangles scanned by the last query (diagnostics). */
  lastScanned = 0;

  private readonly geoms: GeometryStore;
  private readonly frags: FragmentList;

  // candidate triangles: world vertices (9), quantized keys (6: w0, qz per corner), unit normal (3)
  private cv = new Float64Array(9 * 64);
  private ck = new Uint32Array(6 * 64);
  private cn = new Float64Array(3 * 64);
  /** squared distance of each candidate to P */
  private cd = new Float64Array(64);
  private nc = 0;
  // plane of the hit face, oriented towards the camera (n . x >= hd: in front); hn = 0: no filter
  private hnx = 0;
  private hny = 0;
  private hnz = 0;
  private hd = 0;
  // unit view direction (towards the camera) of the current query, or zero
  private vx = 0;
  private vy = 0;
  private vz = 0;

  // edge table (open addressing over the candidate edges)
  private ekey = new Uint32Array(4 * 256);
  private enrm = new Float64Array(3 * 256);
  private ecount = new Int32Array(256);
  private eflags = new Uint8Array(256);
  private etri = new Int32Array(256);
  private ecorner = new Int8Array(256);
  private ed2 = new Float64Array(256);
  private ne = 0;
  private hash = new Int32Array(512);

  private readonly grids = new Map<number, Grid>();
  private gridBytes = 0;
  private stamp = 0;

  constructor(geoms: GeometryStore, frags: FragmentList) {
    this.geoms = geoms;
    this.frags = frags;
  }

  /** Drops all cached grids (e.g. after a scene clear). */
  clearCache(): void {
    this.grids.clear();
    this.gridBytes = 0;
  }

  /**
   * Snaps the origin-relative point (px, py, pz) on fragment `frag` within radius `r`. Writes the
   * result point to out[0..2] and, for an edge, its end points to out[3..8]. Returns SNAP_*.
   */
  snap(frag: number, px: number, py: number, pz: number, r: number, q: SnapQuery, out: Float64Array): number {
    out[0] = px;
    out[1] = py;
    out[2] = pz;
    this.nc = 0;
    this.lastCandidates = 0;
    this.lastScanned = 0;
    const fr = this.frags;
    if (!fr.isAlive(frag) || !(r > 0) || (!q.vertices && !q.edges)) return SNAP_SURFACE;
    const g = fr.geometry[frag];
    const gs = this.geoms;
    if (!gs.isAlive(g)) return SNAP_SURFACE;

    // --- matrix (rows [a b c | t]) and its 3x3 inverse
    const rec = fr.records;
    const o = frag * FRAG_FLOATS + FRAG_MATRIX;
    const m00 = rec[o], m01 = rec[o + 1], m02 = rec[o + 2], tx = rec[o + 3];
    const m10 = rec[o + 4], m11 = rec[o + 5], m12 = rec[o + 6], ty = rec[o + 7];
    const m20 = rec[o + 8], m21 = rec[o + 9], m22 = rec[o + 10], tz = rec[o + 11];
    const c00 = m11 * m22 - m12 * m21, c01 = m12 * m20 - m10 * m22, c02 = m10 * m21 - m11 * m20;
    const det = m00 * c00 + m01 * c01 + m02 * c02;
    if (!(Math.abs(det) > 1e-300)) return SNAP_SURFACE;
    const id = 1 / det;
    // inverse rows
    const i00 = c00 * id, i01 = (m02 * m21 - m01 * m22) * id, i02 = (m01 * m12 - m02 * m11) * id;
    const i10 = c01 * id, i11 = (m00 * m22 - m02 * m20) * id, i12 = (m02 * m10 - m00 * m12) * id;
    const i20 = c02 * id, i21 = (m01 * m20 - m00 * m21) * id, i22 = (m00 * m11 - m01 * m10) * id;
    const dx = px - tx, dy = py - ty, dz = pz - tz;
    const lx = i00 * dx + i01 * dy + i02 * dz;
    const ly = i10 * dx + i11 * dy + i12 * dz;
    const lz = i20 * dx + i21 * dy + i22 * dz;
    this.vx = q.viewX;
    this.vy = q.viewY;
    this.vz = q.viewZ;
    const hasView = q.viewX !== 0 || q.viewY !== 0 || q.viewZ !== 0;
    const rg = hasView ? r * snapConfig.gatherFactor : r; // neighbourhood radius
    const rg2 = rg * rg;
    const rr = rg * 1.0001;
    const ex = rr * Math.sqrt(i00 * i00 + i01 * i01 + i02 * i02);
    const ey = rr * Math.sqrt(i10 * i10 + i11 * i11 + i12 * i12);
    const ez = rr * Math.sqrt(i20 * i20 + i21 * i21 + i22 * i22);

    // --- query box in quantized space
    const dq = gs.dequant;
    const d6 = g * 6;
    const sx = dq[d6], sy = dq[d6 + 1], sz = dq[d6 + 2];
    const ox = dq[d6 + 3], oy = dq[d6 + 4], oz = dq[d6 + 5];
    const bx = qRange(lx, ex, sx, ox), by = qRange(ly, ey, sy, oy), bz = qRange(lz, ez, sz, oz);
    if (bx < 0 || by < 0 || bz < 0) return SNAP_SURFACE;
    const qx0 = bx & 0xffff, qx1 = bx >>> 16;
    const qy0 = by & 0xffff, qy1 = by >>> 16;
    const qz0 = bz & 0xffff, qz1 = bz >>> 16;

    // --- candidate triangles
    const chunk = gs.chunk(g);
    const vw = gs.vertexWord(g);
    const iw = gs.indexWord(g);
    const triCount = gs.indexCount[g] / 3;
    const k65 = 1 / 65535;
    const fx = sx * k65, fy = sy * k65, fz = sz * k65;
    const r2c = rr * rr;
    const grid = triCount >= snapConfig.gridMinTriangles ? this.gridOf(g, chunk, vw, iw, triCount) : null;

    const test = (t: number): void => {
      const ia = iw + t * 3;
      const a = vw + chunk[ia] * 2, b = vw + chunk[ia + 1] * 2, c = vw + chunk[ia + 2] * 2;
      const wa = chunk[a], wb = chunk[b], wc = chunk[c];
      let p = wa & 0xffff, s = wb & 0xffff, u = wc & 0xffff;
      if ((p < qx0 && s < qx0 && u < qx0) || (p > qx1 && s > qx1 && u > qx1)) return;
      p = wa >>> 16; s = wb >>> 16; u = wc >>> 16;
      if ((p < qy0 && s < qy0 && u < qy0) || (p > qy1 && s > qy1 && u > qy1)) return;
      const za = chunk[a + 1] & 0xffff, zb = chunk[b + 1] & 0xffff, zc = chunk[c + 1] & 0xffff;
      if ((za < qz0 && zb < qz0 && zc < qz0) || (za > qz1 && zb > qz1 && zc > qz1)) return;
      // world (origin-relative) corners
      let X = (wa & 0xffff) * fx + ox, Y = (wa >>> 16) * fy + oy, Z = za * fz + oz;
      const ax = m00 * X + m01 * Y + m02 * Z + tx, ay = m10 * X + m11 * Y + m12 * Z + ty, az = m20 * X + m21 * Y + m22 * Z + tz;
      X = (wb & 0xffff) * fx + ox; Y = (wb >>> 16) * fy + oy; Z = zb * fz + oz;
      const bx_ = m00 * X + m01 * Y + m02 * Z + tx, by_ = m10 * X + m11 * Y + m12 * Z + ty, bz_ = m20 * X + m21 * Y + m22 * Z + tz;
      X = (wc & 0xffff) * fx + ox; Y = (wc >>> 16) * fy + oy; Z = zc * fz + oz;
      const cx = m00 * X + m01 * Y + m02 * Z + tx, cy = m10 * X + m11 * Y + m12 * Z + ty, cz = m20 * X + m21 * Y + m22 * Z + tz;
      // unit normal; degenerate triangles carry no surface and are skipped
      const e1x = bx_ - ax, e1y = by_ - ay, e1z = bz_ - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(nl > 0)) return;
      const td2 = pointTriangleDist2(px, py, pz, ax, ay, az, bx_, by_, bz_, cx, cy, cz);
      if (td2 > r2c) return;
      nx /= nl; ny /= nl; nz /= nl;
      const n = this.pushCandidate();
      this.cd[n] = td2;
      const v = this.cv, k = this.ck, nn = this.cn;
      const v9 = n * 9;
      v[v9] = ax; v[v9 + 1] = ay; v[v9 + 2] = az;
      v[v9 + 3] = bx_; v[v9 + 4] = by_; v[v9 + 5] = bz_;
      v[v9 + 6] = cx; v[v9 + 7] = cy; v[v9 + 8] = cz;
      const k6 = n * 6;
      k[k6] = wa; k[k6 + 1] = za; k[k6 + 2] = wb; k[k6 + 3] = zb; k[k6 + 4] = wc; k[k6 + 5] = zc;
      nn[n * 3] = nx; nn[n * 3 + 1] = ny; nn[n * 3 + 2] = nz;
    };

    if (grid) {
      const cs = grid.cell, gn = grid.n;
      const cx0 = (qx0 / cs) | 0, cx1 = Math.min(gn - 1, (qx1 / cs) | 0);
      const cy0 = (qy0 / cs) | 0, cy1 = Math.min(gn - 1, (qy1 / cs) | 0);
      const cz0 = (qz0 / cs) | 0, cz1 = Math.min(gn - 1, (qz1 / cs) | 0);
      const start = grid.cellStart, tris = grid.tris;
      // a triangle is listed in every cell its box touches: visit each once (stamp per query)
      const seen = this.seenFor(triCount);
      const mark = ++this.seenStamp;
      let scanned = 0;
      for (let z = cz0; z <= cz1; z++) {
        for (let y = cy0; y <= cy1; y++) {
          for (let x = cx0; x <= cx1; x++) {
            const c = (z * gn + y) * gn + x;
            for (let j = start[c], e = start[c + 1]; j < e; j++) {
              const t = tris[j];
              if (seen[t] === mark) continue;
              seen[t] = mark;
              scanned++;
              test(t);
            }
          }
        }
      }
      this.lastScanned = scanned;
    } else {
      for (let t = 0; t < triCount; t++) test(t);
      this.lastScanned = triCount;
    }
    const nc = this.nc;
    this.lastCandidates = nc;
    if (nc === 0) return SNAP_SURFACE;
    const r2 = r * r;
    const cv = this.cv;
    this.setHitPlane(px, py, pz, r, q);

    // --- nearest vertex (distance perpendicular to the view ray)
    if (q.vertices) {
      let best = r2;
      let bi = -1;
      const vx = this.vx, vy = this.vy, vz = this.vz;
      for (let i = 0; i < nc * 3; i++) {
        const e = i * 3;
        const ddx = cv[e] - px, ddy = cv[e + 1] - py, ddz = cv[e + 2] - pz;
        const w2 = ddx * ddx + ddy * ddy + ddz * ddz;
        const wv = ddx * vx + ddy * vy + ddz * vz;
        const d2 = w2 - wv * wv;
        if (d2 <= best && w2 <= rg2 && this.inFront(cv[e], cv[e + 1], cv[e + 2])) {
          best = d2;
          bi = e;
        }
      }
      if (bi >= 0) {
        out[0] = cv[bi];
        out[1] = cv[bi + 1];
        out[2] = cv[bi + 2];
        return SNAP_VERTEX;
      }
    }

    // --- nearest feature edge
    if (q.edges && this.buildEdges(px, py, pz, r2, rg2, q.cosAngle)) {
      const ne = this.ne;
      const tmp = this.tmp;
      const hasPlane = this.hnx !== 0 || this.hny !== 0 || this.hnz !== 0;
      // hidden edge points are no features
      if (hasPlane) {
        for (let e = 0; e < ne; e++) {
          if (this.eflags[e] === 0) continue;
          const t9 = this.etri[e] * 9, k = this.ecorner[e];
          this.closestToRay(px, py, pz, cv, t9 + k * 3, t9 + ((k + 1) % 3) * 3, tmp);
          if (!this.inFront(tmp[0], tmp[1], tmp[2])) this.eflags[e] = 0;
        }
      }
      // nearest feature first; a boundary candidate is verified (T-junction check, O(candidates))
      // only when it is the nearest remaining one, so the check runs for few edges
      for (;;) {
        let best = Infinity;
        let be = -1;
        for (let e = 0; e < ne; e++) {
          if (this.eflags[e] !== 0 && this.ed2[e] < best) {
            best = this.ed2[e];
            be = e;
          }
        }
        if (be < 0) break;
        if (this.ecount[be] === 1 && this.insideCoplanar(be, px, py, pz, r2, q.cosAngle)) {
          this.eflags[be] = 0;
          continue;
        }
        const t9 = this.etri[be] * 9;
        const k = this.ecorner[be];
        const a = t9 + k * 3, b = t9 + ((k + 1) % 3) * 3;
        this.closestToRay(px, py, pz, cv, a, b, out);
        for (let j = 0; j < 3; j++) {
          out[3 + j] = cv[a + j];
          out[6 + j] = cv[b + j];
        }
        return SNAP_EDGE;
      }
    }
    return SNAP_SURFACE;
  }

  // ---------------------------------------------------------------------------------------------

  /** Plane of the candidate nearest to P (the hit face), facing the camera; none without a view. */
  private setHitPlane(px: number, py: number, pz: number, r: number, q: SnapQuery): void {
    this.hnx = this.hny = this.hnz = 0;
    if (q.viewX === 0 && q.viewY === 0 && q.viewZ === 0) return;
    let best = Infinity;
    let h = -1;
    for (let i = 0; i < this.nc; i++) {
      if (this.cd[i] < best) {
        best = this.cd[i];
        h = i;
      }
    }
    if (h < 0) return;
    const cn = this.cn;
    let nx = cn[h * 3], ny = cn[h * 3 + 1], nz = cn[h * 3 + 2];
    if (nx * q.viewX + ny * q.viewY + nz * q.viewZ < 0) {
      nx = -nx; ny = -ny; nz = -nz;
    }
    this.hnx = nx;
    this.hny = ny;
    this.hnz = nz;
    this.hd = nx * px + ny * py + nz * pz - snapConfig.behindTolerance * r;
  }

  /**
   * The point of segment cv[a..a+2] - cv[b..b+2] closest to the view ray through P (to P itself
   * without a view direction) into out[0..2]; returns its squared distance to the ray.
   */
  private closestToRay(px: number, py: number, pz: number, cv: Float64Array, a: number, b: number, out: Float64Array): number {
    const vx = this.vx, vy = this.vy, vz = this.vz;
    // end points relative to P, with the component along the ray removed
    let ax = cv[a] - px, ay = cv[a + 1] - py, az = cv[a + 2] - pz;
    let bx = cv[b] - px, by = cv[b + 1] - py, bz = cv[b + 2] - pz;
    const av = ax * vx + ay * vy + az * vz, bv = bx * vx + by * vy + bz * vz;
    ax -= av * vx; ay -= av * vy; az -= av * vz;
    bx -= bv * vx; by -= bv * vy; bz -= bv * vz;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const l2 = dx * dx + dy * dy + dz * dz;
    let t = l2 > 0 ? -(ax * dx + ay * dy + az * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out[0] = cv[a] + (cv[b] - cv[a]) * t;
    out[1] = cv[a + 1] + (cv[b + 1] - cv[a + 1]) * t;
    out[2] = cv[a + 2] + (cv[b + 2] - cv[a + 2]) * t;
    const ex = ax + dx * t, ey = ay + dy * t, ez = az + dz * t;
    return ex * ex + ey * ey + ez * ez;
  }

  private inFront(x: number, y: number, z: number): boolean {
    return this.hnx * x + this.hny * y + this.hnz * z >= this.hd;
  }

  private pushCandidate(): number {
    const n = this.nc++;
    if (n * 9 + 9 > this.cv.length) {
      const cap = this.cv.length / 9 * 2;
      const d = new Float64Array(cap); d.set(this.cd); this.cd = d;
      const v = new Float64Array(cap * 9); v.set(this.cv); this.cv = v;
      const k = new Uint32Array(cap * 6); k.set(this.ck); this.ck = k;
      const nn = new Float64Array(cap * 3); nn.set(this.cn); this.cn = nn;
    }
    return n;
  }

  /**
   * Fills the edge table with the candidate edges within sqrt(r2) of P (matched by quantized end
   * points) and flags features. Returns true when any feature edge exists.
   */
  private buildEdges(px: number, py: number, pz: number, r2: number, rg2: number, cosA: number): boolean {
    const nc = this.nc;
    this.ensureEdges(nc * 3);
    const hash = this.hash;
    hash.fill(-1);
    const mask = hash.length - 1;
    const cv = this.cv, ck = this.ck, cn = this.cn;
    const tmp = this.tmp;
    let ne = 0;
    for (let t = 0; t < nc; t++) {
      const t9 = t * 9, t6 = t * 6;
      for (let k = 0; k < 3; k++) {
        const k1 = (k + 1) % 3;
        const a = t9 + k * 3, b = t9 + k1 * 3;
        const d2 = this.closestToRay(px, py, pz, cv, a, b, tmp);
        if (d2 > r2) continue;
        // the edge point must lie in the neighbourhood, so every face sharing it is a candidate
        const ddx = tmp[0] - px, ddy = tmp[1] - py, ddz = tmp[2] - pz;
        if (ddx * ddx + ddy * ddy + ddz * ddz > rg2 * 0.999) continue;
        // ordered key: (w0, qz) of both ends, smaller first
        let aw = ck[t6 + k * 2], az = ck[t6 + k * 2 + 1], bw = ck[t6 + k1 * 2], bz = ck[t6 + k1 * 2 + 1];
        if (aw > bw || (aw === bw && az > bz)) {
          const w = aw; aw = bw; bw = w;
          const z = az; az = bz; bz = z;
        }
        if (aw === bw && az === bz) continue; // collapsed by quantization
        let h = (Math.imul(aw, 0x9e3779b1) ^ Math.imul(bw + az * 65537, 0x85ebca6b) ^ Math.imul(bz + 1, 0xc2b2ae35)) >>> 0;
        let e = -1;
        for (;;) {
          const slot = h & mask;
          const i = hash[slot];
          if (i < 0) {
            e = ne++;
            hash[slot] = e;
            const e4 = e * 4;
            this.ekey[e4] = aw; this.ekey[e4 + 1] = az; this.ekey[e4 + 2] = bw; this.ekey[e4 + 3] = bz;
            this.ecount[e] = 0;
            this.eflags[e] = 0;
            this.etri[e] = t;
            this.ecorner[e] = k;
            this.ed2[e] = d2;
            this.enrm[e * 3] = cn[t * 3]; this.enrm[e * 3 + 1] = cn[t * 3 + 1]; this.enrm[e * 3 + 2] = cn[t * 3 + 2];
            break;
          }
          const i4 = i * 4;
          if (this.ekey[i4] === aw && this.ekey[i4 + 1] === az && this.ekey[i4 + 2] === bw && this.ekey[i4 + 3] === bz) {
            e = i;
            break;
          }
          h++;
        }
        const c = ++this.ecount[e];
        if (c >= 2) {
          const dot =
            this.enrm[e * 3] * cn[t * 3] + this.enrm[e * 3 + 1] * cn[t * 3 + 1] + this.enrm[e * 3 + 2] * cn[t * 3 + 2];
          // bit 1: normals differ by more than the angle (signed: also catches fins / opposite faces)
          // bit 2: they differ by more than the angle even up to sign
          if (dot < cosA) this.eflags[e] |= 1;
          if (Math.abs(dot) < cosA) this.eflags[e] |= 2;
        }
      }
    }
    this.ne = ne;
    // Feature: a boundary (one face); two faces forming a crease; with more than two faces
    // (duplicated back faces of exports, non-manifold edges) normals are compared up to sign, so a
    // flat double-sided sheet is not all creases.
    let any = false;
    for (let e = 0; e < ne; e++) {
      const c = this.ecount[e];
      const f = this.eflags[e];
      const feature = c === 1 || (c === 2 ? (f & 1) !== 0 : (f & 2) !== 0);
      this.eflags[e] = feature ? 1 : 0;
      if (feature) any = true;
    }
    return any;
  }

  /**
   * A single-face edge whose closest point lies inside another candidate face of (nearly) the same
   * plane: an interior edge of a non-conforming tessellation, not a boundary.
   */
  private insideCoplanar(e: number, px: number, py: number, pz: number, r2: number, cosA: number): boolean {
    const cv = this.cv, cn = this.cn;
    const t = this.etri[e];
    const k = this.ecorner[e];
    const t9 = t * 9;
    const a = t9 + k * 3, b = t9 + ((k + 1) % 3) * 3;
    // the edge point nearest to the view ray: a face containing it is in the neighbourhood, hence
    // a candidate (see buildEdges)
    const q = this.tmp;
    this.closestToRay(px, py, pz, cv, a, b, q);
    const qx = q[0], qy = q[1], qz = q[2];
    const eps2 = r2 * 1e-6; // R / 1000: well above quantization noise at any useful zoom
    const nx = cn[t * 3], ny = cn[t * 3 + 1], nz = cn[t * 3 + 2];
    for (let o = 0; o < this.nc; o++) {
      if (o === t) continue;
      const dot = nx * cn[o * 3] + ny * cn[o * 3 + 1] + nz * cn[o * 3 + 2];
      if (Math.abs(dot) < cosA) continue;
      const o9 = o * 9;
      if (
        pointTriangleDist2(qx, qy, qz, cv[o9], cv[o9 + 1], cv[o9 + 2], cv[o9 + 3], cv[o9 + 4], cv[o9 + 5], cv[o9 + 6], cv[o9 + 7], cv[o9 + 8]) <=
        eps2
      ) {
        return true;
      }
    }
    return false;
  }

  private readonly tmp = new Float64Array(3);

  private ensureEdges(n: number): void {
    if (this.ecount.length < n) {
      let cap = this.ecount.length;
      while (cap < n) cap *= 2;
      this.ekey = new Uint32Array(cap * 4);
      this.enrm = new Float64Array(cap * 3);
      this.ecount = new Int32Array(cap);
      this.eflags = new Uint8Array(cap);
      this.etri = new Int32Array(cap);
      this.ecorner = new Int8Array(cap);
      this.ed2 = new Float64Array(cap);
    }
    if (this.hash.length < n * 2) {
      let cap = this.hash.length;
      while (cap < n * 2) cap *= 2;
      this.hash = new Int32Array(cap);
    }
  }

  // --- grid -------------------------------------------------------------------------------------

  private seen = new Uint32Array(0);
  private seenStamp = 0;

  private seenFor(n: number): Uint32Array {
    if (this.seen.length < n) {
      this.seen = new Uint32Array(n);
      this.seenStamp = 0;
    }
    if (this.seenStamp >= 0xfffffff0) {
      this.seen.fill(0);
      this.seenStamp = 0;
    }
    return this.seen;
  }

  private gridOf(g: number, chunk: Uint32Array, vw: number, iw: number, triCount: number): Grid {
    let grid = this.grids.get(g);
    if (grid && (grid.chunk !== chunk || grid.word !== vw)) {
      this.grids.delete(g);
      this.gridBytes -= grid.bytes;
      grid = undefined;
    }
    if (!grid) {
      grid = buildGrid(chunk, vw, iw, triCount);
      this.grids.set(g, grid);
      this.gridBytes += grid.bytes;
      // evict least recently used grids over the budget (never the one just built)
      while (this.gridBytes > snapConfig.gridBudgetBytes && this.grids.size > 1) {
        let oldest = -1;
        let os = Infinity;
        for (const [k, v] of this.grids) {
          if (v !== grid && v.stamp < os) {
            os = v.stamp;
            oldest = k;
          }
        }
        if (oldest < 0) break;
        this.gridBytes -= this.grids.get(oldest)!.bytes;
        this.grids.delete(oldest);
      }
    }
    grid.stamp = ++this.stamp;
    return grid;
  }

  /** Bytes held by cached grids (diagnostics). */
  get cacheBytes(): number {
    return this.gridBytes;
  }
}

/** Uniform grid over the quantized cube, ~4 triangles per occupied cell on average. */
function buildGrid(chunk: Uint32Array, vw: number, iw: number, triCount: number): Grid {
  const n = Math.max(4, Math.min(128, Math.round(Math.cbrt(triCount / 4))));
  const cell = Math.ceil(65536 / n);
  const cells = n * n * n;
  const counts = new Uint32Array(cells + 1);
  const box = (t: number, out: Int32Array): void => {
    const ia = iw + t * 3;
    const a = vw + chunk[ia] * 2, b = vw + chunk[ia + 1] * 2, c = vw + chunk[ia + 2] * 2;
    const wa = chunk[a], wb = chunk[b], wc = chunk[c];
    const xa = wa & 0xffff, xb = wb & 0xffff, xc = wc & 0xffff;
    const ya = wa >>> 16, yb = wb >>> 16, yc = wc >>> 16;
    const za = chunk[a + 1] & 0xffff, zb = chunk[b + 1] & 0xffff, zc = chunk[c + 1] & 0xffff;
    out[0] = (Math.min(xa, xb, xc) / cell) | 0;
    out[1] = (Math.max(xa, xb, xc) / cell) | 0;
    out[2] = (Math.min(ya, yb, yc) / cell) | 0;
    out[3] = (Math.max(ya, yb, yc) / cell) | 0;
    out[4] = (Math.min(za, zb, zc) / cell) | 0;
    out[5] = (Math.max(za, zb, zc) / cell) | 0;
  };
  const bb = new Int32Array(6);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    box(t, bb);
    for (let z = bb[4]; z <= bb[5]; z++)
      for (let y = bb[2]; y <= bb[3]; y++)
        for (let x = bb[0]; x <= bb[1]; x++) {
          counts[(z * n + y) * n + x]++;
          total++;
        }
  }
  const start = new Uint32Array(cells + 1);
  for (let c = 0; c < cells; c++) start[c + 1] = start[c] + counts[c];
  const fill = counts; // reuse as write cursors
  fill.set(start.subarray(0, cells));
  const tris = new Uint32Array(total);
  for (let t = 0; t < triCount; t++) {
    box(t, bb);
    for (let z = bb[4]; z <= bb[5]; z++)
      for (let y = bb[2]; y <= bb[3]; y++)
        for (let x = bb[0]; x <= bb[1]; x++) tris[fill[(z * n + y) * n + x]++] = t;
  }
  return { n, cell, cellStart: start, tris, bytes: start.byteLength + tris.byteLength, chunk, word: vw, stamp: 0 };
}

/**
 * Quantized range [q0, q1] (packed q0 | q1 << 16) of local coordinate interval l +- e for an axis
 * with dequant scale s and offset o; -1 when empty.
 */
function qRange(l: number, e: number, s: number, o: number): number {
  if (!(s > 0)) return Math.abs(l - o) <= e + 1e-7 * (Math.abs(o) + Math.abs(l)) ? 0 : -1;
  const k = 65535 / s;
  let q0 = Math.floor((l - e - o) * k) - 1;
  let q1 = Math.ceil((l + e - o) * k) + 1;
  if (q1 < 0 || q0 > 65535) return -1;
  if (q0 < 0) q0 = 0;
  if (q1 > 65535) q1 = 65535;
  return (q0 | (q1 << 16)) >>> 0;
}

/** Squared distance from P to triangle ABC (Ericson, Real-Time Collision Detection 5.1.5). */
export function pointTriangleDist2(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax; qy = ay; qz = az;
  } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
      qx = bx; qy = by; qz = bz;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) {
          qx = cx; qy = cy; qz = cz;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w;
            } else {
              const den = 1 / (va + vb + vc);
              const v = vb * den, w = vc * den;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

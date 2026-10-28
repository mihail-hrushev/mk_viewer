/**
 * Growable indexed triangle mesh with per-vertex normals, in float64 while it is being built.
 * Solid builders write in their own local frame and call `transformFrom` to move what they added
 * into the caller's frame, so nested placements never allocate intermediate meshes.
 */
import { ringArea, triangulate } from './triangulate';

export class TriMesh {
  pos = new Float64Array(3 * 256);
  nrm = new Float64Array(3 * 256);
  idx = new Uint32Array(3 * 256);
  /** Vertex count. */
  nv = 0;
  /** Index count (3 per triangle). */
  ni = 0;

  reset(): this {
    this.nv = this.ni = 0;
    return this;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    const k = this.nv++;
    if (this.nv * 3 > this.pos.length) {
      const cap = this.pos.length * 2;
      const p = new Float64Array(cap);
      p.set(this.pos);
      this.pos = p;
      const n = new Float64Array(cap);
      n.set(this.nrm);
      this.nrm = n;
    }
    const o = k * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.nrm[o] = nx;
    this.nrm[o + 1] = ny;
    this.nrm[o + 2] = nz;
    return k;
  }

  tri(a: number, b: number, c: number): void {
    if (this.ni + 3 > this.idx.length) {
      const i = new Uint32Array(this.idx.length * 2);
      i.set(this.idx);
      this.idx = i;
    }
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = b;
    this.idx[this.ni++] = c;
  }

  /**
   * Applies the affine column-major matrix `m` to the vertices from `v0` and the triangles from
   * `i0` on: positions by `m`, normals by its inverse transpose; a mirroring matrix also flips the
   * triangles so they stay front facing.
   */
  transformFrom(v0: number, i0: number, m: ArrayLike<number> | null): void {
    if (!m) return;
    const p = this.pos, n = this.nrm;
    const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], k = m[10];
    // inverse transpose of the 3x3 part (cofactor matrix; the determinant's magnitude is irrelevant)
    const c00 = e * k - f * h, c01 = f * g - d * k, c02 = d * h - e * g;
    const c10 = c * h - b * k, c11 = a * k - c * g, c12 = b * g - a * h;
    const c20 = b * f - c * e, c21 = c * d - a * f, c22 = a * e - b * d;
    const det = a * c00 + b * c01 + c * c02;
    const s = det < 0 ? -1 : 1;
    for (let v = v0 * 3, end = this.nv * 3; v < end; v += 3) {
      const x = p[v], y = p[v + 1], z = p[v + 2];
      p[v] = a * x + d * y + g * z + m[12];
      p[v + 1] = b * x + e * y + h * z + m[13];
      p[v + 2] = c * x + f * y + k * z + m[14];
      const nx = n[v], ny = n[v + 1], nz = n[v + 2];
      const tx = (c00 * nx + c10 * ny + c20 * nz) * s;
      const ty = (c01 * nx + c11 * ny + c21 * nz) * s;
      const tz = (c02 * nx + c12 * ny + c22 * nz) * s;
      const l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      n[v] = tx / l;
      n[v + 1] = ty / l;
      n[v + 2] = tz / l;
    }
    if (det < 0) {
      const idx = this.idx;
      for (let i = i0; i < this.ni; i += 3) {
        const t = idx[i + 1];
        idx[i + 1] = idx[i + 2];
        idx[i + 2] = t;
      }
    }
  }

  /** Appends all of `src`. */
  append(src: TriMesh): void {
    const base = this.nv;
    for (let v = 0; v < src.nv; v++) {
      const o = v * 3;
      this.vertex(src.pos[o], src.pos[o + 1], src.pos[o + 2], src.nrm[o], src.nrm[o + 1], src.nrm[o + 2]);
    }
    for (let i = 0; i < src.ni; i += 3) this.tri(base + src.idx[i], base + src.idx[i + 1], base + src.idx[i + 2]);
  }

  /** [minx, miny, minz, maxx, maxy, maxz] of the vertices, or null when empty. */
  bounds(): Float64Array | null {
    if (!this.nv) return null;
    const b = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    const p = this.pos;
    for (let v = 0; v < this.nv * 3; v += 3) {
      for (let k = 0; k < 3; k++) {
        const c = p[v + k];
        if (c < b[k]) b[k] = c;
        if (c > b[k + 3]) b[k + 3] = c;
      }
    }
    return b;
  }

  /**
   * Adds a planar polygon with holes. `loops` are rings of x, y, z (the first is the outer one);
   * the polygon gets the flat normal (nx, ny, nz), or its Newell normal when that is omitted.
   * Returns false for degenerate polygons.
   */
  polygon(loops: ArrayLike<number>[], nx = 0, ny = 0, nz = 0): boolean {
    const outer = loops[0];
    const n0 = outer.length / 3;
    if (n0 < 3) return false;
    if (nx === 0 && ny === 0 && nz === 0) {
      for (let i = 0, j = n0 - 1; i < n0; j = i++) {
        const xi = outer[i * 3], yi = outer[i * 3 + 1], zi = outer[i * 3 + 2];
        const xj = outer[j * 3], yj = outer[j * 3 + 1], zj = outer[j * 3 + 2];
        nx += (yj - yi) * (zj + zi);
        ny += (zj - zi) * (xj + xi);
        nz += (xj - xi) * (yj + yi);
      }
    }
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(l > 0)) return false;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.nv;
    if (loops.length === 1 && n0 === 3) {
      for (let i = 0; i < 9; i += 3) this.vertex(outer[i], outer[i + 1], outer[i + 2], nx, ny, nz);
      this.orientedTri(base, base + 1, base + 2, nx, ny, nz);
      return true;
    }
    // project onto the plane: drop the dominant axis
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const u = ax >= ay && ax >= az ? 1 : 0;
    const w = ax >= ay && ax >= az ? 2 : ay >= az ? 2 : 1;
    let total = 0;
    for (const r of loops) total += r.length / 3;
    const xy = new Float64Array(total * 2);
    const holes: number[] = [];
    let k = 0;
    for (let r = 0; r < loops.length; r++) {
      const ring = loops[r];
      if (r > 0) holes.push(k);
      for (let i = 0; i < ring.length; i += 3) {
        this.vertex(ring[i], ring[i + 1], ring[i + 2], nx, ny, nz);
        xy[k * 2] = ring[i + u];
        xy[k * 2 + 1] = ring[i + w];
        k++;
      }
    }
    const tris = triangulate(xy, holes.length ? holes : null, scratchTris);
    for (let i = 0; i < tris.length; i += 3) this.orientedTri(base + tris[i], base + tris[i + 1], base + tris[i + 2], nx, ny, nz);
    tris.length = 0;
    return true;
  }

  /** Adds triangle (a, b, c), flipped when its geometric normal opposes (nx, ny, nz). */
  orientedTri(a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const d = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    if (d < 0) this.tri(a, c, b);
    else this.tri(a, b, c);
  }

  /**
   * Removes the part on the positive side of the plane n·p = d (n unit length). Where the cut edges
   * form closed loops, the cut is closed with cap faces (normal n) added to `capInto` (default
   * this mesh; null for no caps). Faces lying in the plane are kept when they face the removed
   * side, so two clips with opposite planes split a solid's boundary without duplicates. Returns
   * this mesh (rebuilt in place); `tmp` is scratch.
   */
  clip(nx: number, ny: number, nz: number, d: number, tmp: TriMesh, capInto: TriMesh | null = this): TriMesh {
    const src = this.pos, sn = this.nrm, idx = this.idx;
    const nv = this.nv;
    const dist = new Float64Array(nv);
    let maxAbs = 0;
    for (let v = 0; v < nv; v++) {
      dist[v] = src[v * 3] * nx + src[v * 3 + 1] * ny + src[v * 3 + 2] * nz - d;
      maxAbs = Math.max(maxAbs, Math.abs(src[v * 3]), Math.abs(src[v * 3 + 1]), Math.abs(src[v * 3 + 2]));
    }
    const eps = 1e-9 * Math.max(1, maxAbs, Math.abs(d));
    let anyPos = false;
    for (let v = 0; v < nv; v++) {
      if (Math.abs(dist[v]) < eps) dist[v] = 0;
      else if (dist[v] > 0) anyPos = true;
    }
    if (!anyPos) return this; // nothing on the removed side

    const out = tmp.reset();
    const segs: number[] = []; // cut segments, 6 numbers each
    const remap = new Int32Array(nv).fill(-1);
    const keep = (v: number) => {
      if (remap[v] < 0) remap[v] = out.vertex(src[v * 3], src[v * 3 + 1], src[v * 3 + 2], sn[v * 3], sn[v * 3 + 1], sn[v * 3 + 2]);
      return remap[v];
    };
    const cut = (a: number, b: number) => {
      const t = dist[a] / (dist[a] - dist[b]);
      const o = a * 3, q = b * 3;
      const x = src[o] + (src[q] - src[o]) * t, y = src[o + 1] + (src[q + 1] - src[o + 1]) * t, z = src[o + 2] + (src[q + 2] - src[o + 2]) * t;
      segs.push(x, y, z);
      return out.vertex(x, y, z, sn[o] + (sn[q] - sn[o]) * t, sn[o + 1] + (sn[q + 1] - sn[o + 1]) * t, sn[o + 2] + (sn[q + 2] - sn[o + 2]) * t);
    };
    const tri: number[] = [];
    for (let i = 0; i < this.ni; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      const da = dist[a], db = dist[b], dc = dist[c];
      if (da <= 0 && db <= 0 && dc <= 0) {
        if (da === 0 && db === 0 && dc === 0 && facing(src, a, b, c, nx, ny, nz) <= 0) continue;
        out.tri(keep(a), keep(b), keep(c));
        continue;
      }
      if (da >= 0 && db >= 0 && dc >= 0) {
        // an edge lying in the plane still bounds the cut
        if ((da === 0 ? 1 : 0) + (db === 0 ? 1 : 0) + (dc === 0 ? 1 : 0) === 2) {
          for (const v of [a, b, c]) if (dist[v] === 0) segs.push(src[v * 3], src[v * 3 + 1], src[v * 3 + 2]);
        }
        continue;
      }
      // walk the edges: kept corners and crossing points form a convex polygon
      tri.length = 0;
      const vs = [a, b, c];
      const ds = [da, db, dc];
      const segStart = segs.length;
      for (let k = 0; k < 3; k++) {
        const p = vs[k], q = vs[(k + 1) % 3];
        const dp = ds[k], dq = ds[(k + 1) % 3];
        if (dp <= 0) tri.push(keep(p));
        if (dp === 0) segs.push(src[p * 3], src[p * 3 + 1], src[p * 3 + 2]);
        if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) tri.push(dp < 0 ? cut(p, q) : cut(q, p));
      }
      // exactly two points on the plane per crossing triangle make one cap segment
      if (segs.length - segStart !== 6) segs.length = segStart;
      for (let k = 1; k + 1 < tri.length; k++) out.tri(tri[0], tri[k], tri[k + 1]);
    }
    this.swap(out);
    if (capInto) this.cap(segs, nx, ny, nz, eps * 100, capInto);
    return this;
  }

  /** Copies this mesh into `into` (reset first) and returns `into`. */
  copyTo(into: TriMesh): TriMesh {
    into.reset().append(this);
    return into;
  }

  /** Reverses all triangles and normals. */
  flip(): this {
    for (let i = 0; i < this.ni; i += 3) {
      const t = this.idx[i + 1];
      this.idx[i + 1] = this.idx[i + 2];
      this.idx[i + 2] = t;
    }
    for (let v = 0; v < this.nv * 3; v++) this.nrm[v] = -this.nrm[v];
    return this;
  }

  /**
   * Subtracts the convex volume {p : n_i·p <= d_i for all i} (`planes`: nx, ny, nz, d per plane,
   * unit normals) from this closed mesh: the boundary outside the volume is kept piece by piece,
   * and the volume's faces are added where they pass through the solid. Returns false (mesh
   * untouched) when the volume misses the mesh. `pool` holds reusable scratch meshes.
   */
  subtractConvex(planes: ArrayLike<number>, pool: TriMesh[]): boolean {
    const k = planes.length / 4;
    const p = this.pos;
    let maxAbs = 1;
    for (let v = 0; v < this.nv * 3; v++) maxAbs = Math.max(maxAbs, Math.abs(p[v]));
    const eps = 1e-7 * maxAbs;
    // the volume misses the mesh when all vertices are on or outside one of its planes
    for (let i = 0; i < k; i++) {
      const nx = planes[i * 4], ny = planes[i * 4 + 1], nz = planes[i * 4 + 2], d = planes[i * 4 + 3];
      let inside = false;
      for (let v = 0; v < this.nv; v++) {
        if (p[v * 3] * nx + p[v * 3 + 1] * ny + p[v * 3 + 2] * nz - d < -eps) {
          inside = true;
          break;
        }
      }
      if (!inside) return false;
    }
    while (pool.length < 5) pool.push(new TriMesh());
    const [out, rest, work, tmp, section] = pool;
    out.reset();
    this.copyTo(rest);
    for (let i = 0; i < k && rest.ni; i++) {
      const nx = planes[i * 4], ny = planes[i * 4 + 1], nz = planes[i * 4 + 2], d = planes[i * 4 + 3];
      // the boundary outside plane i and inside the planes before it
      rest.copyTo(work).clip(-nx, -ny, -nz, -d, tmp, null);
      out.append(work);
      rest.clip(nx, ny, nz, d, tmp, null);
    }
    for (let i = 0; i < k; i++) {
      // the solid's cross-section in plane i, limited to face i of the volume, facing into it
      const nx = planes[i * 4], ny = planes[i * 4 + 1], nz = planes[i * 4 + 2], d = planes[i * 4 + 3];
      section.reset();
      this.copyTo(work).clip(nx, ny, nz, d, tmp, section);
      if (!section.ni) continue;
      section.flip();
      for (let j = 0; j < k && section.ni; j++) if (j !== i) section.clip(planes[j * 4], planes[j * 4 + 1], planes[j * 4 + 2], planes[j * 4 + 3], tmp, null);
      out.append(section);
    }
    out.copyTo(this);
    return true;
  }

  private swap(o: TriMesh): this {
    [this.pos, o.pos] = [o.pos, this.pos];
    [this.nrm, o.nrm] = [o.nrm, this.nrm];
    [this.idx, o.idx] = [o.idx, this.idx];
    [this.nv, o.nv] = [o.nv, this.nv];
    [this.ni, o.ni] = [o.ni, this.ni];
    return this;
  }

  /** Chains cut segments into closed loops and fills them as faces with normal n. */
  private cap(segs: number[], nx: number, ny: number, nz: number, tol: number, into: TriMesh): void {
    const ns = segs.length / 6;
    if (ns < 3) return;
    const q = 1 / Math.max(tol, 1e-12);
    const key = (o: number) => `${Math.round(segs[o] * q)},${Math.round(segs[o + 1] * q)},${Math.round(segs[o + 2] * q)}`;
    // point key -> segment ends touching it
    const ends = new Map<string, number[]>();
    for (let s = 0; s < ns; s++) {
      for (let e = 0; e < 2; e++) {
        const k = key(s * 6 + e * 3);
        const l = ends.get(k);
        if (l) l.push(s * 2 + e);
        else ends.set(k, [s * 2 + e]);
      }
    }
    // in-plane basis
    const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
    let ux = ay * nz, uy = -ax * nz, uz = ax * ny - ay * nx;
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;

    const used = new Uint8Array(ns);
    const loops: { xyz: number[]; xy: number[]; area: number }[] = [];
    for (let s0 = 0; s0 < ns; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      const xyz = [segs[s0 * 6], segs[s0 * 6 + 1], segs[s0 * 6 + 2]];
      let cur = s0 * 2 + 1; // walk from the second end
      let closed = false;
      for (let guard = 0; guard < ns; guard++) {
        const o = (cur >> 1) * 6 + (cur & 1) * 3;
        const cand = ends.get(key(o));
        let next = -1;
        if (cand) for (const c of cand) if (!used[c >> 1]) { next = c; break; }
        if (next < 0) {
          closed = key(o) === key(s0 * 6);
          break;
        }
        used[next >> 1] = 1;
        xyz.push(segs[o], segs[o + 1], segs[o + 2]);
        cur = next ^ 1;
      }
      if (!closed || xyz.length < 9) continue;
      const xy: number[] = [];
      for (let i = 0; i < xyz.length; i += 3) xy.push(xyz[i] * ux + xyz[i + 1] * uy + xyz[i + 2] * uz, xyz[i] * vx + xyz[i + 1] * vy + xyz[i + 2] * vz);
      loops.push({ xyz, xy, area: ringArea(xy) });
    }
    if (!loops.length) return;
    // nesting by containment: even depth = outer boundary, odd = hole of its nearest container
    loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    const parent = loops.map(() => -1);
    const depth = loops.map(() => 0);
    for (let i = 0; i < loops.length; i++) {
      for (let j = i - 1; j >= 0; j--) {
        if (pointInRing(loops[j].xy, loops[i].xy[0], loops[i].xy[1])) {
          parent[i] = j;
          depth[i] = depth[j] + 1;
          break;
        }
      }
    }
    for (let i = 0; i < loops.length; i++) {
      if (depth[i] % 2) continue;
      const rings = [loops[i].xyz];
      for (let j = 0; j < loops.length; j++) if (parent[j] === i && depth[j] % 2) rings.push(loops[j].xyz);
      into.polygon(rings, nx, ny, nz);
    }
  }
}

const scratchTris: number[] = [];

/** Geometric normal of triangle (a, b, c) dotted with n (not normalised). */
function facing(p: Float64Array, a: number, b: number, c: number, nx: number, ny: number, nz: number): number {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  return (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
}

function pointInRing(xy: number[], px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = xy.length - 2; i < xy.length; j = i, i += 2) {
    const yi = xy[i + 1], yj = xy[j + 1];
    if (yi > py !== yj > py && px < ((xy[j] - xy[i]) * (py - yi)) / (yj - yi) + xy[i]) inside = !inside;
  }
  return inside;
}

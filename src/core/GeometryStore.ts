/**
 * GeometryStore: quantized, deduplicated, reference-counted geometry.
 *
 * Each geometry is stored once in the shared 8-byte vertex format (layout.ts SHARED_VERTEX_STRIDE):
 * u16x3 position quantized inside the local AABB + i8x2 octahedral normal, followed by u32
 * indices. Storage is an arena of large Uint32Array chunks (no typed array per geometry):
 * geometry g occupies words [wordOffset[g], wordOffset[g] + 2*vertexCount[g] + indexCount[g])
 * of chunk chunkOf[g]; the first 2*vertexCount words are the vertices (2 words per vertex,
 * little-endian), the rest the indices (local, 0-based).
 *
 * Dequantization: local = q/65535 * scale + offset, with scale = AABB extent (0 on a flat axis)
 * and offset = AABB min. `dequant` holds scale xyz, offset xyz per geometry; `aabb` the local
 * AABB [offset, offset + scale].
 */
import type { GeometryData } from '../types';
import { grow } from './util';

const f32 = new Float32Array(1);
const f32u = new Uint32Array(f32.buffer);

/** Octahedral encode of a (not necessarily unit) vector to two snorm8 values in [-127, 127]. */
export function octEncode(x: number, y: number, z: number, out: Int8Array | number[], o = 0): void {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z);
  if (!(s > 0)) {
    out[o] = 0;
    out[o + 1] = 0;
    return;
  }
  let u = x / s;
  let v = y / s;
  if (z < 0) {
    const ou = u;
    u = (1 - Math.abs(v)) * (ou >= 0 ? 1 : -1);
    v = (1 - Math.abs(ou)) * (v >= 0 ? 1 : -1);
  }
  // Try the 4 neighbouring lattice points and keep the one decoding closest to the input.
  const fu = Math.floor(u * 127);
  const fv = Math.floor(v * 127);
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  const nx = x * inv;
  const ny = y * inv;
  const nz = z * inv;
  let best = -2;
  let bu = 0;
  let bv = 0;
  for (let i = 0; i < 4; i++) {
    let cu = fu + (i & 1);
    let cv = fv + (i >> 1);
    cu = cu < -127 ? -127 : cu > 127 ? 127 : cu;
    cv = cv < -127 ? -127 : cv > 127 ? 127 : cv;
    let du = cu / 127;
    let dv = cv / 127;
    const dz = 1 - Math.abs(du) - Math.abs(dv);
    if (dz < 0) {
      const t = du;
      du = (1 - Math.abs(dv)) * (t >= 0 ? 1 : -1);
      dv = (1 - Math.abs(t)) * (dv >= 0 ? 1 : -1);
    }
    const l = 1 / Math.sqrt(du * du + dv * dv + dz * dz);
    const dot = (du * nx + dv * ny + dz * nz) * l;
    if (dot > best) {
      best = dot;
      bu = cu;
      bv = cv;
    }
  }
  out[o] = bu;
  out[o + 1] = bv;
}

/**
 * Reference decoder (what the shader must do): a,b are the snorm8 integers.
 * u = max(a/127,-1), v = max(b/127,-1), z = 1-|u|-|v|; if z < 0 { (u,v) = ((1-|v|)*sgn(u), (1-|u|)*sgn(v)) }
 * with sgn(t) = t >= 0 ? 1 : -1 (NOT GLSL sign(), which returns 0 at 0); normalize(u, v, z).
 */
export function octDecode(a: number, b: number, out: Float32Array | number[], o = 0): void {
  let u = Math.max(a / 127, -1);
  let v = Math.max(b / 127, -1);
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    const t = u;
    u = (1 - Math.abs(v)) * (t >= 0 ? 1 : -1);
    v = (1 - Math.abs(t)) * (v >= 0 ? 1 : -1);
  }
  const l = 1 / Math.sqrt(u * u + v * v + z * z);
  out[o] = u * l;
  out[o + 1] = v * l;
  out[o + 2] = z * l;
}

export interface GeometryStoreOptions {
  /** Arena chunk size in 32-bit words (default 1M words = 4 MB). Larger geometries get their own chunk. */
  chunkWords?: number;
}

export class GeometryStore {
  /** Slots allocated so far (ids are < highWater). */
  highWater = 0;
  /** Live geometries. */
  liveCount = 0;
  /** Live bytes of quantized geometry data held on the CPU. */
  liveBytes = 0;

  vertexCount = new Uint32Array(64);
  indexCount = new Uint32Array(64);
  /** Per geometry 6 floats: dequant scale xyz, offset xyz. */
  dequant = new Float32Array(64 * 6);
  /** Per geometry 6 floats: local AABB min xyz, max xyz. */
  aabb = new Float32Array(64 * 6);
  /** API handle count (createGeometry calls that returned this id minus releaseGeometry calls). */
  handles = new Int32Array(64);
  /** Fragment slots referencing this geometry (alive or not yet recycled). */
  uses = new Int32Array(64);
  /** Set by the Batcher once the geometry has switched to the instanced path (sticky). */
  stickyInstanced = new Uint8Array(64);
  alive = new Uint8Array(64);
  chunkOf = new Int32Array(64);
  wordOffset = new Uint32Array(64);
  private hash = new Uint32Array(64);
  private hashNext = new Int32Array(64);
  private freeIds: number[] = [];
  private byHash = new Map<number, number>();

  private chunks: (Uint32Array | null)[] = [];
  private chunkUsed: number[] = [];
  private chunkLive: number[] = [];
  private freeChunks: number[] = [];
  private cur = -1;
  private readonly chunkWords: number;

  // scratch
  private normals = new Float32Array(0);
  private words = new Uint32Array(0);
  private readonly oct: number[] = [0, 0];

  constructor(opts: GeometryStoreOptions = {}) {
    this.chunkWords = opts.chunkWords ?? 1 << 20;
  }

  isAlive(id: number): boolean {
    return id >= 0 && id < this.highWater && this.alive[id] === 1;
  }

  /**
   * Quantizes and stores the geometry, or returns the id of an identical existing one (in which
   * case its handle count is incremented). Throws on malformed input.
   */
  add(data: GeometryData): number {
    const pos = data.positions;
    if (pos.length % 3 !== 0) throw new Error('GeometryData.positions length must be a multiple of 3');
    const vc = pos.length / 3;
    const idx = data.indices;
    const ic = idx ? idx.length : vc;
    if (ic % 3 !== 0) throw new Error('triangle list length must be a multiple of 3');
    if (data.normals && data.normals.length !== pos.length) {
      throw new Error('GeometryData.normals must have the same length as positions');
    }

    // --- local AABB, dequant parameters (float32-rounded so encode matches the shader's decode)
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = +pos[i], y = +pos[i + 1], z = +pos[i + 2];
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      if (z < minz) minz = z;
      if (z > maxz) maxz = z;
    }
    if (vc === 0) minx = miny = minz = maxx = maxy = maxz = 0;
    if (!Number.isFinite(minx + miny + minz + maxx + maxy + maxz)) {
      throw new Error('GeometryData.positions contains non-finite values');
    }
    const ox = Math.fround(minx), oy = Math.fround(miny), oz = Math.fround(minz);
    // ensure offset + scale covers max after float rounding
    const sx = fcover(ox, maxx), sy = fcover(oy, maxy), sz = fcover(oz, maxz);
    const ix = sx > 0 ? 65535 / sx : 0;
    const iy = sy > 0 ? 65535 / sy : 0;
    const iz = sz > 0 ? 65535 / sz : 0;

    // --- normals
    let nrm: ArrayLike<number>;
    if (data.normals) {
      nrm = data.normals;
    } else {
      this.normals = grow(this.normals, vc * 3);
      const n = this.normals;
      n.fill(0, 0, vc * 3);
      computeNormals(pos, idx, vc, ic, n);
      nrm = n;
    }

    // --- encode into scratch words
    const total = vc * 2 + ic;
    this.words = grow(this.words, total);
    const w = this.words;
    const oct = this.oct;
    for (let v = 0; v < vc; v++) {
      const p = v * 3;
      const qx = q16((pos[p] - ox) * ix);
      const qy = q16((pos[p + 1] - oy) * iy);
      const qz = q16((pos[p + 2] - oz) * iz);
      octEncode(+nrm[p], +nrm[p + 1], +nrm[p + 2], oct, 0);
      w[v * 2] = (qx | (qy << 16)) >>> 0;
      w[v * 2 + 1] = (qz | ((oct[0] & 255) << 16) | ((oct[1] & 255) << 24)) >>> 0;
    }
    const ib = vc * 2;
    if (idx) {
      for (let i = 0; i < ic; i++) {
        const k = idx[i];
        if (!(k >= 0 && k < vc) || (k | 0) !== k) throw new Error(`index ${k} out of range`);
        w[ib + i] = k;
      }
    } else {
      for (let i = 0; i < ic; i++) w[ib + i] = i;
    }

    // --- dedup by content hash (quantized words + dequant params), verified on match
    let h = 0x811c9dc5 ^ vc ^ Math.imul(ic, 0x01000193);
    h = mix(h, fbits(sx));
    h = mix(h, fbits(sy));
    h = mix(h, fbits(sz));
    h = mix(h, fbits(ox));
    h = mix(h, fbits(oy));
    h = mix(h, fbits(oz));
    for (let i = 0; i < total; i++) h = mix(h, w[i]);
    h = fmix(h);
    const head = this.byHash.get(h);
    if (head !== undefined) {
      for (let g = head; g >= 0; g = this.hashNext[g]) {
        if (this.vertexCount[g] !== vc || this.indexCount[g] !== ic) continue;
        const d = g * 6;
        const dq = this.dequant;
        if (dq[d] !== Math.fround(sx) || dq[d + 1] !== Math.fround(sy) || dq[d + 2] !== Math.fround(sz)) continue;
        if (dq[d + 3] !== ox || dq[d + 4] !== oy || dq[d + 5] !== oz) continue;
        const c = this.chunks[this.chunkOf[g]]!;
        const off = this.wordOffset[g];
        let same = true;
        for (let i = 0; i < total; i++) {
          if (c[off + i] !== w[i]) {
            same = false;
            break;
          }
        }
        if (same) {
          this.handles[g]++;
          return g;
        }
      }
    }

    // --- new slot
    const id = this.allocId();
    this.vertexCount[id] = vc;
    this.indexCount[id] = ic;
    const d = id * 6;
    this.dequant[d] = sx;
    this.dequant[d + 1] = sy;
    this.dequant[d + 2] = sz;
    this.dequant[d + 3] = ox;
    this.dequant[d + 4] = oy;
    this.dequant[d + 5] = oz;
    this.aabb[d] = ox;
    this.aabb[d + 1] = oy;
    this.aabb[d + 2] = oz;
    this.aabb[d + 3] = ox + Math.fround(sx);
    this.aabb[d + 4] = oy + Math.fround(sy);
    this.aabb[d + 5] = oz + Math.fround(sz);
    this.handles[id] = 1;
    this.uses[id] = 0;
    this.stickyInstanced[id] = 0;
    this.alive[id] = 1;
    this.hash[id] = h;
    this.hashNext[id] = head ?? -1;
    this.byHash.set(h, id);
    const c = this.allocWords(total);
    this.chunkOf[id] = c;
    const off = this.chunkUsed[c] - total;
    this.wordOffset[id] = off;
    this.chunks[c]!.set(w.subarray(0, total), off);
    this.liveCount++;
    this.liveBytes += total * 4;
    return id;
  }

  /** Increments the API handle count. */
  retain(id: number): void {
    this.handles[id]++;
  }

  /** Decrements the API handle count; frees the geometry when no handle and no fragment uses it. */
  release(id: number): void {
    if (!this.isAlive(id) || this.handles[id] <= 0) return;
    this.handles[id]--;
    this.maybeFree(id);
  }

  addUse(id: number, n = 1): void {
    this.uses[id] += n;
  }

  removeUse(id: number): void {
    this.uses[id]--;
    this.maybeFree(id);
  }

  /** The arena chunk holding geometry `id` (vertex words then index words). */
  chunk(id: number): Uint32Array {
    return this.chunks[this.chunkOf[id]]!;
  }

  /** Word offset of the first vertex of `id` inside chunk(id). */
  vertexWord(id: number): number {
    return this.wordOffset[id];
  }

  /** Word offset of the first index of `id` inside chunk(id). */
  indexWord(id: number): number {
    return this.wordOffset[id] + this.vertexCount[id] * 2;
  }

  /** View of the 8-byte shared-format vertices (allocates a view; not for hot paths). */
  vertexBytes(id: number): Uint8Array {
    const c = this.chunk(id);
    return new Uint8Array(c.buffer, c.byteOffset + this.wordOffset[id] * 4, this.vertexCount[id] * 8);
  }

  /** View of the local u32 indices (allocates a view; not for hot paths). */
  indices(id: number): Uint32Array {
    const c = this.chunk(id);
    const s = this.indexWord(id);
    return c.subarray(s, s + this.indexCount[id]);
  }

  /** Dequantized position of vertex v of geometry id (for tests / CPU queries). */
  decodePosition(id: number, v: number, out: Float32Array | number[]): void {
    const c = this.chunk(id);
    const o = this.wordOffset[id] + v * 2;
    const w0 = c[o];
    const w1 = c[o + 1];
    const d = id * 6;
    const dq = this.dequant;
    out[0] = ((w0 & 0xffff) / 65535) * dq[d] + dq[d + 3];
    out[1] = ((w0 >>> 16) / 65535) * dq[d + 1] + dq[d + 4];
    out[2] = ((w1 & 0xffff) / 65535) * dq[d + 2] + dq[d + 5];
  }

  /** Decoded unit normal of vertex v of geometry id. */
  decodeNormal(id: number, v: number, out: Float32Array | number[]): void {
    const w1 = this.chunk(id)[this.wordOffset[id] + v * 2 + 1];
    octDecode(((w1 << 8) >> 24), (w1 >> 24), out);
  }

  /** Forgets all fragment uses (scene clear); geometries without API handles are freed. */
  resetUses(): void {
    for (let id = 0; id < this.highWater; id++) {
      if (!this.alive[id]) continue;
      this.uses[id] = 0;
      this.stickyInstanced[id] = 0;
      this.maybeFree(id);
    }
  }

  /** Removes every geometry. */
  clear(): void {
    this.highWater = 0;
    this.liveCount = 0;
    this.liveBytes = 0;
    this.alive.fill(0);
    this.freeIds.length = 0;
    this.byHash.clear();
    this.chunks.length = 0;
    this.chunkUsed.length = 0;
    this.chunkLive.length = 0;
    this.freeChunks.length = 0;
    this.cur = -1;
  }

  private maybeFree(id: number): void {
    if (this.handles[id] > 0 || this.uses[id] > 0 || !this.alive[id]) return;
    this.alive[id] = 0;
    // unlink from hash chain
    const h = this.hash[id];
    const head = this.byHash.get(h)!;
    if (head === id) {
      const nx = this.hashNext[id];
      if (nx >= 0) this.byHash.set(h, nx);
      else this.byHash.delete(h);
    } else {
      let g = head;
      while (this.hashNext[g] !== id) g = this.hashNext[g];
      this.hashNext[g] = this.hashNext[id];
    }
    const words = this.vertexCount[id] * 2 + this.indexCount[id];
    const c = this.chunkOf[id];
    this.chunkLive[c] -= words;
    if (this.chunkLive[c] === 0 && c !== this.cur) {
      this.chunks[c] = null;
      this.freeChunks.push(c);
    }
    this.liveCount--;
    this.liveBytes -= words * 4;
    this.freeIds.push(id);
  }

  private allocId(): number {
    if (this.freeIds.length > 0) return this.freeIds.pop()!;
    const id = this.highWater++;
    if (id >= this.vertexCount.length) {
      const n = id + 1;
      this.vertexCount = grow(this.vertexCount, n);
      this.indexCount = grow(this.indexCount, n);
      this.dequant = grow(this.dequant, n * 6);
      this.aabb = grow(this.aabb, n * 6);
      this.handles = grow(this.handles, n);
      this.uses = grow(this.uses, n);
      this.stickyInstanced = grow(this.stickyInstanced, n);
      this.alive = grow(this.alive, n);
      this.chunkOf = grow(this.chunkOf, n);
      this.wordOffset = grow(this.wordOffset, n);
      this.hash = grow(this.hash, n);
      this.hashNext = grow(this.hashNext, n);
    }
    return id;
  }

  /** Reserves `n` words; returns the chunk index (the allocation ends at chunkUsed[c]). */
  private allocWords(n: number): number {
    if (n > this.chunkWords) {
      const c = this.newChunk(n);
      this.chunkUsed[c] = n;
      this.chunkLive[c] = n;
      return c;
    }
    if (this.cur < 0 || this.chunkUsed[this.cur] + n > this.chunks[this.cur]!.length) {
      const old = this.cur;
      this.cur = this.newChunk(this.chunkWords);
      if (old >= 0 && this.chunkLive[old] === 0) {
        this.chunks[old] = null;
        this.freeChunks.push(old);
      }
    }
    const c = this.cur;
    this.chunkUsed[c] += n;
    this.chunkLive[c] += n;
    return c;
  }

  private newChunk(words: number): number {
    const c = this.freeChunks.length > 0 ? this.freeChunks.pop()! : this.chunks.length;
    this.chunks[c] = new Uint32Array(words);
    this.chunkUsed[c] = 0;
    this.chunkLive[c] = 0;
    return c;
  }
}

/** Smallest float32 extent s such that fround(o + s) >= max (0 for a flat axis). */
function fcover(o: number, max: number): number {
  let s = Math.fround(max - o);
  if (!(s > 0)) return 0;
  while (Math.fround(o + s) < max) s = Math.fround(s * (1 + 1e-7) + 1e-38);
  return s;
}

function q16(v: number): number {
  const q = Math.round(v);
  return q < 0 ? 0 : q > 65535 ? 65535 : q;
}

function fbits(v: number): number {
  f32[0] = v;
  return f32u[0];
}

function mix(h: number, k: number): number {
  k = Math.imul(k, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Flat normals for non-indexed input (one face normal per triangle corner), smooth area-weighted
 * normals for indexed input. `out` must be zeroed. Degenerate results default to +Z.
 */
function computeNormals(
  pos: ArrayLike<number>,
  idx: ArrayLike<number> | undefined,
  vc: number,
  ic: number,
  out: Float32Array,
): void {
  for (let t = 0; t < ic; t += 3) {
    const a = idx ? idx[t] : t;
    const b = idx ? idx[t + 1] : t + 1;
    const c = idx ? idx[t + 2] : t + 2;
    if (!(a < vc && b < vc && c < vc)) continue; // validated later
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const e1x = pos[b * 3] - ax, e1y = pos[b * 3 + 1] - ay, e1z = pos[b * 3 + 2] - az;
    const e2x = pos[c * 3] - ax, e2y = pos[c * 3 + 1] - ay, e2z = pos[c * 3 + 2] - az;
    // cross product: length = 2 * triangle area -> area weighting for free
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    out[a * 3] += nx; out[a * 3 + 1] += ny; out[a * 3 + 2] += nz;
    out[b * 3] += nx; out[b * 3 + 1] += ny; out[b * 3 + 2] += nz;
    out[c * 3] += nx; out[c * 3 + 1] += ny; out[c * 3 + 2] += nz;
  }
  for (let v = 0; v < vc; v++) {
    const o = v * 3;
    const x = out[o], y = out[o + 1], z = out[o + 2];
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l > 0) {
      out[o] = x / l;
      out[o + 1] = y / l;
      out[o + 2] = z / l;
    } else {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 1;
    }
  }
}

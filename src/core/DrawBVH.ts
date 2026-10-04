/**
 * DrawBVH: bounding volume hierarchy over draw items (binned SAH, flat typed arrays) and the
 * per-frame traversal producing the ordered draw list.
 *
 * Node layout: nodeBounds (6 floats), nodeChild (left child index, right = left + 1; -1 = leaf),
 * nodeStart/nodeCount (range in `prims`, leaves only). Children are always allocated after their
 * parent, so a reverse sweep refits bottom-up.
 */
import { aabbDiag, cullAabb, distToAabb, emptyAabb, morton3, unionAabb } from './coremath';
import { DETAIL_STEPS, DrawItems, ITEM_FREE, ITEM_INSTANCED } from './DrawItems';
import { RadixSorter, grow } from './util';

/** Camera input for culling and screen-size estimation. */
export interface CullView {
  /** 6 planes * (nx, ny, nz, d), normals pointing inward: inside when n.p + d >= 0. */
  planes: Float32Array;
  /** Eye position (world). */
  eye: ArrayLike<number>;
  orthographic: boolean;
  /**
   * Perspective: pixels per world unit at distance 1 (= viewportHeightPx / (2 * tan(fovY / 2))).
   * Orthographic: pixels per world unit (= viewportHeightPx / orthoHeightWorld).
   */
  pixelScale: number;
  /** Items / members whose projected size (AABB diagonal, px) is below this are skipped. */
  pixelThreshold: number;
}

/**
 * Traversal output, allocated once by the caller and reused every frame (grows amortised with
 * the item count). Entries [0, opaqueCount) are opaque in priority order (large on screen and near
 * first); entries [opaqueCount, opaqueCount + transparentCount) are transparent, back to front.
 * `count[i]` is an index count for merged items and an instance count for instanced items.
 */
export class DrawList {
  item = new Uint32Array(0);
  count = new Uint32Array(0);
  opaqueCount = 0;
  transparentCount = 0;
  /** Triangles of all entries, and of the opaque ones. */
  triangles = 0;
  opaqueTriangles = 0;
  /** Nodes visited by the last traversal (diagnostics). */
  nodesVisited = 0;

  // scratch
  key = new Float32Array(0);
  tItem = new Uint32Array(0);
  tCount = new Uint32Array(0);
  tKey = new Float32Array(0);
  sItem = new Uint32Array(0);
  sCount = new Uint32Array(0);
  sKey = new Float32Array(0);
  readonly hist = new Uint32Array(BUCKETS + 1);

  get length(): number {
    return this.opaqueCount + this.transparentCount;
  }

  ensure(n: number): void {
    if (this.item.length >= n) return;
    this.item = grow(this.item, n);
    this.count = grow(this.count, n);
    this.key = grow(this.key, n);
    this.tItem = grow(this.tItem, n);
    this.tCount = grow(this.tCount, n);
    this.tKey = grow(this.tKey, n);
    this.sItem = grow(this.sItem, n);
    this.sCount = grow(this.sCount, n);
    this.sKey = grow(this.sKey, n);
  }
}

const BUCKETS = 2048;
const LEAF_MAX = 2;
const SMALL = 12;
const BINS = 16;

export class DrawBVH {
  nodeCount = 0;
  nodeBounds = new Float32Array(0);
  nodeChild = new Int32Array(0);
  nodeStart = new Int32Array(0);
  nodePrimCount = new Int32Array(0);
  prims = new Int32Array(0);
  primCount = 0;
  /** Versions of the Batcher state this tree reflects. */
  builtStructure = -1;
  builtBounds = -1;
  /** Duration of the last build/refit in ms (diagnostics). */
  lastBuildMs = 0;

  private cen = new Float32Array(0);
  private stack = new Int32Array(0);
  /** Item count above which the linear (Morton) builder replaces binned SAH. */
  sahMaxItems = 2048;
  private codes = new Uint32Array(0);
  private readonly radix = new RadixSorter();
  private cenBounds = new Float32Array(0);
  private binBounds = new Float32Array(BINS * 6);
  private binCenBounds = new Float32Array(BINS * 6);
  private binCount = new Int32Array(BINS);
  private leftArea = new Float32Array(BINS);
  private leftCnt = new Int32Array(BINS);

  /** Rebuilds or refits if the item set / bounds changed since the last call. */
  update(items: DrawItems, structureVersion: number, boundsVersion: number): void {
    if (structureVersion !== this.builtStructure) {
      this.build(items);
      this.builtStructure = structureVersion;
      this.builtBounds = boundsVersion;
    } else if (boundsVersion !== this.builtBounds) {
      this.refit(items);
      this.builtBounds = boundsVersion;
    }
  }

  /** Scene bounds of all draw items (conservative). Returns false when empty. */
  rootBounds(out: Float32Array): boolean {
    if (this.nodeCount === 0) return false;
    for (let i = 0; i < 6; i++) out[i] = this.nodeBounds[i];
    return true;
  }

  /**
   * Largest view depth of content that is in front of the eye and at least `minPx` pixels on screen
   * (draw items with visible members; whole subtrees below the size are skipped), or -Infinity.
   * `fz` = view-space depth row (-row 2 of the view matrix: depth = fz0*x + fz1*y + fz2*z + fz3).
   * Used to keep the near plane small when far-away content (e.g. a distant federated model) is
   * sub-pixel anyway.
   */
  visibleDepthMax(
    items: DrawItems,
    fz0: number, fz1: number, fz2: number, fz3: number,
    ex: number, ey: number, ez: number,
    pixelScale: number,
    minPx: number,
  ): number {
    if (this.nodeCount === 0) return -Infinity;
    this.stack = grow(this.stack, this.nodeCount * 2 + 4);
    const stack = this.stack;
    const nb = this.nodeBounds;
    const child = this.nodeChild;
    const ib = items.bounds;
    const vis = items.visibleFrags;
    let best = -Infinity;
    let sp = 0;
    stack[sp++] = 0;
    const far = (b: Float32Array, o: number): number =>
      fz3 + (fz0 > 0 ? fz0 * b[o + 3] : fz0 * b[o]) + (fz1 > 0 ? fz1 * b[o + 4] : fz1 * b[o + 1]) +
      (fz2 > 0 ? fz2 * b[o + 5] : fz2 * b[o + 2]);
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 6;
      const hi = far(nb, o);
      if (hi <= 0 || hi <= best) continue; // behind the eye, or cannot raise the maximum
      if (aabbDiag(nb, o) * pixelScale < minPx * distToAabb(ex, ey, ez, nb, o)) continue;
      const c = child[node];
      if (c >= 0) {
        stack[sp++] = c;
        stack[sp++] = c + 1;
        continue;
      }
      const s = this.nodeStart[node];
      for (let k = 0; k < this.nodePrimCount[node]; k++) {
        const it = this.prims[s + k];
        if (vis[it] === 0) continue;
        const io = it * 6;
        const h = far(ib, io);
        if (h <= best) continue;
        if (aabbDiag(ib, io) * pixelScale < minPx * distToAabb(ex, ey, ez, ib, io)) continue;
        best = h;
      }
    }
    return best;
  }

  /** Full binned-SAH rebuild over all live items. */
  build(items: DrawItems): void {
    const hw = items.highWater;
    this.prims = grow(this.prims, hw);
    this.cen = grow(this.cen, hw * 3);
    const prims = this.prims;
    const cen = this.cen;
    const ib = items.bounds;
    let n = 0;
    for (let i = 0; i < hw; i++) {
      if (items.kind[i] === ITEM_FREE) continue;
      prims[n++] = i;
      const o = i * 6;
      cen[i * 3] = (ib[o] + ib[o + 3]) * 0.5;
      cen[i * 3 + 1] = (ib[o + 1] + ib[o + 4]) * 0.5;
      cen[i * 3 + 2] = (ib[o + 2] + ib[o + 5]) * 0.5;
    }
    this.primCount = n;
    this.nodeCount = 0;
    if (n === 0) return;
    const maxNodes = 2 * n;
    if (this.nodeChild.length < maxNodes) {
      this.nodeBounds = grow(this.nodeBounds, maxNodes * 6);
      this.cenBounds = grow(this.cenBounds, maxNodes * 6);
      this.nodeChild = grow(this.nodeChild, maxNodes);
      this.nodeStart = grow(this.nodeStart, maxNodes);
      this.nodePrimCount = grow(this.nodePrimCount, maxNodes);
    }
    this.stack = grow(this.stack, maxNodes * 3 + 3);
    if (n > this.sahMaxItems) {
      this.buildLbvh(items, n);
      return;
    }
    const nb = this.nodeBounds;
    const cb = this.cenBounds;
    const child = this.nodeChild;
    const nstart = this.nodeStart;
    const ncount = this.nodePrimCount;
    const stack = this.stack;
    const binB = this.binBounds;
    const binCB = this.binCenBounds;
    const binC = this.binCount;
    const leftA = this.leftArea;
    const leftC = this.leftCnt;
    this.scan(ib, 0, n, 0);
    let sp = 0;
    stack[sp++] = 0;
    stack[sp++] = 0;
    stack[sp++] = n;
    this.nodeCount = 1;
    while (sp > 0) {
      const end = stack[--sp];
      const start = stack[--sp];
      const node = stack[--sp];
      const cnt = end - start;
      nstart[node] = start;
      ncount[node] = cnt;
      if (cnt <= LEAF_MAX) {
        child[node] = -1;
        continue;
      }
      const co = node * 6;
      const ex = cb[co + 3] - cb[co], ey = cb[co + 4] - cb[co + 1], ez = cb[co + 5] - cb[co + 2];
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const cmin = cb[co + axis];
      const ext = axis === 0 ? ex : axis === 1 ? ey : ez;
      const left = this.nodeCount;
      this.nodeCount += 2;
      child[node] = left;
      let mid = -1;
      if (ext > 0 && cnt > SMALL) {
        const scale = BINS / ext;
        binC.fill(0);
        for (let b = 0; b < BINS; b++) {
          emptyAabb(binB, b * 6);
          emptyAabb(binCB, b * 6);
        }
        for (let i = start; i < end; i++) {
          const p = prims[i];
          let b = ((cen[p * 3 + axis] - cmin) * scale) | 0;
          if (b >= BINS) b = BINS - 1;
          binC[b]++;
          const bo = b * 6;
          unionAabb(binB, bo, ib, p * 6);
          const x = cen[p * 3], y = cen[p * 3 + 1], z = cen[p * 3 + 2];
          if (x < binCB[bo]) binCB[bo] = x;
          if (y < binCB[bo + 1]) binCB[bo + 1] = y;
          if (z < binCB[bo + 2]) binCB[bo + 2] = z;
          if (x > binCB[bo + 3]) binCB[bo + 3] = x;
          if (y > binCB[bo + 4]) binCB[bo + 4] = y;
          if (z > binCB[bo + 5]) binCB[bo + 5] = z;
        }
        // sweep from the left: area and count of bins [0..b]
        let lminx = Infinity, lminy = Infinity, lminz = Infinity;
        let lmaxx = -Infinity, lmaxy = -Infinity, lmaxz = -Infinity;
        let lc = 0;
        for (let b = 0; b < BINS - 1; b++) {
          const o = b * 6;
          if (binC[b] > 0) {
            if (binB[o] < lminx) lminx = binB[o];
            if (binB[o + 1] < lminy) lminy = binB[o + 1];
            if (binB[o + 2] < lminz) lminz = binB[o + 2];
            if (binB[o + 3] > lmaxx) lmaxx = binB[o + 3];
            if (binB[o + 4] > lmaxy) lmaxy = binB[o + 4];
            if (binB[o + 5] > lmaxz) lmaxz = binB[o + 5];
          }
          lc += binC[b];
          leftC[b] = lc;
          leftA[b] = lc > 0 ? halfArea(lmaxx - lminx, lmaxy - lminy, lmaxz - lminz) : 0;
        }
        let rminx = Infinity, rminy = Infinity, rminz = Infinity;
        let rmaxx = -Infinity, rmaxy = -Infinity, rmaxz = -Infinity;
        let rc = 0;
        let best = Infinity;
        let split = -1;
        for (let b = BINS - 1; b > 0; b--) {
          const o = b * 6;
          if (binC[b] > 0) {
            if (binB[o] < rminx) rminx = binB[o];
            if (binB[o + 1] < rminy) rminy = binB[o + 1];
            if (binB[o + 2] < rminz) rminz = binB[o + 2];
            if (binB[o + 3] > rmaxx) rmaxx = binB[o + 3];
            if (binB[o + 4] > rmaxy) rmaxy = binB[o + 4];
            if (binB[o + 5] > rmaxz) rmaxz = binB[o + 5];
          }
          rc += binC[b];
          const lcnt = leftC[b - 1];
          if (rc === 0 || lcnt === 0) continue;
          const cost = leftA[b - 1] * lcnt + halfArea(rmaxx - rminx, rmaxy - rminy, rmaxz - rminz) * rc;
          if (cost < best) {
            best = cost;
            split = b;
          }
        }
        if (split > 0) {
          let l = start;
          let r = end - 1;
          while (l <= r) {
            const p = prims[l];
            let b = ((cen[p * 3 + axis] - cmin) * scale) | 0;
            if (b >= BINS) b = BINS - 1;
            if (b < split) l++;
            else {
              prims[l] = prims[r];
              prims[r] = p;
              r--;
            }
          }
          mid = l;
          // children bounds straight from the bins
          const lo = left * 6;
          const ro = lo + 6;
          emptyAabb(nb, lo);
          emptyAabb(nb, ro);
          emptyAabb(cb, lo);
          emptyAabb(cb, ro);
          for (let b = 0; b < BINS; b++) {
            if (binC[b] === 0) continue;
            const t = b < split ? lo : ro;
            unionAabb(nb, t, binB, b * 6);
            unionAabb(cb, t, binCB, b * 6);
          }
        }
      } else if (ext > 0) {
        // small node: median split along the axis (insertion sort by centroid)
        for (let i = start + 1; i < end; i++) {
          const p = prims[i];
          const k = cen[p * 3 + axis];
          let j = i - 1;
          while (j >= start && cen[prims[j] * 3 + axis] > k) {
            prims[j + 1] = prims[j];
            j--;
          }
          prims[j + 1] = p;
        }
      }
      if (mid <= start || mid >= end) {
        // small node or coincident centroids: split in half
        mid = (start + end) >>> 1;
        this.scan(ib, start, mid, left);
        this.scan(ib, mid, end, left + 1);
      }
      stack[sp++] = left;
      stack[sp++] = start;
      stack[sp++] = mid;
      stack[sp++] = left + 1;
      stack[sp++] = mid;
      stack[sp++] = end;
    }
  }

  /**
   * Linear BVH: Morton-sort item centroids, split ranges at the highest differing code bit, then
   * refit bounds bottom-up. O(n) passes; used above sahMaxItems where binned SAH gets slower.
   */
  private buildLbvh(items: DrawItems, n: number): void {
    const prims = this.prims;
    const cen = this.cen;
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = prims[i] * 3;
      const x = cen[p], y = cen[p + 1], z = cen[p + 2];
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      if (z < minz) minz = z;
      if (z > maxz) maxz = z;
    }
    const sx = maxx > minx ? 1023.99 / (maxx - minx) : 0;
    const sy = maxy > miny ? 1023.99 / (maxy - miny) : 0;
    const sz = maxz > minz ? 1023.99 / (maxz - minz) : 0;
    this.codes = grow(this.codes, n);
    const codes = this.codes;
    for (let i = 0; i < n; i++) {
      const p = prims[i] * 3;
      codes[i] = morton3(((cen[p] - minx) * sx) | 0, ((cen[p + 1] - miny) * sy) | 0, ((cen[p + 2] - minz) * sz) | 0);
    }
    this.radix.sort(codes, prims, n);
    const child = this.nodeChild;
    const nstart = this.nodeStart;
    const ncount = this.nodePrimCount;
    const stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    stack[sp++] = 0;
    stack[sp++] = n;
    this.nodeCount = 1;
    while (sp > 0) {
      const end = stack[--sp];
      const start = stack[--sp];
      const node = stack[--sp];
      const cnt = end - start;
      nstart[node] = start;
      ncount[node] = cnt;
      if (cnt <= LEAF_MAX) {
        child[node] = -1;
        continue;
      }
      const a = codes[start];
      const diff = (a ^ codes[end - 1]) >>> 0;
      let mid: number;
      if (diff === 0) {
        mid = (start + end) >>> 1;
      } else {
        // first index whose code has the highest differing bit set (codes share the prefix above it)
        const bit = 1 << (31 - Math.clz32(diff));
        let lo = start;
        let hi = end - 1;
        while (lo < hi) {
          const m = (lo + hi) >>> 1;
          if (codes[m] & bit) hi = m;
          else lo = m + 1;
        }
        mid = lo;
      }
      const left = this.nodeCount;
      this.nodeCount += 2;
      child[node] = left;
      stack[sp++] = left;
      stack[sp++] = start;
      stack[sp++] = mid;
      stack[sp++] = left + 1;
      stack[sp++] = mid;
      stack[sp++] = end;
    }
    this.refit(items);
  }

  /** Node and centroid bounds of prims[start..end) into node `node`. */
  private scan(ib: Float32Array, start: number, end: number, node: number): void {
    const nb = this.nodeBounds;
    const cb = this.cenBounds;
    const cen = this.cen;
    const prims = this.prims;
    const o = node * 6;
    emptyAabb(nb, o);
    emptyAabb(cb, o);
    for (let i = start; i < end; i++) {
      const p = prims[i];
      unionAabb(nb, o, ib, p * 6);
      const x = cen[p * 3], y = cen[p * 3 + 1], z = cen[p * 3 + 2];
      if (x < cb[o]) cb[o] = x;
      if (y < cb[o + 1]) cb[o + 1] = y;
      if (z < cb[o + 2]) cb[o + 2] = z;
      if (x > cb[o + 3]) cb[o + 3] = x;
      if (y > cb[o + 4]) cb[o + 4] = y;
      if (z > cb[o + 5]) cb[o + 5] = z;
    }
  }

  /** Recomputes node bounds bottom-up after item bounds changed (same item set). */
  refit(items: DrawItems): void {
    const nb = this.nodeBounds;
    const ib = items.bounds;
    for (let node = this.nodeCount - 1; node >= 0; node--) {
      const no = node * 6;
      emptyAabb(nb, no);
      const c = this.nodeChild[node];
      if (c < 0) {
        const s = this.nodeStart[node];
        const e = s + this.nodePrimCount[node];
        for (let i = s; i < e; i++) unionAabb(nb, no, ib, this.prims[i] * 6);
      } else {
        unionAabb(nb, no, nb, c * 6);
        unionAabb(nb, no, nb, (c + 1) * 6);
      }
    }
  }

  /**
   * Frustum + screen-size culling and ordering into `out` (no allocation except amortised growth
   * of `out`). Returns the number of entries.
   */
  traverse(items: DrawItems, view: CullView, out: DrawList): number {
    out.opaqueCount = 0;
    out.transparentCount = 0;
    out.triangles = 0;
    out.opaqueTriangles = 0;
    out.nodesVisited = 0;
    if (this.nodeCount === 0) return 0;
    out.ensure(items.highWater);
    this.stack = grow(this.stack, this.nodeCount * 2 + 4);
    const stack = this.stack;
    const planes = view.planes;
    const ex = view.eye[0], ey = view.eye[1], ez = view.eye[2];
    const ortho = view.orthographic;
    const scale = view.pixelScale;
    const thr = view.pixelThreshold;
    const nb = this.nodeBounds;
    const child = this.nodeChild;
    const nstart = this.nodeStart;
    const ncount = this.nodePrimCount;
    const prims = this.prims;
    const ib = items.bounds;
    const kind = items.kind;
    const transp = items.transparent;
    const visibleFrags = items.visibleFrags;
    const ds = items.detailSize;
    const dc = items.detailCount;
    const dl = items.detailLen;
    const oItem = out.item, oCount = out.count, oKey = out.key;
    const tItem = out.tItem, tCount = out.tCount, tKey = out.tKey;
    let no = 0;
    let nt = 0;
    let tris = 0;
    let otris = 0;
    let visited = 0;
    let sp = 0;
    stack[sp++] = 0;
    stack[sp++] = 63;
    while (sp > 0) {
      const inMask = stack[--sp];
      const node = stack[--sp];
      visited++;
      const o = node * 6;
      const mask = inMask === 0 ? 0 : cullAabb(planes, nb, o, inMask);
      if (mask < 0) continue;
      if (thr > 0) {
        const diag = aabbDiag(nb, o);
        if (ortho) {
          if (diag * scale < thr) continue;
        } else {
          const d = distToAabb(ex, ey, ez, nb, o);
          if (diag * scale < thr * d) continue;
        }
      }
      const c = child[node];
      if (c >= 0) {
        // push the farther child first so the nearer one is processed first
        const da = centreDist2(nb, c * 6, ex, ey, ez);
        const db = centreDist2(nb, (c + 1) * 6, ex, ey, ez);
        if (da <= db) {
          stack[sp++] = c + 1;
          stack[sp++] = mask;
          stack[sp++] = c;
          stack[sp++] = mask;
        } else {
          stack[sp++] = c;
          stack[sp++] = mask;
          stack[sp++] = c + 1;
          stack[sp++] = mask;
        }
        continue;
      }
      const s = nstart[node];
      const e = s + ncount[node];
      for (let i = s; i < e; i++) {
        const it = prims[i];
        if (kind[it] === ITEM_FREE || visibleFrags[it] === 0) continue;
        const io = it * 6;
        if (mask !== 0 && cullAabb(planes, ib, io, mask) < 0) continue;
        // minimum visible world size for this item, and its distance
        const d = ortho ? 0 : distToAabb(ex, ey, ez, ib, io);
        const sMin = ortho ? thr / scale : (thr * d) / scale;
        const d0 = it * DETAIL_STEPS;
        const len = dl[it];
        let cnt = dc[d0 + len - 1];
        for (let k = 0; k < len; k++) {
          if (ds[d0 + k] < sMin) {
            cnt = dc[d0 + k];
            break;
          }
        }
        if (cnt === 0) continue;
        const t = kind[it] === ITEM_INSTANCED ? (items.indexCount[it] / 3) * cnt : cnt / 3;
        tris += t;
        if (transp[it]) {
          tItem[nt] = it;
          tCount[nt] = cnt;
          // back to front: ascending key = -distance to centre
          tKey[nt] = -Math.sqrt(centreDist2(ib, io, ex, ey, ez));
          nt++;
        } else {
          oItem[no] = it;
          oCount[no] = cnt;
          // importance = projected size of the largest member; ascending key = -log2(px)
          const big = ds[d0];
          const px = ortho ? big * scale : d > 0 ? (big * scale) / d : 1e30;
          oKey[no] = -Math.log2(px > 1e-30 ? px : 1e-30);
          otris += t;
          no++;
        }
      }
    }
    bucketSort(oItem, oCount, oKey, no, out, false);
    bucketSort(tItem, tCount, tKey, nt, out, true);
    if (nt > 0) {
      oItem.set(tItem.subarray(0, nt), no);
      oCount.set(tCount.subarray(0, nt), no);
    }
    out.opaqueCount = no;
    out.transparentCount = nt;
    out.triangles = tris;
    out.opaqueTriangles = otris;
    out.nodesVisited = visited;
    return no + nt;
  }
}

function halfArea(dx: number, dy: number, dz: number): number {
  return dx * dy + dy * dz + dz * dx;
}

function centreDist2(b: Float32Array, o: number, ex: number, ey: number, ez: number): number {
  const x = (b[o] + b[o + 3]) * 0.5 - ex;
  const y = (b[o + 1] + b[o + 4]) * 0.5 - ey;
  const z = (b[o + 2] + b[o + 5]) * 0.5 - ez;
  return x * x + y * y + z * z;
}

/**
 * Stable counting sort of (item, count) by ascending key into BUCKETS linear buckets between the
 * min and max key; `exact` adds an insertion pass for a fully sorted result.
 */
function bucketSort(
  item: Uint32Array,
  count: Uint32Array,
  key: Float32Array,
  n: number,
  out: DrawList,
  exact: boolean,
): void {
  if (n < 2) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const k = key[i];
    if (k < lo) lo = k;
    if (k > hi) hi = k;
  }
  if (hi > lo) {
    const h = out.hist;
    h.fill(0);
    const s = (BUCKETS - 1) / (hi - lo);
    for (let i = 0; i < n; i++) h[((key[i] - lo) * s) | 0]++;
    let sum = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const c = h[b];
      h[b] = sum;
      sum += c;
    }
    const sI = out.sItem, sC = out.sCount, sK = out.sKey;
    for (let i = 0; i < n; i++) {
      const p = h[((key[i] - lo) * s) | 0]++;
      sI[p] = item[i];
      sC[p] = count[i];
      sK[p] = key[i];
    }
    item.set(sI.subarray(0, n));
    count.set(sC.subarray(0, n));
    key.set(sK.subarray(0, n));
  }
  if (!exact) return;
  for (let i = 1; i < n; i++) {
    const k = key[i];
    if (key[i - 1] <= k) continue;
    const it = item[i];
    const c = count[i];
    let j = i - 1;
    while (j >= 0 && key[j] > k) {
      key[j + 1] = key[j];
      item[j + 1] = item[j];
      count[j + 1] = count[j];
      j--;
    }
    key[j + 1] = k;
    item[j + 1] = it;
    count[j + 1] = c;
  }
}

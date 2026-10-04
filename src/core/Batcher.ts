/**
 * Batcher: turns queued fragments into draw items ("Consolidation" in docs/ARCHITECTURE.md).
 *
 * Fragments are queued (enqueue) and processed once per frame (flush):
 *  - instanced path when the geometry is used by >= instanceThreshold fragment slots, is large
 *    (>= largeMeshVertices), or already switched to instancing (sticky). The geometry is copied
 *    once into a shared page; instances are grouped by (geometry, transparency), Morton-sorted and
 *    cut into chunks; each chunk is one item whose u32 fragment indices live in an instance page.
 *  - merged path otherwise: fragments are Morton-sorted (transparency as top key bit), cut into
 *    batches of ~batchVertices, ordered largest-first within a batch and copied into a merged page
 *    in the 12-byte format with the fragment index stamped on every vertex and indices rebased.
 *
 * Removal never touches vertex data: the fragment's Visible flag is cleared and the hole counted;
 * an item whose members are all dead is freed (its fragment slots recycled). compact() re-batches
 * items with many holes and merges undersized ones within a time budget.
 */
import { FRAG_FLOATS, FRAG_MATERIAL, FragFlags } from '../layout';
import { aabbDiag, emptyAabb, morton3, unionAabb } from './coremath';
import { DETAIL_STEPS, DrawItems, ITEM_FREE, ITEM_INSTANCED, ITEM_MERGED } from './DrawItems';
import { FragmentList, STATE_ALIVE, STATE_PENDING } from './FragmentList';
import type { GeometryStore } from './GeometryStore';
import type { MaterialStore } from './MaterialStore';
import { PAGE_INSTANCE, PAGE_MERGED, PAGE_SHARED, PagePool } from './Pages';
import { RadixSorter, grow, now, sortPairsDesc } from './util';

export interface BatcherOptions {
  /** Geometry used by at least this many fragments is drawn instanced. Default 16. */
  instanceThreshold?: number;
  /** Geometry with at least this many vertices is always drawn instanced (stored once). Default 16384. */
  largeMeshVertices?: number;
  /** Target vertex count of a merged batch. Default 65536. */
  batchVertices?: number;
  /** Max instances per instanced chunk. Default 2048. */
  chunkInstances?: number;
  /** Max triangles per instanced chunk (limits chunks of heavy geometry). Default 262144. */
  chunkTriangles?: number;
  /**
   * Geometry with at least this many vertices that gets new users while others are already in merged
   * batches (e.g. a second model sharing it) switches to instancing, and its merged users are moved
   * to the shared copy, so it is stored on the GPU once instead of once per batch. Default 1024.
   */
  reuseInstanceVertices?: number;
  /** compact(): items with holes/total >= this are rebuilt. Default 0.5. */
  compactHoleRatio?: number;
  /** compact(): items below this fraction of the batch/chunk target are merged. Default 0.25. */
  undersizedRatio?: number;
  /**
   * compact(): items in sealed merged / instance pages whose live share fell below this are moved,
   * so the page (GPU buffers) can be released, e.g. after a model was unloaded. Default 0.5.
   */
  pageEvacuateRatio?: number;
}

const INTERIOR_STEPS = 7; // detail entries at 1/8 .. 7/8 of the item's element count

export class Batcher {
  readonly items = new DrawItems();
  /** Incremented when items are created or freed (BVH must rebuild). */
  structureVersion = 0;
  /** Incremented when item bounds grow (BVH can refit). */
  boundsVersion = 0;

  readonly instanceThreshold: number;
  readonly largeMeshVertices: number;
  readonly batchVertices: number;
  readonly chunkInstances: number;
  readonly chunkTriangles: number;
  readonly reuseInstanceVertices: number;
  readonly compactHoleRatio: number;
  readonly undersizedRatio: number;
  readonly pageEvacuateRatio: number;

  private queue = new Int32Array(1024);
  private queueLen = 0;
  // items whose member transforms changed: exact bounds are recomputed at the next flush
  private refitQueue = new Int32Array(64);
  private refitLen = 0;
  private refitMark = new Uint8Array(0);
  /** Per fragment: `moveEpoch` when its transform changed since the last flush. */
  private moved = new Uint32Array(0);
  private moveEpoch = 1;
  /** Per item: AABB diagonal when it was batched (detects members drifting apart). */
  private baseDiag = new Float32Array(0);
  /** Items refitted / split by the last flush (diagnostics). */
  lastRefitCount = 0;
  lastSplitCount = 0;

  // per geometry: shared-page allocation used by instanced items
  private sharedPage = new Int32Array(0);
  private sharedIndex = new Uint32Array(0);
  private sharedVc = new Uint32Array(0);
  private sharedIc = new Uint32Array(0);
  private sharedRefs = new Int32Array(0);
  /** Per geometry: member slots in merged items. */
  private mergedUsers = new Int32Array(0);
  private flipped = new Uint8Array(0);
  /** Merged items rebuilt because their geometry switched to instancing (diagnostics). */
  migratedItems = 0;

  // scratch (grown amortised)
  private mKeys = new Uint32Array(0);
  private mVals = new Int32Array(0);
  private iKeys = new Uint32Array(0);
  private iVals = new Int32Array(0);
  private sizes = new Float32Array(0);
  private tmp = new Int32Array(0);
  private readonly groupCount = new Map<number, number>();
  private readonly radix = new RadixSorter();
  private compactCursor = 0;
  private sparse = new Uint8Array(0);

  constructor(
    readonly geometries: GeometryStore,
    readonly materials: MaterialStore,
    readonly fragments: FragmentList,
    readonly pages: PagePool,
    opts: BatcherOptions = {},
  ) {
    this.instanceThreshold = opts.instanceThreshold ?? 16;
    this.largeMeshVertices = opts.largeMeshVertices ?? 16384;
    this.batchVertices = opts.batchVertices ?? 65536;
    this.chunkInstances = opts.chunkInstances ?? 2048;
    this.chunkTriangles = opts.chunkTriangles ?? 262144;
    this.reuseInstanceVertices = opts.reuseInstanceVertices ?? 1024;
    this.compactHoleRatio = opts.compactHoleRatio ?? 0.5;
    this.undersizedRatio = opts.undersizedRatio ?? 0.25;
    this.pageEvacuateRatio = opts.pageEvacuateRatio ?? 0.5;
  }

  /** Fragments waiting for the next flush. */
  get pendingCount(): number {
    return this.queueLen;
  }

  /** Queues an alive, unbatched fragment. */
  enqueue(f: number): void {
    const st = this.fragments.state;
    if (st[f] & STATE_PENDING) return;
    st[f] |= STATE_PENDING;
    if (this.queueLen >= this.queue.length) this.queue = grow(this.queue, this.queueLen + 1);
    this.queue[this.queueLen++] = f;
  }

  /** Queues `n` consecutive freshly initialised fragments. */
  enqueueRange(first: number, n: number): void {
    this.queue = grow(this.queue, this.queueLen + n);
    const st = this.fragments.state;
    const q = this.queue;
    let len = this.queueLen;
    for (let i = 0; i < n; i++) {
      const f = first + i;
      if (st[f] & STATE_PENDING) continue;
      st[f] |= STATE_PENDING;
      q[len++] = f;
    }
    this.queueLen = len;
  }

  /**
   * Removes an alive fragment: clears its flags, counts the hole, frees its item when it was the
   * last live member. Returns false when the fragment was not alive.
   */
  removeFragment(f: number): boolean {
    const fr = this.fragments;
    const st = fr.state[f];
    if (!(st & STATE_ALIVE)) return false;
    const visible = fr.flags[f] & FragFlags.Visible;
    fr.kill(f);
    if (st & STATE_PENDING) return true; // released when the queue is processed
    const it = fr.item[f];
    if (it < 0) {
      this.releaseSlot(f);
      return true;
    }
    const items = this.items;
    items.liveFrags[it]--;
    if (visible) items.visibleFrags[it]--;
    if (items.liveFrags[it] === 0) this.freeItem(it);
    return true;
  }

  /** Must be called when the Visible flag of an alive fragment toggles. */
  visibilityChanged(f: number, visible: boolean): void {
    const it = this.fragments.item[f];
    if (it >= 0) this.items.visibleFrags[it] += visible ? 1 : -1;
  }

  /**
   * Must be called after a fragment's world bounds changed (transform). The item's bounds grow at
   * once (culling stays conservative) and are recomputed exactly at the next flush, so they also
   * shrink again after members moved away.
   */
  boundsChanged(f: number): void {
    const it = this.fragments.item[f];
    if (it < 0) return;
    const ib = this.items.bounds;
    const fb = this.fragments.bounds;
    const o = it * 6;
    const p = f * 6;
    if (fb[p] < ib[o] || fb[p + 1] < ib[o + 1] || fb[p + 2] < ib[o + 2] ||
        fb[p + 3] > ib[o + 3] || fb[p + 4] > ib[o + 4] || fb[p + 5] > ib[o + 5]) {
      unionAabb(ib, o, fb, p);
      this.boundsVersion++;
    }
    if (f >= this.moved.length) this.moved = grow(this.moved, this.fragments.capacity);
    this.moved[f] = this.moveEpoch;
    if (it >= this.refitMark.length) this.refitMark = grow(this.refitMark, this.items.capacity);
    if (this.refitMark[it]) return;
    this.refitMark[it] = 1;
    if (this.refitLen >= this.refitQueue.length) this.refitQueue = grow(this.refitQueue, this.refitLen + 1);
    this.refitQueue[this.refitLen++] = it;
  }

  /**
   * Recomputes the exact bounds of items whose members moved (from their alive members). An item
   * whose moved members drifted away from its unmoved ones (bounds now > 1.5x the batched diagonal,
   * e.g. a draw item shared by two models of which one was re-placed) is split: it is freed and its
   * members re-batched, moved and unmoved ones separately. Many refits at once (a whole model
   * re-placed) bump structureVersion so the BVH is rebuilt rather than refitted into a poor
   * topology. flush() calls this. Returns the number of items split.
   */
  refitMoved(): number {
    const n = this.refitLen;
    this.lastRefitCount = n;
    this.lastSplitCount = 0;
    if (n === 0) return 0;
    this.refitLen = 0;
    const epoch = this.moveEpoch;
    const moved = this.moved;
    let split = 0;
    const items = this.items;
    const fr = this.fragments;
    const fb = fr.bounds;
    const ib = items.bounds;
    const next = fr.itemNext;
    const st = fr.state;
    const q = this.refitQueue;
    const mark = this.refitMark;
    for (let k = 0; k < n; k++) {
      const it = q[k];
      mark[it] = 0;
      if (items.kind[it] === ITEM_FREE) continue;
      const o = it * 6;
      emptyAabb(ib, o);
      let alive = 0;
      let nm = 0;
      for (let f = items.head[it]; f >= 0; f = next[f]) {
        if (!(st[f] & STATE_ALIVE)) continue;
        unionAabb(ib, o, fb, f * 6);
        alive++;
        if (moved[f] === epoch) nm++;
      }
      // all members dead (item about to be freed): keep a valid point box
      if (alive === 0) for (let i = 0; i < 6; i++) ib[o + i] = 0;
      else if (nm > 0 && nm < alive && aabbDiag(ib, o) > this.baseDiag[it] * 1.5 + 1e-6) {
        this.freeItem(it); // members re-queued; flush() batches moved and unmoved ones apart
        split++;
      }
    }
    this.lastSplitCount = split;
    if (split > 0 || n * 4 > items.liveCount) this.structureVersion++;
    else this.boundsVersion++;
    return split;
  }

  /**
   * Frees an item and re-queues its live members (they are re-batched at the next flush);
   * dead members' slots are recycled. Used for compaction and for pass changes
   * (opaque <-> transparent material switches).
   */
  rebuildItem(it: number): void {
    if (this.items.kind[it] !== ITEM_FREE) this.freeItem(it);
  }

  /** Processes the queue into new draw items. Returns the number of items created. */
  flush(): number {
    const split = this.refitMoved();
    this.migrate();
    const n = this.queueLen;
    const epoch = this.moveEpoch;
    this.moveEpoch = (epoch + 1) >>> 0 || 1;
    if (n === 0) return 0;
    this.queueLen = 0;
    const q = this.queue;
    if (split === 0) return this.batch(q, n);
    // keep members that moved apart from their former item-mates out of the others' batches
    const moved = this.moved;
    this.tmp = grow(this.tmp, n);
    const t = this.tmp;
    let u = 0;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const f = q[i];
      if (f < moved.length && moved[f] === epoch) t[m++] = f;
      else q[u++] = f;
    }
    q.set(t.subarray(0, m), u);
    let created = this.batch(q.subarray(0, u), u);
    created += this.batch(q.subarray(u, n), m);
    return created;
  }

  /**
   * Geometry about to switch to instancing (uses >= instanceThreshold, or large and reused across
   * flushes) while some of its fragments sit in merged batches: rebuild those batches so the
   * geometry ends up stored once (shared page) instead of copied per batch. One O(fragments) scan per
   * flush that switches any geometry.
   */
  private migrate(): void {
    const n = this.queueLen;
    if (n === 0) return;
    const gs = this.geometries;
    const fr = this.fragments;
    this.ensureGeomArrays();
    const mu = this.mergedUsers;
    const flipped = this.flipped;
    const q = this.queue;
    let any = false;
    for (let i = 0; i < n; i++) {
      const f = q[i];
      if (!(fr.state[f] & STATE_ALIVE)) continue;
      const g = fr.geometry[f];
      if (gs.stickyInstanced[g] || mu[g] === 0) continue;
      if (gs.uses[g] >= this.instanceThreshold || gs.vertexCount[g] >= this.reuseInstanceVertices) {
        gs.stickyInstanced[g] = 1;
        flipped[g] = 1;
        any = true;
      }
    }
    if (!any) return;
    const items = this.items;
    const hw = fr.highWater;
    for (let f = 0; f < hw; f++) {
      const it = fr.item[f];
      if (it < 0 || items.kind[it] !== ITEM_MERGED || !flipped[fr.geometry[f]]) continue;
      this.freeItem(it); // members re-queued: flipped ones go instanced, the others are re-merged
      this.migratedItems++;
    }
    flipped.fill(0);
  }

  /** Batches the n queued fragments q[0..n). */
  private batch(q: Int32Array, n: number): number {
    if (n === 0) return 0;
    const fr = this.fragments;
    const gs = this.geometries;
    const st = fr.state;
    const bounds = fr.bounds;
    this.mKeys = grow(this.mKeys, n);
    this.mVals = grow(this.mVals, n);
    this.iKeys = grow(this.iKeys, n);
    this.iVals = grow(this.iVals, n);
    const mVals = this.mVals;
    const iVals = this.iVals;
    let m = 0;
    let k = 0;
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < n; i++) {
      const f = q[i];
      const s = st[f];
      if (!(s & STATE_ALIVE)) {
        // removed while pending
        this.releaseSlot(f);
        continue;
      }
      st[f] = s & ~STATE_PENDING;
      const g = fr.geometry[f];
      if (gs.indexCount[g] === 0) continue; // nothing to draw; stays unbatched (item = -1)
      const o = f * 6;
      const cx = bounds[o] + bounds[o + 3];
      const cy = bounds[o + 1] + bounds[o + 4];
      const cz = bounds[o + 2] + bounds[o + 5];
      if (cx < minx) minx = cx;
      if (cx > maxx) maxx = cx;
      if (cy < miny) miny = cy;
      if (cy > maxy) maxy = cy;
      if (cz < minz) minz = cz;
      if (cz > maxz) maxz = cz;
      if (gs.stickyInstanced[g] || gs.uses[g] >= this.instanceThreshold || gs.vertexCount[g] >= this.largeMeshVertices) {
        gs.stickyInstanced[g] = 1;
        iVals[k++] = f;
      } else {
        mVals[m++] = f;
      }
    }
    const before = this.items.liveCount;
    const sx = maxx > minx ? 1023.99 / (maxx - minx) : 0;
    const sy = maxy > miny ? 1023.99 / (maxy - miny) : 0;
    const sz = maxz > minz ? 1023.99 / (maxz - minz) : 0;
    if (m > 0) this.flushMerged(m, minx, miny, minz, sx, sy, sz);
    if (k > 0) this.flushInstanced(k, minx, miny, minz, sx, sy, sz);
    const created = this.items.liveCount - before;
    if (m > 0 || k > 0) this.structureVersion++;
    return created;
  }

  /**
   * Time-sliced maintenance: rebuilds items whose hole ratio >= compactHoleRatio and merges
   * undersized items (when at least two exist in a group), then flushes. Returns true when any
   * item was rebuilt.
   */
  compact(budgetMs: number): boolean {
    const t0 = now();
    const items = this.items;
    const hw = items.highWater;
    if (hw === 0) return false;
    const mergedSmall = this.batchVertices * this.undersizedRatio;
    // pass 1: count undersized items per merge class (batch group + transparency, and geometry
    // for instanced items): only items of one class can be merged
    const gc = this.groupCount;
    gc.clear();
    for (let it = 0; it < hw; it++) {
      const grp = this.undersizedGroup(it, mergedSmall);
      if (grp >= 0) gc.set(grp, (gc.get(grp) ?? 0) + 1);
    }
    // sparse sealed pages: move their items out so the page is released
    const pages = this.pages.pages;
    this.sparse = grow(this.sparse, pages.length);
    const sparse = this.sparse;
    let anySparse = false;
    for (let id = 0; id < pages.length; id++) {
      const p = pages[id];
      const sp = !!p && p.sealed && !p.released && p.kind !== PAGE_SHARED && p.liveAllocs > 0 &&
        p.liveVertices < p.vertexCapacity * this.pageEvacuateRatio && p.liveIndices <= p.indexCapacity * this.pageEvacuateRatio;
      sparse[id] = sp ? 1 : 0;
      if (sp) anySparse = true;
    }
    let changed = false;
    let idx = this.compactCursor % hw;
    for (let j = 0; j < hw; j++, idx = idx + 1 === hw ? 0 : idx + 1) {
      if (items.kind[idx] === ITEM_FREE) continue;
      const total = items.fragCount[idx];
      const holes = total - items.liveFrags[idx];
      let rebuild = total > 0 && holes / total >= this.compactHoleRatio;
      if (!rebuild) {
        const grp = this.undersizedGroup(idx, mergedSmall);
        rebuild = grp >= 0 && (gc.get(grp) ?? 0) >= 2;
      }
      if (!rebuild && anySparse) {
        rebuild = sparse[items.kind[idx] === ITEM_MERGED ? items.page[idx] : items.instancePage[idx]] === 1;
      }
      if (rebuild) {
        this.freeItem(idx);
        changed = true;
      }
      if ((j & 15) === 15 && now() - t0 > budgetMs) {
        idx = idx + 1 === hw ? 0 : idx + 1;
        break;
      }
    }
    this.compactCursor = idx;
    if (changed) this.flush();
    return changed;
  }

  /** Drops all items and the queue (pages must be cleared separately). */
  clear(): void {
    this.queueLen = 0;
    this.mergedUsers.fill(0);
    for (let k = 0; k < this.refitLen; k++) this.refitMark[this.refitQueue[k]] = 0;
    this.refitLen = 0;
    this.items.clear();
    this.sharedPage.fill(-1);
    this.sharedRefs.fill(0);
    this.structureVersion++;
  }

  // ---------------------------------------------------------------------------

  private undersizedGroup(it: number, mergedSmall: number): number {
    const items = this.items;
    const kind = items.kind[it];
    const span = (this.geometries.highWater + 1) * 2;
    const base = (items.group[it] >>> 0) * span;
    if (kind === ITEM_MERGED) {
      return items.vertexCount[it] < mergedSmall ? base + items.transparent[it] : -1;
    }
    if (kind === ITEM_INSTANCED) {
      const g = items.geometry[it];
      const max = this.maxPerChunk(this.geometries.indexCount[g]);
      if (max > 1 && items.instanceCount[it] < max * this.undersizedRatio) {
        return base + 2 + g * 2 + items.transparent[it];
      }
    }
    return -1;
  }

  private maxPerChunk(indexCount: number): number {
    const tris = Math.max(1, indexCount / 3);
    return Math.max(1, Math.min(this.chunkInstances, Math.floor(this.chunkTriangles / tris)));
  }

  private releaseSlot(f: number): void {
    const g = this.fragments.geometry[f];
    this.fragments.release(f);
    this.geometries.removeUse(g);
  }

  private freeItem(it: number): void {
    const items = this.items;
    const fr = this.fragments;
    if (items.kind[it] === ITEM_MERGED) {
      this.pages.free(items.page[it], items.vertexCount[it], items.indexCount[it]);
      const mu = this.mergedUsers;
      for (let f = items.head[it]; f >= 0; f = fr.itemNext[f]) mu[fr.geometry[f]]--;
    } else {
      this.pages.free(items.instancePage[it], items.instanceCount[it], 0);
      this.unrefShared(items.geometry[it]);
    }
    const st = fr.state;
    const next = fr.itemNext;
    let f = items.head[it];
    while (f >= 0) {
      const nf = next[f];
      next[f] = -1;
      fr.item[f] = -1;
      if (st[f] & STATE_ALIVE) this.enqueue(f);
      else this.releaseSlot(f);
      f = nf;
    }
    items.free(it);
    this.structureVersion++;
  }

  private ensureGeomArrays(): void {
    const n = this.geometries.highWater;
    if (this.sharedPage.length >= n) return;
    const old = this.sharedPage.length;
    this.sharedPage = grow(this.sharedPage, n);
    this.sharedPage.fill(-1, old);
    this.sharedIndex = grow(this.sharedIndex, n);
    this.sharedVc = grow(this.sharedVc, n);
    this.sharedIc = grow(this.sharedIc, n);
    this.sharedRefs = grow(this.sharedRefs, n);
    this.mergedUsers = grow(this.mergedUsers, n);
    this.flipped = grow(this.flipped, n);
  }

  private unrefShared(g: number): void {
    if (--this.sharedRefs[g] > 0) return;
    this.pages.free(this.sharedPage[g], this.sharedVc[g], this.sharedIc[g]);
    this.sharedPage[g] = -1;
  }

  private ensureShared(g: number): void {
    if (this.sharedPage[g] >= 0) return;
    const gs = this.geometries;
    const vc = gs.vertexCount[g];
    const ic = gs.indexCount[g];
    const pid = this.pages.allocate(PAGE_SHARED, vc, ic);
    const fv = this.pages.lastVertex;
    const fi = this.pages.lastIndex;
    const page = this.pages.get(pid);
    const src = gs.chunk(g);
    const w0 = gs.vertexWord(g);
    page.vertexWords!.set(src.subarray(w0, w0 + vc * 2), fv * 2);
    const dst = page.indexData!;
    const i0 = w0 + vc * 2;
    for (let i = 0; i < ic; i++) dst[fi + i] = src[i0 + i] + fv;
    this.sharedPage[g] = pid;
    this.sharedIndex[g] = fi;
    this.sharedVc[g] = vc;
    this.sharedIc[g] = ic;
    this.sharedRefs[g] = 0;
  }

  private flushMerged(m: number, minx: number, miny: number, minz: number, sx: number, sy: number, sz: number): void {
    const keys = this.mKeys;
    const vals = this.mVals;
    const fr = this.fragments;
    const b = fr.bounds;
    const recs = fr.records;
    const tr = this.materials.transparent;
    for (let i = 0; i < m; i++) {
      const f = vals[i];
      const o = f * 6;
      const code = morton3(
        ((b[o] + b[o + 3] - minx) * sx) | 0,
        ((b[o + 1] + b[o + 4] - miny) * sy) | 0,
        ((b[o + 2] + b[o + 5] - minz) * sz) | 0,
      );
      const t = tr[recs[f * FRAG_FLOATS + FRAG_MATERIAL]];
      keys[i] = (code | (t << 30)) >>> 0;
    }
    this.radix.sort(keys, vals, m);
    const grp = fr.group;
    if (this.sortByGroup(vals, m)) {
      // stable: group-major, (transparency, Morton) order kept inside each group
      for (let i = 0; i < m; i++) keys[i] = grp[vals[i]] >>> 0;
      this.radix.sort(keys, vals, m);
    }
    const vcount = this.geometries.vertexCount;
    const geom = fr.geometry;
    const target = this.batchVertices;
    let i = 0;
    while (i < m) {
      const f0 = vals[i];
      const t = tr[recs[f0 * FRAG_FLOATS + FRAG_MATERIAL]];
      const g0 = grp[f0];
      let j = i;
      let v = 0;
      while (j < m) {
        const f = vals[j];
        if (grp[f] !== g0 || tr[recs[f * FRAG_FLOATS + FRAG_MATERIAL]] !== t) break;
        const vc = vcount[geom[f]];
        if (j > i && v + vc > target) break;
        v += vc;
        j++;
      }
      this.emitMerged(vals, i, j, t);
      i = j;
    }
  }

  /** True when vals[0..n) holds fragments of more than one batch group. */
  private sortByGroup(vals: Int32Array, n: number): boolean {
    const grp = this.fragments.group;
    const g0 = grp[vals[0]];
    for (let i = 1; i < n; i++) if (grp[vals[i]] !== g0) return true;
    return false;
  }

  private emitMerged(src: Int32Array, i0: number, i1: number, transparent: number): void {
    const n = i1 - i0;
    const fr = this.fragments;
    const gs = this.geometries;
    const fb = fr.bounds;
    this.sizes = grow(this.sizes, n);
    this.tmp = grow(this.tmp, n);
    const sizes = this.sizes;
    const order = this.tmp;
    let V = 0;
    let I = 0;
    for (let k = 0; k < n; k++) {
      const f = src[i0 + k];
      order[k] = f;
      sizes[k] = aabbDiag(fb, f * 6) || 0;
      const g = fr.geometry[f];
      V += gs.vertexCount[g];
      I += gs.indexCount[g];
    }
    sortPairsDesc(sizes, order, 0, n);
    const pid = this.pages.allocate(PAGE_MERGED, V, I);
    const fv = this.pages.lastVertex;
    const fi = this.pages.lastIndex;
    const page = this.pages.get(pid);
    const dw = page.vertexWords!;
    const di = page.indexData!;
    const items = this.items;
    const it = items.alloc(ITEM_MERGED);
    items.transparent[it] = transparent;
    items.group[it] = fr.group[order[0]];
    items.page[it] = pid;
    items.firstVertex[it] = fv;
    items.vertexCount[it] = V;
    items.firstIndex[it] = fi;
    items.indexCount[it] = I;
    items.triangles[it] = I / 3;
    items.fragCount[it] = n;
    items.liveFrags[it] = n;
    const ib = items.bounds;
    const bo = it * 6;
    emptyAabb(ib, bo);
    const ds = items.detailSize;
    const dc = items.detailCount;
    const d0 = it * DETAIL_STEPS;
    ds[d0] = sizes[0];
    dc[d0] = 0;
    let dl = 1;
    let step = 1;
    const st = fr.state;
    const flags = fr.flags;
    const next = fr.itemNext;
    const itemOf = fr.item;
    let vb = fv;
    let xb = fi;
    let prev = -1;
    let visible = 0;
    this.ensureGeomArrays();
    const mu = this.mergedUsers;
    for (let k = 0; k < n; k++) {
      const f = order[k];
      const g = fr.geometry[f];
      mu[g]++;
      const vc = gs.vertexCount[g];
      const ic = gs.indexCount[g];
      const c = gs.chunk(g);
      let s = gs.vertexWord(g);
      let d = vb * 3;
      for (let v = 0; v < vc; v++) {
        dw[d] = c[s];
        dw[d + 1] = c[s + 1];
        dw[d + 2] = f;
        d += 3;
        s += 2;
      }
      // s now points at the indices
      for (let x = 0; x < ic; x++) di[xb + x] = c[s + x] + vb;
      vb += vc;
      xb += ic;
      unionAabb(ib, bo, fb, f * 6);
      if (prev < 0) items.head[it] = f;
      else next[prev] = f;
      next[f] = -1;
      itemOf[f] = it;
      st[f] &= ~STATE_PENDING;
      prev = f;
      if (flags[f] & FragFlags.Visible) visible++;
      // detail steps at 1/8 .. 7/8 of the index count
      if (k + 1 < n && step <= INTERIOR_STEPS) {
        const cum = xb - fi;
        if (cum * 8 >= I * step) {
          ds[d0 + dl] = sizes[k + 1];
          dc[d0 + dl] = cum;
          dl++;
          while (step <= INTERIOR_STEPS && cum * 8 >= I * step) step++;
        }
      }
    }
    ds[d0 + dl] = -1;
    dc[d0 + dl] = I;
    dl++;
    items.detailLen[it] = dl;
    items.visibleFrags[it] = visible;
    this.setBaseDiag(it);
  }

  private setBaseDiag(it: number): void {
    if (it >= this.baseDiag.length) this.baseDiag = grow(this.baseDiag, this.items.capacity);
    this.baseDiag[it] = aabbDiag(this.items.bounds, it * 6);
  }

  private flushInstanced(k: number, minx: number, miny: number, minz: number, sx: number, sy: number, sz: number): void {
    const keys = this.iKeys;
    const vals = this.iVals;
    const fr = this.fragments;
    const b = fr.bounds;
    const recs = fr.records;
    const tr = this.materials.transparent;
    const geom = fr.geometry;
    for (let i = 0; i < k; i++) {
      const o = vals[i] * 6;
      keys[i] = morton3(
        ((b[o] + b[o + 3] - minx) * sx) | 0,
        ((b[o + 1] + b[o + 4] - miny) * sy) | 0,
        ((b[o + 2] + b[o + 5] - minz) * sz) | 0,
      );
    }
    this.radix.sort(keys, vals, k);
    const grp = fr.group;
    if (this.sortByGroup(vals, k)) {
      for (let i = 0; i < k; i++) keys[i] = grp[vals[i]] >>> 0;
      this.radix.sort(keys, vals, k);
    }
    // stable sort by (geometry, transparent) keeps (group, Morton) order inside each group
    for (let i = 0; i < k; i++) {
      const f = vals[i];
      keys[i] = (geom[f] * 2 + tr[recs[f * FRAG_FLOATS + FRAG_MATERIAL]]) >>> 0;
    }
    this.radix.sort(keys, vals, k);
    this.ensureGeomArrays();
    let i = 0;
    while (i < k) {
      const key = keys[i];
      const g0 = grp[vals[i]];
      let j = i + 1;
      while (j < k && keys[j] === key && grp[vals[j]] === g0) j++;
      const g = key >>> 1;
      const t = key & 1;
      const cnt = j - i;
      const max = this.maxPerChunk(this.geometries.indexCount[g]);
      const chunks = Math.ceil(cnt / max);
      const per = Math.ceil(cnt / chunks);
      this.ensureShared(g);
      for (let s = i; s < j; s += per) this.emitInstanced(vals, s, Math.min(j, s + per), g, t);
      i = j;
    }
  }

  private emitInstanced(src: Int32Array, i0: number, i1: number, g: number, transparent: number): void {
    const n = i1 - i0;
    const fr = this.fragments;
    const fb = fr.bounds;
    this.sizes = grow(this.sizes, n);
    this.tmp = grow(this.tmp, n);
    const sizes = this.sizes;
    const order = this.tmp;
    for (let k = 0; k < n; k++) {
      const f = src[i0 + k];
      order[k] = f;
      sizes[k] = aabbDiag(fb, f * 6) || 0;
    }
    sortPairsDesc(sizes, order, 0, n);
    const pid = this.pages.allocate(PAGE_INSTANCE, n, 0);
    const first = this.pages.lastVertex;
    const dst = this.pages.get(pid).vertexWords!;
    const ic = this.geometries.indexCount[g];
    const items = this.items;
    const it = items.alloc(ITEM_INSTANCED);
    items.transparent[it] = transparent;
    items.group[it] = fr.group[order[0]];
    items.page[it] = this.sharedPage[g];
    items.firstIndex[it] = this.sharedIndex[g];
    items.indexCount[it] = ic;
    items.instancePage[it] = pid;
    items.firstInstance[it] = first;
    items.instanceCount[it] = n;
    items.geometry[it] = g;
    items.triangles[it] = (ic / 3) * n;
    items.fragCount[it] = n;
    items.liveFrags[it] = n;
    this.sharedRefs[g]++;
    const ib = items.bounds;
    const bo = it * 6;
    emptyAabb(ib, bo);
    const ds = items.detailSize;
    const dc = items.detailCount;
    const d0 = it * DETAIL_STEPS;
    ds[d0] = sizes[0];
    dc[d0] = 0;
    let dl = 1;
    let step = 1;
    const st = fr.state;
    const flags = fr.flags;
    const next = fr.itemNext;
    const itemOf = fr.item;
    let prev = -1;
    let visible = 0;
    for (let k = 0; k < n; k++) {
      const f = order[k];
      dst[first + k] = f;
      unionAabb(ib, bo, fb, f * 6);
      if (prev < 0) items.head[it] = f;
      else next[prev] = f;
      next[f] = -1;
      itemOf[f] = it;
      st[f] &= ~STATE_PENDING;
      prev = f;
      if (flags[f] & FragFlags.Visible) visible++;
      if (k + 1 < n && step <= INTERIOR_STEPS) {
        const cum = k + 1;
        if (cum * 8 >= n * step) {
          ds[d0 + dl] = sizes[k + 1];
          dc[d0 + dl] = cum;
          dl++;
          while (step <= INTERIOR_STEPS && cum * 8 >= n * step) step++;
        }
      }
    }
    ds[d0 + dl] = -1;
    dc[d0 + dl] = n;
    dl++;
    items.detailLen[it] = dl;
    items.visibleFrags[it] = visible;
    this.setBaseDiag(it);
  }
}

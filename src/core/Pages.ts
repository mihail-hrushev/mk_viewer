/**
 * Page pool: fixed-capacity CPU staging buffers that the GL layer mirrors 1:1 as GPU buffers.
 *
 * A page is a (vertex buffer, index buffer) pair with fixed capacity, filled by bump allocation:
 *  - PAGE_MERGED:   MERGED_VERTEX_STRIDE (12 B) vertices + u32 indices (consolidated batches)
 *  - PAGE_SHARED:   SHARED_VERTEX_STRIDE (8 B) vertices + u32 indices (instanced geometry, stored once)
 *  - PAGE_INSTANCE: 4-byte elements (u32 fragment index per instance), no index buffer
 * Indices are absolute within their page (already rebased), so a draw never needs baseVertex.
 *
 * GL mirroring contract (per frame, skip entirely when `version` did not change):
 *   for each non-null page p:
 *     if p.released: delete its GL buffers, then pool.acknowledgeRelease(p.id)
 *     else:
 *       if no GL buffers yet: create them with bufferData(size = p.vertexCapacity * p.vertexStride)
 *                             and (if p.indexCapacity > 0) bufferData(size = p.indexCapacity * 4)
 *       if p.vDirtyEnd > p.vDirtyStart: bufferSubData(ARRAY_BUFFER, p.vDirtyStart,
 *                             p.vertexBytes, p.vDirtyStart, p.vDirtyEnd - p.vDirtyStart)
 *       same for the index buffer with iDirtyStart/iDirtyEnd (bytes) and p.indexBytes
 *       pool.markUploaded(p.id)   // clears dirty ranges; may drop the CPU copy of a sealed page
 * A page never grows; once sealed it never receives new data.
 */
import { INDEX_BYTES, MERGED_VERTEX_STRIDE, SHARED_VERTEX_STRIDE } from '../layout';

export const PAGE_MERGED = 0;
export const PAGE_SHARED = 1;
export const PAGE_INSTANCE = 2;
export type PageKind = typeof PAGE_MERGED | typeof PAGE_SHARED | typeof PAGE_INSTANCE;

export class Page {
  /** CPU copy; null after release or after the CPU copy was dropped (dropCpuAfterUpload). */
  vertexBytes: Uint8Array | null;
  /** Same memory as vertexBytes, as u32 words. */
  vertexWords: Uint32Array | null;
  /** Index buffer contents (absolute vertex indices within this page); null for instance pages. */
  indexData: Uint32Array | null;
  indexBytes: Uint8Array | null;
  /** Elements (vertices / instances) and indices handed out so far. */
  vertexUsed = 0;
  indexUsed = 0;
  /** Live allocations and their sizes (for occupancy / release). */
  liveAllocs = 0;
  liveVertices = 0;
  liveIndices = 0;
  /** No further allocations go to this page. */
  sealed = false;
  /** All allocations freed after sealing: GL should delete the buffers and acknowledge. */
  released = false;
  /** Dirty byte ranges [start, end) still to upload. */
  vDirtyStart = Infinity;
  vDirtyEnd = 0;
  iDirtyStart = Infinity;
  iDirtyEnd = 0;

  constructor(
    readonly id: number,
    readonly kind: PageKind,
    /** Bytes per vertex element: 12 (merged), 8 (shared) or 4 (instance). */
    readonly vertexStride: number,
    /** Capacity in vertex elements. GPU buffer size = vertexCapacity * vertexStride. */
    readonly vertexCapacity: number,
    /** Capacity in u32 indices (0 for instance pages). GPU buffer size = indexCapacity * 4. */
    readonly indexCapacity: number,
  ) {
    const vb = new ArrayBuffer(vertexCapacity * vertexStride);
    this.vertexBytes = new Uint8Array(vb);
    this.vertexWords = new Uint32Array(vb);
    if (indexCapacity > 0) {
      const ib = new ArrayBuffer(indexCapacity * INDEX_BYTES);
      this.indexData = new Uint32Array(ib);
      this.indexBytes = new Uint8Array(ib);
    } else {
      this.indexData = null;
      this.indexBytes = null;
    }
  }

  get hasCpuCopy(): boolean {
    return this.vertexBytes !== null;
  }

  get byteSize(): number {
    return this.vertexCapacity * this.vertexStride + this.indexCapacity * INDEX_BYTES;
  }
}

export interface PagePoolOptions {
  /** Vertex capacity of a merged page (default 512k vertices = 6 MB). */
  mergedVertices?: number;
  /** Vertex capacity of a shared (instanced geometry) page (default 512k = 4 MB). */
  sharedVertices?: number;
  /** Index capacity = vertex capacity * this (default 3). */
  indicesPerVertex?: number;
  /** Instance page capacity in u32 entries (default 1M = 4 MB). */
  instanceCapacity?: number;
  /** Drop the CPU copy of a sealed page once markUploaded() is called (default false). */
  dropCpuAfterUpload?: boolean;
}

export class PagePool {
  /** All pages by id (ids are never reused; null once released and acknowledged). */
  readonly pages: (Page | null)[] = [];
  /** Incremented on any page creation, write, seal or release. */
  version = 0;
  /** Results of the last allocate(): first vertex element and first index within the page. */
  lastVertex = 0;
  lastIndex = 0;
  dropCpuAfterUpload: boolean;
  private readonly open: number[] = [-1, -1, -1];
  private readonly vcap: number[];
  private readonly icap: number[];
  private static readonly STRIDE = [MERGED_VERTEX_STRIDE, SHARED_VERTEX_STRIDE, 4];

  constructor(opts: PagePoolOptions = {}) {
    const ipv = opts.indicesPerVertex ?? 3;
    const mv = opts.mergedVertices ?? 1 << 19;
    const sv = opts.sharedVertices ?? 1 << 19;
    this.vcap = [mv, sv, opts.instanceCapacity ?? 1 << 20];
    this.icap = [Math.ceil(mv * ipv), Math.ceil(sv * ipv), 0];
    this.dropCpuAfterUpload = opts.dropCpuAfterUpload ?? false;
  }

  get(id: number): Page {
    return this.pages[id]!;
  }

  /**
   * Reserves `vertices` elements and `indices` indices in one page of `kind`, marks them dirty
   * (the caller writes them immediately) and returns the page id; the offsets are in
   * lastVertex / lastIndex. Requests larger than a page get a dedicated, exactly sized page.
   */
  allocate(kind: PageKind, vertices: number, indices: number): number {
    const vcap = this.vcap[kind];
    const icap = this.icap[kind];
    let p: Page;
    if (vertices > vcap || indices > icap) {
      p = this.newPage(kind, vertices, indices);
      p.sealed = true;
    } else {
      const o = this.open[kind];
      let cur = o >= 0 ? this.pages[o]! : null;
      if (!cur || cur.vertexUsed + vertices > cur.vertexCapacity || cur.indexUsed + indices > cur.indexCapacity) {
        if (cur) this.seal(cur);
        cur = this.newPage(kind, vcap, icap);
        this.open[kind] = cur.id;
      }
      p = cur;
    }
    this.lastVertex = p.vertexUsed;
    this.lastIndex = p.indexUsed;
    p.vertexUsed += vertices;
    p.indexUsed += indices;
    p.liveAllocs++;
    p.liveVertices += vertices;
    p.liveIndices += indices;
    const vs = this.lastVertex * p.vertexStride;
    const ve = p.vertexUsed * p.vertexStride;
    if (ve > vs) {
      if (vs < p.vDirtyStart) p.vDirtyStart = vs;
      if (ve > p.vDirtyEnd) p.vDirtyEnd = ve;
    }
    const is = this.lastIndex * INDEX_BYTES;
    const ie = p.indexUsed * INDEX_BYTES;
    if (ie > is) {
      if (is < p.iDirtyStart) p.iDirtyStart = is;
      if (ie > p.iDirtyEnd) p.iDirtyEnd = ie;
    }
    this.version++;
    return p.id;
  }

  /** Frees an allocation made by allocate(); a sealed page with no live allocation is released. */
  free(id: number, vertices: number, indices: number): void {
    const p = this.pages[id];
    if (!p || p.released) return;
    p.liveAllocs--;
    p.liveVertices -= vertices;
    p.liveIndices -= indices;
    if (p.liveAllocs === 0) {
      if (p.sealed) this.release(p);
      else {
        // Open page that became empty: rewind it so the space is reused.
        p.vertexUsed = 0;
        p.indexUsed = 0;
      }
    }
  }

  /** Called by the GL layer after uploading the dirty ranges of page `id`. */
  markUploaded(id: number): void {
    const p = this.pages[id];
    if (!p) return;
    p.vDirtyStart = p.iDirtyStart = Infinity;
    p.vDirtyEnd = p.iDirtyEnd = 0;
    if (this.dropCpuAfterUpload && p.sealed) this.dropCpu(p);
  }

  /** Called by the GL layer once it deleted the buffers of a released page. */
  acknowledgeRelease(id: number): void {
    const p = this.pages[id];
    if (p && p.released) this.pages[id] = null;
  }

  /** Seals every open page (e.g. before dropping CPU copies after a big load). */
  sealAll(): void {
    for (let k = 0; k < 3; k++) {
      const o = this.open[k];
      if (o >= 0) this.seal(this.pages[o]!);
    }
  }

  /** Releases every page (scene clear). */
  clear(): void {
    for (const p of this.pages) if (p && !p.released) this.release(p);
    this.open[0] = this.open[1] = this.open[2] = -1;
  }

  /** GPU bytes of all unreleased pages. */
  get gpuBytes(): number {
    let n = 0;
    for (const p of this.pages) if (p && !p.released) n += p.byteSize;
    return n;
  }

  /** CPU bytes still held by page staging copies. */
  get cpuBytes(): number {
    let n = 0;
    for (const p of this.pages) if (p && p.vertexBytes) n += p.byteSize;
    return n;
  }

  private seal(p: Page): void {
    p.sealed = true;
    if (this.open[p.kind] === p.id) this.open[p.kind] = -1;
    if (p.liveAllocs === 0) this.release(p);
    else if (this.dropCpuAfterUpload && p.vDirtyEnd === 0 && p.iDirtyEnd === 0) this.dropCpu(p);
    this.version++;
  }

  private release(p: Page): void {
    p.sealed = true;
    p.released = true;
    if (this.open[p.kind] === p.id) this.open[p.kind] = -1;
    this.dropCpu(p);
    this.version++;
  }

  private dropCpu(p: Page): void {
    p.vertexBytes = null;
    p.vertexWords = null;
    p.indexData = null;
    p.indexBytes = null;
  }

  private newPage(kind: PageKind, vertices: number, indices: number): Page {
    const p = new Page(this.pages.length, kind, PagePool.STRIDE[kind], vertices, kind === PAGE_INSTANCE ? 0 : indices);
    this.pages.push(p);
    this.version++;
    return p;
  }
}

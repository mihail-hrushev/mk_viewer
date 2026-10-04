/**
 * Draw items (structure of arrays). One item = one draw call:
 *
 *  ITEM_MERGED:    drawElements(TRIANGLES, count, UNSIGNED_INT, firstIndex * 4) on page `page`
 *                  (a PAGE_MERGED page, 12-byte vertices carrying their fragment index).
 *  ITEM_INSTANCED: drawElementsInstanced(TRIANGLES, indexCount, UNSIGNED_INT, firstIndex * 4,
 *                  count) on shared page `page` (8-byte vertices), with the per-instance u32
 *                  fragment-index attribute pointing at instance page `instancePage`, byte offset
 *                  firstInstance * 4 (divisor 1).
 *
 * `count` is what traversal outputs: for merged items an index count (<= indexCount, a prefix
 * that drops the smallest members), for instanced items an instance count (<= instanceCount).
 *
 * Detail table (per item, up to DETAIL_STEPS entries at it * DETAIL_STEPS):
 *   entries (size_k, count_k), count increasing, size decreasing. Members are stored largest
 *   first, so drawing the first count_k elements drops only members whose world size (AABB
 *   diagonal) is <= size_k. The last entry is (-1, full count). Traversal picks the first k with
 *   size_k < minimum visible world size.
 */

export const ITEM_FREE = 0;
export const ITEM_MERGED = 1;
export const ITEM_INSTANCED = 2;
export const DETAIL_STEPS = 10;

export class DrawItems {
  capacity: number;
  /** Slots ever used; valid item indices are < highWater (check kind !== ITEM_FREE). */
  highWater = 0;
  liveCount = 0;

  kind: Uint8Array;
  transparent: Uint8Array;
  /** World AABB, 6 floats per item (grows when members move; tightened on rebuild). */
  bounds: Float32Array;
  /** Vertex/index page (merged page for merged items, shared page for instanced). */
  page: Int32Array;
  firstIndex: Uint32Array;
  indexCount: Uint32Array;
  /** Merged items: first vertex and vertex count in the page (for freeing). */
  firstVertex: Uint32Array;
  vertexCount: Uint32Array;
  /** Instanced items: instance page and range. */
  instancePage: Int32Array;
  firstInstance: Uint32Array;
  instanceCount: Uint32Array;
  /** Instanced items: geometry id. */
  geometry: Int32Array;
  /** Member fragments: total slots, alive ones, visible ones, linked list head (FragmentList.itemNext). */
  fragCount: Uint32Array;
  liveFrags: Uint32Array;
  visibleFrags: Uint32Array;
  head: Int32Array;
  /** Triangles of the full item (indexCount/3 * instanceCount for instanced). */
  triangles: Float64Array;
  detailSize: Float32Array;
  detailCount: Uint32Array;
  detailLen: Uint8Array;

  private freeList: number[] = [];

  constructor(initialCapacity = 256) {
    const c = initialCapacity;
    this.capacity = c;
    this.kind = new Uint8Array(c);
    this.transparent = new Uint8Array(c);
    this.bounds = new Float32Array(c * 6);
    this.page = new Int32Array(c);
    this.firstIndex = new Uint32Array(c);
    this.indexCount = new Uint32Array(c);
    this.firstVertex = new Uint32Array(c);
    this.vertexCount = new Uint32Array(c);
    this.instancePage = new Int32Array(c);
    this.firstInstance = new Uint32Array(c);
    this.instanceCount = new Uint32Array(c);
    this.geometry = new Int32Array(c);
    this.fragCount = new Uint32Array(c);
    this.liveFrags = new Uint32Array(c);
    this.visibleFrags = new Uint32Array(c);
    this.head = new Int32Array(c);
    this.triangles = new Float64Array(c);
    this.detailSize = new Float32Array(c * DETAIL_STEPS);
    this.detailCount = new Uint32Array(c * DETAIL_STEPS);
    this.detailLen = new Uint8Array(c);
  }

  /** Removed member slots still occupying the item. */
  holes(i: number): number {
    return this.fragCount[i] - this.liveFrags[i];
  }

  alloc(kind: number): number {
    let i: number;
    if (this.freeList.length > 0) i = this.freeList.pop()!;
    else {
      i = this.highWater++;
      if (i >= this.capacity) this.growTo(this.capacity * 2);
    }
    this.kind[i] = kind;
    this.transparent[i] = 0;
    this.page[i] = -1;
    this.instancePage[i] = -1;
    this.firstIndex[i] = this.indexCount[i] = 0;
    this.firstVertex[i] = this.vertexCount[i] = 0;
    this.firstInstance[i] = this.instanceCount[i] = 0;
    this.geometry[i] = -1;
    this.fragCount[i] = this.liveFrags[i] = this.visibleFrags[i] = 0;
    this.head[i] = -1;
    this.triangles[i] = 0;
    this.detailLen[i] = 0;
    this.liveCount++;
    return i;
  }

  free(i: number): void {
    this.kind[i] = ITEM_FREE;
    this.liveCount--;
    this.freeList.push(i);
  }

  clear(): void {
    this.kind.fill(0);
    this.highWater = 0;
    this.liveCount = 0;
    this.freeList.length = 0;
  }

  private growTo(c: number): void {
    this.capacity = c;
    this.kind = g(this.kind, c);
    this.transparent = g(this.transparent, c);
    this.bounds = g(this.bounds, c * 6);
    this.page = g(this.page, c);
    this.firstIndex = g(this.firstIndex, c);
    this.indexCount = g(this.indexCount, c);
    this.firstVertex = g(this.firstVertex, c);
    this.vertexCount = g(this.vertexCount, c);
    this.instancePage = g(this.instancePage, c);
    this.firstInstance = g(this.firstInstance, c);
    this.instanceCount = g(this.instanceCount, c);
    this.geometry = g(this.geometry, c);
    this.fragCount = g(this.fragCount, c);
    this.liveFrags = g(this.liveFrags, c);
    this.visibleFrags = g(this.visibleFrags, c);
    this.head = g(this.head, c);
    this.triangles = g(this.triangles, c);
    this.detailSize = g(this.detailSize, c * DETAIL_STEPS);
    this.detailCount = g(this.detailCount, c * DETAIL_STEPS);
    this.detailLen = g(this.detailLen, c);
  }
}

function g<T extends Float32Array | Float64Array | Int32Array | Uint32Array | Uint8Array>(a: T, n: number): T {
  const b = new (a.constructor as new (n: number) => T)(n);
  (b as unknown as { set(x: ArrayLike<number>): void }).set(a);
  return b;
}

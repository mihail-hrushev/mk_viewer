/**
 * FragmentList: every placed mesh ("fragment", index = MeshId) as structure-of-arrays.
 *
 * - `records`: the GPU fragment record (layout.ts FRAG_*), FRAG_FLOATS per fragment. Capacity is
 *   always a multiple of FRAG_RECORDS_PER_ROW so it maps 1:1 onto the RGBA32F data texture
 *   (width FRAG_TEX_WIDTH, height `rows`). Dirty rows are tracked in `dirty`.
 * - `bounds`: world AABB, 6 floats per fragment.
 * - `geometry`, `objectId`, `flags` (GPU FragFlags mirror), `state` (CPU lifecycle), `item`
 *   (owning draw item or -1) and `itemNext` (linked list of an item's members).
 * - objectId index: fragments whose objectId equals their own index ("self", the default) are
 *   found directly; all others are linked into a per-objectId doubly linked list whose head is
 *   held in an open-addressing NumberMap. No JS array per object.
 *
 * Lifecycle (`state` bits): Free(0) -> Alive [+Pending while queued for batching] ->
 * Zombie (removed, but vertex/instance data of a draw item still references the index) -> Free.
 * Slots are only recycled once no draw item references them (otherwise stale vertices stamped with
 * the index would render with the new occupant's record).
 */
import {
  FRAG_COLOR,
  FRAG_DEQUANT_OFFSET,
  FRAG_DEQUANT_SCALE,
  FRAG_FLAGS,
  FRAG_FLOATS,
  FRAG_MATERIAL,
  FRAG_MATRIX,
  FRAG_RECORDS_PER_ROW,
  FragFlags,
} from '../layout';
import { DirtyRows } from './DirtyRows';
import { NumberMap } from './NumberMap';
import { transformAabb } from './coremath';

export const STATE_FREE = 0;
export const STATE_ALIVE = 1;
export const STATE_PENDING = 2;
export const STATE_ZOMBIE = 4;

const ROW_SHIFT = Math.log2(FRAG_RECORDS_PER_ROW) | 0;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export class FragmentList {
  /** Allocated slot capacity (multiple of FRAG_RECORDS_PER_ROW). */
  capacity: number;
  /** Slots ever handed out by bump allocation; every index < highWater has been used. */
  highWater = 0;
  /** Alive fragments. */
  liveCount = 0;
  /** Incremented whenever capacity changes (GPU texture must be reallocated and fully uploaded). */
  capacityVersion = 0;

  records: Float32Array;
  bounds: Float32Array;
  geometry: Int32Array;
  objectId: Float64Array;
  /** Batch group: fragments of different groups never share a draw item. */
  group: Int32Array;
  flags: Uint8Array;
  state: Uint8Array;
  item: Int32Array;
  itemNext: Int32Array;
  private objNext: Int32Array;
  private objPrev: Int32Array;
  private readonly objHead = new NumberMap(1024);
  private freeList: Int32Array;
  private freeCount = 0;
  /** freeList[0..freeCount) is sorted descending (pop yields the lowest slot; runs are adjacent). */
  private freeSorted = true;
  readonly dirty: DirtyRows;

  constructor(initialCapacity = FRAG_RECORDS_PER_ROW) {
    const cap = roundCap(initialCapacity);
    this.capacity = cap;
    this.records = new Float32Array(cap * FRAG_FLOATS);
    this.bounds = new Float32Array(cap * 6);
    this.geometry = new Int32Array(cap);
    this.objectId = new Float64Array(cap);
    this.group = new Int32Array(cap);
    this.flags = new Uint8Array(cap);
    this.state = new Uint8Array(cap);
    this.item = new Int32Array(cap).fill(-1);
    this.itemNext = new Int32Array(cap).fill(-1);
    this.objNext = new Int32Array(cap);
    this.objPrev = new Int32Array(cap);
    this.freeList = new Int32Array(64);
    this.dirty = new DirtyRows(cap >> ROW_SHIFT);
  }

  /** Data texture height. */
  get rows(): number {
    return this.capacity >> ROW_SHIFT;
  }

  /** Rows containing any slot ever used (upload range after a capacity change). */
  get usedRows(): number {
    return (this.highWater + FRAG_RECORDS_PER_ROW - 1) >> ROW_SHIFT;
  }

  isAlive(i: number): boolean {
    return i >= 0 && i < this.highWater && (this.state[i] & STATE_ALIVE) !== 0;
  }

  materialOf(i: number): number {
    return this.records[i * FRAG_FLOATS + FRAG_MATERIAL];
  }

  /** Allocates one slot (recycled from the free list when possible, lowest first). */
  alloc(): number {
    if (this.freeCount > 0) {
      // lowest slots first keeps the high free slots contiguous for bulk allocRange()
      if (!this.freeSorted) this.sortFree();
      return this.freeList[--this.freeCount];
    }
    return this.allocRange(1);
  }

  private sortFree(): void {
    const l = this.freeList.subarray(0, this.freeCount);
    l.sort();
    l.reverse();
    this.freeSorted = true;
  }

  /**
   * Allocates `n` consecutive slots (bulk adds need consecutive MeshIds): a run of recycled slots
   * when the free list has one (so load / unload cycles do not grow the slot range), else at the top.
   */
  allocRange(n: number): number {
    if (n > 1 && this.freeCount >= n) {
      const r = this.takeFreeRun(n);
      if (r >= 0) return r;
    } else if (n === 1 && this.freeCount > 0) {
      return this.alloc();
    }
    const first = this.highWater;
    this.ensureCapacity(first + n);
    this.highWater += n;
    return first;
  }

  /** Removes a run of n consecutive free slots from the free list; returns its first slot or -1. */
  private takeFreeRun(n: number): number {
    const fl = this.freeList;
    const cnt = this.freeCount;
    if (!this.freeSorted) this.sortFree();
    // descending order: a run of n is fl[k] = v, fl[k+1] = v - 1, ..., fl[k+n-1] = v - n + 1.
    // Scan from the end (lowest slots first).
    let len = 1;
    for (let k = cnt - 2; k >= 0; k--) {
      if (fl[k] === fl[k + 1] + 1) {
        if (++len === n) {
          const first = fl[k + n - 1];
          fl.copyWithin(k, k + n, cnt);
          this.freeCount = cnt - n;
          return first;
        }
      } else len = 1;
    }
    return -1;
  }

  ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    let cap = this.capacity * 2;
    while (cap < n) cap *= 2;
    cap = roundCap(cap);
    const r = new Float32Array(cap * FRAG_FLOATS);
    r.set(this.records);
    this.records = r;
    const b = new Float32Array(cap * 6);
    b.set(this.bounds);
    this.bounds = b;
    this.geometry = growTo(this.geometry, cap);
    this.objectId = growTo(this.objectId, cap);
    this.group = growTo(this.group, cap);
    this.flags = growTo(this.flags, cap);
    this.state = growTo(this.state, cap);
    const old = this.item.length;
    this.item = growTo(this.item, cap);
    this.item.fill(-1, old);
    this.itemNext = growTo(this.itemNext, cap);
    this.itemNext.fill(-1, old);
    this.objNext = growTo(this.objNext, cap);
    this.objPrev = growTo(this.objPrev, cap);
    this.capacity = cap;
    this.dirty.resize(cap >> ROW_SHIFT);
    this.capacityVersion++;
  }

  /**
   * Initialises an allocated slot as an alive fragment. `dequant`/`localAabb` are the
   * GeometryStore arrays (6 floats per geometry). `m` (column-major 4x4 at offset mo) may be null
   * for identity.
   */
  init(
    i: number,
    geometry: number,
    dequant: Float32Array,
    localAabb: Float32Array,
    material: number,
    objectId: number,
    m: ArrayLike<number> | null,
    mo: number,
  ): void {
    const r = this.records;
    const o = i * FRAG_FLOATS;
    const g = geometry * 6;
    r[o + FRAG_DEQUANT_SCALE] = dequant[g];
    r[o + FRAG_DEQUANT_SCALE + 1] = dequant[g + 1];
    r[o + FRAG_DEQUANT_SCALE + 2] = dequant[g + 2];
    r[o + FRAG_MATERIAL] = material;
    r[o + FRAG_DEQUANT_OFFSET] = dequant[g + 3];
    r[o + FRAG_DEQUANT_OFFSET + 1] = dequant[g + 4];
    r[o + FRAG_DEQUANT_OFFSET + 2] = dequant[g + 5];
    r[o + FRAG_FLAGS] = FragFlags.Visible;
    r[o + FRAG_COLOR] = 0;
    r[o + FRAG_COLOR + 1] = 0;
    r[o + FRAG_COLOR + 2] = 0;
    r[o + FRAG_COLOR + 3] = 0;
    this.geometry[i] = geometry;
    this.group[i] = 0;
    this.flags[i] = FragFlags.Visible;
    this.state[i] = STATE_ALIVE;
    this.item[i] = -1;
    this.itemNext[i] = -1;
    this.objectId[i] = i;
    if (objectId !== i) this.setObjectId(i, objectId);
    this.writeTransform(i, m ?? IDENTITY, m ? mo : 0, localAabb, g);
    this.liveCount++;
    this.dirty.mark(i >> ROW_SHIFT);
  }

  /** Sets the world transform (column-major 4x4) and recomputes the world AABB. */
  setTransform(i: number, m: ArrayLike<number>, mo: number, localAabb: Float32Array): void {
    this.writeTransform(i, m, mo, localAabb, this.geometry[i] * 6);
    this.dirty.mark(i >> ROW_SHIFT);
  }

  /** Reads the world matrix back as column-major 4x4 into out. */
  getTransform(i: number, out: Float32Array | number[]): void {
    const r = this.records;
    const o = i * FRAG_FLOATS + FRAG_MATRIX;
    for (let row = 0; row < 3; row++) {
      for (let c = 0; c < 4; c++) out[c * 4 + row] = r[o + row * 4 + c];
    }
    out[3] = out[7] = out[11] = 0;
    out[15] = 1;
  }

  setFlags(i: number, flags: number): void {
    this.flags[i] = flags;
    this.records[i * FRAG_FLOATS + FRAG_FLAGS] = flags;
    this.dirty.mark(i >> ROW_SHIFT);
  }

  setMaterial(i: number, material: number): void {
    this.records[i * FRAG_FLOATS + FRAG_MATERIAL] = material;
    this.dirty.mark(i >> ROW_SHIFT);
  }

  /** Colour override: linear rgb + blend strength a (0 = none). */
  setColor(i: number, r: number, g: number, b: number, a: number): void {
    const o = i * FRAG_FLOATS + FRAG_COLOR;
    this.records[o] = r;
    this.records[o + 1] = g;
    this.records[o + 2] = b;
    this.records[o + 3] = a;
    this.dirty.mark(i >> ROW_SHIFT);
  }

  setObjectId(i: number, id: number): void {
    const cur = this.objectId[i];
    if (cur === id) return;
    if (cur !== i && cur === cur) this.unlinkObject(i);
    this.objectId[i] = id;
    if (id !== i) {
      const head = this.objHead.get(id);
      this.objPrev[i] = -1;
      this.objNext[i] = head;
      if (head >= 0) this.objPrev[head] = i;
      this.objHead.set(id, i);
    }
  }

  /**
   * Removes an alive fragment from the scene: clears its flags (shader collapses it), unlinks it
   * from the objectId index and marks it Zombie (Pending bit preserved). The slot is not reusable
   * until release().
   */
  kill(i: number): void {
    const cur = this.objectId[i];
    if (cur !== i && cur === cur) this.unlinkObject(i);
    this.objectId[i] = NaN;
    this.setFlags(i, 0);
    this.state[i] = (this.state[i] & STATE_PENDING) | STATE_ZOMBIE;
    this.liveCount--;
  }

  /** Returns a zombie slot to the free list. */
  release(i: number): void {
    this.state[i] = STATE_FREE;
    this.item[i] = -1;
    this.itemNext[i] = -1;
    if (this.freeCount >= this.freeList.length) {
      const f = new Int32Array(this.freeList.length * 2);
      f.set(this.freeList);
      this.freeList = f;
    }
    if (this.freeCount > 0 && this.freeList[this.freeCount - 1] < i) this.freeSorted = false;
    this.freeList[this.freeCount++] = i;
  }

  /** Iteration over alive fragments with a given objectId: first, then nextOfObject(). */
  firstOfObject(id: number): number {
    if ((id | 0) === id && id >= 0 && id < this.highWater && this.objectId[id] === id) return id;
    return this.objHead.get(id);
  }

  nextOfObject(i: number, id: number): number {
    if (i === id) return this.objHead.get(id);
    return this.objNext[i];
  }

  /** Calls fn for every alive fragment carrying objectId `id`. */
  forEachOfObject(id: number, fn: (fragment: number) => void): void {
    for (let f = this.firstOfObject(id); f >= 0; f = this.nextOfObject(f, id)) fn(f);
  }

  /** Reports dirty texture rows (firstRow, rowCount) and clears them. */
  flushDirty(fn: (firstRow: number, rowCount: number) => void): void {
    this.dirty.flush(fn);
  }

  /** Removes all fragments (capacity kept). */
  clear(): void {
    this.records.fill(0, 0, this.highWater * FRAG_FLOATS);
    this.state.fill(0, 0, this.highWater);
    this.flags.fill(0, 0, this.highWater);
    this.item.fill(-1, 0, this.highWater);
    this.itemNext.fill(-1, 0, this.highWater);
    if (this.highWater > 0) this.dirty.markRange(0, (this.highWater - 1) >> ROW_SHIFT);
    this.highWater = 0;
    this.liveCount = 0;
    this.freeCount = 0;
    this.freeSorted = true;
    this.objHead.clear();
  }

  private unlinkObject(i: number): void {
    const p = this.objPrev[i];
    const n = this.objNext[i];
    if (n >= 0) this.objPrev[n] = p;
    if (p >= 0) {
      this.objNext[p] = n;
    } else {
      const id = this.objectId[i];
      if (n >= 0) this.objHead.set(id, n);
      else this.objHead.delete(id);
    }
  }

  private writeTransform(
    i: number,
    m: ArrayLike<number>,
    mo: number,
    localAabb: Float32Array,
    lo: number,
  ): void {
    const r = this.records;
    const o = i * FRAG_FLOATS + FRAG_MATRIX;
    // column-major 4x4 -> three rows [m_r0, m_r1, m_r2, t_r]
    r[o] = m[mo];
    r[o + 1] = m[mo + 4];
    r[o + 2] = m[mo + 8];
    r[o + 3] = m[mo + 12];
    r[o + 4] = m[mo + 1];
    r[o + 5] = m[mo + 5];
    r[o + 6] = m[mo + 9];
    r[o + 7] = m[mo + 13];
    r[o + 8] = m[mo + 2];
    r[o + 9] = m[mo + 6];
    r[o + 10] = m[mo + 10];
    r[o + 11] = m[mo + 14];
    transformAabb(m, mo, localAabb, lo, this.bounds, i * 6);
  }
}

function roundCap(n: number): number {
  return Math.max(FRAG_RECORDS_PER_ROW, Math.ceil(n / FRAG_RECORDS_PER_ROW) * FRAG_RECORDS_PER_ROW);
}

function growTo<T extends Int32Array | Float64Array | Uint8Array>(a: T, cap: number): T {
  const b = new (a.constructor as new (n: number) => T)(cap);
  (b as unknown as { set(x: ArrayLike<number>): void }).set(a);
  return b;
}

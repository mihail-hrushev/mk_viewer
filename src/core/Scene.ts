/**
 * Scene: facade over the CPU data core. One object the Viewer/Renderer drives:
 *
 *   per frame:  scene.flush()                  // queued meshes -> draw items (once per frame)
 *               upload dirty data: scene.fragments.flushDirty(...), scene.materials.flushDirty(...),
 *                                  pages (see Pages.ts contract)
 *               scene.traverse(view, drawList) // culled, ordered draw list
 *   when idle:  scene.compact(budgetMs)
 *
 * All per-mesh state lives in typed arrays; bulk adds create no per-instance JS objects.
 */
import type { Color, GeometryData, MaterialParams, Mat4, ObjectIdRange, ObjectSelection } from '../types';
import { FragFlags } from '../layout';
import { Batcher, type BatcherOptions } from './Batcher';
import { DrawBVH, DrawList, type CullView } from './DrawBVH';
import { DrawItems } from './DrawItems';
import { FragmentList } from './FragmentList';
import { GeometryStore, type GeometryStoreOptions } from './GeometryStore';
import { MaterialStore } from './MaterialStore';
import { PagePool, type PagePoolOptions } from './Pages';
import { linearToSrgb, srgbToLinear } from './coremath';
import { grow } from './util';

export interface SceneOptions extends BatcherOptions {
  pages?: PagePoolOptions;
  geometry?: GeometryStoreOptions;
  /** Initial fragment capacity (rounded up to a texture row). */
  initialFragmentCapacity?: number;
}

export class Scene {
  readonly geometries: GeometryStore;
  readonly materials: MaterialStore;
  readonly fragments: FragmentList;
  readonly pages: PagePool;
  readonly batcher: Batcher;
  readonly items: DrawItems;
  readonly bvh = new DrawBVH();
  /** Triangles of all alive meshes. */
  triangleCount = 0;

  private selection = new Float64Array(16);
  private selectionCount = 0;
  /**
   * Objects given a colour override by setColor, in first-coloured order. May hold ids whose meshes
   * were removed since; getColoredObjects prunes them.
   */
  private readonly colored = new Set<number>();
  private readonly colorTmp = new Float64Array(4);
  private highlighted = NaN;
  private mark = new Uint8Array(0);

  constructor(opts: SceneOptions = {}) {
    this.geometries = new GeometryStore(opts.geometry);
    this.materials = new MaterialStore();
    this.fragments = new FragmentList(opts.initialFragmentCapacity);
    this.pages = new PagePool(opts.pages);
    this.batcher = new Batcher(this.geometries, this.materials, this.fragments, this.pages, opts);
    this.items = this.batcher.items;
  }

  /** Alive meshes. */
  get meshCount(): number {
    return this.fragments.liveCount;
  }

  // --- geometry / material -------------------------------------------------

  createGeometry(data: GeometryData): number {
    return this.geometries.add(data);
  }

  releaseGeometry(id: number): void {
    this.geometries.release(id);
  }

  createMaterial(params?: MaterialParams): number {
    return this.materials.create(params);
  }

  /**
   * Invalidates a material handle; its slot is recycled once no alive mesh uses it (meshes still
   * referencing it keep rendering with it until removed or given another material).
   */
  releaseMaterial(id: number): boolean {
    return this.materials.release(id);
  }

  updateMaterial(id: number, params: MaterialParams): void {
    if (!this.materials.update(id, params)) return;
    // opaque <-> transparent: affected fragments must move to items of the other pass
    const fr = this.fragments;
    const items = this.items;
    const t = this.materials.transparent[id];
    for (let f = 0; f < fr.highWater; f++) {
      const it = fr.item[f];
      if (it < 0 || !fr.isAlive(f) || fr.materialOf(f) !== id) continue;
      if (items.transparent[it] !== t) this.batcher.rebuildItem(it);
    }
  }

  // --- meshes ----------------------------------------------------------------

  /** Adds one mesh; returns its MeshId (fragment index). objectId defaults to the MeshId. */
  addMesh(geometry: number, material: number, transform?: Mat4 | null, objectId?: number, group = 0): number {
    this.checkGeometry(geometry);
    this.checkMaterial(material);
    if (transform && transform.length < 16) throw new Error('transform must have 16 elements');
    const fr = this.fragments;
    const gs = this.geometries;
    const f = fr.alloc();
    fr.init(f, geometry, gs.dequant, gs.aabb, material, objectId ?? f, transform ?? null, 0);
    fr.group[f] = group;
    gs.addUse(geometry);
    this.materials.addUse(material);
    this.triangleCount += gs.indexCount[geometry] / 3;
    this.batcher.enqueue(f);
    return f;
  }

  /**
   * Bulk add of `transforms.length / 16` instances of one geometry. Returns the first MeshId; the
   * others follow consecutively. `material` is one id or one per instance; objectIds default to
   * the MeshIds.
   */
  addMeshes(
    geometry: number,
    material: number | ArrayLike<number>,
    transforms: ArrayLike<number>,
    objectIds?: ArrayLike<number>,
    group = 0,
  ): number {
    this.checkGeometry(geometry);
    const n = transforms.length / 16;
    if (n !== (n | 0)) throw new Error('transforms length must be a multiple of 16');
    const perInstance = typeof material !== 'number';
    if (perInstance) {
      if (material.length < n) throw new Error('material array shorter than instance count');
      for (let i = 0; i < n; i++) this.checkMaterial(material[i]);
    } else this.checkMaterial(material);
    if (objectIds && objectIds.length < n) throw new Error('objectIds shorter than instance count');
    const fr = this.fragments;
    const gs = this.geometries;
    const first = fr.allocRange(n);
    const dq = gs.dequant;
    const aabb = gs.aabb;
    const ms = this.materials;
    for (let i = 0; i < n; i++) {
      const f = first + i;
      const mat = perInstance ? (material as ArrayLike<number>)[i] : (material as number);
      fr.init(f, geometry, dq, aabb, mat, objectIds ? objectIds[i] : f, transforms, i * 16);
      if (perInstance) ms.addUse(mat);
    }
    if (!perInstance) ms.addUse(material as number, n);
    if (group !== 0) fr.group.fill(group, first, first + n);
    gs.addUse(geometry, n);
    this.triangleCount += (n * gs.indexCount[geometry]) / 3;
    this.batcher.enqueueRange(first, n);
    return first;
  }

  /** Removes meshes; unknown / already removed ids are ignored. Returns the number removed. */
  remove(ids: number | ArrayLike<number>): number {
    if (typeof ids === 'number') return this.removeOne(ids) ? 1 : 0;
    let n = 0;
    for (let i = 0; i < ids.length; i++) if (this.removeOne(ids[i])) n++;
    return n;
  }

  /** Removes every mesh and draw item (geometries with API handles and materials are kept). */
  clear(): void {
    this.batcher.clear();
    this.pages.clear();
    this.fragments.clear();
    this.geometries.resetUses();
    this.materials.resetUses();
    this.triangleCount = 0;
    this.selectionCount = 0;
    this.highlighted = NaN;
    this.colored.clear();
  }

  setTransform(id: number, transform: Mat4): void {
    if (!this.fragments.isAlive(id)) return;
    if (transform.length < 16) throw new Error('transform must have 16 elements');
    this.fragments.setTransform(id, transform, 0, this.geometries.aabb);
    this.batcher.boundsChanged(id);
  }

  /**
   * Bulk transform update of consecutive MeshIds first .. first + n - 1 (n = transforms.length / 16);
   * not-alive ids are skipped. Draw item bounds are refitted exactly at the next flush, once per item.
   */
  setTransforms(first: number, transforms: ArrayLike<number>): void {
    const n = Math.floor(transforms.length / 16);
    const fr = this.fragments;
    const aabb = this.geometries.aabb;
    const b = this.batcher;
    for (let i = 0; i < n; i++) {
      const f = first + i;
      if (!fr.isAlive(f)) continue;
      fr.setTransform(f, transforms, i * 16, aabb);
      b.boundsChanged(f);
    }
  }

  setMaterial(id: number, material: number): void {
    const fr = this.fragments;
    if (!fr.isAlive(id)) return;
    this.checkMaterial(material);
    const old = fr.materialOf(id);
    if (old === material) return;
    fr.setMaterial(id, material);
    this.materials.addUse(material);
    this.materials.removeUse(old);
    const it = fr.item[id];
    if (it >= 0 && this.items.transparent[it] !== this.materials.transparent[material]) {
      this.batcher.rebuildItem(it);
    }
  }

  isAlive(id: number): boolean {
    return this.fragments.isAlive(id);
  }

  /** objectId of a mesh (NaN when not alive). */
  objectIdOf(id: number): number {
    return this.fragments.isAlive(id) ? this.fragments.objectId[id] : NaN;
  }

  // --- per-objectId state -------------------------------------------------------

  setVisible(objectIds: ObjectSelection, visible: boolean): void {
    const set = visible ? FragFlags.Visible : 0;
    const clr = visible ? 0 : FragFlags.Visible;
    forEachObject(objectIds, (id) => this.objectFlags(id, set, clr));
  }

  /**
   * Shows only these objects (made visible, un-ghosted); others are ghosted, or hidden when
   * hideOthers. `null` ends isolation (same as showAll()).
   */
  isolate(objectIds: ObjectSelection | null, hideOthers = false): void {
    if (objectIds === null) {
      this.showAll();
      return;
    }
    const fr = this.fragments;
    const hw = fr.highWater;
    this.mark = grow(this.mark, hw);
    const mark = this.mark;
    mark.fill(0, 0, hw);
    forEachObject(objectIds, (id) => {
      for (let f = fr.firstOfObject(id); f >= 0; f = fr.nextOfObject(f, id)) mark[f] = 1;
    });
    const V = FragFlags.Visible;
    const G = FragFlags.Ghosted;
    for (let f = 0; f < hw; f++) {
      if (!fr.isAlive(f)) continue;
      const cur = fr.flags[f];
      let nf: number;
      if (mark[f]) nf = (cur | V) & ~G;
      else if (hideOthers) nf = cur & ~(V | G);
      else nf = cur | G;
      this.applyFlags(f, nf);
    }
  }

  /** Every mesh visible and un-ghosted. */
  showAll(): void {
    const fr = this.fragments;
    for (let f = 0; f < fr.highWater; f++) {
      if (!fr.isAlive(f)) continue;
      this.applyFlags(f, (fr.flags[f] | FragFlags.Visible) & ~FragFlags.Ghosted);
    }
  }

  /** Colour override (sRGB; optional 4th component = blend strength, default 1); null restores. */
  setColor(objectIds: ObjectSelection, color: Color | null): void {
    let r = 0, g = 0, b = 0, a = 0;
    if (color) {
      r = srgbToLinear(color[0]);
      g = srgbToLinear(color[1]);
      b = srgbToLinear(color[2]);
      a = color.length > 3 ? (color as number[])[3] : 1;
    }
    const fr = this.fragments;
    const colored = this.colored;
    const one = (id: number) => {
      let f = fr.firstOfObject(id);
      if (f < 0) return; // no mesh: nothing to colour, and not remembered
      if (a > 0) colored.add(id); // strength 0 is no override, as getColor reports it
      else colored.delete(id);
      for (; f >= 0; f = fr.nextOfObject(f, id)) fr.setColor(f, r, g, b, a);
    };
    forEachObject(objectIds, one);
  }

  /**
   * The objects that have a colour override, in the order they were first coloured: exactly those
   * for which getColor is true. Objects whose meshes were removed since are dropped.
   */
  getColoredObjects(): number[] {
    const out: number[] = [];
    for (const id of this.colored) {
      if (this.getColor(id, this.colorTmp)) out.push(id);
      else this.colored.delete(id); // deleting during iteration of a Set is safe
    }
    return out;
  }

  /**
   * Colour override of an object's first alive mesh into out (sRGB rgb + strength). False when the
   * object has no mesh or no override.
   */
  getColor(objectId: number, out: Float64Array | number[]): boolean {
    const f = this.fragments.firstOfObject(objectId);
    if (f < 0) return false;
    this.fragments.getColor(f, out);
    if (!(out[3] > 0)) return false;
    out[0] = linearToSrgb(out[0]);
    out[1] = linearToSrgb(out[1]);
    out[2] = linearToSrgb(out[2]);
    return true;
  }

  /** Replaces the selection. */
  select(objectIds: ArrayLike<number>): void {
    const S = FragFlags.Selected;
    for (let i = 0; i < this.selectionCount; i++) this.objectFlags(this.selection[i], 0, S);
    this.selection = grow(this.selection, objectIds.length);
    for (let i = 0; i < objectIds.length; i++) {
      this.selection[i] = objectIds[i];
      this.objectFlags(objectIds[i], S, 0);
    }
    this.selectionCount = objectIds.length;
  }

  getSelection(): number[] {
    return Array.from(this.selection.subarray(0, this.selectionCount));
  }

  /** Hover highlight of one object (null clears). */
  setHighlighted(objectId: number | null): void {
    const H = FragFlags.Highlighted;
    if (this.highlighted === this.highlighted) this.objectFlags(this.highlighted, 0, H);
    this.highlighted = objectId ?? NaN;
    if (objectId !== null) this.objectFlags(objectId, H, 0);
  }

  /** Sets/clears FragFlags bits on every mesh carrying objectId. */
  objectFlags(objectId: number, set: number, clear: number): void {
    const fr = this.fragments;
    for (let f = fr.firstOfObject(objectId); f >= 0; f = fr.nextOfObject(f, objectId)) {
      this.applyFlags(f, (fr.flags[f] | set) & ~clear);
    }
  }

  /** Sets/clears FragFlags bits on one mesh. */
  meshFlags(id: number, set: number, clear: number): void {
    if (this.fragments.isAlive(id)) this.applyFlags(id, (this.fragments.flags[id] | set) & ~clear);
  }

  // --- bounds -------------------------------------------------------------------

  /**
   * Exact world bounds of the given objects (or all alive meshes) as a new Float32Array(6), or
   * null when empty. O(meshes) for the whole scene; intended for fit-to-view, not per frame.
   */
  getBounds(objectIds?: ObjectSelection): Float32Array | null {
    const fr = this.fragments;
    const b = fr.bounds;
    const out = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    let any = false;
    const acc = (f: number) => {
      const o = f * 6;
      if (b[o] < out[0]) out[0] = b[o];
      if (b[o + 1] < out[1]) out[1] = b[o + 1];
      if (b[o + 2] < out[2]) out[2] = b[o + 2];
      if (b[o + 3] > out[3]) out[3] = b[o + 3];
      if (b[o + 4] > out[4]) out[4] = b[o + 4];
      if (b[o + 5] > out[5]) out[5] = b[o + 5];
      any = true;
    };
    if (objectIds !== undefined) {
      forEachObject(objectIds, (id) => {
        for (let f = fr.firstOfObject(id); f >= 0; f = fr.nextOfObject(f, id)) acc(f);
      });
    } else {
      for (let f = 0; f < fr.highWater; f++) if (fr.isAlive(f)) acc(f);
    }
    return any ? out : null;
  }

  /**
   * Conservative bounds of everything batched (BVH root; may include removed meshes until
   * compaction). Cheap; use for near/far planes. Returns false when empty.
   */
  getDrawBounds(out: Float32Array): boolean {
    this.updateBvh();
    return this.bvh.rootBounds(out);
  }

  // --- per frame -------------------------------------------------------------------

  /** Batches queued meshes. Call once per frame before uploading/traversing. Returns items created. */
  flush(): number {
    return this.batcher.flush();
  }

  /** Time-sliced compaction of draw items (call when idle). Returns true when items changed. */
  compact(budgetMs: number): boolean {
    return this.batcher.compact(budgetMs);
  }

  /** Rebuilds/refits the BVH if needed. traverse() calls this. */
  updateBvh(): void {
    this.bvh.update(this.items, this.batcher.structureVersion, this.batcher.boundsVersion);
  }

  /** Culls and orders draw items into `out`. Returns the number of entries. */
  traverse(view: CullView, out: DrawList): number {
    this.updateBvh();
    return this.bvh.traverse(this.items, view, out);
  }

  // ---------------------------------------------------------------------------

  private removeOne(id: number): boolean {
    const fr = this.fragments;
    if (!fr.isAlive(id)) return false;
    this.triangleCount -= this.geometries.indexCount[fr.geometry[id]] / 3;
    // a removed fragment is collapsed (flags 0), so its material slot may be recycled right away
    this.materials.removeUse(fr.materialOf(id));
    return this.batcher.removeFragment(id);
  }

  private applyFlags(f: number, nf: number): void {
    const fr = this.fragments;
    const cur = fr.flags[f];
    if (cur === nf) return;
    fr.setFlags(f, nf);
    if ((cur ^ nf) & FragFlags.Visible) this.batcher.visibilityChanged(f, (nf & FragFlags.Visible) !== 0);
  }

  private checkGeometry(id: number): void {
    if (!this.geometries.isAlive(id)) throw new Error(`invalid geometry id ${id}`);
  }

  private checkMaterial(id: number): void {
    if (!this.materials.isValid(id)) throw new Error(`invalid material id ${id}`);
  }
}

/** True for `{ first, count }`. */
export function isObjectIdRange(sel: unknown): sel is ObjectIdRange {
  return typeof sel === 'object' && sel !== null && typeof (sel as ObjectIdRange).first === 'number' &&
    typeof (sel as ObjectIdRange).count === 'number' && (sel as ArrayLike<number>).length === undefined;
}

/** Calls fn for every objectId of a selection (one id, a list, or a `{ first, count }` range). */
export function forEachObject(sel: ObjectSelection, fn: (id: number) => void): void {
  if (typeof sel === 'number') fn(sel);
  else if (isObjectIdRange(sel)) {
    const end = sel.first + sel.count;
    for (let id = sel.first; id < end; id++) fn(id);
  } else for (let i = 0; i < sel.length; i++) fn(sel[i]);
}

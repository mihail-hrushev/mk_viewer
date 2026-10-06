/**
 * LoadContext implementation (tracking wrappers over ViewerApi) and the Model it produces.
 */
import type {
  GeometryData,
  GeometryId,
  Mat4,
  MaterialId,
  MaterialParams,
  MeshBatchParams,
  MeshId,
  MeshParams,
  ObjectIdRange,
  ObjectSelection,
  ViewerApi,
} from '../types';
import { invertAffine } from '../math/mat4';
import { HierarchyStore } from './hierarchy';
import { PropertyIndexImpl } from '../metadata/PropertyIndex';
import { emptyAabb, expandTransformedAabb, identity, multiply } from './mat4d';
import { allocObjectIds } from './objectIds';
import { abortError, Slicer } from './scheduler';
import type { LoadContext, Model, ModelHierarchy, ModelStats, PropertyIndex, PropertyProvider } from './types';

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Growable list of [start, count] runs of consecutive numbers. */
export class Runs {
  data = new Float64Array(32);
  len = 0; // number of float slots used (2 per run)
  total = 0;
  push(start: number, count: number): void {
    if (count <= 0) return;
    this.total += count;
    const d = this.data;
    if (this.len > 0 && d[this.len - 2] + d[this.len - 1] === start) {
      d[this.len - 1] += count;
      return;
    }
    if (this.len + 2 > d.length) {
      const g = new Float64Array(d.length * 2);
      g.set(d);
      this.data = g;
    }
    this.data[this.len++] = start;
    this.data[this.len++] = count;
  }
  fill<T extends Int32Array | Float64Array>(out: T): T {
    let o = 0;
    for (let r = 0; r < this.len; r += 2) {
      const s = this.data[r], c = this.data[r + 1];
      for (let i = 0; i < c; i++) out[o++] = s + i;
    }
    return out;
  }
  min(): number {
    let m = Infinity;
    for (let r = 0; r < this.len; r += 2) m = Math.min(m, this.data[r]);
    return m;
  }
  max(): number {
    let m = -Infinity;
    for (let r = 0; r < this.len; r += 2) m = Math.max(m, this.data[r] + this.data[r + 1]);
    return m;
  }
  contains(v: number): boolean {
    const d = this.data;
    for (let r = 0; r < this.len; r += 2) if (v >= d[r] && v < d[r] + d[r + 1]) return true;
    return false;
  }
}

export interface ContextInit<O> {
  viewer: ViewerApi;
  signal: AbortSignal;
  options: Partial<O>;
  rootTransform: Float64Array | null;
  /** The user placement part of rootTransform (LoadOptions.transform), null = identity. */
  placement: Float64Array | null;
  sliceMs: number;
  onProgress: (fraction: number, stage: string | undefined) => void;
  onWarning: (message: string) => void;
  /** Called after content was added (the Viewer uses it for progressive fitting). */
  onContent?: () => void;
  /** MeshParams.batchGroup of every mesh of this load. */
  batchGroup?: number;
}

/** Everything a load records; becomes the Model on success, or is rolled back on failure. */
export class LoadContextImpl<O> implements LoadContext<O> {
  readonly viewer: ViewerApi;
  readonly signal: AbortSignal;
  readonly options: Readonly<Partial<O>>;
  readonly rootTransform: Float64Array | null;
  readonly placement: Float64Array | null;
  readonly hierarchy = new HierarchyStore();
  readonly slicer: Slicer;

  readonly meshes = new Runs();
  readonly objects = new Runs();
  readonly geometries: GeometryId[] = [];
  readonly materials: MaterialId[] = [];
  readonly warnings: string[] = [];
  readonly bounds = emptyAabb();
  triangles = 0;
  props: Map<number, Record<string, unknown>> | null = null;
  provider: PropertyProvider | null = null;

  /** Per geometry id: local AABB (6) + triangle count (1). */
  private geomInfo = new Map<GeometryId, Float64Array>();
  private finished = false;
  private scratch = new Float64Array(16 * 256);
  private readonly init: ContextInit<O>;
  private readonly hasGeomBounds: boolean;

  constructor(init: ContextInit<O>) {
    this.init = init;
    this.viewer = init.viewer;
    this.signal = init.signal;
    this.options = init.options;
    this.rootTransform = init.rootTransform;
    this.placement = init.placement;
    this.slicer = new Slicer(init.sliceMs, init.signal);
    this.hasGeomBounds = typeof (init.viewer as Partial<ViewerApi>).getGeometryBounds === 'function';
  }

  progress(fraction: number, stage?: string): void {
    if (!this.finished) this.init.onProgress(fraction, stage);
  }

  warn(message: string): void {
    this.warnings.push(message);
    this.init.onWarning(message);
  }

  throwIfAborted(): void {
    if (this.signal.aborted) throw abortError();
  }

  shouldYield(): boolean {
    return this.slicer.shouldYield();
  }
  yield(): Promise<void> {
    return this.slicer.yield();
  }
  yieldIfNeeded(): Promise<void> {
    return this.slicer.yieldIfNeeded();
  }

  private live(): void {
    if (this.finished) throw new Error('LoadContext used after the load finished');
    if (this.signal.aborted) throw abortError();
  }

  createGeometry(data: GeometryData): GeometryId {
    this.live();
    const id = this.viewer.createGeometry(data);
    this.geometries.push(id);
    if (!this.geomInfo.has(id)) {
      // the viewer already scanned the positions: ask it instead of scanning again
      let info: Float64Array | null = null;
      if (this.hasGeomBounds) {
        const b = this.viewer.getGeometryBounds(id);
        if (b) {
          info = new Float64Array(7);
          info.set(b);
        }
      }
      if (!info) info = scanBounds(data.positions);
      const p = data.positions;
      info[6] = data.indices ? Math.floor(data.indices.length / 3) : Math.floor(p.length / 9);
      this.geomInfo.set(id, info);
    }
    return id;
  }

  createMaterial(params?: MaterialParams): MaterialId {
    this.live();
    const id = this.viewer.createMaterial(params);
    this.materials.push(id);
    return id;
  }

  allocObjectIds(count: number): number {
    this.live();
    const first = allocObjectIds(this.viewer, count);
    this.objects.push(first, count);
    return first;
  }

  private account(geometry: GeometryId, transforms: ArrayLike<number>, n: number): void {
    const info = this.geomInfo.get(geometry);
    if (!info) return; // geometry not created by this load (shared / primitive): no bounds known
    this.triangles += info[6] * n;
    if (info[0] > info[3]) return; // empty
    for (let i = 0; i < n; i++) expandTransformedAabb(this.bounds, info, transforms, i * 16);
  }

  addMesh(params: MeshParams): MeshId {
    this.live();
    let m: ArrayLike<number> = params.transform ?? IDENTITY;
    if (this.rootTransform) {
      multiply(this.scratch, 0, this.rootTransform, 0, m, 0);
      m = this.scratch.subarray(0, 16);
    }
    const objectId = params.objectId ?? this.allocObjectIds(1);
    const id = this.viewer.addMesh({
      geometry: params.geometry,
      material: params.material,
      transform: m,
      objectId,
      batchGroup: this.init.batchGroup ?? params.batchGroup,
    });
    this.meshes.push(id, 1);
    this.account(params.geometry, m, 1);
    this.init.onContent?.();
    return id;
  }

  addMeshes(params: MeshBatchParams): MeshId {
    this.live();
    const n = Math.floor(params.transforms.length / 16);
    let tr = params.transforms;
    if (this.rootTransform) {
      const out = new Float64Array(n * 16);
      for (let i = 0; i < n; i++) multiply(out, i * 16, this.rootTransform, 0, tr, i * 16);
      tr = out;
    }
    let objectIds = params.objectIds;
    if (!objectIds) {
      const first = this.allocObjectIds(n);
      const ids = new Float64Array(n);
      for (let i = 0; i < n; i++) ids[i] = first + i;
      objectIds = ids;
    }
    const id = this.viewer.addMeshes({
      geometry: params.geometry,
      material: params.material,
      transforms: tr,
      objectIds,
      batchGroup: this.init.batchGroup ?? params.batchGroup,
    });
    this.meshes.push(id, n);
    this.account(params.geometry, tr, n);
    this.init.onContent?.();
    return id;
  }

  setProperties(objectId: number, props: Record<string, unknown>): void {
    (this.props ??= new Map()).set(objectId, props);
  }

  setPropertyProvider(provider: PropertyProvider): void {
    this.provider = provider;
  }

  /** Bounds of everything added so far (float64 world), or null. */
  currentBounds(): Float64Array | null {
    const b = this.bounds;
    return b[0] <= b[3] ? b : null;
  }

  /** Ends the context: no further viewer calls are accepted. */
  finish(): void {
    this.finished = true;
    this.slicer.dispose();
    this.geomInfo.clear();
  }

  /** Removes everything this load added (abort / failure). */
  rollback(): void {
    this.finish();
    removeAll(this.viewer, this.meshes, this.geometries, this.materials);
  }
}

function scanBounds(p: ArrayLike<number>): Float64Array {
  const info = new Float64Array(7);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0, n = p.length; i + 2 < n; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  info[0] = x0; info[1] = y0; info[2] = z0; info[3] = x1; info[4] = y1; info[5] = z1;
  return info;
}

function removeAll(viewer: ViewerApi, meshes: Runs, geometries: GeometryId[], materials: MaterialId[]): void {
  // mesh runs are passed run by run: no per-mesh id array for the common (few runs) case
  const d = meshes.data;
  for (let r = 0; r < meshes.len; r += 2) {
    const s = d[r], c = d[r + 1];
    if (c === 1) viewer.remove(s);
    else {
      const ids = new Int32Array(c);
      for (let i = 0; i < c; i++) ids[i] = s + i;
      viewer.remove(ids);
    }
  }
  const seen = new Set<number>();
  for (const g of geometries) {
    if (seen.has(g)) continue;
    seen.add(g);
    viewer.releaseGeometry(g);
  }
  if (typeof (viewer as Partial<ViewerApi>).releaseMaterial === 'function') {
    for (const m of new Set(materials)) viewer.releaseMaterial(m);
  }
}

export class ModelImpl implements Model {
  readonly name: string;
  readonly loader: string;
  readonly stats: ModelStats;
  readonly objectIdRange: { first: number; count: number };
  readonly warnings: readonly string[];
  readonly info: Readonly<Record<string, unknown>>;
  readonly hierarchy: ModelHierarchy;
  readonly properties: PropertyIndex;
  /** Internal: called once by unload() (the Viewer's model registry). */
  onUnload: ((m: ModelImpl) => void) | null = null;
  private _unloaded = false;
  private _visible = true;
  private viewer: ViewerApi;
  private meshes: Runs;
  private objects: Runs;
  private geometries: GeometryId[];
  private materials: MaterialId[];
  private props: Map<number, Record<string, unknown>> | null;
  private provider: PropertyProvider | null;
  private hstore: HierarchyStore;
  /** Load-time bounds and placement. */
  private readonly bounds0: Float64Array | null;
  private readonly placement0: Float64Array;
  private placement: Float64Array;
  private _bounds: Float64Array | null;
  /** World matrices of all meshes at load time, captured by the first setTransform. */
  private base: Float64Array | null = null;

  constructor(ctx: LoadContextImpl<unknown>, name: string, loader: string, info: Record<string, unknown>, loadMs: number) {
    this.viewer = ctx.viewer;
    this.name = name;
    this.loader = loader;
    this.meshes = ctx.meshes;
    this.objects = ctx.objects;
    this.geometries = Array.from(new Set(ctx.geometries));
    this.materials = Array.from(new Set(ctx.materials));
    this.props = ctx.props;
    this.provider = ctx.provider;
    this.hstore = ctx.hierarchy;
    this.hierarchy = ctx.hierarchy;
    this.properties = new PropertyIndexImpl(ctx.hierarchy);
    this.warnings = ctx.warnings;
    this.info = info;
    const b = ctx.bounds;
    this.bounds0 = b[0] <= b[3] ? b : null;
    this._bounds = this.bounds0;
    this.placement0 = ctx.placement ? Float64Array.from(ctx.placement) : identity();
    this.placement = Float64Array.from(this.placement0);
    const first = ctx.objects.total ? ctx.objects.min() : 0;
    this.objectIdRange = { first, count: ctx.objects.total ? ctx.objects.max() - first : 0 };
    this.stats = {
      meshes: ctx.meshes.total,
      triangles: ctx.triangles,
      geometries: this.geometries.length,
      materials: this.materials.length,
      objects: ctx.objects.total,
      nodes: ctx.hierarchy.count,
      loadMs,
    };
  }

  get unloaded(): boolean {
    return this._unloaded;
  }

  get visible(): boolean {
    return this._visible;
  }

  get bounds(): Float64Array | null {
    return this._bounds;
  }

  get transform(): Float64Array {
    return Float64Array.from(this.placement);
  }

  meshIds(): Int32Array {
    return this.meshes.fill(new Int32Array(this.meshes.total));
  }

  objectIds(): Float64Array {
    return this.objects.fill(new Float64Array(this.objects.total));
  }

  objectIdRuns(): Float64Array {
    return this.objects.data.slice(0, this.objects.len);
  }

  containsObject(objectId: number): boolean {
    return this.objects.contains(objectId);
  }

  getProperties(objectId: number): Record<string, unknown> | undefined {
    let out: Record<string, unknown> | undefined;
    const node = this.hstore.nodeOfObject(objectId);
    if (node >= 0) {
      const name = this.hstore.name(node);
      if (name !== undefined) out = { name };
    }
    const explicit = this.props?.get(objectId);
    if (explicit) out = { ...out, ...explicit };
    const lazy = this.provider?.(objectId);
    if (lazy) out = { ...out, ...lazy };
    return out;
  }

  /** The model's objectIds as one selection: a range when contiguous, else the id list. */
  private selection(): ObjectSelection {
    const o = this.objects;
    if (o.len === 2) return { first: o.data[0], count: o.data[1] } as ObjectIdRange;
    return this.objectIds();
  }

  setVisible(visible: boolean): void {
    if (this._unloaded || this.objects.total === 0) return;
    this._visible = visible;
    const o = this.objects;
    for (let r = 0; r < o.len; r += 2) this.viewer.setVisible({ first: o.data[r], count: o.data[r + 1] }, visible);
  }

  isolate(hideOthers = false): void {
    if (this._unloaded) return;
    this._visible = true;
    this.viewer.isolate(this.selection(), hideOthers);
  }

  fitToView(animate = false): void {
    if (this._unloaded || this.objects.total === 0) return;
    this.viewer.fitToView(this.selection(), animate);
  }

  getBounds(): Float64Array | null {
    if (this._unloaded || this.objects.total === 0) return null;
    const out = emptyAabb();
    const o = this.objects;
    for (let r = 0; r < o.len; r += 2) {
      const b = this.viewer.getBounds({ first: o.data[r], count: o.data[r + 1] });
      if (!b) continue;
      for (let i = 0; i < 3; i++) {
        if (b[i] < out[i]) out[i] = b[i];
        if (b[i + 3] > out[i + 3]) out[i + 3] = b[i + 3];
      }
    }
    return out[0] <= out[3] ? out : null;
  }

  setTransform(transform: Mat4): void {
    if (this._unloaded) return;
    if (transform.length < 16) throw new Error('Model.setTransform: transform must have 16 elements');
    const p = Float64Array.from({ length: 16 }, (_, i) => +transform[i]);
    const inv0 = invertAffine(new Float64Array(16), this.placement0);
    if (!inv0) throw new Error('Model.setTransform: the load-time placement is not invertible');
    // delta from the load-time placement: W' = P' * P0^-1 * W0 (no accumulation over calls)
    const d = new Float64Array(16);
    multiply(d, 0, p, 0, inv0, 0);
    const v = this.viewer;
    const m = this.meshes;
    if (!this.base) {
      const base = new Float64Array(m.total * 16);
      let k = 0;
      for (let r = 0; r < m.len; r += 2) {
        const c = m.data[r + 1];
        v.getTransforms(m.data[r], c, base.subarray(k * 16, (k + c) * 16));
        k += c;
      }
      this.base = base;
    }
    const base = this.base;
    let maxRun = 0;
    for (let r = 0; r < m.len; r += 2) maxRun = Math.max(maxRun, m.data[r + 1]);
    const out = new Float64Array(maxRun * 16);
    let k = 0;
    for (let r = 0; r < m.len; r += 2) {
      const c = m.data[r + 1];
      for (let i = 0; i < c; i++) multiply(out, i * 16, d, 0, base, (k + i) * 16);
      v.setTransforms(m.data[r], c === maxRun ? out : out.subarray(0, c * 16));
      k += c;
    }
    this.placement = p;
    if (this.bounds0) {
      const b = emptyAabb();
      expandTransformedAabb(b, this.bounds0, d, 0);
      this._bounds = b;
    }
  }

  unload(): void {
    if (this._unloaded) return;
    this._unloaded = true;
    removeAll(this.viewer, this.meshes, this.geometries, this.materials);
    this.meshes = new Runs();
    this.geometries = [];
    this.materials = [];
    this.base = null;
    // metadata may hold large parsed data (e.g. glTF nodes): drop it even if the app keeps the Model
    this.provider = null;
    this.props = null;
    (this.properties as PropertyIndexImpl).dispose();
    this.hstore.dropNames();
    const cb = this.onUnload;
    this.onUnload = null;
    cb?.(this);
  }
}

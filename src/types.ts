/**
 * Public API types of mk-viewer. The Viewer class (src/Viewer.ts) implements `ViewerApi`.
 *
 * Conventions: right-handed coordinates, 4x4 matrices are column-major (gl-matrix / glTF layout),
 * colours are sRGB in 0..1, angles are radians.
 */

import type { LoaderInput, LoaderPlugin, LoadOptions, LoadTask, Model } from './loaders/types';

export type Vec3 = [number, number, number] | Float32Array;
export type Color = [number, number, number] | [number, number, number, number];
/** Column-major 4x4, 16 numbers. Must be affine. */
export type Mat4 = ArrayLike<number>;

/** Opaque handles. Numeric so bulk APIs can use typed arrays. */
export type GeometryId = number;
export type MaterialId = number;
/** Identifies one placed mesh (a "fragment"). Stable until removed. */
export type MeshId = number;

/** The consecutive objectIds first .. first + count - 1 (e.g. a loaded model's ids). */
export interface ObjectIdRange {
  first: number;
  count: number;
}

/** objectIds for per-object operations: one id, a list, or a `{ first, count }` range. */
export type ObjectSelection = number | ArrayLike<number> | ObjectIdRange;

export interface ViewerOptions {
  /** World up axis. Default 'y'. */
  up?: 'y' | 'z';
  /** Background colour(s): one colour or [top, bottom] gradient. */
  background?: Color | [Color, Color];
  /** CPU/GPU time budget per frame in ms while the camera moves. Default 12. */
  frameBudgetMs?: number;
  /** Objects whose projected size is below this many pixels are skipped while moving. Default 2. */
  cullPixelSize?: number;
  /** Same threshold for the final still image. Default 0.5. */
  cullPixelSizeStill?: number;
  /** Device pixel ratio cap. Default min(devicePixelRatio, 2). */
  pixelRatio?: number;
  /** Install built-in orbit/pan/zoom controls. Default true. */
  controls?: boolean;
  /** Click-to-select and hover highlight handled by the viewer. Default true. */
  autoSelect?: boolean;
  /**
   * Loader plugins of this viewer (`viewer.load`). When given (even empty), this per-viewer registry
   * is used instead of the shared `defaultRegistry`; `registerLoader` adds to it. Plugins are only
   * bundled when imported, e.g. `loaders: [gltfLoader, objLoader]`.
   */
  loaders?: LoaderPlugin<any>[];
}

export interface GeometryData {
  /** xyz triples. */
  positions: ArrayLike<number>;
  /** Triangle list. If omitted, positions are taken as non-indexed triangles. */
  indices?: ArrayLike<number>;
  /** xyz triples. If omitted, normals are computed (flat for non-indexed, smooth for indexed). */
  normals?: ArrayLike<number>;
}

export interface MaterialParams {
  /** sRGB colour; alpha < 1 makes the material transparent. Default [0.8, 0.8, 0.8, 1]. */
  color?: Color;
  metalness?: number;
  roughness?: number;
  /** 0..1, how much the base colour glows independent of lighting. */
  emissive?: number;
}

export interface MeshParams {
  geometry: GeometryId;
  material: MaterialId;
  /** Default identity. */
  transform?: Mat4;
  /**
   * Application-level id reported by picking/selection. Many meshes may share one objectId
   * (e.g. all parts of one door). Default: the MeshId.
   */
  objectId?: number;
  /**
   * Meshes of different batch groups are never consolidated into the same draw item, so a group
   * (e.g. one loaded model) can be culled, moved and unloaded without affecting others' batches.
   * `viewer.load` gives every model its own group. Default 0.
   */
  batchGroup?: number;
}

export interface MeshBatchParams {
  geometry: GeometryId;
  /** One material for all, or one per instance. */
  material: MaterialId | ArrayLike<number>;
  /** 16 * count numbers, column-major matrices back to back. */
  transforms: ArrayLike<number>;
  objectIds?: ArrayLike<number>;
  /** See `MeshParams.batchGroup`. */
  batchGroup?: number;
}

export interface PickResult {
  meshId: MeshId;
  objectId: number;
  /** The loaded model owning the object (undefined for meshes added directly or still loading). */
  model?: Model;
  /** World-space hit position. */
  position: [number, number, number];
  /** Distance from the camera eye. */
  distance: number;
}

export interface CameraState {
  eye: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  /** Vertical field of view (perspective only). */
  fov: number;
  orthographic: boolean;
}

export interface SectionPlane {
  /** Plane normal; geometry on the positive side is cut away. */
  normal: Vec3;
  /** Any point on the plane. */
  point: Vec3;
}

export interface ViewerStats {
  fps: number;
  frameMs: number;
  /** Meshes alive in the scene. */
  meshes: number;
  triangles: number;
  /** Draw items / draw calls / triangles submitted in the last frame. */
  drawItems: number;
  drawCalls: number;
  trianglesDrawn: number;
  /** 0..1, how much of the visible scene the progressive renderer has presented. */
  progress: number;
  gpuMemoryBytes: number;
  /**
   * GPU time of the most recently measured frame in ms (EXT_disjoint_timer_query_webgl2; arrives a
   * few frames late). NaN when the browser does not expose GPU timers.
   */
  gpuMs: number;
}

export interface ViewerEvents {
  /** User clicked; `null` when the background was hit. */
  pick: PickResult | null;
  hover: PickResult | null;
  /** Current selection as objectIds. */
  selection: number[];
  camera: CameraState;
  /** Progressive rendering finished: the image is complete. */
  frameComplete: ViewerStats;
  /** A `viewer.load()` finished; the model is in `viewer.models`. */
  modelLoaded: Model;
  /** A model was unloaded (`model.unload()` or `clear()`). */
  modelUnloaded: Model;
  /** Progress of a running `viewer.load()`. */
  loadProgress: ViewerLoadProgress;
}

export interface ViewerLoadProgress {
  task: LoadTask;
  /** File name (or URL path segment) of the input. */
  name: string;
  /** Overall 0..1, monotonic. */
  fraction: number;
  /** 'download' | 'detect' | plugin stage | 'done' | 'failed' | 'aborted'. */
  stage: string;
}

/** Options of `viewer.load`; `up` defaults to the viewer's up axis, the registry to the viewer's. */
export interface ViewerLoadOptions<O = Record<string, unknown>> extends LoadOptions<O> {
  /**
   * Frame the camera on this model while it loads and when it is done (until the user moves the
   * camera). Default: true when no other model is loaded or loading and the scene is empty; later
   * models never move the camera unless this is true.
   */
  fitToView?: boolean;
}

export interface Primitives {
  box(size?: Vec3): GeometryId;
  sphere(radius?: number, segments?: number): GeometryId;
  cylinder(radius?: number, height?: number, segments?: number): GeometryId;
  cone(radius?: number, height?: number, segments?: number): GeometryId;
  plane(width?: number, depth?: number): GeometryId;
  torus(radius?: number, tube?: number, radialSegments?: number, tubularSegments?: number): GeometryId;
  /** Extrude a closed 2D polygon (xy pairs, counter-clockwise) along +Z (or +Y when up = 'y'). */
  extrusion(outline: ArrayLike<number>, height: number): GeometryId;
}

export interface ViewerApi {
  readonly canvas: HTMLCanvasElement;
  readonly primitives: Primitives;
  readonly stats: ViewerStats;

  /** World up axis (`ViewerOptions.up`). */
  readonly up: 'y' | 'z';

  // --- scene construction (callable at any time, including every frame) ---
  createGeometry(data: GeometryData): GeometryId;
  /** Frees the geometry once no mesh uses it. The handle may be reused afterwards. */
  releaseGeometry(id: GeometryId): void;
  /**
   * Local bounds of a geometry's positions as given to `createGeometry` [minx, miny, minz, maxx,
   * maxy, maxz] (float64, fresh array), or null for an invalid id. O(1).
   */
  getGeometryBounds(id: GeometryId): Float64Array | null;
  createMaterial(params?: MaterialParams): MaterialId;
  updateMaterial(id: MaterialId, params: MaterialParams): void;
  /**
   * Invalidates a material handle (no new meshes or updates with it). Meshes still using it keep
   * rendering with it; its slot is reused once the last of them is removed or re-assigned.
   */
  releaseMaterial(id: MaterialId): void;
  addMesh(params: MeshParams): MeshId;
  /** Bulk add; returns the first MeshId, the rest follow consecutively. */
  addMeshes(params: MeshBatchParams): MeshId;
  remove(ids: MeshId | ArrayLike<number>): void;
  clear(): void;
  setTransform(id: MeshId, transform: Mat4): void;
  /**
   * Bulk `setTransform` of the consecutive MeshIds first .. first + n - 1, n = transforms.length / 16
   * (e.g. the range `addMeshes` returned). Removed ids are skipped. Use Float64Array for large
   * coordinates.
   */
  setTransforms(first: MeshId, transforms: ArrayLike<number>): void;
  /**
   * World matrices of the consecutive MeshIds first .. first + count - 1 (column-major, 16 per mesh;
   * removed ids give zeros) into `out` (allocated when omitted).
   */
  getTransforms(first: MeshId, count: number, out?: Float64Array): Float64Array;
  setMaterial(id: MeshId, material: MaterialId): void;
  /**
   * Reserves `count` consecutive objectIds that no other caller of this method (e.g. another loaded
   * model) receives; returns the first. Ids start at 2^30 so they never collide with the default
   * objectIds (= MeshIds) of meshes added without one.
   */
  allocObjectIds(count: number): number;

  // --- per-object state; these take objectIds and affect every mesh carrying that id ---
  setVisible(objectIds: ObjectSelection, visible: boolean): void;
  /** Show only these objects; everything else is ghosted (or hidden when `hideOthers`). */
  isolate(objectIds: ObjectSelection | null, hideOthers?: boolean): void;
  /** Override colour; `null` restores the material colour. */
  setColor(objectIds: ObjectSelection, color: Color | null): void;
  select(objectIds: ArrayLike<number>): void;
  getSelection(): number[];
  showAll(): void;

  // --- camera ---
  getCamera(): CameraState;
  setCamera(state: Partial<CameraState>, animate?: boolean): void;
  /** Frame the given objects, or the whole scene. */
  fitToView(objectIds?: ObjectSelection, animate?: boolean): void;
  /** World-space bounds [minx, miny, minz, maxx, maxy, maxz] (float64), or null when empty. */
  getBounds(objectIds?: ObjectSelection): Float64Array | null;

  // --- models (loader plugins, federation) ---
  /** Loaded models, in load-completion order (read-only snapshot). */
  readonly models: readonly Model[];
  /**
   * Loads a model with a loader plugin (see src/loaders/README.md). Several loads may run at once;
   * each returns its own abortable task. The first model is framed unless `fitToView: false`.
   */
  load<O = Record<string, unknown>>(input: LoaderInput, options?: ViewerLoadOptions<O>): LoadTask;
  /** Adds a plugin to this viewer's own registry. Returns a function that unregisters it. */
  registerLoader(plugin: LoaderPlugin<any>): () => void;
  /** Model owning an objectId (binary search over the models' id ranges), or undefined. */
  getModelOf(objectId: number): Model | undefined;
  /** Groups objectIds (e.g. the selection) by owning model; ids of no model go under `null`. */
  groupByModel(objectIds: ArrayLike<number>): Map<Model | null, number[]>;

  // --- queries and effects ---
  /** GPU pick at canvas CSS-pixel coordinates. */
  pick(x: number, y: number): Promise<PickResult | null>;
  setSectionPlanes(planes: SectionPlane[]): void;

  // --- lifecycle ---
  on<K extends keyof ViewerEvents>(event: K, handler: (payload: ViewerEvents[K]) => void): () => void;
  /** Call after changing canvas CSS size (a ResizeObserver does this automatically). */
  resize(): void;
  /** Force a redraw; normally not needed. */
  invalidate(): void;
  dispose(): void;
}

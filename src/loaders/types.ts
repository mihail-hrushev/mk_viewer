/**
 * Model-loader plugin contract. This file is the stable surface third parties implement to add their
 * own formats; see `README.md` in this folder for a guide and a minimal skeleton.
 *
 * A plugin turns bytes into viewer content using only the `LoadContext` it is given. The context wraps
 * `ViewerApi` so every geometry/mesh the plugin creates is recorded and can be removed again
 * (`Model.unload()`, abort, failure), applies the global transform / up-axis conversion, allocates
 * scene-unique objectIds and stores metadata compactly.
 */
import type { GeometryData, GeometryId, MaterialId, MaterialParams, Mat4, MeshBatchParams, MeshId, MeshParams, ViewerApi } from '../types';

export type UpAxis = 'y' | 'z';

// ------------------------------------------------------------------------------------------------
// Plugin
// ------------------------------------------------------------------------------------------------

/** What detection can look at before a plugin is chosen. */
export interface LoaderProbe {
  /** File name (or last URL path segment), when known. */
  fileName?: string;
  mimeType?: string;
  /** First bytes of the input (up to 256; may be shorter or empty when unavailable). */
  header: Uint8Array;
}

export interface LoaderPlugin<O = Record<string, unknown>> {
  /** Unique, short, lower-case id, e.g. 'gltf'. Used in errors and for `LoadOptions.loader`. */
  readonly name: string;
  /** Lower-case extensions without the dot; multi-part allowed ('ifc.gz'). */
  readonly extensions: readonly string[];
  readonly mimeTypes?: readonly string[];
  /**
   * Native up axis of the format. When it differs from `LoadOptions.up` the context rotates the whole
   * model; plugins never convert axes themselves. Omit for "no conversion".
   */
  readonly up?: UpAxis;
  /** Content sniffing, used when neither extension nor mime type identifies the input. Must be cheap. */
  canLoad?(probe: LoaderProbe): boolean;
  /**
   * Reads `source` and builds the model through `ctx`. Should `await ctx.yieldIfNeeded()` regularly and
   * let abort errors propagate. May return extra model info.
   */
  load(source: LoaderSource, ctx: LoadContext<O>): Promise<void | Partial<ModelInfoExtras>>;
}

export interface ModelInfoExtras {
  /** Display name (default: the file name). */
  name: string;
  /** Free-form format info (generator, version, units, georeference…). */
  info: Record<string, unknown>;
}

// ------------------------------------------------------------------------------------------------
// Source
// ------------------------------------------------------------------------------------------------

/**
 * Uniform access to the input regardless of origin (URL, File/Blob, ArrayBuffer/Uint8Array).
 * Download progress of URL sources is reported to the load task automatically.
 */
export interface LoaderSource {
  /** File name, or the last path segment of the URL (decoded, without query). */
  readonly name: string;
  /** Absolute or relative URL for URL inputs. */
  readonly url?: string;
  /** Size in bytes when known up front. */
  readonly size?: number;
  readonly mimeType?: string;
  /** Whole content. Not copied when the input already is a buffer; prefer this over `arrayBuffer()`. */
  bytes(): Promise<Uint8Array>;
  /** Whole content as an ArrayBuffer (may copy when the input is a sub-view of a larger buffer). */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Whole content decoded as UTF-8. */
  text(): Promise<string>;
  /** Streaming read, for parsers that can consume incrementally. */
  stream(): ReadableStream<Uint8Array>;
  /**
   * Bytes [start, end). Efficient for Blobs and buffers; for URLs an HTTP Range request (falls back to
   * downloading everything when the server ignores ranges; the result is then cached).
   */
  readRange(start: number, end: number): Promise<Uint8Array>;
  /**
   * Opens a sibling resource (external .bin of a .gltf, .mtl of an .obj…). `data:` URIs always work;
   * URLs resolve relative to this source; for Files/buffers `LoadOptions.resolve` must be supplied,
   * otherwise reading the returned source rejects with a clear error.
   */
  resolve(uri: string): LoaderSource;
}

/** Inputs `loadModel` accepts (and `LoadOptions.resolve` may return). */
export type LoaderInput = string | URL | Blob | ArrayBuffer | Uint8Array;

/**
 * Maps a URI referenced from a file to its content, e.g. a lookup in a set of dropped files.
 * `uri` is percent-decoded. Return undefined to fall back to the default (URL-relative) resolution.
 */
export type ResourceResolver = (
  uri: string,
  from: LoaderSource,
) => LoaderInput | undefined | Promise<LoaderInput | undefined>;

// ------------------------------------------------------------------------------------------------
// Context
// ------------------------------------------------------------------------------------------------

/**
 * Metadata hierarchy (names, parent/child tree) stored columnar: a parent index array, an objectId
 * array and lazily resolved names. No per-node objects are created.
 */
export interface HierarchyBuilder {
  /** Number of nodes added so far (node indices are 0..count-1 in insertion order). */
  readonly count: number;
  /**
   * Adds one node. `parent`: an earlier node index, or -1 for a root. `objectId` links the node to
   * meshes (NaN/omitted when the node has no own object).
   */
  addNode(parent: number, name?: string, objectId?: number): number;
  /**
   * Bulk add. `parents[i]` is a node index in the same index space (already offset: pass absolute
   * indices; -1 = root, -2 = detached / not part of the tree). Names are produced lazily by
   * `name(i)` (i = index within this batch) only when asked for. Returns the first node index.
   */
  addNodes(parents: ArrayLike<number>, objectIds?: ArrayLike<number>, name?: (i: number) => string | undefined): number;
}

/** Lazily computes properties for an objectId of this model (undefined = none). */
export type PropertyProvider = (objectId: number) => Record<string, unknown> | undefined;

export interface LoadContext<O = Record<string, unknown>> {
  readonly viewer: ViewerApi;
  readonly signal: AbortSignal;
  /** Plugin-specific options (`LoadOptions.options`). */
  readonly options: Readonly<Partial<O>>;
  /**
   * Model-to-world matrix (user transform x up conversion) applied automatically by `addMesh`/
   * `addMeshes`; null when identity. For information only.
   */
  readonly rootTransform: Float64Array | null;

  /** Reports progress of the parse/build phase, 0..1, with an optional stage label. */
  progress(fraction: number, stage?: string): void;
  /** Non-fatal problem; collected in `Model.warnings` and forwarded to `LoadOptions.onWarning`. */
  warn(message: string): void;
  /** Throws an AbortError when the load was aborted. */
  throwIfAborted(): void;

  /** True when the current time slice is used up (or the load was aborted). ~one clock read. */
  shouldYield(): boolean;
  /** Yields to the event loop (macrotask) and starts a new slice; rejects with AbortError when aborted. */
  yield(): Promise<void>;
  /**
   * `shouldYield() ? yield() : resolved promise`. Call freely in loops: `await ctx.yieldIfNeeded()`.
   * In the hottest loops use `if (ctx.shouldYield()) await ctx.yield();` to skip the await.
   */
  yieldIfNeeded(): Promise<void>;

  // --- tracked scene construction (use these, not ctx.viewer.*, so the model can be unloaded) ---
  createGeometry(data: GeometryData): GeometryId;
  createMaterial(params?: MaterialParams): MaterialId;
  /** objectId defaults to a freshly allocated one (never the MeshId). Transform is model-local. */
  addMesh(params: MeshParams): MeshId;
  /** objectIds default to freshly allocated ones. Transforms are model-local. */
  addMeshes(params: MeshBatchParams): MeshId;

  /**
   * Reserves `count` consecutive scene-unique objectIds; returns the first. Delegates to
   * `viewer.allocObjectIds` (one allocator for the whole scene, so models never share ids).
   */
  allocObjectIds(count: number): number;

  // --- metadata ---
  readonly hierarchy: HierarchyBuilder;
  /** Explicit properties for an objectId (stored in a map: use for sparse data). */
  setProperties(objectId: number, props: Record<string, unknown>): void;
  /** Lazy properties for any objectId of this model; merged over the explicit ones on lookup. */
  setPropertyProvider(provider: PropertyProvider): void;
}

// ------------------------------------------------------------------------------------------------
// loadModel options, task and result
// ------------------------------------------------------------------------------------------------

export interface LoadProgress {
  /** Overall 0..1 (download and build phases combined), monotonic. */
  fraction: number;
  /** 'download' | 'detect' | plugin-defined stage | 'done'. */
  stage: string;
  /** Bytes, for download stages. */
  loaded?: number;
  total?: number;
}

export interface LoadOptions<O = Record<string, unknown>> {
  /** Registry to pick the plugin from (default: the shared `defaultRegistry`). */
  registry?: import('./registry').LoaderRegistry;
  /** Force a plugin (name or instance) instead of detection. */
  loader?: string | LoaderPlugin<any>;
  /** Overrides the file name (used for detection and as model name). Useful for Blob/buffer inputs. */
  name?: string;
  mimeType?: string;
  /** External abort signal (the task's `abort()` works too). */
  signal?: AbortSignal;
  onProgress?: (p: LoadProgress) => void;
  onWarning?: (message: string) => void;
  /**
   * Placement: extra model-to-world transform (column-major, affine), applied after the up
   * conversion and composed in float64 (georeferenced placements ~1e7 keep full precision).
   * `model.setTransform` changes it later.
   */
  transform?: Mat4;
  /** Up axis of the scene (the viewer's `up`). Default 'y'. */
  up?: UpAxis;
  /** Treat the file as having this up axis instead of the plugin's declared one. */
  sourceUp?: UpAxis;
  /** Time-slice budget for `yieldIfNeeded`, ms. Default 8. */
  sliceMs?: number;
  /** Resolves sibling resources (required for multi-file inputs given as Files/buffers). */
  resolve?: ResourceResolver;
  /** Extra fetch options for URL inputs (headers, credentials, …). */
  fetchInit?: RequestInit;
  /** Plugin-specific options, passed through as `ctx.options`. */
  options?: Partial<O>;
}

export interface ModelStats {
  meshes: number;
  triangles: number;
  geometries: number;
  materials: number;
  /** objectIds allocated. */
  objects: number;
  /** Metadata hierarchy nodes. */
  nodes: number;
  loadMs: number;
}

/** Read access to the metadata tree. Node indices are 0..nodeCount-1. */
export interface ModelHierarchy {
  readonly nodeCount: number;
  roots(): Int32Array;
  children(node: number): Int32Array;
  /** -1 for roots, -2 for detached nodes. */
  parent(node: number): number;
  name(node: number): string | undefined;
  /** NaN when the node has no own objectId. */
  objectId(node: number): number;
  /** Node carrying this objectId, or -1. */
  nodeOfObject(objectId: number): number;
}

export interface Model {
  readonly name: string;
  /** Plugin that loaded it. */
  readonly loader: string;
  readonly stats: Readonly<ModelStats>;
  /**
   * World-space [minx, miny, minz, maxx, maxy, maxz] (float64), or null when empty. Computed at load
   * time and moved with `setTransform` (exact for translations, conservative under rotation);
   * `getBounds()` gives the exact current bounds.
   */
  readonly bounds: Float64Array | null;
  /**
   * All objectIds of this model lie in [first, first+count). With concurrent loads other models' ids
   * may interleave; `objectIdRuns()` gives the exact ranges.
   */
  readonly objectIdRange: { first: number; count: number };
  /** Current placement (LoadOptions.transform, or the last `setTransform`); identity when none. */
  readonly transform: Float64Array;
  /** False after `setVisible(false)`. */
  readonly visible: boolean;
  readonly warnings: readonly string[];
  readonly info: Readonly<Record<string, unknown>>;
  readonly hierarchy: ModelHierarchy;
  /** True after `unload()`. */
  readonly unloaded: boolean;
  /** MeshIds of this model (fresh array). */
  meshIds(): Int32Array;
  /** objectIds of this model (fresh array). */
  objectIds(): Float64Array;
  /** Node name and plugin-provided properties for an objectId of this model. */
  getProperties(objectId: number): Record<string, unknown> | undefined;
  /** The exact objectId ranges of this model as [first0, count0, first1, count1, ...] (fresh array). */
  objectIdRuns(): Float64Array;
  /** True when the objectId belongs to this model. */
  containsObject(objectId: number): boolean;
  /** Shows / hides the whole model (other models untouched). */
  setVisible(visible: boolean): void;
  /** Shows only this model; all other content is ghosted, or hidden with `hideOthers`. */
  isolate(hideOthers?: boolean): void;
  /** Frames the camera on this model. */
  fitToView(animate?: boolean): void;
  /** Exact current world bounds of the model's meshes (float64), or null when empty / unloaded. */
  getBounds(): Float64Array | null;
  /**
   * Re-places the model: replaces the placement (LoadOptions.transform) by `transform`, composed in
   * float64 like at load time. One bulk update of all meshes; repeated calls do not accumulate error.
   */
  setTransform(transform: Mat4): void;
  /**
   * Removes the model's meshes and releases its geometries and materials (geometry shared with other
   * models stays until they are unloaded too). Names and properties are dropped as well; the Model
   * object only keeps its stats and id ranges. Idempotent.
   */
  unload(): void;
}

/** A running load: a Promise of the Model with abort and progress. */
export interface LoadTask extends Promise<Model> {
  abort(): void;
  /** Subscribes to progress; returns an unsubscribe function. */
  onProgress(cb: (p: LoadProgress) => void): () => void;
  /** Latest overall progress 0..1. */
  readonly progress: number;
}

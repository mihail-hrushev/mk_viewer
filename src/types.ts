/**
 * Public API types of mk-viewer. The Viewer class (src/Viewer.ts) implements `ViewerApi`.
 *
 * Conventions: right-handed coordinates, 4x4 matrices are column-major (gl-matrix / glTF layout),
 * colours are sRGB in 0..1, angles are radians.
 */

import type {
  LoaderInput,
  LoaderPlugin,
  LoadOptions,
  LoadTask,
  Model,
  PropertyKeyInfo,
  PropertyMatch,
  PropertyQuery,
} from './loaders/types';
import type { PluginInstance, ViewerPlugin } from './plugins/types';

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
  /**
   * Lowest frame rate the renderer may drop to in order to show a more complete image while the
   * camera moves. Heavy scenes are drawn as fully as fits into 1 / minFps seconds per frame; only
   * what does not fit is left for the still image. Higher values keep motion smoother but drop
   * more detail while moving (60 = never miss a display refresh). Default 15.
   */
  minFps?: number;
  /** Frame time budget in ms; overrides `minFps` (budget = 1000 / minFps). */
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
  /**
   * Image-based lighting from the start (see `ViewerApi.setEnvironment`). Loaded asynchronously; a
   * failure is reported on the console and the default lighting stays.
   */
  environment?: EnvironmentSource;
  /** Options for `environment`. */
  environmentOptions?: EnvironmentOptions;
  /** Edge display from the start: `true` for the defaults, or its options (see `setEdges`). Default off. */
  edges?: boolean | EdgeOptions;
  /**
   * Selection x-ray from the start: `true` for the defaults, or its options (see
   * `setSelectionXray`). Default off.
   */
  selectionXray?: boolean | SelectionXrayOptions;
  /** Ghost-hidden mode from the start (see `setGhostHidden`). Default off. */
  ghostHidden?: boolean;
  /**
   * Viewer plugins (tools, overlays, UI additions; see docs/PLUGIN_API.md), installed in this
   * order at the end of construction. Not to be confused with `loaders` (file format plugins).
   * When one fails to install, the viewer is disposed and the constructor throws.
   */
  plugins?: ViewerPlugin<any>[];
}

/**
 * Linear RGB equirectangular (longitude / latitude) HDR pixels: 3 floats per pixel, rows from the
 * top (sky, the image's up) to the bottom, the centre column looking towards -Z of the image.
 */
export interface EnvironmentImage {
  width: number;
  height: number;
  data: Float32Array;
}

/**
 * Light source for image-based lighting:
 *  - `'studio'`: built-in neutral studio preset (generated in code);
 *  - any other string: URL of a Radiance `.hdr` file;
 *  - a `Blob` / `File`, `ArrayBuffer` or `Uint8Array` holding a Radiance `.hdr` file;
 *  - raw `EnvironmentImage` pixels.
 * Only Radiance RGBE `.hdr` is supported as a file format (no OpenEXR).
 */
export type EnvironmentSource = 'studio' | (string & {}) | Blob | ArrayBuffer | Uint8Array | EnvironmentImage;

export interface EnvironmentOptions {
  /** Relative brightness of the environment light (the image is auto-exposed). Default 1. */
  intensity?: number;
  /** Rotation of the environment about the world up axis, radians. Default 0. */
  rotation?: number;
  /**
   * 0..1: how much of the camera-attached key light is kept on top of the environment. A little
   * headlight keeps shapes readable from every side. Default 0.25.
   */
  keyLight?: number;
}

/** Options of the edge display (`setEdges`). */
export interface EdgeOptions {
  /** sRGB line colour. Default [0.1, 0.1, 0.1]. */
  color?: Color;
  /** 0..1, how strongly lines cover the surface colour. Default 0.75. */
  opacity?: number;
  /**
   * Faces meeting at an angle (between their normals, degrees) below this get no line, so curved
   * surfaces stay clean. Same meaning and default as `SnapOptions.edgeAngle`. Default 20.
   */
  creaseAngle?: number;
}

/** The active edge display settings (`getEdges`). */
export interface EdgeInfo {
  color: [number, number, number];
  opacity: number;
  creaseAngle: number;
}

/** Options of the selection x-ray (`setSelectionXray`). */
export interface SelectionXrayOptions {
  /** sRGB line colour. Default [1, 0.62, 0.1], the selection outline colour. */
  color?: Color;
  /** 0..1. Default 1. */
  opacity?: number;
  /** Line width in CSS pixels (1..8). Default 2. */
  width?: number;
}

/** The active selection x-ray settings (`getSelectionXray`). */
export interface SelectionXrayInfo {
  color: [number, number, number];
  opacity: number;
  width: number;
}

/** The active environment (`getEnvironment`, `environment` event). */
export interface EnvironmentInfo {
  /** 'studio', the file name / last URL segment, or 'environment' for bytes and raw pixels. */
  name: string;
  intensity: number;
  rotation: number;
  keyLight: number;
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

/** How `snap` placed the point. */
export type SnapKind = 'vertex' | 'edge' | 'surface';

export interface SnapOptions {
  /**
   * Magnet tolerance in CSS pixels, converted to a world radius at the hit depth. Default 12, or 24
   * for `pointerType: 'touch'`.
   */
  radius?: number;
  /** The kind of pointer the position comes from; 'touch' gets the larger default radius. */
  pointerType?: string;
  /** Snap to vertices. Default true. */
  vertices?: boolean;
  /** Snap to feature edges (boundaries and creases). Default true. */
  edges?: boolean;
  /**
   * Edges between faces whose normals differ by less than this angle (degrees) are not features
   * (e.g. the diagonal of a flat quad). Default 20.
   */
  edgeAngle?: number;
}

/** Result of `snap`: a picked mesh point moved to the nearest vertex or feature edge. */
export interface SnapResult extends PickResult {
  kind: SnapKind;
  /** The raw surface point under the cursor (world). `position` is the snapped point. */
  hit: [number, number, number];
  /** For kind 'edge': the edge's end points (world). */
  edge?: [[number, number, number], [number, number, number]];
}

/** `worldToScreen` result. */
export interface ScreenPoint {
  /** Canvas CSS pixels from the left / top edge (meaningless when `inFront` is false). */
  x: number;
  y: number;
  /** Distance in front of the eye along the view direction (negative behind the eye). */
  depth: number;
  /** In front of the camera (perspective: depth > 0; orthographic: always). */
  inFront: boolean;
  /** In front and inside the canvas rectangle. */
  inView: boolean;
}

/** Pointer details passed to a `ViewerTool`. */
export interface ToolPointerInfo {
  /** PointerEvent.pointerType: 'mouse', 'pen' or 'touch'. */
  pointerType: string;
  /** Ctrl, meta or shift was held. */
  modifier: boolean;
}

/** Why a tool was deactivated. */
export type ToolEndReason = 'api' | 'replaced' | 'escape' | 'dispose';

/**
 * An interactive tool that takes over clicks while active (`viewer.setTool`). While a tool is
 * active, clicks / taps go to `onTap` instead of selecting, double click / double tap does not
 * zoom (both clicks arrive as taps), and the viewer's hover highlight is off. Camera navigation
 * (drag, wheel, pinch, keys) keeps working; a drag never produces a tap.
 */
export interface ViewerTool {
  readonly name: string;
  /** CSS cursor over the canvas while active. Default 'crosshair'. */
  cursor?: string;
  /** Click / tap (not a drag) at canvas CSS pixel (x, y). */
  onTap?(x: number, y: number, info: ToolPointerInfo): void;
  /** Mouse / pen moved over the canvas with no button pressed and no camera interaction running. */
  onPointerMove?(x: number, y: number, info: ToolPointerInfo): void;
  /** The pointer left the canvas, or a camera interaction started. */
  onPointerLeave?(): void;
  /**
   * Escape was pressed. Return true when the tool handled it (e.g. cancelled a half-done
   * operation) and stays active; otherwise the tool is deactivated.
   */
  onEscape?(): boolean | void;
  /**
   * Right click (not a right-button drag) on the canvas. Return true to consume it: the built-in
   * context menu (and any other `contextmenu` listener added after the viewer) is then not shown.
   */
  onContextMenu?(x: number, y: number): boolean | void;
  /** The tool stopped being the active tool. */
  onDeactivate?(reason: ToolEndReason): void;
}

/**
 * Where and on what a context menu was opened (right click without drag, long press on touch, or
 * `openContextMenu`). Passed to the `visible`, `enabled` and `onClick` callbacks of every
 * `ContextMenuItem` of that menu.
 */
export interface ContextMenuContext {
  /** Canvas CSS pixels of the right click. */
  readonly x: number;
  readonly y: number;
  /** PointerEvent.pointerType of the right click: 'mouse', 'pen' or 'touch'. */
  readonly pointerType: string;
  /** The object under the pointer, or null on the background. */
  readonly hit: PickResult | null;
  /**
   * The objects the menu acts on (objectIds): the selection, or, when nothing is selected, the
   * object under the pointer. A right click never changes the selection. May be empty (right click
   * on the background with nothing selected).
   */
  readonly selection: readonly number[];
}

/**
 * Maps a clicked object to the objects a click selects (`viewer.setSelectionResolver`): a
 * selection level plugin returns the object's spool or isometric, for example. Return null for
 * the default (the object itself). Called per click, so it should be cheap.
 */
export type SelectionResolver = (hit: PickResult) => ArrayLike<number> | null;

/**
 * An entry of the canvas context menu (`viewer.addContextMenuItem`, `PluginContext.addContextMenuItem`):
 * either an action (`onClick`) or a submenu (`items`).
 */
export interface ContextMenuItem {
  label: string;
  /** Tooltip. */
  title?: string;
  /**
   * Sort key: lower first, equal keys in registration order. Items of equal `order` form a group;
   * the built-in menu draws a line between groups. The built-in UI's own items use -100. Default 0.
   * Inside a submenu the key sorts and groups the submenu's own items.
   */
  order?: number;
  /** A colour swatch drawn before the label (sRGB, 0..1). */
  color?: Color;
  /** Listed only when this returns true. Default: always listed. */
  visible?(context: ContextMenuContext): boolean;
  /**
   * Listed but disabled when this returns false. Default: always enabled. A disabled submenu does
   * not open.
   */
  enabled?(context: ContextMenuContext): boolean;
  /** The item was chosen. Required unless the item is a submenu (`items`). */
  onClick?(context: ContextMenuContext): void;
  /**
   * Makes the item a submenu with these items (same type, so they can nest). Their `visible` and
   * `enabled` are evaluated with the same context; a submenu whose items are all hidden is listed
   * but disabled.
   */
  items?: ContextMenuItem[];
}

/** A listed item of a `ContextMenuRequest`, with `visible` / `enabled` already evaluated. */
export interface ContextMenuEntry {
  readonly label: string;
  readonly title?: string;
  readonly order: number;
  readonly enabled: boolean;
  /** See `ContextMenuItem.color`. */
  readonly color?: Color;
  /** The listed items of a submenu entry, sorted by `order`; absent on an action entry. */
  readonly items?: readonly ContextMenuEntry[];
  /**
   * Calls the item's `onClick` with the request's context (errors are logged); no-op when disabled
   * and on a submenu entry.
   */
  run(): void;
}

/**
 * Payload of the `contextMenu` event: a menu was requested, here are its items. The built-in UI
 * (`createViewerUi`) shows them; to show your own menu instead, call `preventDefault()` synchronously
 * in your handler and call `entry.run()` for the chosen entry.
 */
export interface ContextMenuRequest extends ContextMenuContext {
  /** The visible items, sorted by `order`. May be empty. */
  readonly items: readonly ContextMenuEntry[];
  /** Asks the built-in menu not to show this request. */
  preventDefault(): void;
  readonly defaultPrevented: boolean;
}

/** Payload of the `view` event. */
export interface ViewInfo {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
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
  /** The environment lighting changed (`null`: back to the default lighting). */
  environment: EnvironmentInfo | null;
  /**
   * The mapping of world points to the canvas changed: the camera moved (also every frame of an
   * animated transition) or the canvas was resized. Emitted inside the animation frame, before the
   * image of that frame is presented, so DOM positioned with `worldToScreen` here stays glued to
   * the model. Never emitted while nothing moves.
   */
  view: ViewInfo;
  /** A viewer plugin was installed (`plugins` option or `use`). */
  pluginInstalled: { name: string; instance: PluginInstance };
  /** A viewer plugin was removed (`removePlugin`), after its `dispose()`. Not emitted by `viewer.dispose()`. */
  pluginRemoved: { name: string; instance: PluginInstance };
  /** A context menu was requested (see `ContextMenuRequest`). */
  contextMenu: ContextMenuRequest;
}

/** Result of `viewer.findObjects`: the matches of all loaded models together. */
export interface PropertySearch {
  /** objectIds of every match (the matching nodes and everything below them), ascending, no duplicates. */
  objectIds: Float64Array;
  /** `in` queries: per input value, the number of matching nodes over all models (0 = not found); else null. */
  hits: Int32Array | null;
  /** Per model with at least one match: its own result. */
  matches: { model: Model; match: PropertyMatch }[];
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
  /**
   * Colour override of every mesh of these objects (sRGB; an optional 4th component is the blend
   * strength over the material colour, default 1; opacity is never changed). `null` removes the
   * override, restoring the material colour.
   */
  setColor(objectIds: ObjectSelection, color: Color | null): void;
  /**
   * The colour override of an object as set by `setColor` ([r, g, b, strength], sRGB, rounded to 6
   * decimals), or null when it has none or does not exist. Reads the object's first mesh.
   */
  getColor(objectId: number): [number, number, number, number] | null;
  /**
   * Every object that currently has a colour override, whoever set it, in the order they were
   * first coloured (a new array). Lets a plugin or application reset or restore colours it did not
   * set itself before applying its own.
   */
  getColoredObjects(): number[];
  /** Removes every colour override: `setColor(getColoredObjects(), null)`. */
  clearColors(): void;
  select(objectIds: ArrayLike<number>): void;
  getSelection(): number[];
  /**
   * Installs the function that maps a clicked object to what the click selects (`autoSelect`):
   * all of it is selected, or, with Ctrl / Shift, added to the selection, or removed when all of
   * it was selected. Also what the context menu acts on when nothing is selected. One resolver at
   * a time; null restores the default (the object itself). The hover highlight stays on the object.
   */
  setSelectionResolver(resolver: SelectionResolver | null): void;
  showAll(): void;

  // --- camera ---
  getCamera(): CameraState;
  setCamera(state: Partial<CameraState>, animate?: boolean): void;
  /** Frame the given objects, or the whole scene. */
  fitToView(objectIds?: ObjectSelection, animate?: boolean): void;
  /**
   * Looks at the centre of the objects' bounding box from 3x its largest side away, keeping the
   * view direction; the centre becomes the orbit pivot (what a double click on an object does).
   * `animate` defaults to true.
   */
  zoomToObjects(objectIds: ObjectSelection, animate?: boolean): void;
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
  /**
   * Searches the properties of every loaded model (`model.properties.find` on each, merged): one
   * value, a list of thousands of values, a prefix or a numeric range against one key (node names
   * are under the key `name`). The result's `objectIds` go straight into `select`, `isolate`,
   * `setColor` or `fitToView`; `hits` tells which input values were not found. Each model's index
   * is built on its first query.
   */
  findObjects(query: PropertyQuery): PropertySearch;
  /** The property keys of all loaded models, merged by name (`count` and `distinct` summed), alphabetically. */
  propertyKeys(): PropertyKeyInfo[];

  // --- queries and effects ---
  /** GPU pick at canvas CSS-pixel coordinates. */
  pick(x: number, y: number): Promise<PickResult | null>;
  /**
   * GPU pick at canvas CSS pixel (x, y), then a "magnet" on the picked mesh: the nearest vertex
   * within the tolerance, else the nearest point on a feature edge (boundary or crease), else the
   * surface point. Only geometry within the tolerance of the hit point in 3D is considered, so
   * hidden or distant parts of the mesh are never chosen. Resolves null on the background.
   */
  snap(x: number, y: number, options?: SnapOptions): Promise<SnapResult | null>;
  /**
   * Projects a world point (float64) to canvas CSS pixels with the current camera. Allocation-free
   * when `out` is given.
   */
  worldToScreen(point: ArrayLike<number>, out?: ScreenPoint): ScreenPoint;
  setSectionPlanes(planes: SectionPlane[]): void;
  /**
   * Image-based lighting: lights the scene with an HDR environment image (diffuse from its
   * irradiance, reflections from the image blurred by roughness) instead of the default
   * hemisphere light; `null` returns to the default lighting. The image is auto-exposed, so
   * `intensity` is relative. Resolves once the new lighting is in place; rejects for an unreadable
   * source (only Radiance `.hdr` files are supported). A later call supersedes one still loading
   * (the earlier promise then resolves without applying anything). Calling it again with the same
   * source object / string only changes the options, without reloading the image.
   */
  setEnvironment(source: EnvironmentSource | null, options?: EnvironmentOptions): Promise<void>;
  /** The active environment, or null for the default lighting. */
  getEnvironment(): EnvironmentInfo | null;
  /**
   * Edge display ("display edges"): thin dark lines along the real edges of the visible surfaces -
   * creases sharper than `creaseAngle`, silhouettes, and boundaries between touching meshes -
   * but never along the diagonals of flat faces. Computed in screen space while presenting, so it
   * does not depend on triangle counts; switching it on costs one extra 2-byte-per-pixel render
   * target and a little more work in the final pass. Omitted options take their defaults. Default
   * off.
   */
  setEdges(enabled: boolean, options?: EdgeOptions): void;
  /** The active edge display settings, or null when edges are off. */
  getEdges(): EdgeInfo | null;
  /**
   * Selection x-ray: the border of the selection drawn on top of everything, so a selection stays
   * visible through whatever is in front of it. The line follows the silhouette of the selected
   * objects against everything that is not selected, hidden parts and holes included, but not the
   * boundaries between selected objects nor the creases and edges inside them; it is `width` CSS
   * pixels wide. Found on a second
   * image that holds only the selected objects. Independent of the edge display. Costs an id +
   * depth target of its own and a pass over the draw items that hold selected objects whenever the
   * view or the selection changes. While on, the lines replace the selection outline (the selection
   * tint stays). Defaults: the selection outline colour `[1, 0.62, 0.1]`, opacity 1, width 2.
   * Default off.
   */
  setSelectionXray(enabled: boolean, options?: SelectionXrayOptions): void;
  /** The active selection x-ray settings, or null when it is off. */
  getSelectionXray(): SelectionXrayInfo | null;
  /**
   * Ghost-hidden mode: objects hidden with `setVisible(false)` or `isolate(ids, true)` are drawn
   * faintly, like ghosted ones (not pickable, no ids, no edges), instead of not at all, so what
   * was hidden stays in context. Their visibility state is unchanged: `setVisible(true)` and
   * `showAll` work as before, and switching the mode off hides them again. Costs one more blended
   * pass over the draw items per image while hidden objects exist. Default off.
   */
  setGhostHidden(enabled: boolean): void;
  /** Whether the ghost-hidden mode is on. */
  getGhostHidden(): boolean;

  // --- tools and plugins ---
  /**
   * Makes `tool` the active tool (see `ViewerTool`), or deactivates the current one with null. Only
   * one tool is active at a time: activating another deactivates the previous one (its
   * `onDeactivate('replaced')` is called). Escape deactivates the tool unless it handles it.
   */
  setTool(tool: ViewerTool | null): void;
  /** The active tool, or null. */
  getTool(): ViewerTool | null;
  /**
   * Installs a viewer plugin and returns its instance. Throws when a plugin with the same name is
   * installed, or when its `install` throws (the plugin is then not installed).
   */
  use<T extends PluginInstance>(plugin: ViewerPlugin<T>): T;
  /** The instance of an installed plugin, or undefined. */
  getPlugin<T = PluginInstance>(name: string): T | undefined;
  /**
   * Uninstalls a viewer plugin: calls its `dispose()`, removes what it registered through its
   * `PluginContext` (context menu items) and emits `pluginRemoved` (the built-in UI then runs the
   * cleanup its `ui()` hook returned). Returns false when no plugin of that name is installed.
   */
  removePlugin(name: string): boolean;
  /** Names of the installed viewer plugins, in install order. */
  readonly plugins: readonly string[];

  // --- context menu ---
  /**
   * Adds an entry to the canvas context menu (right click without drag; long press on touch).
   * Returns a function that removes it. Plugins should use `PluginContext.addContextMenuItem`, which
   * also removes the entry when the plugin is removed. The viewer only collects the entries and
   * emits `contextMenu`; the built-in UI (`createViewerUi`) draws the menu.
   */
  addContextMenuItem(item: ContextMenuItem): () => void;
  /**
   * Opens the context menu as a right click at canvas CSS pixel (x, y) would: picks under the point
   * (see `ContextMenuContext.selection`; the selection is not changed) and emits `contextMenu`.
   * Resolves with the emitted request, or null when superseded by a newer request.
   */
  openContextMenu(x: number, y: number, pointerType?: string): Promise<ContextMenuRequest | null>;

  // --- lifecycle ---
  on<K extends keyof ViewerEvents>(event: K, handler: (payload: ViewerEvents[K]) => void): () => void;
  /** Call after changing canvas CSS size (a ResizeObserver does this automatically). */
  resize(): void;
  /** Force a redraw; normally not needed. */
  invalidate(): void;
  dispose(): void;
}

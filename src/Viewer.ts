/**
 * mk-viewer public entry point: `new Viewer(canvas, options)` implements `ViewerApi` (src/types.ts).
 *
 * Usage notes
 *
 * - Scene edits (createGeometry, addMesh(es), remove, setTransform, setColor, ...) may be called at
 *   any time, including every frame. Added meshes are batched once per frame; edits are cheap writes
 *   into typed arrays. The progressive renderer redraws automatically; `invalidate()` is never
 *   required.
 * - Colours are sRGB in 0..1. The optional 4th component means different things:
 *     * `MaterialParams.color[3]` is the material OPACITY (< 1 makes the material transparent,
 *       drawn in the blended pass);
 *     * `setColor(ids, [r, g, b, a])` is an override whose 4th component is the BLEND STRENGTH of the
 *       override over the material colour (default 1 = full replacement, 0.5 = half tint). It never
 *       changes opacity.
 * - Large coordinates (e.g. georeferenced data around 1e7) are supported: geometry is recentred at
 *   creation and the scene is rendered relative to a float64 origin chosen from the first mesh (see
 *   src/render/origin.ts). All API values (transforms, camera, pick positions, bounds, section
 *   planes) are plain world coordinates; the origin is invisible to callers.
 * - `stats.frameMs` is the CPU time of the last rendered frame (traversal + submission), `fps` the
 *   rate of rendered frames while the renderer is busy (the loop idles when the image is complete).
 * - Picking (`pick`, hover, click selection) reads the GPU id buffer of the image on screen, so it
 *   reflects what is drawn: while a heavy image is still being refined, small objects not drawn yet
 *   are not pickable.
 * - Models: `load()` runs a loader plugin (registered explicitly: `ViewerOptions.loaders`,
 *   `registerLoader`, or the shared `defaultRegistry`). Several loads may run concurrently; they share
 *   one round-robin time-slicing scheduler and appear progressively. Loaded models are listed in
 *   `models`; each owns disjoint objectId ranges (`getModelOf` is a binary search over them) and can
 *   be hidden, isolated, framed, re-placed (`model.setTransform`) and unloaded on its own.
 * - Handles: geometry and material ids are recycled after release (once no mesh uses them).
 * - Precision: the float64 scene origin is fixed by the first mesh (until `clear()`). Mesh placements
 *   are stored as float32 relative to it, so a mesh at distance d from the origin is shifted rigidly
 *   by up to ulp(d) / 2 (the shader cancels the large terms per mesh, so shapes do not deform):
 *   <= 1 mm up to d = 1.6e4, 4 mm at 1e5, 16 mm at 5e5, 31 mm at 1e6 units. Federated models should
 *   therefore lie within ~1e5 units of each other (they may all be ~1e7 from world 0). The near plane
 *   follows visible content, so a far-away model does not clip close-ups of another.
 */
import type {
  CameraState,
  Color,
  ContextMenuContext,
  ContextMenuEntry,
  ContextMenuItem,
  ContextMenuRequest,
  EdgeInfo,
  EdgeOptions,
  SelectionXrayInfo,
  SelectionXrayOptions,
  EnvironmentInfo,
  EnvironmentOptions,
  EnvironmentSource,
  GeometryData,
  GeometryId,
  Mat4,
  MaterialId,
  MaterialParams,
  MeshBatchParams,
  MeshId,
  MeshParams,
  PickResult,
  Primitives,
  ScreenPoint,
  SectionPlane,
  SnapOptions,
  SnapResult,
  ObjectSelection,
  PropertySearch,
  ToolEndReason,
  ViewerApi,
  ViewerEvents,
  ViewerLoadOptions,
  ViewerOptions,
  ViewerStats,
  ViewerTool,
} from './types';
import type { PluginContext, PluginInstance, ViewerPlugin } from './plugins/types';
import { createCanvasLayer, type CanvasLayer } from './plugins/overlay';
import { SNAP_EDGE, SNAP_VERTEX, Snapper, type SnapQuery } from './core/snap';
import type { LoaderInput, LoaderPlugin, LoadTask, Model, PropertyKeyInfo, PropertyMatch, PropertyQuery } from './loaders/types';
import type { LoadContextImpl, ModelImpl } from './loaders/context';
import { loadModel } from './loaders/loadModel';
import { defaultRegistry, LoaderRegistry } from './loaders/registry';
import { DEFAULT_OBJECT_ID_BASE } from './loaders/objectIds';
import { FRAG_TEX_WIDTH, FragFlags, MAX_SECTION_PLANES } from './layout';
import { Scene } from './core';
import { GlContext, planeFromNormalPoint } from './gl';
import { Camera, CameraTransition, OrbitControls } from './camera';
import * as prim from './primitives';
import { Renderer, type RenderHost } from './render/Renderer';
import { foldTransform, needsRecentre, positionsBounds, shiftPositions, transformedCenter } from './render/origin';
import { prepareEnvironment, readEnvironmentSource, type PreparedEnvironment } from './render/environment';

const DEFAULT_BACKGROUND: [Color, Color] = [
  [0.86, 0.89, 0.92],
  [0.7, 0.74, 0.99],
];
const BULK_CHUNK = 32768;
/** Double click zoom: camera distance from the object's centre, in units of its largest side. */
const OBJECT_ZOOM_DISTANCE = 3;
/** Default `snap` tolerance in CSS pixels (mouse / pen, touch). */
const SNAP_RADIUS_PX = 12;
const SNAP_RADIUS_TOUCH_PX = 24;
const DEFAULT_EDGE_ANGLE = 20;

type Listener<K extends keyof ViewerEvents> = (payload: ViewerEvents[K]) => void;

/** An installed viewer plugin and the cleanups of what it registered through its context. */
interface PluginEntry {
  name: string;
  instance: PluginInstance;
  owned: (() => void)[];
}

/** A running `load()`. */
interface LoadEntry {
  task: LoadTask;
  name: string;
  ctx: LoadContextImpl<unknown> | null;
  /** Auto-frame this load (first model, or `fitToView: true`). */
  fit: boolean;
  /** Bounds (origin-relative) of the last automatic fit, null before the first one. */
  fitted: Float64Array | null;
  contentDirty: boolean;
}

export class Viewer implements ViewerApi {
  readonly canvas: HTMLCanvasElement;
  readonly primitives: Primitives;

  // Internal objects, reachable at runtime for diagnostics; not part of the API (stripped from the d.ts).
  /** @internal */
  readonly ctx: GlContext;
  /** @internal */
  readonly scene: Scene;
  /** @internal */
  readonly camera: Camera;
  /** @internal */
  readonly controls: OrbitControls | null;
  /** @internal */
  readonly renderer: Renderer;

  readonly up: 'y' | 'z';
  private readonly autoSelect: boolean;
  private readonly pixelRatio: number | undefined;

  // float64 scene origin (camera and core data are relative to it)
  private readonly origin = new Float64Array(3);
  private originSet = false;

  // geometry handles: core geometry id + recentring offset + local bounds. A released handle is
  // recycled once no mesh uses it (meshGeom must keep pointing at the right offset until then).
  private geomCore: Int32Array = new Int32Array(64);
  private geomOff: Float64Array = new Float64Array(64 * 3);
  private geomBox: Float64Array = new Float64Array(64 * 6);
  private geomAlive: Uint8Array = new Uint8Array(64);
  /** Alive meshes per handle. */
  private geomUses: Int32Array = new Int32Array(64);
  private geomCount = 0;
  private geomFree: number[] = [];
  /** Geometry handle of every mesh (for setTransform). */
  private meshGeom: Int32Array = new Int32Array(1024);

  // objectId allocator (one per scene, shared by all loaded models)
  private nextObjectId = DEFAULT_OBJECT_ID_BASE;
  /** Batch group of the next load (0 = meshes added directly). */
  private nextBatchGroup = 1;

  // models
  private registry: LoaderRegistry | null = null;
  private readonly loaded: ModelImpl[] = [];
  private modelsView: readonly Model[] | null = null;
  private readonly loading = new Set<LoadEntry>();
  /** Sorted objectId runs of loaded models: [start, end) -> model, rebuilt when models change. */
  private runStart = new Float64Array(0);
  private runEnd = new Float64Array(0);
  private runModel: ModelImpl[] = [];
  private runsDirty = false;
  private readonly fitCamEye = new Float64Array(3);
  private readonly fitCamTarget = new Float64Array(3);
  private fitCamValid = false;

  private readonly m64 = new Float64Array(16);
  private readonly m32 = new Float32Array(16);
  private readonly boxTmp = new Float64Array(6);
  private readonly bulk = new Float32Array(BULK_CHUNK * 16);
  private readonly tmp3 = new Float64Array(3);

  private selectionCount = 0;
  private ghostDirty = true;
  private ghostN = 0;
  private hiddenN = 0;
  private ghostHidden = false;
  private sectionWorld: { n: [number, number, number]; p: [number, number, number] }[] = [];
  private readonly transition = new CameraTransition();
  private readonly listeners: { [K in keyof ViewerEvents]: Set<Listener<K>> } = {
    pick: new Set(),
    hover: new Set(),
    selection: new Set(),
    camera: new Set(),
    frameComplete: new Set(),
    modelLoaded: new Set(),
    modelUnloaded: new Set(),
    loadProgress: new Set(),
    environment: new Set(),
    view: new Set(),
    pluginInstalled: new Set(),
    pluginRemoved: new Set(),
    contextMenu: new Set(),
  };
  private lastCamera: CameraState | null = null;
  /** Camera (origin-relative) and canvas size at the last `view` event: eye, target, up, fov, ortho, w, h. */
  private readonly lastView = new Float64Array(13).fill(NaN);

  // tools and viewer plugins
  private tool: ViewerTool | null = null;
  private toolCursor = '';
  /** The active tool was told about the pointer being over the canvas (onPointerMove). */
  private toolHover = false;
  private readonly pluginEntries: PluginEntry[] = [];
  private pluginNames: readonly string[] | null = null;
  private layer: CanvasLayer | null = null;
  private disposing = false;

  // context menu entries (registration order) and the latest request (newer ones supersede it)
  private readonly menuItems: ContextMenuItem[] = [];
  private menuRequest = 0;
  private readonly colorTmp = new Float64Array(4);

  // snapping
  private readonly snapper: Snapper;
  private readonly snapOut = new Float64Array(9);
  private readonly snapQuery: SnapQuery = { vertices: true, edges: true, cosAngle: 0, viewX: 0, viewY: 0, viewZ: 0 };
  /** @internal CPU time of the last snap (ms; diagnostics). */
  lastSnapMs = 0;

  // image-based lighting: the latest setEnvironment call wins (token), the prepared image is reused
  // while the source stays the same
  private envToken = 0;
  private envSource: EnvironmentSource | null = null;
  private envPrepared: PreparedEnvironment | null = null;
  private envInfo: EnvironmentInfo | null = null;

  // edge display (null = off)
  private edgeInfo: EdgeInfo | null = null;
  // selection x-ray (null = off)
  private xrayInfo: SelectionXrayInfo | null = null;

  // pointer / hover
  private hoverInFlight = false;
  private hoverX = -1;
  private hoverY = -1;
  private hoverInside = false;
  /** The pointer is over the canvas (keyboard shortcuts such as F apply). */
  private pointerOver = false;
  private hoverObject: number | null = null;
  private readonly resizeObserver: ResizeObserver | null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: ViewerOptions = {}) {
    this.canvas = canvas;
    this.up = options.up ?? 'y';
    this.autoSelect = options.autoSelect ?? true;
    this.pixelRatio = options.pixelRatio;
    if (options.loaders) {
      this.registry = new LoaderRegistry();
      for (const p of options.loaders) this.registry.register(p);
    }

    const ctx = GlContext.create(canvas);
    if (ctx.caps.maxTextureSize < FRAG_TEX_WIDTH) {
      const max = ctx.caps.maxTextureSize;
      ctx.dispose();
      throw new Error(
        `mk-viewer: this device's WebGL2 MAX_TEXTURE_SIZE is ${max}, but mk-viewer needs at least ` +
          `${FRAG_TEX_WIDTH} (width of the fragment data texture). The GPU/driver is not supported.`,
      );
    }
    this.ctx = ctx;
    this.scene = new Scene();
    this.camera = new Camera({ up: this.up });
    this.controls =
      options.controls === false
        ? null
        : new OrbitControls(canvas, this.camera, {
            up: this.up,
            pickPivot: (x, y) => this.renderer.pick(x, y).then((r) => (r ? r.position : null)),
            onInteractionStart: () => {
              this.toolLeave();
              this.renderer.wake();
            },
            onInteractionEnd: () => this.renderer.wake(),
            onTap: (x, y, type, toggle) => this.tapAt(x, y, type, toggle),
            onDoubleTap: (x, y) => this.zoomToObjectAt(x, y),
            requestFrame: () => this.renderer.wake(),
          });

    const [top, bottom] = parseBackground(options.background);
    const self = this;
    const host: RenderHost = {
      beforeFrame: (dt) => this.beforeFrame(dt),
      get interacting() {
        return self.controls?.interacting ?? false;
      },
      ghostCount: () => this.ghostCount(),
      hiddenCount: () => this.hiddenCount(),
      get selectionCount() {
        return self.selectionCount;
      },
      get highlightActive() {
        return self.autoSelect && self.hoverObject !== null;
      },
      cameraChanged: () => this.cameraChanged(),
      frameComplete: () => this.emit('frameComplete', this.renderer.stats),
    };
    this.renderer = new Renderer(ctx, this.scene, this.camera, host, {
      frameBudgetMs: options.frameBudgetMs ?? 1000 / Math.max(1, options.minFps ?? 15),
      cullPixelSize: options.cullPixelSize ?? 2,
      cullPixelSizeStill: options.cullPixelSizeStill ?? 0.5,
      background: [top, bottom],
      up: this.up,
    });

    this.primitives = this.makePrimitives();
    this.snapper = new Snapper(this.scene.geometries, this.scene.fragments);

    // With controls, clicks / taps come from their gesture recognizer (pointer events), which
    // classifies touch taps properly and never double-reports with the compatibility `click`.
    if (!this.controls) canvas.addEventListener('click', this.onClick);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    if (typeof window !== 'undefined') window.addEventListener('keydown', this.onKeyDown);
    this.resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    this.resizeObserver?.observe(canvas);
    this.resize();
    if (options.edges) this.setEdges(true, options.edges === true ? {} : options.edges);
    if (options.selectionXray) this.setSelectionXray(true, options.selectionXray === true ? {} : options.selectionXray);
    if (options.ghostHidden) this.setGhostHidden(true);
    if (options.environment != null) {
      this.setEnvironment(options.environment, options.environmentOptions).catch((e) =>
        console.error('mk-viewer: the environment could not be loaded', e),
      );
    }
    if (options.plugins) {
      try {
        for (const p of options.plugins) this.use(p);
      } catch (e) {
        this.dispose(); // no half-constructed viewer: earlier plugins are disposed in reverse
        throw e;
      }
    }
  }

  get stats(): ViewerStats {
    return this.renderer.stats;
  }

  // ---------------------------------------------------------------------------------------------
  // scene construction

  createGeometry(data: GeometryData): GeometryId {
    const c = this.tmp3;
    const box = this.boxTmp;
    positionsBounds(data.positions, box, 0, c);
    let d = data;
    if (needsRecentre(c)) {
      d = { positions: shiftPositions(data.positions, c), indices: data.indices, normals: data.normals };
    }
    const core = this.scene.createGeometry(d);
    let id: number;
    if (this.geomFree.length > 0) id = this.geomFree.pop()!;
    else {
      id = this.geomCount++;
      if (id >= this.geomCore.length) {
        this.geomCore = growI32(this.geomCore, id + 1);
        this.geomAlive = growU8(this.geomAlive, id + 1);
        this.geomUses = growI32(this.geomUses, id + 1);
        this.geomOff = growF64(this.geomOff, (id + 1) * 3);
        this.geomBox = growF64(this.geomBox, (id + 1) * 6);
      }
    }
    this.geomCore[id] = core;
    this.geomAlive[id] = 1;
    this.geomUses[id] = 0;
    this.geomOff[id * 3] = c[0];
    this.geomOff[id * 3 + 1] = c[1];
    this.geomOff[id * 3 + 2] = c[2];
    this.geomBox.set(box, id * 6);
    return id;
  }

  releaseGeometry(id: GeometryId): void {
    if (!(id >= 0 && id < this.geomCount) || !this.geomAlive[id]) return;
    this.geomAlive[id] = 0;
    this.scene.releaseGeometry(this.geomCore[id]);
    if (this.geomUses[id] === 0) this.geomFree.push(id);
  }

  getGeometryBounds(id: GeometryId): Float64Array | null {
    if (!(id >= 0 && id < this.geomCount) || !this.geomAlive[id]) return null;
    return this.geomBox.slice(id * 6, id * 6 + 6);
  }

  /** @internal Geometry handles in use (diagnostics: live handles + released ones still used by meshes). */
  get geometryHandleCount(): number {
    return this.geomCount - this.geomFree.length;
  }

  createMaterial(params?: MaterialParams): MaterialId {
    return this.scene.createMaterial(params);
  }

  updateMaterial(id: MaterialId, params: MaterialParams): void {
    this.scene.updateMaterial(id, params);
    this.renderer.invalidateImage();
  }

  releaseMaterial(id: MaterialId): void {
    this.scene.releaseMaterial(id);
  }

  addMesh(params: MeshParams): MeshId {
    const g = this.geometryHandle(params.geometry);
    const m = params.transform ?? null;
    if (m && m.length < 16) throw new Error('mk-viewer: transform must have 16 elements');
    this.ensureOrigin(m, 0, g);
    foldTransform(m, 0, this.geomOff.subarray(g * 3, g * 3 + 3), this.origin, this.m64, 0);
    const id = this.scene.addMesh(this.geomCore[g], params.material, this.m64, params.objectId, params.batchGroup ?? 0);
    this.setMeshGeom(id, 1, g);
    this.geomUses[g]++;
    this.renderer.noteAppend();
    return id;
  }

  addMeshes(params: MeshBatchParams): MeshId {
    const g = this.geometryHandle(params.geometry);
    const tr = params.transforms;
    const n = tr.length / 16;
    if (n !== (n | 0)) throw new Error('mk-viewer: transforms length must be a multiple of 16');
    const mat = params.material;
    const sc = this.scene;
    if (typeof mat === 'number') {
      if (!sc.materials.isValid(mat)) throw new Error(`mk-viewer: invalid material id ${mat}`);
    } else {
      if (mat.length < n) throw new Error('mk-viewer: material array shorter than instance count');
      for (let i = 0; i < n; i++) {
        if (!sc.materials.isValid(mat[i])) throw new Error(`mk-viewer: invalid material id ${mat[i]}`);
      }
    }
    const ids = params.objectIds;
    if (ids && ids.length < n) throw new Error('mk-viewer: objectIds shorter than instance count');
    if (n === 0) return sc.fragments.highWater;
    this.ensureOrigin(tr, 0, g);
    const off = this.geomOff.subarray(g * 3, g * 3 + 3);
    const core = this.geomCore[g];
    const buf = this.bulk;
    let first = -1;
    for (let s = 0; s < n; s += BULK_CHUNK) {
      const k = Math.min(BULK_CHUNK, n - s);
      for (let i = 0; i < k; i++) foldTransform(tr, (s + i) * 16, off, this.origin, buf, i * 16);
      const f = sc.addMeshes(
        core,
        typeof mat === 'number' ? mat : slice(mat, s, s + k),
        buf.subarray(0, k * 16),
        ids ? slice(ids, s, s + k) : undefined,
        params.batchGroup ?? 0,
      );
      if (first < 0) first = f;
    }
    this.setMeshGeom(first, n, g);
    this.geomUses[g] += n;
    this.renderer.noteAppend();
    return first;
  }

  remove(ids: MeshId | ArrayLike<number>): void {
    const sc = this.scene;
    let n = 0;
    if (typeof ids === 'number') {
      if (sc.isAlive(ids)) {
        this.unuseGeom(this.meshGeom[ids]);
        n = sc.remove(ids);
      }
    } else {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (!sc.isAlive(id)) continue;
        this.unuseGeom(this.meshGeom[id]);
        n += sc.remove(id);
      }
    }
    if (n > 0) {
      this.ghostDirty = true;
      this.renderer.invalidateImage();
    }
  }

  /**
   * Removes everything: running loads are aborted and loaded models unloaded (`modelUnloaded` is
   * emitted for each). Geometry and material handles stay valid.
   */
  clear(): void {
    for (const e of Array.from(this.loading)) e.task.abort();
    for (const m of this.loaded.slice()) m.unload();
    this.scene.clear();
    this.geomUses.fill(0);
    const free = new Set(this.geomFree);
    for (let g = 0; g < this.geomCount; g++) {
      if (!this.geomAlive[g] && !free.has(g)) this.geomFree.push(g);
    }
    // a new scene may live elsewhere: pick a new origin with the next mesh (camera is shifted then)
    this.originSet = false;
    this.selectionCount = 0;
    this.ghostDirty = true;
    this.hoverObject = null;
    this.snapper.clearCache();
    this.renderer.invalidateImage();
  }

  setTransform(id: MeshId, transform: Mat4): void {
    if (!this.scene.isAlive(id)) return;
    if (transform.length < 16) throw new Error('mk-viewer: transform must have 16 elements');
    const g = this.meshGeom[id];
    foldTransform(transform, 0, this.geomOff.subarray(g * 3, g * 3 + 3), this.origin, this.m64, 0);
    this.scene.setTransform(id, this.m64);
    this.renderer.invalidateImage();
  }

  setTransforms(first: MeshId, transforms: ArrayLike<number>): void {
    const n = Math.floor(transforms.length / 16);
    if (n * 16 !== transforms.length) throw new Error('mk-viewer: transforms length must be a multiple of 16');
    if (n === 0) return;
    const buf = this.bulk;
    const geomOff = this.geomOff;
    const meshGeom = this.meshGeom;
    const sc = this.scene;
    const o = this.origin;
    const off = this.tmp3;
    for (let s = 0; s < n; s += BULK_CHUNK) {
      const k = Math.min(BULK_CHUNK, n - s);
      for (let i = 0; i < k; i++) {
        const id = first + s + i;
        if (!sc.isAlive(id)) continue;
        const g = meshGeom[id];
        off[0] = geomOff[g * 3];
        off[1] = geomOff[g * 3 + 1];
        off[2] = geomOff[g * 3 + 2];
        foldTransform(transforms, (s + i) * 16, off, o, buf, i * 16);
      }
      sc.setTransforms(first + s, buf.subarray(0, k * 16));
    }
    this.renderer.invalidateImage();
  }

  getTransforms(first: MeshId, count: number, out?: Float64Array): Float64Array {
    const res = out ?? new Float64Array(count * 16);
    if (res.length < count * 16) throw new Error('mk-viewer: getTransforms output too small');
    const fr = this.scene.fragments;
    const m = this.m32;
    const o = this.origin;
    for (let i = 0; i < count; i++) {
      const id = first + i;
      const r = i * 16;
      if (!fr.isAlive(id)) {
        res.fill(0, r, r + 16);
        continue;
      }
      fr.getTransform(id, m);
      const g = this.meshGeom[id];
      const ox = this.geomOff[g * 3], oy = this.geomOff[g * 3 + 1], oz = this.geomOff[g * 3 + 2];
      // world = T(origin) * core * T(-offset), in float64
      for (let k = 0; k < 12; k++) res[r + k] = m[k];
      res[r + 3] = res[r + 7] = res[r + 11] = 0;
      for (let row = 0; row < 3; row++) {
        res[r + 12 + row] = m[12 + row] + o[row] - (m[row] * ox + m[4 + row] * oy + m[8 + row] * oz);
      }
      res[r + 15] = 1;
    }
    return res;
  }

  setMaterial(id: MeshId, material: MaterialId): void {
    if (!this.scene.isAlive(id)) return;
    this.scene.setMaterial(id, material);
    this.renderer.invalidateImage();
  }

  allocObjectIds(count: number): number {
    if (!(count >= 0) || Math.floor(count) !== count) throw new RangeError(`mk-viewer: allocObjectIds: invalid count ${count}`);
    const first = this.nextObjectId;
    this.nextObjectId += count;
    return first;
  }

  /** Sets the next objectId `allocObjectIds` hands out (e.g. to restore saved ids). */
  setNextObjectId(id: number): void {
    this.nextObjectId = id;
  }

  // ---------------------------------------------------------------------------------------------
  // per-object state

  setVisible(objectIds: ObjectSelection, visible: boolean): void {
    this.scene.setVisible(objectIds, visible);
    this.ghostDirty = true;
    this.renderer.invalidateImage();
  }

  isolate(objectIds: ObjectSelection | null, hideOthers = false): void {
    this.scene.isolate(objectIds, hideOthers);
    this.ghostDirty = true;
    this.renderer.invalidateImage();
  }

  setColor(objectIds: ObjectSelection, color: Color | null): void {
    this.scene.setColor(objectIds, color);
    this.renderer.invalidateImage();
  }

  getColoredObjects(): number[] {
    return this.scene.getColoredObjects();
  }

  clearColors(): void {
    const ids = this.scene.getColoredObjects();
    if (ids.length > 0) this.setColor(ids, null);
  }

  getColor(objectId: number): [number, number, number, number] | null {
    const c = this.colorTmp;
    if (!this.scene.getColor(objectId, c)) return null;
    // stored as float32 linear: round so that the values given to setColor come back exactly
    const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
    return [r6(c[0]), r6(c[1]), r6(c[2]), r6(c[3])];
  }

  select(objectIds: ArrayLike<number>): void {
    this.scene.select(objectIds);
    this.selectionCount = objectIds.length;
    // selection tint + outline are composited at present time: no redraw of the scene
    this.renderer.selectionChanged();
    this.renderer.invalidatePresent();
    this.emit('selection', this.scene.getSelection());
  }

  getSelection(): number[] {
    return this.scene.getSelection();
  }

  showAll(): void {
    this.scene.showAll();
    this.ghostDirty = true;
    this.renderer.invalidateImage();
  }

  // ---------------------------------------------------------------------------------------------
  // camera

  getCamera(): CameraState {
    const s = this.camera.getState();
    const o = this.origin;
    for (let i = 0; i < 3; i++) {
      s.eye[i] += o[i];
      s.target[i] += o[i];
    }
    return s;
  }

  setCamera(state: Partial<CameraState>, animate = false): void {
    const o = this.origin;
    const rel: Partial<CameraState> = { ...state };
    if (state.eye) rel.eye = [state.eye[0] - o[0], state.eye[1] - o[1], state.eye[2] - o[2]];
    if (state.target) rel.target = [state.target[0] - o[0], state.target[1] - o[1], state.target[2] - o[2]];
    this.applyCamera(rel, animate);
  }

  fitToView(objectIds?: ObjectSelection, animate = false): void {
    const box = this.scene.getBounds(objectIds);
    if (!box) return;
    const s = this.camera.computeFitState(box, 1.05);
    if (s) this.applyCamera(s, animate);
  }

  /** World bounds in float64 (the origin offset is added in double precision). */
  getBounds(objectIds?: ObjectSelection): Float64Array | null {
    const b = this.scene.getBounds(objectIds);
    if (!b) return null;
    const o = this.origin;
    const out = new Float64Array(6);
    for (let i = 0; i < 6; i++) out[i] = b[i] + o[i % 3];
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // models

  get models(): readonly Model[] {
    return (this.modelsView ??= Object.freeze(this.loaded.slice()));
  }

  load<O = Record<string, unknown>>(input: LoaderInput, options: ViewerLoadOptions<O> = {}): LoadTask {
    if (this.disposed) throw new Error('mk-viewer: load() after dispose()');
    const fit = options.fitToView ?? (this.loaded.length === 0 && this.loading.size === 0 && this.scene.meshCount === 0);
    const entry: LoadEntry = {
      task: null as unknown as LoadTask,
      name: options.name ?? inputName(input),
      ctx: null,
      fit,
      fitted: null,
      contentDirty: false,
    };
    const { fitToView: _f, ...rest } = options;
    const task = loadModel<O>(
      this,
      input,
      { ...rest, registry: options.registry ?? this.registry ?? defaultRegistry, up: options.up ?? this.up },
      {
        batchGroup: this.nextBatchGroup++,
        onContext: (c) => (entry.ctx = c),
        onContent: () => {
          entry.contentDirty = true;
        },
      },
    );
    entry.task = task;
    this.loading.add(entry);
    task.onProgress((p) => this.emit('loadProgress', { task, name: entry.name, fraction: p.fraction, stage: p.stage }));
    task.then(
      (model) => this.modelLoaded(entry, model as ModelImpl),
      (e) => {
        this.loading.delete(entry);
        const aborted = !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';
        this.emit('loadProgress', { task, name: entry.name, fraction: task.progress, stage: aborted ? 'aborted' : 'failed' });
      },
    );
    return task;
  }

  registerLoader(plugin: LoaderPlugin<any>): () => void {
    this.registry ??= new LoaderRegistry(defaultRegistry);
    return this.registry.register(plugin);
  }

  /** The registry `load()` uses (the viewer's own, or the shared default). */
  get loaderRegistry(): LoaderRegistry {
    return this.registry ?? defaultRegistry;
  }

  getModelOf(objectId: number): Model | undefined {
    if (this.runsDirty) this.rebuildRuns();
    const s = this.runStart;
    let lo = 0, hi = s.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= objectId) lo = mid + 1;
      else hi = mid - 1;
    }
    // hi = last run starting at or before objectId
    return hi >= 0 && objectId < this.runEnd[hi] ? this.runModel[hi] : undefined;
  }

  groupByModel(objectIds: ArrayLike<number>): Map<Model | null, number[]> {
    const out = new Map<Model | null, number[]>();
    for (let i = 0; i < objectIds.length; i++) {
      const id = objectIds[i];
      const m = this.getModelOf(id) ?? null;
      let list = out.get(m);
      if (!list) out.set(m, (list = []));
      list.push(id);
    }
    return out;
  }

  findObjects(query: PropertyQuery): PropertySearch {
    const matches: { model: Model; match: PropertyMatch }[] = [];
    const hits = query.in ? new Int32Array(query.in.length) : null;
    let total = 0;
    for (const m of this.loaded) {
      const match = m.properties.find(query);
      if (hits && match.hits) for (let i = 0; i < hits.length; i++) hits[i] += match.hits[i];
      if (match.nodes.length === 0) continue;
      matches.push({ model: m, match });
      total += match.objectIds.length;
    }
    let objectIds: Float64Array;
    if (matches.length === 1) objectIds = matches[0].match.objectIds;
    else {
      objectIds = new Float64Array(total);
      let k = 0;
      for (const { match } of matches) {
        objectIds.set(match.objectIds, k);
        k += match.objectIds.length;
      }
      if (matches.length > 1) objectIds.sort();
    }
    return { objectIds, hits, matches };
  }

  propertyKeys(): PropertyKeyInfo[] {
    const merged = new Map<string, PropertyKeyInfo>();
    for (const m of this.loaded) {
      for (const k of m.properties.keys()) {
        const e = merged.get(k.key);
        if (!e) merged.set(k.key, { ...k });
        else {
          e.count += k.count;
          e.distinct += k.distinct;
          e.numeric = e.numeric && k.numeric;
        }
      }
    }
    return Array.from(merged.values()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  private modelLoaded(entry: LoadEntry, model: ModelImpl): void {
    this.loading.delete(entry);
    if (this.disposed) return;
    this.loaded.push(model);
    this.modelsView = null;
    this.runsDirty = true;
    model.onUnload = (m) => this.modelGone(m);
    if (entry.fit) this.autoFit(entry, model.bounds, true);
    this.emit('modelLoaded', model);
  }

  private modelGone(m: ModelImpl): void {
    const i = this.loaded.indexOf(m);
    if (i < 0) return;
    this.loaded.splice(i, 1);
    this.modelsView = null;
    this.runsDirty = true;
    this.emit('modelUnloaded', m);
  }

  private rebuildRuns(): void {
    this.runsDirty = false;
    const tmp: { s: number; c: number; m: ModelImpl }[] = [];
    for (const m of this.loaded) {
      const r = m.objectIdRuns();
      for (let k = 0; k < r.length; k += 2) tmp.push({ s: r[k], c: r[k + 1], m });
    }
    tmp.sort((a, b) => a.s - b.s);
    const n = tmp.length;
    this.runStart = new Float64Array(n);
    this.runEnd = new Float64Array(n);
    this.runModel = new Array(n);
    for (let k = 0; k < n; k++) {
      this.runStart[k] = tmp[k].s;
      this.runEnd[k] = tmp[k].s + tmp[k].c;
      this.runModel[k] = tmp[k].m;
    }
  }

  /** Progressive framing of auto-fit loads, once per frame while content arrives. */
  private fitLoading(): void {
    for (const e of this.loading) {
      if (!e.fit || !e.contentDirty || !e.ctx) continue;
      e.contentDirty = false;
      this.autoFit(e, e.ctx.currentBounds(), false);
    }
  }

  /**
   * Frames `world` (float64 world bounds) for an auto-fit load unless the user moved the camera
   * since the last automatic fit. While loading, it refits only when the bounds outgrew the last
   * fitted ones notably (each fit restarts the progressive image).
   */
  private autoFit(e: LoadEntry, world: Float64Array | null, final: boolean): void {
    if (!world || !this.originSet) return;
    const cam = this.camera;
    if (e.fitted && this.fitCamValid) {
      const E = this.fitCamEye, T = this.fitCamTarget;
      if (cam.eye[0] !== E[0] || cam.eye[1] !== E[1] || cam.eye[2] !== E[2] ||
          cam.target[0] !== T[0] || cam.target[1] !== T[1] || cam.target[2] !== T[2]) {
        e.fit = false; // the user took over
        return;
      }
    }
    const o = this.origin;
    const rel = new Float64Array(6);
    for (let i = 0; i < 6; i++) rel[i] = world[i] - o[i % 3];
    const f = e.fitted;
    if (f) {
      const diag = Math.hypot(f[3] - f[0], f[4] - f[1], f[5] - f[2]);
      const tol = final ? diag * 0.1 : diag * 0.25;
      let grew = false;
      for (let i = 0; i < 3; i++) if (rel[i] < f[i] - tol || rel[i + 3] > f[i + 3] + tol) grew = true;
      if (!grew) return;
    }
    const s = cam.computeFitState(rel, 1.05);
    if (!s) return;
    this.applyCamera(s, false);
    e.fitted = rel;
    this.fitCamEye.set(cam.eye);
    this.fitCamTarget.set(cam.target);
    this.fitCamValid = true;
  }

  // ---------------------------------------------------------------------------------------------
  // queries and effects

  async pick(x: number, y: number): Promise<PickResult | null> {
    const r = await this.renderer.pick(x, y);
    if (!r) return null;
    const objectId = this.scene.objectIdOf(r.meshId);
    if (objectId !== objectId) return null; // removed meanwhile
    const o = this.origin;
    const res: PickResult = {
      meshId: r.meshId,
      objectId,
      position: [r.position[0] + o[0], r.position[1] + o[1], r.position[2] + o[2]],
      distance: r.distance,
    };
    const model = this.getModelOf(objectId);
    if (model) res.model = model;
    return res;
  }

  async snap(x: number, y: number, options: SnapOptions = {}): Promise<SnapResult | null> {
    const r = await this.renderer.pick(x, y);
    if (!r || this.disposed) return null;
    const px = options.radius ?? (options.pointerType === 'touch' ? SNAP_RADIUS_TOUCH_PX : SNAP_RADIUS_PX);
    const p = r.position;
    const radius = this.worldPerPixelAt(p[0], p[1], p[2]) * Math.max(0, px);
    return this.snapRel(r.meshId, p[0], p[1], p[2], radius, options);
  }

  /**
   * @internal Snap without the GPU pick: `point` (world) on mesh `meshId`, world `radius`. Used by
   * `snap` and the unit tests.
   */
  snapMesh(meshId: MeshId, point: ArrayLike<number>, radius: number, options: SnapOptions = {}): SnapResult | null {
    const o = this.origin;
    return this.snapRel(meshId, point[0] - o[0], point[1] - o[1], point[2] - o[2], radius, options);
  }

  /** @internal Diagnostics of the last snap: candidate / scanned triangles, grid cache, CPU ms. */
  get snapStats(): { candidates: number; scanned: number; cacheBytes: number; ms: number } {
    const s = this.snapper;
    return { candidates: s.lastCandidates, scanned: s.lastScanned, cacheBytes: s.cacheBytes, ms: this.lastSnapMs };
  }

  worldToScreen(point: ArrayLike<number>, out?: ScreenPoint): ScreenPoint {
    const res = out ?? { x: 0, y: 0, depth: 0, inFront: false, inView: false };
    const o = this.origin;
    const x = point[0] - o[0], y = point[1] - o[1], z = point[2] - o[2];
    const cam = this.camera;
    const m = cam.viewProjection64;
    const v = cam.view64;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const w = this.canvas.clientWidth || cam.width;
    const h = this.canvas.clientHeight || cam.height;
    const inv = cw !== 0 ? 1 / cw : 0;
    res.x = (cx * inv * 0.5 + 0.5) * w;
    res.y = (0.5 - cy * inv * 0.5) * h;
    res.depth = -(v[2] * x + v[6] * y + v[10] * z + v[14]);
    res.inFront = cam.orthographic || res.depth > 0;
    res.inView = res.inFront && res.x >= 0 && res.x <= w && res.y >= 0 && res.y <= h;
    return res;
  }

  /** World size of one CSS pixel at origin-relative point (x, y, z) for the current camera. */
  private worldPerPixelAt(x: number, y: number, z: number): number {
    const cam = this.camera;
    const h = this.canvas.clientHeight || cam.height;
    if (cam.orthographic) return cam.orthoHeight / h;
    const v = cam.view64;
    const depth = -(v[2] * x + v[6] * y + v[10] * z + v[14]);
    return (2 * Math.tan(cam.fov / 2) * Math.max(depth, 0)) / h;
  }

  private snapRel(meshId: number, px: number, py: number, pz: number, radius: number, options: SnapOptions): SnapResult | null {
    const objectId = this.scene.objectIdOf(meshId);
    if (objectId !== objectId) return null; // removed meanwhile
    const q = this.snapQuery;
    q.vertices = options.vertices ?? true;
    q.edges = options.edges ?? true;
    q.cosAngle = Math.cos(((options.edgeAngle ?? DEFAULT_EDGE_ANGLE) * Math.PI) / 180);
    // direction towards the camera at the hit, for hiding points behind the hit face
    const cam = this.camera;
    const v3 = this.tmp3;
    if (cam.orthographic) {
      cam.getForward(v3);
      v3[0] = -v3[0]; v3[1] = -v3[1]; v3[2] = -v3[2];
    } else {
      const ce = cam.eye;
      const l = Math.hypot(ce[0] - px, ce[1] - py, ce[2] - pz) || 1;
      v3[0] = (ce[0] - px) / l; v3[1] = (ce[1] - py) / l; v3[2] = (ce[2] - pz) / l;
    }
    q.viewX = v3[0]; q.viewY = v3[1]; q.viewZ = v3[2];
    const so = this.snapOut;
    const t0 = performance.now();
    const k = this.snapper.snap(meshId, px, py, pz, radius, q, so);
    this.lastSnapMs = performance.now() - t0;
    const o = this.origin;
    const e = this.camera.eye;
    const res: SnapResult = {
      meshId,
      objectId,
      position: [so[0] + o[0], so[1] + o[1], so[2] + o[2]],
      distance: Math.hypot(so[0] - e[0], so[1] - e[1], so[2] - e[2]),
      kind: k === SNAP_VERTEX ? 'vertex' : k === SNAP_EDGE ? 'edge' : 'surface',
      hit: [px + o[0], py + o[1], pz + o[2]],
    };
    if (k === SNAP_EDGE) {
      res.edge = [
        [so[3] + o[0], so[4] + o[1], so[5] + o[2]],
        [so[6] + o[0], so[7] + o[1], so[8] + o[2]],
      ];
    }
    const model = this.getModelOf(objectId);
    if (model) res.model = model;
    return res;
  }

  setSectionPlanes(planes: SectionPlane[]): void {
    if (planes.length > MAX_SECTION_PLANES) {
      throw new Error(`mk-viewer: at most ${MAX_SECTION_PLANES} section planes are supported`);
    }
    this.sectionWorld = planes.map((p) => ({
      n: [+p.normal[0], +p.normal[1], +p.normal[2]],
      p: [+p.point[0], +p.point[1], +p.point[2]],
    }));
    this.applySectionPlanes();
  }

  async setEnvironment(source: EnvironmentSource | null, options: EnvironmentOptions = {}): Promise<void> {
    if (this.disposed) return;
    const token = ++this.envToken;
    const opts = environmentOptions(options);
    if (source === null) {
      this.envSource = null;
      this.envPrepared = null;
      this.renderer.setEnvironment(null, opts);
      this.envInfo = null;
      this.emit('environment', null);
      return;
    }
    let prepared = this.envPrepared;
    let name = this.envInfo?.name ?? 'environment';
    if (!prepared || source !== this.envSource) {
      try {
        const r = await readEnvironmentSource(source);
        if (token !== this.envToken || this.disposed) return;
        prepared = prepareEnvironment(r.pixels);
        name = r.name;
      } catch (e) {
        if (token !== this.envToken || this.disposed) return; // superseded: nothing to report
        throw e;
      }
    }
    this.envSource = source;
    this.envPrepared = prepared;
    this.renderer.setEnvironment(prepared, opts);
    this.envInfo = { name, ...opts };
    this.emit('environment', { ...this.envInfo });
  }

  getEnvironment(): EnvironmentInfo | null {
    return this.envInfo ? { ...this.envInfo } : null;
  }

  setEdges(enabled: boolean, options: EdgeOptions = {}): void {
    if (this.disposed) return;
    if (!enabled) {
      this.edgeInfo = null;
      this.renderer.setEdges(null);
      return;
    }
    const info = edgeOptions(options);
    this.edgeInfo = info;
    this.renderer.setEdges(info);
  }

  getEdges(): EdgeInfo | null {
    return copyEdgeInfo(this.edgeInfo);
  }

  setSelectionXray(enabled: boolean, options: SelectionXrayOptions = {}): void {
    if (this.disposed) return;
    if (!enabled) {
      this.xrayInfo = null;
      this.renderer.setSelectionXray(null);
      return;
    }
    const info = xrayOptions(options);
    this.xrayInfo = info;
    this.renderer.setSelectionXray(info);
  }

  getSelectionXray(): SelectionXrayInfo | null {
    const x = this.xrayInfo;
    return x ? { color: [x.color[0], x.color[1], x.color[2]], opacity: x.opacity, width: x.width } : null;
  }

  setGhostHidden(enabled: boolean): void {
    if (this.disposed) return;
    this.ghostHidden = enabled;
    this.renderer.setGhostHidden(enabled);
  }

  getGhostHidden(): boolean {
    return this.ghostHidden;
  }

  // ---------------------------------------------------------------------------------------------
  // tools and viewer plugins

  setTool(tool: ViewerTool | null): void {
    if (tool === this.tool) return;
    if (tool && (this.disposed || this.disposing)) throw new Error('mk-viewer: setTool() after dispose()');
    if (this.tool) this.endTool(tool ? 'replaced' : 'api');
    if (!tool || this.tool) return; // (the deactivated tool may have activated another meanwhile)
    this.tool = tool;
    if (this.controls) this.controls.doubleTapEnabled = false; // both clicks are taps
    this.toolCursor = this.canvas.style.cursor;
    this.canvas.style.cursor = tool.cursor ?? 'crosshair';
    // the hover highlight would compete with the tool's own feedback
    this.hoverInside = false;
    this.setHover(null);
  }

  getTool(): ViewerTool | null {
    return this.tool;
  }

  use<T extends PluginInstance>(plugin: ViewerPlugin<T>): T {
    if (this.disposed || this.disposing) throw new Error('mk-viewer: use() after dispose()');
    if (!plugin || typeof plugin.name !== 'string' || !plugin.name || typeof plugin.install !== 'function') {
      throw new TypeError('mk-viewer: a viewer plugin needs a non-empty string `name` and an `install(context)` function');
    }
    const name = plugin.name;
    if (this.pluginEntries.some((p) => p.name === name)) {
      throw new Error(`mk-viewer: a viewer plugin named '${name}' is already installed`);
    }
    const owned: (() => void)[] = [];
    const context: PluginContext = {
      viewer: this,
      name,
      overlay: () => this.pluginLayer(),
      addContextMenuItem: (item) => {
        const remove = this.addContextMenuItem(item);
        const off = (): void => {
          const i = owned.indexOf(off);
          if (i >= 0) owned.splice(i, 1);
          remove();
        };
        owned.push(off);
        return off;
      },
    };
    let result: T | void;
    try {
      result = plugin.install(context);
    } catch (e) {
      runCleanups(owned, name);
      const err = new Error(`mk-viewer: viewer plugin '${name}' failed to install: ${e instanceof Error ? e.message : String(e)}`);
      (err as { cause?: unknown }).cause = e;
      throw err;
    }
    const instance = (result ?? {}) as T;
    this.pluginEntries.push({ name, instance, owned });
    this.pluginNames = null;
    this.emit('pluginInstalled', { name, instance });
    return instance;
  }

  getPlugin<T = PluginInstance>(name: string): T | undefined {
    for (const p of this.pluginEntries) if (p.name === name) return p.instance as unknown as T;
    return undefined;
  }

  removePlugin(name: string): boolean {
    const i = this.pluginEntries.findIndex((p) => p.name === name);
    if (i < 0) return false;
    const [entry] = this.pluginEntries.splice(i, 1);
    this.pluginNames = null;
    disposePlugin(entry);
    this.emit('pluginRemoved', { name, instance: entry.instance });
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // context menu

  addContextMenuItem(item: ContextMenuItem): () => void {
    Viewer.checkMenuItem(item);
    this.menuItems.push(item);
    return () => {
      const i = this.menuItems.indexOf(item);
      if (i >= 0) this.menuItems.splice(i, 1);
    };
  }

  async openContextMenu(x: number, y: number, pointerType = 'mouse'): Promise<ContextMenuRequest | null> {
    if (this.disposed) return null;
    const request = ++this.menuRequest;
    let hit: PickResult | null = null;
    try {
      hit = await this.pick(x, y);
    } catch {
      hit = null;
    }
    if (request !== this.menuRequest || this.disposed) return null;
    return this.contextMenuAt(x, y, pointerType, hit);
  }

  /**
   * @internal The part of `openContextMenu` after the pick: the target objects, collecting the
   * items, the `contextMenu` event. Used by the unit tests (no GPU pick in node).
   */
  contextMenuAt(x: number, y: number, pointerType: string, hit: PickResult | null): ContextMenuRequest {
    // the menu acts on the selection; with nothing selected, on the object under the pointer. A
    // right click never changes the selection (the user may have selected the target by hand).
    let selection = this.scene.getSelection();
    if (selection.length === 0 && hit) selection = [hit.objectId];
    const context: ContextMenuContext = Object.freeze({ x, y, pointerType, hit, selection: Object.freeze(selection) });
    const entries = Viewer.listMenuEntries(this.menuItems.slice(), context); // callbacks may add / remove items
    let prevented = false;
    const req: ContextMenuRequest = {
      ...context,
      items: entries,
      preventDefault: () => {
        prevented = true;
      },
      get defaultPrevented() {
        return prevented;
      },
    };
    this.emit('contextMenu', req);
    return req;
  }

  /** Throws unless `item` is an action (`onClick`) or a submenu (`items`, checked recursively). */
  private static checkMenuItem(item: ContextMenuItem): void {
    const ok = !!item && typeof item.label === 'string' && (typeof item.onClick === 'function' || Array.isArray(item.items));
    if (!ok) {
      throw new TypeError('mk-viewer: a context menu item needs a string `label` and an `onClick(context)` function or submenu `items`');
    }
    if (item.items) for (const sub of item.items) Viewer.checkMenuItem(sub);
  }

  /** The visible items of one menu level, evaluated for `context` and sorted; submenus recursively. */
  private static listMenuEntries(items: readonly ContextMenuItem[], context: ContextMenuContext): readonly ContextMenuEntry[] {
    const listed: { item: ContextMenuItem; order: number; seq: number }[] = [];
    for (let k = 0; k < items.length; k++) {
      const item = items[k];
      let visible = true;
      try {
        visible = item.visible ? item.visible(context) !== false : true;
      } catch (e) {
        console.error(`mk-viewer: error in visible() of context menu item '${item.label}'`, e);
        visible = false;
      }
      if (visible) listed.push({ item, order: Number.isFinite(item.order) ? item.order! : 0, seq: k });
    }
    listed.sort((a, b) => a.order - b.order || a.seq - b.seq);
    const entries = listed.map(({ item, order }) => {
      let enabled = true;
      try {
        enabled = item.enabled ? item.enabled(context) !== false : true;
      } catch (e) {
        console.error(`mk-viewer: error in enabled() of context menu item '${item.label}'`, e);
        enabled = false;
      }
      const sub = item.items ? Viewer.listMenuEntries(item.items.slice(), context) : undefined;
      if (sub && sub.length === 0) enabled = false; // an empty submenu has nothing to open
      const onClick = item.onClick;
      const entry: { -readonly [K in keyof ContextMenuEntry]: ContextMenuEntry[K] } = {
        label: item.label,
        order,
        enabled,
        run: () => {
          if (!enabled || !onClick || sub) return;
          try {
            onClick.call(item, context);
          } catch (e) {
            console.error(`mk-viewer: error in context menu item '${item.label}'`, e);
          }
        },
      };
      if (item.title !== undefined) entry.title = item.title;
      if (item.color !== undefined) entry.color = item.color.slice() as Color;
      if (sub) entry.items = sub;
      return Object.freeze(entry);
    });
    return Object.freeze(entries);
  }

  get plugins(): readonly string[] {
    return (this.pluginNames ??= Object.freeze(this.pluginEntries.map((p) => p.name)));
  }

  private pluginLayer(): HTMLElement {
    if (this.disposed) throw new Error('mk-viewer: overlay() after dispose()');
    return (this.layer ??= createCanvasLayer(this.canvas)).element;
  }

  private endTool(reason: ToolEndReason): void {
    const t = this.tool;
    if (!t) return;
    this.tool = null;
    this.toolHover = false;
    if (this.controls) this.controls.doubleTapEnabled = true;
    this.canvas.style.cursor = this.toolCursor;
    try {
      t.onDeactivate?.(reason);
    } catch (e) {
      console.error(`mk-viewer: error in tool '${t.name}' onDeactivate`, e);
    }
  }

  /** The pointer left the canvas or a camera interaction started: tell the tool once. */
  private toolLeave(): void {
    const t = this.tool;
    if (!t || !this.toolHover) return;
    this.toolHover = false;
    try {
      t.onPointerLeave?.();
    } catch (e) {
      console.error(`mk-viewer: error in tool '${t.name}' onPointerLeave`, e);
    }
  }

  /** Click / tap (not a drag): to the active tool, else selection. */
  private tapAt(x: number, y: number, pointerType: string, modifier: boolean): void {
    const t = this.tool;
    if (!t) {
      this.selectAt(x, y, modifier);
      return;
    }
    try {
      t.onTap?.(x, y, { pointerType, modifier });
    } catch (e) {
      console.error(`mk-viewer: error in tool '${t.name}' onTap`, e);
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || isEditable(e.target)) return;
    // F: frame the selection (everything when nothing is selected), like the WASD keys only while
    // the pointer is over the canvas or the canvas has focus
    if (e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (!this.pointerOver && document.activeElement !== this.canvas) return;
      e.preventDefault();
      const sel = this.scene.getSelection();
      this.fitToView(sel.length > 0 ? sel : undefined, true);
      return;
    }
    const t = this.tool;
    if (!t || e.key !== 'Escape') return;
    let handled = false;
    try {
      handled = t.onEscape?.() === true;
    } catch (err) {
      console.error(`mk-viewer: error in tool '${t.name}' onEscape`, err);
    }
    if (!handled && this.tool === t) this.endTool('escape');
    e.preventDefault();
  };

  /**
   * Right click (long press on touch) that was not the end of a right-button pan: first to the
   * active tool, which may consume it (stopImmediatePropagation also keeps it from listeners added
   * after the viewer), then the context menu. Without items or `contextMenu` listeners the event is
   * left alone (the controls, when installed, still suppress the browser menu).
   */
  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.controls?.dragged) return;
    const t = this.tool;
    if (t && t.onContextMenu) {
      let consumed = false;
      try {
        consumed = t.onContextMenu(e.offsetX, e.offsetY) === true;
      } catch (err) {
        console.error(`mk-viewer: error in tool '${t.name}' onContextMenu`, err);
      }
      if (consumed) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
    }
    if (this.menuItems.length === 0 && this.listeners.contextMenu.size === 0) return;
    e.preventDefault();
    this.openContextMenu(e.offsetX, e.offsetY, (e as PointerEvent).pointerType || 'mouse').catch(() => undefined);
  };

  // ---------------------------------------------------------------------------------------------
  // lifecycle

  on<K extends keyof ViewerEvents>(event: K, handler: (payload: ViewerEvents[K]) => void): () => void {
    const set = this.listeners[event] as Set<Listener<K>>;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  resize(): void {
    if (this.disposed) return;
    const c = this.canvas;
    const dpr = this.pixelRatio ?? Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    if (cw > 0 && ch > 0) {
      const w = Math.max(1, Math.round(cw * dpr));
      const h = Math.max(1, Math.round(ch * dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    this.renderer.invalidateImage();
  }

  invalidate(): void {
    this.renderer.invalidateImage();
  }

  dispose(): void {
    if (this.disposed || this.disposing) return;
    this.disposing = true;
    // plugins first, in reverse install order, while the viewer still works
    const plugins = this.pluginEntries;
    for (let i = plugins.length - 1; i >= 0; i--) disposePlugin(plugins[i]);
    plugins.length = 0;
    this.pluginNames = null;
    this.menuItems.length = 0;
    this.menuRequest++;
    this.endTool('dispose');
    this.layer?.dispose();
    this.layer = null;
    for (const e of Array.from(this.loading)) e.task.abort();
    this.loading.clear();
    this.disposed = true;
    const c = this.canvas;
    c.removeEventListener('click', this.onClick);
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('contextmenu', this.onContextMenu);
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this.onKeyDown);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.renderer.dispose();
    this.ctx.dispose();
    for (const k of Object.keys(this.listeners) as (keyof ViewerEvents)[]) this.listeners[k].clear();
  }

  // ---------------------------------------------------------------------------------------------
  // internals

  private geometryHandle(id: GeometryId): number {
    if (!(id >= 0 && id < this.geomCount && (id | 0) === id) || !this.geomAlive[id]) {
      throw new Error(`mk-viewer: invalid geometry id ${id}`);
    }
    return id;
  }

  /** One mesh of handle g went away: recycle the handle when it was released and is now unused. */
  private unuseGeom(g: number): void {
    if (--this.geomUses[g] === 0 && !this.geomAlive[g]) this.geomFree.push(g);
  }

  private setMeshGeom(first: number, n: number, g: number): void {
    const end = first + n;
    if (end > this.meshGeom.length) {
      let cap = this.meshGeom.length * 2;
      while (cap < end) cap *= 2;
      this.meshGeom = growI32(this.meshGeom, cap);
    }
    this.meshGeom.fill(g, first, end);
  }

  /** Picks the scene origin from the first mesh: the world centre of its AABB. */
  private ensureOrigin(m: ArrayLike<number> | null, mo: number, g: number): void {
    if (this.originSet) return;
    const c = this.tmp3;
    transformedCenter(m, mo, this.geomOff.subarray(g * 3, g * 3 + 3), c);
    if (!Number.isFinite(c[0] + c[1] + c[2])) c[0] = c[1] = c[2] = 0;
    this.setOrigin(c);
  }

  private setOrigin(c: ArrayLike<number>): void {
    const o = this.origin;
    const dx = c[0] - o[0], dy = c[1] - o[1], dz = c[2] - o[2];
    o[0] = c[0];
    o[1] = c[1];
    o[2] = c[2];
    this.originSet = true;
    if (dx === 0 && dy === 0 && dz === 0) return;
    // keep the camera where it is in world space
    this.controls?.cancelAnimation();
    this.transition.cancel();
    const cam = this.camera;
    cam.set(
      [cam.eye[0] - dx, cam.eye[1] - dy, cam.eye[2] - dz],
      [cam.target[0] - dx, cam.target[1] - dy, cam.target[2] - dz],
      null,
    );
    this.lastCamera = null;
    if (this.sectionWorld.length) this.applySectionPlanes();
  }

  private applySectionPlanes(): void {
    const o = this.origin;
    const n = this.sectionWorld.length;
    const planes: number[] = new Array<number>(n * 4).fill(0);
    for (let i = 0; i < n; i++) {
      const s = this.sectionWorld[i];
      planeFromNormalPoint(s.n[0], s.n[1], s.n[2], s.p[0] - o[0], s.p[1] - o[1], s.p[2] - o[2], planes, i * 4);
    }
    this.renderer.setSectionPlanes(planes, n);
  }

  private applyCamera(rel: Partial<CameraState>, animate: boolean): void {
    if (this.controls) this.controls.setCamera(rel, animate);
    else if (animate) this.transition.start(this.camera, rel, 400);
    else {
      this.transition.cancel();
      this.camera.setState(rel);
    }
    this.renderer.wake();
  }

  private beforeFrame(dt: number): boolean {
    if (this.loading.size > 0) this.fitLoading();
    let animating = false;
    if (this.controls) animating = this.controls.update(dt) || this.controls.animating;
    if (this.transition.active) animating = this.transition.step(this.camera, dt) || animating;
    return animating;
  }

  private ghostCount(): number {
    if (this.ghostDirty) this.countFlags();
    return this.ghostN;
  }

  private hiddenCount(): number {
    if (this.ghostDirty) this.countFlags();
    return this.hiddenN;
  }

  /** Ghosted (visible + ghosted) and hidden fragments; `ghostDirty` is set by whatever changes them. */
  private countFlags(): void {
    const fr = this.scene.fragments;
    const flags = fr.flags;
    const want = FragFlags.Visible | FragFlags.Ghosted;
    let g = 0;
    let h = 0;
    for (let f = 0; f < fr.highWater; f++) {
      const fl = flags[f];
      if ((fl & want) === want) g++;
      else if (fl & FragFlags.Hidden) h++;
    }
    this.ghostN = g;
    this.hiddenN = h;
    this.ghostDirty = false;
  }

  private cameraChanged(): void {
    if (this.listeners.view.size > 0) this.viewChanged();
    if (this.listeners.camera.size === 0) return;
    const s = this.getCamera();
    const l = this.lastCamera;
    if (
      l &&
      l.fov === s.fov &&
      l.orthographic === s.orthographic &&
      sameVec(l.eye, s.eye) &&
      sameVec(l.target, s.target) &&
      sameVec(l.up, s.up)
    ) {
      return;
    }
    this.lastCamera = s;
    this.emit('camera', s);
  }

  /** `view` event when the camera pose / projection or the canvas size changed (not near / far only). */
  private viewChanged(): void {
    const cam = this.camera;
    const l = this.lastView;
    const w = this.canvas.clientWidth || cam.width;
    const h = this.canvas.clientHeight || cam.height;
    const e = cam.eye, t = cam.target, u = cam.up;
    if (
      l[0] === e[0] && l[1] === e[1] && l[2] === e[2] &&
      l[3] === t[0] && l[4] === t[1] && l[5] === t[2] &&
      l[6] === u[0] && l[7] === u[1] && l[8] === u[2] &&
      l[9] === cam.fov && l[10] === (cam.orthographic ? 1 : 0) && l[11] === w && l[12] === h
    ) {
      return;
    }
    l[0] = e[0]; l[1] = e[1]; l[2] = e[2];
    l[3] = t[0]; l[4] = t[1]; l[5] = t[2];
    l[6] = u[0]; l[7] = u[1]; l[8] = u[2];
    l[9] = cam.fov; l[10] = cam.orthographic ? 1 : 0; l[11] = w; l[12] = h;
    this.emit('view', { width: w, height: h });
  }

  private emit<K extends keyof ViewerEvents>(event: K, payload: ViewerEvents[K]): void {
    const set = this.listeners[event] as Set<Listener<K>>;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`mk-viewer: error in '${event}' handler`, e);
      }
    }
  }

  private makePrimitives(): Primitives {
    const up = this.up;
    return {
      box: (size) => this.createGeometry(prim.box(size)),
      sphere: (radius, segments) => this.createGeometry(prim.sphere(radius, segments, up)),
      cylinder: (radius, height, segments) => this.createGeometry(prim.cylinder(radius, height, segments, up)),
      cone: (radius, height, segments) => this.createGeometry(prim.cone(radius, height, segments, up)),
      plane: (width, depth) => this.createGeometry(prim.plane(width, depth, up)),
      torus: (radius, tube, rs, ts) => this.createGeometry(prim.torus(radius, tube, rs, ts, up)),
      extrusion: (outline, height) => this.createGeometry(prim.extrusion(outline, height, up)),
    };
  }

  // --- pointer: click selection, hover highlight -------------------------------------------------

  /** Only used without built-in controls. */
  private readonly onClick = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.tapAt(e.offsetX, e.offsetY, (e as PointerEvent).pointerType || 'mouse', e.ctrlKey || e.metaKey || e.shiftKey);
  };

  /** Click / tap at CSS pixel (x, y): emits `pick` and updates the selection (autoSelect). */
  /**
   * Double click / double tap: looks at the centre of the picked object's bounding box from
   * OBJECT_ZOOM_DISTANCE times its largest side away, keeping the view direction. The box centre
   * becomes the orbit pivot. Nothing happens on the background.
   */
  private zoomToObjectAt(x: number, y: number): void {
    if (this.disposed) return;
    this.pick(x, y).then((r) => {
      if (!this.disposed && r) this.zoomToObjects(r.objectId);
    }, () => undefined);
  }

  zoomToObjects(objectIds: ObjectSelection, animate = true): void {
    if (this.disposed) return;
    const box = this.scene.getBounds(objectIds); // origin-relative, like the camera
    if (!box) return;
    const cam = this.camera;
    const size = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
    const dist = size > 0 ? size * OBJECT_ZOOM_DISTANCE : cam.distance;
    const target: [number, number, number] = [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2];
    const k = dist / Math.max(cam.distance, 1e-300);
    const eye: [number, number, number] = [
      target[0] + (cam.eye[0] - cam.target[0]) * k,
      target[1] + (cam.eye[1] - cam.target[1]) * k,
      target[2] + (cam.eye[2] - cam.target[2]) * k,
    ];
    this.applyCamera({ eye, target }, animate);
    this.renderer.wake();
  }

  private selectAt(x: number, y: number, toggle: boolean): void {
    if (this.disposed) return;
    const wantPick = this.listeners.pick.size > 0;
    if (!this.autoSelect && !wantPick) return;
    this.pick(x, y).then((r) => {
      if (this.disposed) return;
      this.emit('pick', r);
      if (!this.autoSelect) return;
      const cur = this.scene.getSelection();
      if (!r) {
        if (!toggle && cur.length > 0) this.select([]);
        return;
      }
      if (toggle) {
        const i = cur.indexOf(r.objectId);
        if (i >= 0) cur.splice(i, 1);
        else cur.push(r.objectId);
        this.select(cur);
      } else if (cur.length !== 1 || cur[0] !== r.objectId) {
        this.select([r.objectId]);
      }
    });
  }

  /** Hover is for mouse / pen: a touch clears it and suppresses hover picks until it moves away. */
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    this.hoverInside = false; // also drops the result of a hover pick in flight
    this.setHover(null);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    this.pointerOver = true;
    const tool = this.tool;
    if (tool) {
      if (e.buttons !== 0 || this.controls?.interacting) {
        this.toolLeave();
        return;
      }
      this.toolHover = true;
      try {
        tool.onPointerMove?.(e.offsetX, e.offsetY, { pointerType: e.pointerType, modifier: e.ctrlKey || e.metaKey || e.shiftKey });
      } catch (err) {
        console.error(`mk-viewer: error in tool '${tool.name}' onPointerMove`, err);
      }
      return;
    }
    if (!this.autoSelect && this.listeners.hover.size === 0) return;
    this.hoverInside = true;
    if (e.buttons !== 0 || this.controls?.interacting) return;
    this.hoverX = e.offsetX;
    this.hoverY = e.offsetY;
    if (!this.hoverInFlight) this.hoverPick();
  };

  private readonly onPointerLeave = (): void => {
    this.toolLeave();
    this.pointerOver = false;
    this.hoverInside = false;
    this.setHover(null);
  };

  /** At most one hover pick in flight; re-issued only when the pointer moved meanwhile. */
  private hoverPick(): void {
    const x = this.hoverX;
    const y = this.hoverY;
    this.hoverInFlight = true;
    this.pick(x, y).then(
      (r) => {
        this.hoverInFlight = false;
        if (this.disposed || !this.hoverInside) return;
        this.setHover(r);
        if ((x !== this.hoverX || y !== this.hoverY) && !this.controls?.interacting) this.hoverPick();
      },
      () => {
        this.hoverInFlight = false;
      },
    );
  }

  private setHover(r: PickResult | null): void {
    const id = r ? r.objectId : null;
    if (id === this.hoverObject) return;
    this.hoverObject = id;
    if (this.autoSelect) {
      this.scene.setHighlighted(id);
      this.renderer.invalidatePresent();
    }
    this.emit('hover', r);
  }
}

/** Display name of a load input: File name, or the last URL path segment. */
function inputName(input: LoaderInput): string {
  if (typeof input === 'string' || input instanceof URL) {
    const path = String(input).split(/[?#]/)[0];
    const seg = path.substring(path.lastIndexOf('/') + 1);
    try {
      return decodeURIComponent(seg) || 'model';
    } catch {
      return seg || 'model';
    }
  }
  const n = (input as { name?: unknown }).name;
  return typeof n === 'string' && n ? n : 'model';
}

function parseBackground(bg: ViewerOptions['background']): [number[], number[]] {
  const b = bg ?? DEFAULT_BACKGROUND;
  if (Array.isArray(b[0])) {
    const g = b as [Color, Color];
    return [[g[0][0], g[0][1], g[0][2]], [g[1][0], g[1][1], g[1][2]]];
  }
  const c = b as Color;
  return [[c[0], c[1], c[2]], [c[0], c[1], c[2]]];
}

function environmentOptions(o: EnvironmentOptions): { intensity: number; rotation: number; keyLight: number } {
  const intensity = o.intensity ?? 1;
  const rotation = o.rotation ?? 0;
  const keyLight = o.keyLight ?? 0.25;
  if (!(Number.isFinite(intensity) && intensity >= 0)) throw new RangeError(`mk-viewer: invalid environment intensity ${intensity}`);
  if (!Number.isFinite(rotation)) throw new RangeError(`mk-viewer: invalid environment rotation ${rotation}`);
  if (!(keyLight >= 0 && keyLight <= 1)) throw new RangeError(`mk-viewer: environment keyLight must be in 0..1, got ${keyLight}`);
  return { intensity, rotation, keyLight };
}

function copyEdgeInfo(e: EdgeInfo | null): EdgeInfo | null {
  return e ? { color: [e.color[0], e.color[1], e.color[2]], opacity: e.opacity, creaseAngle: e.creaseAngle } : null;
}

function xrayOptions(o: SelectionXrayOptions): SelectionXrayInfo {
  const c = o.color ?? [1, 0.62, 0.1]; // the selection outline colour
  const color: [number, number, number] = [+c[0], +c[1], +c[2]];
  const opacity = o.opacity ?? 1;
  const width = o.width ?? 2;
  if (!color.every((v) => v >= 0 && v <= 1)) throw new RangeError(`mk-viewer: x-ray color components must be in 0..1, got ${color}`);
  if (!(opacity >= 0 && opacity <= 1)) throw new RangeError(`mk-viewer: x-ray opacity must be in 0..1, got ${opacity}`);
  if (!(width >= 1 && width <= 8)) throw new RangeError(`mk-viewer: x-ray width must be in 1..8 pixels, got ${width}`);
  return { color, opacity, width };
}

function edgeOptions(o: EdgeOptions): EdgeInfo {
  const c = o.color ?? [0.1, 0.1, 0.1];
  const color: [number, number, number] = [+c[0], +c[1], +c[2]];
  const opacity = o.opacity ?? 0.75;
  const creaseAngle = o.creaseAngle ?? 20;
  if (!color.every((v) => v >= 0 && v <= 1)) throw new RangeError(`mk-viewer: edge color components must be in 0..1, got ${color}`);
  if (!(opacity >= 0 && opacity <= 1)) throw new RangeError(`mk-viewer: edge opacity must be in 0..1, got ${opacity}`);
  if (!(creaseAngle > 0 && creaseAngle < 180)) {
    throw new RangeError(`mk-viewer: edge creaseAngle must be in (0, 180) degrees, got ${creaseAngle}`);
  }
  return { color, opacity, creaseAngle };
}

/** Calls a plugin's dispose(), then removes what it registered through its context. */
function disposePlugin(entry: PluginEntry): void {
  try {
    entry.instance.dispose?.();
  } catch (e) {
    console.error(`mk-viewer: error disposing viewer plugin '${entry.name}'`, e);
  }
  runCleanups(entry.owned, entry.name);
}

/** Runs and empties a plugin's context-owned cleanups, newest first. */
function runCleanups(owned: (() => void)[], name: string): void {
  const list = owned.splice(0);
  for (let i = list.length - 1; i >= 0; i--) {
    try {
      list[i]();
    } catch (e) {
      console.error(`mk-viewer: error removing a registration of viewer plugin '${name}'`, e);
    }
  }
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

function sameVec(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function slice(a: ArrayLike<number>, s: number, e: number): ArrayLike<number> {
  if (ArrayBuffer.isView(a)) return (a as unknown as Float64Array).subarray(s, e);
  return Array.prototype.slice.call(a, s, e) as number[];
}

function growI32(a: Int32Array, n: number): Int32Array {
  const b = new Int32Array(Math.max(n, a.length * 2));
  b.set(a);
  return b;
}
function growU8(a: Uint8Array, n: number): Uint8Array {
  const b = new Uint8Array(Math.max(n, a.length * 2));
  b.set(a);
  return b;
}
function growF64(a: Float64Array, n: number): Float64Array {
  const b = new Float64Array(Math.max(n, a.length * 2));
  b.set(a);
  return b;
}

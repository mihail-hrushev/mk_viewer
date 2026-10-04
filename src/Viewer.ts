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
 */
import type {
  CameraState,
  Color,
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
  SectionPlane,
  ViewerApi,
  ViewerEvents,
  ViewerOptions,
  ViewerStats,
} from './types';
import { FRAG_TEX_WIDTH, FragFlags, MAX_SECTION_PLANES } from './layout';
import { Scene } from './core';
import { GlContext, planeFromNormalPoint } from './gl';
import { Camera, CameraTransition, OrbitControls } from './camera';
import * as prim from './primitives';
import { Renderer, type RenderHost } from './render/Renderer';
import { foldTransform, needsRecentre, positionsCenter, shiftPositions, transformedCenter } from './render/origin';

const DEFAULT_BACKGROUND: [Color, Color] = [
  [0.86, 0.89, 0.92],
  [0.6, 0.64, 0.69],
];
const BULK_CHUNK = 32768;

type Listener<K extends keyof ViewerEvents> = (payload: ViewerEvents[K]) => void;

export class Viewer implements ViewerApi {
  readonly canvas: HTMLCanvasElement;
  readonly primitives: Primitives;

  /** Internal objects, exposed for advanced use and diagnostics (not part of the stable API). */
  readonly ctx: GlContext;
  readonly scene: Scene;
  readonly camera: Camera;
  readonly controls: OrbitControls | null;
  readonly renderer: Renderer;

  private readonly up: 'y' | 'z';
  private readonly autoSelect: boolean;
  private readonly pixelRatio: number | undefined;

  // float64 scene origin (camera and core data are relative to it)
  private readonly origin = new Float64Array(3);
  private originSet = false;

  // geometry handles: core geometry id + recentring offset (handles are never reused)
  private geomCore: Int32Array = new Int32Array(64);
  private geomOff: Float64Array = new Float64Array(64 * 3);
  private geomAlive: Uint8Array = new Uint8Array(64);
  private geomCount = 0;
  /** Geometry handle of every mesh (for setTransform). */
  private meshGeom: Int32Array = new Int32Array(1024);

  private readonly m64 = new Float64Array(16);
  private readonly bulk = new Float32Array(BULK_CHUNK * 16);
  private readonly tmp3 = new Float64Array(3);

  private selectionCount = 0;
  private ghostDirty = true;
  private ghostN = 0;
  private sectionWorld: { n: [number, number, number]; p: [number, number, number] }[] = [];
  private readonly transition = new CameraTransition();
  private readonly listeners: { [K in keyof ViewerEvents]: Set<Listener<K>> } = {
    pick: new Set(),
    hover: new Set(),
    selection: new Set(),
    camera: new Set(),
    frameComplete: new Set(),
  };
  private lastCamera: CameraState | null = null;

  // pointer / hover
  private hoverInFlight = false;
  private hoverX = -1;
  private hoverY = -1;
  private hoverInside = false;
  private hoverObject: number | null = null;
  private readonly resizeObserver: ResizeObserver | null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: ViewerOptions = {}) {
    this.canvas = canvas;
    this.up = options.up ?? 'y';
    this.autoSelect = options.autoSelect ?? true;
    this.pixelRatio = options.pixelRatio;

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
            onInteractionStart: () => this.renderer.wake(),
            onInteractionEnd: () => this.renderer.wake(),
            onTap: (x, y, _type, toggle) => this.selectAt(x, y, toggle),
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
      frameBudgetMs: options.frameBudgetMs ?? 12,
      cullPixelSize: options.cullPixelSize ?? 2,
      cullPixelSizeStill: options.cullPixelSizeStill ?? 0.5,
      background: [top, bottom],
      up: this.up,
    });

    this.primitives = this.makePrimitives();

    // With controls, clicks / taps come from their gesture recognizer (pointer events), which
    // classifies touch taps properly and never double-reports with the compatibility `click`.
    if (!this.controls) canvas.addEventListener('click', this.onClick);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    this.resizeObserver?.observe(canvas);
    this.resize();
  }

  get stats(): ViewerStats {
    return this.renderer.stats;
  }

  // ---------------------------------------------------------------------------------------------
  // scene construction

  createGeometry(data: GeometryData): GeometryId {
    const c = this.tmp3;
    positionsCenter(data.positions, c);
    let d = data;
    if (needsRecentre(c)) {
      d = { positions: shiftPositions(data.positions, c), indices: data.indices, normals: data.normals };
    }
    const core = this.scene.createGeometry(d);
    const id = this.geomCount++;
    if (id >= this.geomCore.length) {
      this.geomCore = growI32(this.geomCore, id + 1);
      this.geomAlive = growU8(this.geomAlive, id + 1);
      this.geomOff = growF64(this.geomOff, (id + 1) * 3);
    }
    this.geomCore[id] = core;
    this.geomAlive[id] = 1;
    this.geomOff[id * 3] = c[0];
    this.geomOff[id * 3 + 1] = c[1];
    this.geomOff[id * 3 + 2] = c[2];
    return id;
  }

  releaseGeometry(id: GeometryId): void {
    if (!(id >= 0 && id < this.geomCount) || !this.geomAlive[id]) return;
    this.geomAlive[id] = 0;
    this.scene.releaseGeometry(this.geomCore[id]);
  }

  createMaterial(params?: MaterialParams): MaterialId {
    return this.scene.createMaterial(params);
  }

  updateMaterial(id: MaterialId, params: MaterialParams): void {
    this.scene.updateMaterial(id, params);
    this.renderer.invalidateImage();
  }

  addMesh(params: MeshParams): MeshId {
    const g = this.geometryHandle(params.geometry);
    const m = params.transform ?? null;
    if (m && m.length < 16) throw new Error('mk-viewer: transform must have 16 elements');
    this.ensureOrigin(m, 0, g);
    foldTransform(m, 0, this.geomOff.subarray(g * 3, g * 3 + 3), this.origin, this.m64, 0);
    const id = this.scene.addMesh(this.geomCore[g], params.material, this.m64, params.objectId);
    this.setMeshGeom(id, 1, g);
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
      );
      if (first < 0) first = f;
    }
    this.setMeshGeom(first, n, g);
    this.renderer.noteAppend();
    return first;
  }

  remove(ids: MeshId | ArrayLike<number>): void {
    if (this.scene.remove(ids) > 0) {
      this.ghostDirty = true;
      this.renderer.invalidateImage();
    }
  }

  clear(): void {
    this.scene.clear();
    // a new scene may live elsewhere: pick a new origin with the next mesh (camera is shifted then)
    this.originSet = false;
    this.selectionCount = 0;
    this.ghostDirty = true;
    this.hoverObject = null;
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

  setMaterial(id: MeshId, material: MaterialId): void {
    if (!this.scene.isAlive(id)) return;
    this.scene.setMaterial(id, material);
    this.renderer.invalidateImage();
  }

  // ---------------------------------------------------------------------------------------------
  // per-object state

  setVisible(objectIds: number | ArrayLike<number>, visible: boolean): void {
    this.scene.setVisible(objectIds, visible);
    this.ghostDirty = true;
    this.renderer.invalidateImage();
  }

  isolate(objectIds: ArrayLike<number> | null, hideOthers = false): void {
    this.scene.isolate(objectIds, hideOthers);
    this.ghostDirty = true;
    this.renderer.invalidateImage();
  }

  setColor(objectIds: number | ArrayLike<number>, color: Color | null): void {
    this.scene.setColor(objectIds, color);
    this.renderer.invalidateImage();
  }

  select(objectIds: ArrayLike<number>): void {
    this.scene.select(objectIds);
    this.selectionCount = objectIds.length;
    // selection tint + outline are composited at present time: no redraw of the scene
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

  fitToView(objectIds?: ArrayLike<number>, animate = false): void {
    const box = this.scene.getBounds(objectIds);
    if (!box) return;
    const s = this.camera.computeFitState(box, 1.05);
    if (s) this.applyCamera(s, animate);
  }

  getBounds(objectIds?: ArrayLike<number>): Float32Array | null {
    const b = this.scene.getBounds(objectIds);
    if (!b) return null;
    const o = this.origin;
    const out = new Float32Array(6);
    for (let i = 0; i < 6; i++) out[i] = b[i] + o[i % 3];
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // queries and effects

  async pick(x: number, y: number): Promise<PickResult | null> {
    const r = await this.renderer.pick(x, y);
    if (!r) return null;
    const objectId = this.scene.objectIdOf(r.meshId);
    if (objectId !== objectId) return null; // removed meanwhile
    const o = this.origin;
    return {
      meshId: r.meshId,
      objectId,
      position: [r.position[0] + o[0], r.position[1] + o[1], r.position[2] + o[2]],
      distance: r.distance,
    };
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
    if (this.disposed) return;
    this.disposed = true;
    const c = this.canvas;
    c.removeEventListener('click', this.onClick);
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerleave', this.onPointerLeave);
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
    let animating = false;
    if (this.controls) animating = this.controls.update(dt) || this.controls.animating;
    if (this.transition.active) animating = this.transition.step(this.camera, dt) || animating;
    return animating;
  }

  private ghostCount(): number {
    if (this.ghostDirty) {
      const fr = this.scene.fragments;
      const flags = fr.flags;
      const want = FragFlags.Visible | FragFlags.Ghosted;
      let n = 0;
      for (let f = 0; f < fr.highWater; f++) if ((flags[f] & want) === want) n++;
      this.ghostN = n;
      this.ghostDirty = false;
    }
    return this.ghostN;
  }

  private cameraChanged(): void {
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
    this.selectAt(e.offsetX, e.offsetY, e.ctrlKey || e.metaKey || e.shiftKey);
  };

  /** Click / tap at CSS pixel (x, y): emits `pick` and updates the selection (autoSelect). */
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
    if (!this.autoSelect && this.listeners.hover.size === 0) return;
    this.hoverInside = true;
    if (e.buttons !== 0 || this.controls?.interacting) return;
    this.hoverX = e.offsetX;
    this.hoverY = e.offsetY;
    if (!this.hoverInFlight) this.hoverPick();
  };

  private readonly onPointerLeave = (): void => {
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

function parseBackground(bg: ViewerOptions['background']): [number[], number[]] {
  const b = bg ?? DEFAULT_BACKGROUND;
  if (Array.isArray(b[0])) {
    const g = b as [Color, Color];
    return [[g[0][0], g[0][1], g[0][2]], [g[1][0], g[1][1], g[1][2]]];
  }
  const c = b as Color;
  return [[c[0], c[1], c[2]], [c[0], c[1], c[2]]];
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

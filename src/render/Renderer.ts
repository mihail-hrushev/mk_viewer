/**
 * Progressive, time-budgeted renderer (docs/ARCHITECTURE.md "Progressive rendering").
 *
 * Frame (requestAnimationFrame, idles completely when there is nothing to do):
 *   host.beforeFrame (controls / camera animation) -> scene.flush() -> GpuScene.sync (dirty texture
 *   rows, page mirroring) -> change detection -> traversal (when needed) -> draw a budgeted slice ->
 *   present (+ selection / hover overlay).
 *
 * Image lifecycle
 *  - Moving (camera changed this frame, animating or user interacting): every frame restarts the
 *    image, traverses with `cullPixelSize`, draws the importance-ordered opaque list until the work
 *    budget is spent, then the nearest transparent items that still fit (back to front), the ghost
 *    pass and the transparent-id pass, and presents. What does not fit is dropped for this frame.
 *  - Still: frames do not clear. The list is re-traversed once with `cullPixelSizeStill` and drawing
 *    continues where it stopped, in phases OPAQUE -> TRANSPARENT -> GHOST -> TRANSPARENT_ID, each
 *    continued across frames within the budget, presenting every frame, until done
 *    (`frameComplete`). Opaque items already drawn in the current image are tracked per draw item
 *    (image stamp + drawn element count), so a re-traversal only draws what is missing: for a merged
 *    item the remaining index range, for an instanced item the remaining instances.
 *  - Blended passes (transparent, ghost) may only be drawn after every opaque item of the image:
 *    once an image contains blended content (`imageHasBlended`), anything that would add opaque
 *    content (becoming still, appended meshes) restarts the image instead of appending.
 *
 * What restarts the image vs. what appends
 *  - restart: camera/projection/viewport change, near/far change, any change of existing fragment
 *    records that affects geometry passes (transform, visibility, colour, ghosting, material),
 *    removal, section planes, background, environment (image or options), context restore,
 *    the ghost-hidden mode (`setGhostHidden`: hidden fragments drawn by a second ghost pass),
 *    `invalidateImage()`.
 *  - present only (`invalidatePresent()`): selection / hover flags. They are a screen-space overlay
 *    (tint + outline from the id target and the fragment flags, COMPOSITE_FS) composited when the
 *    accumulated image is presented, so a flag change costs the fragment texture row upload and one
 *    fullscreen pass; the accumulated image is neither cleared nor redrawn. The selection x-ray
 *    (`setSelectionXray`) adds a pass into a target of its own before presenting (`drawXray`): the
 *    selected fragments alone, redrawn when the image, the selection or the batching changes.
 *  - append (`noteAppend()`, i.e. addMesh/addMeshes only): re-traverse and draw the new items into
 *    the existing image, unless the image already holds blended content or items were re-batched by
 *    compaction since the image started (stamps unreliable), in which case it restarts.
 *
 * Budget: an adaptive work-unit estimate (BudgetController) corrected from rAF intervals, CPU time
 * and GPU timer queries. Never gl.finish().
 */
import type { ViewerStats } from '../types';
import { DETAIL_STEPS, DrawList, ITEM_FREE, ITEM_INSTANCED, type CullView, type Scene } from '../core';
import {
  DrawSubmitter,
  EnvironmentTexture,
  GpuTimer,
  PixelReader,
  PostPasses,
  RenderTargets,
  UberProgram,
  UBER_FRAG_TEX_UNIT,
  UBER_MAT_TEX_UNIT,
  UBER_ENV_TEX_UNIT,
  applyPassState,
  planesToViewSpace,
  unprojectDepth,
  type EdgeStyle,
  type EnvironmentUniforms,
  type GlContext,
  type OverlayStyle,
  type UberPass,
} from '../gl';
import type { Camera } from '../camera';
import * as frustum from '../math/frustum';
import { MAX_SECTION_PLANES } from '../layout';
import { BudgetController } from './BudgetController';
import { GpuScene, type VaoSlot } from './GpuScene';
import { SliceGrouper } from './SliceGrouper';
import type { PreparedEnvironment } from './environment';

/** Environment lighting settings (validated by the Viewer). */
export interface RenderEnvironmentOptions {
  intensity: number;
  /** Radians about the world up axis. */
  rotation: number;
  /** 0..1 */
  keyLight: number;
}

/** Selection x-ray settings (validated by the Viewer). */
export interface RenderXrayOptions {
  /** sRGB rgb. */
  color: ArrayLike<number>;
  /** 0..1 */
  opacity: number;
  /** Line width, CSS pixels. */
  width: number;
}

/** Edge display settings (validated by the Viewer). */
export interface RenderEdgeOptions {
  /** sRGB rgb. */
  color: ArrayLike<number>;
  /** 0..1 */
  opacity: number;
  /** Crease angle, degrees. */
  creaseAngle: number;
}

export interface RendererOptions {
  frameBudgetMs: number;
  cullPixelSize: number;
  cullPixelSizeStill: number;
  /** sRGB top and bottom background colours (equal = solid). */
  background: [ArrayLike<number>, ArrayLike<number>];
  up: 'y' | 'z';
}

/** Callbacks from the renderer into its owner (the Viewer). */
export interface RenderHost {
  /** Start of every frame: advance controls / camera animations. Returns true while animating. */
  beforeFrame(dtMs: number): boolean;
  /** True while the user interacts (pointer down, wheel); the loop keeps polling the camera. */
  readonly interacting: boolean;
  /** Number of ghosted fragments (0 skips the ghost pass entirely). */
  ghostCount(): number;
  /** Number of hidden fragments (0 skips the ghost-hidden pass; only read in ghost-hidden mode). */
  hiddenCount(): number;
  /** Number of selected objects (0 and no highlight: plain present without overlay). */
  readonly selectionCount: number;
  /** An object is hover-highlighted (overlay needed even without selection). */
  readonly highlightActive: boolean;
  /** The camera version changed in this frame (pose, projection, viewport or clip planes). */
  cameraChanged(): void;
  /** The progressive image is complete. */
  frameComplete(): void;
}

export interface RenderPick {
  meshId: number;
  /** Origin-relative world position of the hit. */
  position: Float64Array;
  distance: number;
}

const PHASE_OPAQUE = 0;
const PHASE_TRANSPARENT = 1;
const PHASE_GHOST = 2;
const PHASE_TID = 3;
const PHASE_DONE = 4;
/** Moving frame that ran out of budget: cannot be continued (blended passes may sit on top). */
const PHASE_MOVING_PARTIAL = 5;

/** Work units charged per draw item on top of its triangles (draw call / state overhead). */
export const ENTRY_OVERHEAD_UNITS = 300;

/** Frames after an upload larger than this are not used to correct the budget. */
const UPLOAD_SKIP_BYTES = 4 * 1024 * 1024;

export class Renderer {
  readonly gpu: GpuScene;
  readonly targets: RenderTargets;
  readonly budget: BudgetController;
  readonly list = new DrawList();
  readonly stats: ViewerStats = {
    fps: 0,
    frameMs: 0,
    meshes: 0,
    triangles: 0,
    drawItems: 0,
    drawCalls: 0,
    trianglesDrawn: 0,
    progress: 0,
    gpuMemoryBytes: 0,
    gpuMs: NaN,
  };
  /** Frames rendered (diagnostics). */
  frameCount = 0;
  /** Images started (diagnostics). */
  imageCount = 0;
  /** Presents to the canvas, including present-only frames (diagnostics). */
  presentCount = 0;
  /** Frames that only re-presented the existing image for an overlay change (diagnostics). */
  overlayOnlyFrames = 0;
  /** Scene draw calls submitted since creation, all passes (diagnostics). */
  drawCallsTotal = 0;
  /**
   * Selection / hover overlay. Tints are linear rgb + amount, the outline sRGB rgb + alpha.
   * Call `invalidatePresent()` after changing it.
   */
  readonly overlay: OverlayStyle = {
    selectionTint: [0.15, 0.45, 1.0, 0.45],
    highlightTint: [1.0, 1.0, 1.0, 0.25],
    outlineColor: [1.0, 0.62, 0.1, 1.0],
    outlineWidth: 2,
  };
  /** True while a frame is scheduled. */
  get scheduled(): boolean {
    return this.raf !== 0;
  }
  /** Last frame classification (diagnostics): 'moving' | 'still' | 'idle'. */
  lastMode = 'idle';

  private readonly gl: WebGL2RenderingContext;
  /**
   * Uber-shader variants by key (1 = section planes, 2 = environment, 4 = edges / normal output),
   * created when first needed; [0] is the default program.
   */
  private readonly variants: (UberProgram | null)[] = [null, null, null, null, null, null, null, null];
  private prog: UberProgram;
  private readonly post: PostPasses;
  private readonly reader: PixelReader;
  private readonly timer: GpuTimer;
  private readonly submitter: DrawSubmitter;
  private readonly grouper = new SliceGrouper();
  private keys = new Int32Array(256);
  /** Draw items submitted in the current frame (all passes). */
  private entriesDrawn = 0;
  /** List entry drawn only up to partialCount elements in the current slice (-1 = none). */
  private partialEntry = -1;
  private partialCount = 0;

  // image state
  private imageId = 0;
  private phase = PHASE_DONE;
  private cursor = 0;
  private imageHasBlended = false;
  private stampsInvalid = false;
  private completeNotified = true;
  private listThreshold = -1;
  private invalid = true;
  private presentPending = false;
  private appendPending = false;
  private compactPending = false;
  private drawnImage = new Uint32Array(256);
  private drawnCount = new Uint32Array(256);
  private drawnGen = new Uint32Array(256);
  private progressTotal = 0;
  private progressDone = 0;

  // camera snapshot of the current image (for picking)
  private readonly imgInvViewProj = new Float64Array(16);
  private readonly imgEye = new Float64Array(3);
  private seenCamera = -1;
  private seenStructure = -1;
  private seenBounds = -1;
  private seenCompactStructure = -1;
  private readonly boundsTmp = new Float32Array(6);
  private readonly sceneBounds = new Float64Array(6);
  private hasSceneBounds = false;

  // culling
  private readonly planes64 = new Float64Array(24);
  private readonly cull: CullView = {
    planes: new Float32Array(24),
    eye: new Float64Array(3),
    orthographic: false,
    pixelScale: 1,
    pixelThreshold: 1,
  };

  // section planes (origin-relative world planes a,b,c,d)
  private sectionCount = 0;
  private readonly sectionWorld = new Float64Array(MAX_SECTION_PLANES * 4);
  private readonly sectionView = new Float32Array(MAX_SECTION_PLANES * 4);

  // frame loop
  private raf = 0;
  private lastT = 0;
  private chained = false;
  private prevSubmitted = 0;
  private prevLimited = false;
  private prevCpuMs = 0;
  private budgetSkip = 0;
  private fpsT = 0;
  private fpsFrames = 0;
  private disposed = false;
  private readonly offRestored: () => void;
  private background: [Float32Array, Float32Array];
  private readonly overlayScratch: OverlayStyle = { selectionTint: [], highlightTint: [], outlineColor: [], outlineWidth: 0 };
  private static readonly NO_TINT = [0, 0, 0, 0];

  // edge display (null = off); the camera parameters are those of the current image
  private edges: RenderEdgeOptions | null = null;
  private readonly edgeStyle: EdgeStyle = {
    color: new Float32Array(4),
    cosAngle: 0,
    near: 0,
    far: 1,
    orthographic: false,
    pixelSize: 0,
    depthTex: null,
    normalTex: null,
  };

  // selection x-ray (null = off): the borders of the selected fragments over everything, found on a
  // ghost-hidden mode: hidden fragments drawn faintly by a second ghost pass (`ghostHidden`), and
  // fully hidden draw items kept by the traversal
  private ghostHidden = false;

  // target holding only them (ids + depth; no colour, no normals), see drawXray
  private xray: RenderXrayOptions | null = null;
  private xrayTargets: RenderTargets | null = null;
  private readonly xrayColor = new Float32Array(4);
  /** Image the x-ray target holds, and whether it must be redrawn for other reasons. */
  private xrayImage = 0;
  private xrayDirty = true;
  /** Draw items holding a selected fragment, collected at batching version `xrayStructure`. */
  private xrayItems = new Int32Array(64);
  private xrayItemCount = 0;
  private xrayItemsStale = true;
  private xrayStructure = -1;
  private xrayMark = new Uint32Array(0);
  private xrayMarkGen = 0;

  // image-based lighting
  private readonly envTex: EnvironmentTexture;
  private envUniforms: EnvironmentUniforms | null = null;
  private envPrepared: PreparedEnvironment | null = null;
  /** World -> environment-local rotation, row-major 3x3 (up axis mapping and `rotation`). */
  private readonly envWorld = new Float64Array(9);
  /** View -> environment-local, column-major (u_envMatrix). */
  private readonly envView = new Float32Array(9);

  constructor(
    private readonly ctx: GlContext,
    private readonly scene: Scene,
    private readonly camera: Camera,
    private readonly host: RenderHost,
    private readonly opts: RendererOptions,
  ) {
    this.gl = ctx.gl;
    this.gpu = new GpuScene(ctx);
    this.prog = this.variants[0] = new UberProgram(ctx);
    this.targets = new RenderTargets(ctx);
    this.post = new PostPasses(ctx);
    this.reader = new PixelReader(ctx);
    this.timer = new GpuTimer(ctx);
    this.submitter = new DrawSubmitter(ctx);
    this.envTex = new EnvironmentTexture(ctx);
    this.budget = new BudgetController({ targetMs: opts.frameBudgetMs });
    this.background = [Float32Array.from(opts.background[0]), Float32Array.from(opts.background[1])];
    // near plane from visible content: distant sub-pixel content must not push it out
    camera.visibleDepth = (fz0, fz1, fz2, fz3, pixelScale) => {
      const e = camera.eye;
      const canvas = this.ctx.canvas as HTMLCanvasElement;
      const dpr = this.targets.height / (canvas.clientHeight || this.targets.height);
      return scene.bvh.visibleDepthMax(scene.items, fz0, fz1, fz2, fz3, e[0], e[1], e[2], pixelScale / (dpr > 0 ? dpr : 1), 0.5, this.ghostHidden);
    };
    this.offRestored = ctx.on('restored', () => {
      this.budget.resetCeiling();
      this.invalidateImage();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // control

  /** Schedules a frame (no-op when one is scheduled). */
  wake(): void {
    if (this.raf === 0 && !this.disposed) {
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  /** Restart the progressive image at the next frame. */
  invalidateImage(): void {
    this.invalid = true;
    this.wake();
  }

  /**
   * Re-present the current image at the next frame without redrawing it (selection / hover flags
   * changed). Frames are only scheduled for this one present; the loop idles again afterwards.
   */
  invalidatePresent(): void {
    this.presentPending = true;
    this.wake();
  }

  /** Meshes were added (only): new items can be appended to the current image. */
  noteAppend(): void {
    this.appendPending = true;
    this.wake();
  }

  setFrameBudget(ms: number): void {
    this.budget.targetMs = ms;
  }

  setBackground(top: ArrayLike<number>, bottom: ArrayLike<number>): void {
    this.background = [Float32Array.from(top), Float32Array.from(bottom)];
    this.invalidateImage();
  }

  /** Section planes as origin-relative world planes (a, b, c, d; cut where a*x+b*y+c*z+d > 0). */
  setSectionPlanes(planes: ArrayLike<number>, count: number): void {
    const n = Math.min(count, MAX_SECTION_PLANES);
    this.sectionWorld.fill(0);
    for (let i = 0; i < n * 4; i++) this.sectionWorld[i] = planes[i];
    this.sectionCount = n;
    if (n > 0) this.ensurePrograms();
    this.invalidateImage();
  }

  /**
   * Image-based lighting: a prepared environment (src/render/environment.ts) and its options, or
   * null for the default hemisphere + key light. Re-uploads only when the image changes; always
   * restarts the progressive image.
   */
  setEnvironment(env: PreparedEnvironment | null, options: RenderEnvironmentOptions): void {
    if (env !== this.envPrepared) {
      this.envTex.setLevels(env ? env.levels : null);
      this.envPrepared = env;
    }
    this.envUniforms = env
      ? {
          sh: env.sh,
          lodScale: env.lodScale,
          maxLod: env.levels.length - 1,
          intensity: options.intensity,
          keyLight: options.keyLight,
        }
      : null;
    // world -> env-local: world up onto +Y (z-up: (x, y, z) -> (x, z, -y)), then the environment
    // turned by `rotation` about up (sample direction rotated by -rotation)
    const c = Math.cos(options.rotation);
    const s = Math.sin(options.rotation);
    const m = this.envWorld;
    // R_y(-rotation) rows: [c, 0, -s], [0, 1, 0], [s, 0, c]
    if (this.opts.up === 'z') {
      m.set([c, s, 0, 0, 0, 1, s, -c, 0]);
    } else {
      m.set([c, 0, -s, 0, 1, 0, s, 0, c]);
    }
    this.ensurePrograms();
    for (const v of this.variants) v?.setEnvironment(this.envUniforms);
    this.invalidateImage();
  }

  /**
   * Edge display (screen-space lines at creases, silhouettes and mesh boundaries, drawn in the
   * composite pass), or null for off. Switching it on or off adds / removes the normal attachment and
   * restarts the image; changing only colour / opacity / angle re-presents the current image.
   */
  setEdges(options: RenderEdgeOptions | null): void {
    const was = this.edges !== null;
    this.edges = options;
    const st = this.edgeStyle;
    if (options) {
      const c = st.color as Float32Array;
      c[0] = options.color[0];
      c[1] = options.color[1];
      c[2] = options.color[2];
      c[3] = options.opacity;
      st.cosAngle = Math.cos((options.creaseAngle * Math.PI) / 180);
      this.post.prepareEdges();
    }
    if (this.targets.setNormals(options !== null) || was !== (options !== null)) {
      this.ensurePrograms();
      this.invalidateImage();
    } else {
      this.invalidatePresent();
    }
  }

  /**
   * Selection x-ray: the borders of the selected fragments drawn over the presented image, through
   * whatever is in front of them (`drawXray`), or null for off. Changing the options only
   * re-presents; switching it off frees its target.
   */
  /**
   * Ghost-hidden mode: hidden fragments are drawn like ghosted ones (faint, no ids, not pickable)
   * by a second ghost pass, and draw items whose members are all hidden stay in the draw list.
   * Switching restarts the image.
   */
  setGhostHidden(on: boolean): void {
    if (this.ghostHidden === on) return;
    this.ghostHidden = on;
    this.invalidateImage();
  }

  get isGhostHidden(): boolean {
    return this.ghostHidden;
  }

  setSelectionXray(options: RenderXrayOptions | null): void {
    this.xray = options;
    if (options) {
      const c = this.xrayColor;
      c[0] = options.color[0];
      c[1] = options.color[1];
      c[2] = options.color[2];
      c[3] = options.opacity;
      this.post.prepareXray();
      this.ensurePrograms();
    } else if (this.xrayTargets) {
      this.xrayTargets.dispose();
      this.xrayTargets = null;
      this.xrayDirty = true;
    }
    this.invalidatePresent();
  }

  /** The selection changed (the x-ray target, if any, is stale). */
  selectionChanged(): void {
    this.xrayDirty = true;
    this.xrayItemsStale = true;
  }

  /** Variant key of the current settings (see `variants`). */
  private variantKey(): number {
    return (this.sectionCount > 0 ? 1 : 0) | (this.envUniforms ? 2 : 0) | (this.edges ? 4 : 0);
  }

  /** Variant of the x-ray pass: the section planes only (ids are the only output). */
  private xrayKey(): number {
    return this.sectionCount > 0 ? 1 : 0;
  }

  /** Compiles the program variants the current settings need (outside the frame loop). */
  private ensurePrograms(): void {
    this.ensureProgram(this.variantKey());
    if (this.xray) this.ensureProgram(this.xrayKey());
  }

  private ensureProgram(k: number): void {
    if (this.variants[k]) return;
    const v = new UberProgram(this.ctx, { sectionPlanes: (k & 1) !== 0, environment: (k & 2) !== 0, edges: (k & 4) !== 0 });
    if (k & 2) v.setEnvironment(this.envUniforms);
    this.variants[k] = v;
  }

  /** The program variant for the current settings. */
  private selectProgram(): UberProgram {
    this.ensurePrograms();
    return this.variants[this.variantKey()]!;
  }

  /** GPU pick at CSS pixel coordinates relative to the canvas. */
  async pick(cssX: number, cssY: number): Promise<RenderPick | null> {
    const t = this.targets;
    const canvas = this.ctx.canvas as HTMLCanvasElement;
    if (this.ctx.isLost || t.width < 1) return null;
    const sx = t.width / (canvas.clientWidth || t.width);
    const sy = t.height / (canvas.clientHeight || t.height);
    const x = Math.floor(cssX * sx);
    const y = t.height - 1 - Math.floor(cssY * sy);
    if (x < 0 || y < 0 || x >= t.width || y >= t.height) return null;
    const inv = Float64Array.from(this.imgInvViewProj);
    const eye = Float64Array.from(this.imgEye);
    const w = t.width;
    const h = t.height;
    const p = this.reader.readPixel(t, x, y);
    this.wake(); // the frame loop polls the reader
    const s = await p;
    if (!s || s.id < 0) return null;
    const pos = [0, 0, 0];
    if (!unprojectDepth(x + 0.5, y + 0.5, w, h, s.depth, inv, pos)) return null;
    const dx = pos[0] - eye[0], dy = pos[1] - eye[1], dz = pos[2] - eye[2];
    return { meshId: s.id, position: Float64Array.from(pos), distance: Math.sqrt(dx * dx + dy * dy + dz * dz) };
  }

  /** Idle state check (tests / examples): nothing scheduled and the image is complete. */
  get idle(): boolean {
    return this.raf === 0 && this.phase === PHASE_DONE;
  }

  get pendingPicks(): number {
    return this.reader.pendingCount;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.offRestored();
    this.gpu.dispose();
    for (const v of this.variants) v?.dispose();
    this.targets.dispose();
    this.xrayTargets?.dispose();
    this.post.dispose();
    this.reader.dispose();
    this.timer.dispose();
    this.envTex.dispose();
  }

  // ---------------------------------------------------------------------------------------------
  // frame

  private readonly tick = (t: number): void => {
    this.raf = 0;
    if (this.disposed) return;
    this.frame(t);
  };

  private frame(t: number): void {
    const dt = this.lastT > 0 ? Math.max(0, t - this.lastT) : 1000 / 60;
    const interval = this.chained ? dt : NaN;
    this.lastT = t;
    if (this.budgetSkip > 0) this.budgetSkip--;
    else if (this.prevSubmitted > 0) {
      this.budget.update({
        submitted: this.prevSubmitted,
        limited: this.prevLimited,
        intervalMs: interval,
        cpuMs: this.prevCpuMs,
        gpuMs: this.timer.lastMs,
      });
    }
    this.prevSubmitted = 0;
    this.prevLimited = false;
    this.chained = false;
    if (this.ctx.isLost) return; // 'restored' wakes us again

    const t0 = performance.now();
    const host = this.host;
    const scene = this.scene;
    const camera = this.camera;
    const animating = host.beforeFrame(dt);

    // --- data upload
    scene.flush();
    this.gpu.sync(scene);
    // big uploads (scene loading) make the next frames slow for reasons other than draw work
    if (this.gpu.lastUploadBytes > UPLOAD_SKIP_BYTES) this.budgetSkip = 3;
    this.reader.poll();
    this.timer.poll();

    // --- viewport, scene bounds -> near/far
    const gl = this.gl;
    if (this.targets.resize(gl.drawingBufferWidth, gl.drawingBufferHeight)) this.invalid = true;
    camera.setViewport(this.targets.width, this.targets.height);
    const batcher = scene.batcher;
    if (batcher.structureVersion !== this.seenStructure || batcher.boundsVersion !== this.seenBounds) {
      if (batcher.structureVersion !== this.seenCompactStructure) this.compactPending = true;
      this.seenStructure = batcher.structureVersion;
      this.seenBounds = batcher.boundsVersion;
      this.updateSceneBounds();
    }
    const camChanged = camera.version !== this.seenCamera;
    if (camChanged) {
      this.seenCamera = camera.version;
      host.cameraChanged();
    }

    // --- decide what to draw
    const moving = camChanged || animating || host.interacting;
    const thr = moving ? this.opts.cullPixelSize : this.opts.cullPixelSizeStill;
    let restart = this.invalid || camChanged;
    let submitted = 0;
    let drew = false;
    let limited = false;
    if (moving) {
      if (this.appendPending) restart = true;
      if (restart) {
        this.newImage();
        this.traverse(thr);
        this.timer.begin();
        submitted = this.drawMoving(this.budget.units);
        this.timer.end();
        limited = this.phase === PHASE_MOVING_PARTIAL;
        drew = true;
      }
      this.lastMode = restart ? 'moving' : 'idle';
    } else {
      if (!restart) {
        const stale = this.appendPending || this.listThreshold !== thr || this.phase === PHASE_MOVING_PARTIAL;
        if (stale) {
          if (this.imageHasBlended || this.stampsInvalid) restart = true;
          else {
            this.appendPending = false;
            this.traverse(thr);
            this.phase = PHASE_OPAQUE;
            this.cursor = 0;
            this.completeNotified = false;
            this.advanceEmptyPhases();
          }
        }
      }
      if (restart) {
        this.newImage();
        this.traverse(thr);
        drew = true; // the cleared image must be presented even when nothing is drawn
      }
      if (this.phase < PHASE_DONE) {
        this.timer.begin();
        submitted = this.drawStill(this.budget.units);
        this.timer.end();
        limited = this.phase < PHASE_DONE;
        drew = true;
      }
      this.lastMode = drew ? 'still' : 'idle';
    }

    if (drew) {
      this.present();
      this.frameCount++;
      this.drawCallsTotal += this.submitter.drawCalls;
    } else if (this.presentPending) {
      this.present(); // overlay flags changed: same image, new composite
      this.overlayOnlyFrames++;
    }
    const cpuMs = performance.now() - t0;

    // --- stats
    const st = this.stats;
    st.meshes = scene.meshCount;
    st.triangles = scene.triangleCount;
    st.gpuMemoryBytes = this.ctx.gpuMemoryBytes;
    st.gpuMs = this.timer.lastMs;
    if (drew) {
      st.drawCalls = this.submitter.drawCalls;
      st.trianglesDrawn = this.submitter.trianglesDrawn;
      st.frameMs = cpuMs;
      this.fpsFrames++;
      if (this.fpsT === 0) this.fpsT = t;
      else if (t - this.fpsT >= 500) {
        st.fps = (this.fpsFrames * 1000) / (t - this.fpsT);
        this.fpsFrames = 0;
        this.fpsT = t;
      }
    }
    st.progress =
      this.phase === PHASE_DONE ? 1 : this.progressTotal > 0 ? Math.min(1, this.progressDone / this.progressTotal) : 0;

    // --- completion and idle work
    if (this.phase === PHASE_DONE && !moving) {
      if (!this.completeNotified) {
        this.completeNotified = true;
        host.frameComplete();
      } else if (this.compactPending) {
        if (scene.compact(2)) {
          this.stampsInvalid = true; // re-batched items reuse item slots
        } else {
          this.compactPending = false;
        }
        this.seenCompactStructure = batcher.structureVersion;
      }
    }

    this.prevSubmitted = submitted;
    this.prevLimited = limited;
    this.prevCpuMs = cpuMs;

    // --- schedule
    const more =
      moving ||
      this.invalid ||
      this.appendPending ||
      this.phase < PHASE_DONE ||
      (this.phase === PHASE_DONE && !this.completeNotified) ||
      (this.phase === PHASE_DONE && this.compactPending) ||
      this.reader.pendingCount > 0 ||
      this.phase === PHASE_MOVING_PARTIAL;
    if (more) {
      this.chained = submitted > 0;
      this.wake();
    } else {
      this.fpsT = 0;
      this.fpsFrames = 0;
      // the loop goes idle: the next frame must not see the idle time as its frame time (an
      // animated transition started then would otherwise jump to its end in one frame)
      this.lastT = 0;
    }
  }

  /** Hysteresis on near/far: only grow/shrink the camera's scene bounds on notable change. */
  private updateSceneBounds(): void {
    const b = this.boundsTmp;
    if (!this.scene.getDrawBounds(b)) {
      if (this.hasSceneBounds) {
        this.hasSceneBounds = false;
        this.camera.setSceneBounds(null);
      }
      return;
    }
    const cur = this.sceneBounds;
    const diag = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    let update = !this.hasSceneBounds;
    if (!update) {
      // grew outside the padded bounds?
      for (let i = 0; i < 3; i++) if (b[i] < cur[i] || b[i + 3] > cur[i + 3]) update = true;
      // shrank a lot?
      const cdiag = Math.hypot(cur[3] - cur[0], cur[4] - cur[1], cur[5] - cur[2]);
      if (diag < cdiag * 0.5) update = true;
    }
    if (!update) return;
    const pad = diag * 0.1;
    for (let i = 0; i < 3; i++) {
      cur[i] = b[i] - pad;
      cur[i + 3] = b[i + 3] + pad;
    }
    this.hasSceneBounds = true;
    this.camera.setSceneBounds(cur);
  }

  private newImage(): void {
    this.imageId = (this.imageId + 1) >>> 0 || 1;
    this.imageCount++;
    this.phase = PHASE_OPAQUE;
    this.cursor = 0;
    this.imageHasBlended = false;
    this.stampsInvalid = false;
    this.completeNotified = false;
    this.appendPending = false;
    this.invalid = false;
    this.submitter.resetStats();
    this.stats.drawItems = 0;

    const cam = this.camera;
    this.imgInvViewProj.set(cam.inverseViewProjection64);
    this.imgEye.set(cam.eye);
    // the edge display linearizes this image's depth with this image's projection
    const es = this.edgeStyle;
    es.near = cam.near;
    es.far = cam.far;
    es.orthographic = cam.orthographic;
    es.pixelSize = 1 / cam.pixelFactor;

    // clear + background
    const t = this.targets;
    const s = this.ctx.state;
    const [top, bottom] = this.background;
    if (top[0] === bottom[0] && top[1] === bottom[1] && top[2] === bottom[2]) {
      t.clear(top[0], top[1], top[2], 1);
    } else {
      t.clearIdAndDepth();
      s.setDepthTest(false);
      s.setDepthMask(false);
      s.setBlend(false);
      t.setDrawBuffers('color');
      this.post.drawBackground(top, bottom);
    }

    // per-image uniforms
    const prog = this.selectProgram();
    this.prog = prog;
    const view = cam.view;
    prog.setCamera(view, cam.projection, cam.orthographic);
    if (this.opts.up === 'z') prog.setUpView(view[8], view[9], view[10]);
    else prog.setUpView(view[4], view[5], view[6]);
    if (this.envUniforms) {
      // u_envMatrix = envWorld * viewToWorld; viewToWorld(k, c) = view[k * 4 + c] (transpose of the
      // rotation part of the column-major view matrix)
      const w = this.envWorld;
      const ev = this.envView;
      for (let r = 0; r < 3; r++) {
        for (let col = 0; col < 3; col++) {
          ev[col * 3 + r] = w[r * 3] * view[col] + w[r * 3 + 1] * view[4 + col] + w[r * 3 + 2] * view[8 + col];
        }
      }
      prog.setEnvMatrix(ev);
    }
    if (prog.hasSectionPlanes) {
      planesToViewSpace(this.sectionWorld, this.sectionCount, cam.view64, this.sectionView);
      prog.setSectionPlanes(this.sectionView, this.sectionCount);
    }
  }

  private traverse(threshold: number): void {
    const cam = this.camera;
    const cv = this.cull;
    frustum.fromViewProjection(this.planes64, cam.viewProjection64);
    (cv.planes as Float32Array).set(this.planes64);
    const eye = cv.eye as Float64Array;
    eye[0] = cam.eye[0];
    eye[1] = cam.eye[1];
    eye[2] = cam.eye[2];
    cv.orthographic = cam.orthographic;
    const canvas = this.ctx.canvas as HTMLCanvasElement;
    const dpr = this.targets.height / (canvas.clientHeight || this.targets.height);
    cv.pixelScale = cam.pixelFactor / (dpr > 0 ? dpr : 1);
    cv.pixelThreshold = threshold;
    cv.includeHidden = this.ghostHidden;
    this.scene.traverse(cv, this.list);
    this.listThreshold = threshold;
    this.ensureStamps();

    // progress accounting: opaque + transparent work, minus what this image already shows
    const list = this.list;
    const no = list.opaqueCount;
    const n = no + list.transparentCount;
    let total = 0;
    let done = 0;
    for (let e = 0; e < n; e++) {
      const full = this.cost(e, 0);
      total += full;
      if (e < no) done += full - this.cost(e, this.skipOf(list.item[e]));
    }
    this.progressTotal = total;
    this.progressDone = done;
  }

  private ensureStamps(): void {
    const cap = this.scene.items.capacity;
    if (this.drawnImage.length >= cap) return;
    const a = new Uint32Array(cap);
    a.set(this.drawnImage);
    this.drawnImage = a;
    const b = new Uint32Array(cap);
    b.set(this.drawnCount);
    this.drawnCount = b;
    const c = new Uint32Array(cap);
    c.set(this.drawnGen);
    this.drawnGen = c;
  }

  /** Elements of item `it` already in the current image (0 for an item re-allocated since). */
  private skipOf(it: number): number {
    return this.drawnImage[it] === this.imageId && this.drawnGen[it] === this.scene.items.gen[it] ? this.drawnCount[it] : 0;
  }

  /** Work units of list entry e with `skip` elements already drawn. */
  private cost(e: number, skip: number): number {
    return this.rangeCost(e, skip, this.list.count[e]);
  }

  /** Work units of drawing elements [from, to) of entry e (indices for merged, instances for instanced). */
  private rangeCost(e: number, from: number, to: number): number {
    if (to <= from) return 0;
    const it = this.list.item[e];
    const items = this.scene.items;
    const n = to - from;
    const tris = items.kind[it] === ITEM_INSTANCED ? (items.indexCount[it] / 3) * n : n / 3;
    return tris + ENTRY_OVERHEAD_UNITS;
  }

  /** Elements of entry e to submit this frame (a partially drawn entry uses a shorter prefix). */
  private countOf(e: number): number {
    return e === this.partialEntry ? this.partialCount : this.list.count[e];
  }

  /**
   * Largest prefix end q in (skip, count) of entry e whose remainder [skip, q) fits into `units`, or
   * 0. Items store their members largest first, so a prefix is the most important part. Instanced:
   * any instance count. Merged: only member boundaries from the item's detail table, so no mesh is
   * ever drawn half.
   */
  private partialFit(e: number, skip: number, units: number): number {
    const it = this.list.item[e];
    const cnt = this.list.count[e];
    const items = this.scene.items;
    const avail = units - ENTRY_OVERHEAD_UNITS;
    if (avail <= 0) return 0;
    if (items.kind[it] === ITEM_INSTANCED) {
      const per = items.indexCount[it] / 3;
      const q = skip + Math.floor(avail / Math.max(per, 1));
      return q > skip && q < cnt ? q : 0;
    }
    const d0 = it * DETAIL_STEPS;
    const len = items.detailLen[it];
    const dc = items.detailCount;
    let best = 0;
    for (let k = 1; k < len; k++) {
      const q = dc[d0 + k];
      if (q <= skip || q >= cnt) continue;
      if ((q - skip) / 3 <= avail && q > best) best = q;
    }
    return best;
  }

  /** Skips phases that have nothing to draw. */
  private advanceEmptyPhases(): void {
    const no = this.list.opaqueCount;
    const n = no + this.list.transparentCount;
    const ghost = this.ghostPassCount() > 0;
    for (;;) {
      if (this.phase === PHASE_OPAQUE && this.cursor >= no) {
        this.phase = PHASE_TRANSPARENT;
        this.cursor = no;
      } else if (this.phase === PHASE_TRANSPARENT && this.cursor >= n) {
        this.phase = PHASE_GHOST;
        this.cursor = 0;
      } else if (this.phase === PHASE_GHOST && (!ghost || this.cursor >= n)) {
        this.phase = PHASE_TID;
        this.cursor = no;
      } else if (this.phase === PHASE_TID && this.cursor >= n) {
        this.phase = PHASE_DONE;
      } else return;
    }
  }

  private beginDraw(): void {
    this.targets.bind();
    this.gpu.fragTex.bind(UBER_FRAG_TEX_UNIT);
    this.gpu.matTex.bind(UBER_MAT_TEX_UNIT);
    if (this.envUniforms) this.envTex.bind(UBER_ENV_TEX_UNIT);
  }

  private setPass(pass: UberPass): void {
    applyPassState(this.ctx, this.targets, pass);
    this.prog.setPass(pass, false); // items are split by transparency already
  }

  /**
   * Number of ghost passes of this image: one for ghosted fragments, one more for hidden fragments
   * in ghost-hidden mode (0 skips the GHOST phase). Each pass runs over the whole list; the flag
   * filter drops the other fragments in the vertex shader.
   */
  private ghostPassCount(): number {
    let n = this.host.ghostCount() > 0 ? 1 : 0;
    if (this.ghostHidden && this.host.hiddenCount() > 0) n++;
    return n;
  }

  /** The k-th ghost pass (k < ghostPassCount()). */
  private ghostPass(k: number): UberPass {
    return k === 0 && this.host.ghostCount() > 0 ? 'ghost' : 'ghostHidden';
  }

  /** Moving frame: restart was done; draw what fits, drop the rest. Returns units submitted. */
  private drawMoving(budget: number): number {
    const list = this.list;
    const no = list.opaqueCount;
    const n = no + list.transparentCount;
    const gp = this.ghostPassCount();
    this.submitter.resetStats();
    // opaque prefix (importance order); the first entry that does not fit is drawn partially
    const fo = 1 + gp;
    const opaqueBudget = n > no ? budget * 0.85 : budget;
    let used = 0;
    let e = 0;
    let partial = false;
    this.partialEntry = -1;
    while (e < no) {
      const c = this.cost(e, 0) * fo;
      if (used + c > opaqueBudget) {
        const q = this.partialFit(e, 0, (opaqueBudget - used) / fo);
        if (q > 0) {
          this.partialEntry = e;
          this.partialCount = q;
          used += this.rangeCost(e, 0, q) * fo;
          partial = true;
          e++;
          break;
        }
        if (e > 0) break;
      }
      used += c;
      e++;
    }
    // transparent: the nearest ones that still fit (list is back to front -> take a suffix)
    const ft = 2 + gp;
    let ts = n;
    while (ts > no) {
      const c = this.cost(ts - 1, 0) * ft;
      if (used + c > budget && (e < no || ts < n)) break;
      used += c;
      ts--;
    }
    this.beginDraw();
    this.entriesDrawn = 0;
    if (e > 0) {
      this.setPass('opaque');
      this.groupSlice(0, e);
      this.submitGroups(0, true);
    }
    if (ts < n) {
      this.setPass('transparent');
      this.drawInOrder(ts, n);
      this.imageHasBlended = true;
    }
    if (gp > 0 && (e > 0 || ts < n)) {
      for (let k = 0; k < gp; k++) {
        this.setPass(this.ghostPass(k));
        if (e > 0) {
          this.groupSlice(0, e);
          this.submitGroups(0, false);
        }
        if (ts < n) this.drawInOrder(ts, n);
      }
      this.imageHasBlended = true;
    }
    if (ts < n) {
      this.setPass('transparentId');
      this.drawInOrder(ts, n);
    }
    this.stats.drawItems = this.entriesDrawn;
    this.partialEntry = -1;
    this.phase = partial || e < no || ts > no ? PHASE_MOVING_PARTIAL : PHASE_DONE;
    if (this.phase === PHASE_DONE) this.progressDone = this.progressTotal;
    return used;
  }

  /** Still frame: continue the phases within the budget. Returns units submitted. */
  private drawStill(budget: number): number {
    const list = this.list;
    const no = list.opaqueCount;
    const n = no + list.transparentCount;
    this.submitter.resetStats();
    this.beginDraw();
    let used = 0;
    this.entriesDrawn = 0;
    this.advanceEmptyPhases();
    while (this.phase < PHASE_DONE) {
      if (used >= budget) break;
      const phase = this.phase;
      const start = this.cursor;
      const end = phase === PHASE_OPAQUE ? no : n;
      let e = start;
      const opaque = phase === PHASE_OPAQUE;
      let drawEnd = -1; // > e when the last entry is drawn partially (cursor stays on it)
      let budgetHit = false;
      this.partialEntry = -1;
      while (e < end) {
        const skip = opaque ? this.skipOf(list.item[e]) : 0;
        const c = this.cost(e, skip);
        if (used + c > budget) {
          // opaque entries can be drawn partially; stamps remember the prefix for the next frame
          const q = opaque ? this.partialFit(e, skip, budget - used) : 0;
          if (q > 0) {
            this.partialEntry = e;
            this.partialCount = q;
            const pc = this.rangeCost(e, skip, q);
            used += pc;
            this.progressDone += pc;
            drawEnd = e + 1;
            budgetHit = true;
            break;
          }
          if (e > start || used > 0) {
            budgetHit = true;
            break;
          }
        }
        used += c;
        if (phase === PHASE_OPAQUE || phase === PHASE_TRANSPARENT) this.progressDone += c;
        e++;
      }
      const sliceEnd = drawEnd > e ? drawEnd : e;
      if (sliceEnd > start) {
        const e = sliceEnd; // the draw calls below cover [start, sliceEnd)
        if (phase === PHASE_OPAQUE) {
          this.setPass('opaque');
          this.groupSlice(start, e);
          this.submitGroups(start, true);
        } else if (phase === PHASE_TRANSPARENT) {
          this.setPass('transparent');
          this.drawInOrder(start, e);
          this.imageHasBlended = true;
        } else if (phase === PHASE_GHOST) {
          const gp = this.ghostPassCount();
          for (let k = 0; k < gp; k++) {
            this.setPass(this.ghostPass(k));
            this.groupSlice(start, e);
            this.submitGroups(start, false);
          }
          this.imageHasBlended = true;
        } else {
          this.setPass('transparentId');
          this.groupSlice(start, e);
          this.submitGroups(start, false);
        }
      }
      this.partialEntry = -1;
      this.cursor = e;
      this.advanceEmptyPhases();
      if (budgetHit) break;
    }
    this.stats.drawItems = this.entriesDrawn;
    return used;
  }

  /** VAO slot of list entry e (created lazily), or null when it cannot be drawn. */
  private slotOf(e: number): VaoSlot | null {
    const items = this.scene.items;
    const it = this.list.item[e];
    const kind = items.kind[it];
    if (kind === ITEM_FREE) return null;
    if (kind === ITEM_INSTANCED) return this.gpu.instancedSlot(items.page[it], items.instancePage[it]);
    return this.gpu.mergedSlot(items.page[it]);
  }

  /** Buckets entries [start, end) of the list by VAO slot (SliceGrouper). */
  private groupSlice(start: number, end: number): void {
    const n = end - start;
    if (this.keys.length < n) this.keys = new Int32Array(Math.max(n, this.keys.length * 2));
    const keys = this.keys;
    for (let i = 0; i < n; i++) {
      const s = this.slotOf(start + i);
      keys[i] = s ? s.slot : -1;
    }
    this.grouper.group(keys, n, this.gpu.slotCount);
  }

  /**
   * Submits the groups of the last groupSlice(start, ..). `opaque`: skip elements already drawn in
   * this image and stamp what gets drawn.
   */
  private submitGroups(start: number, opaque: boolean): void {
    const g = this.grouper;
    const list = this.list;
    const items = this.scene.items;
    const sub = this.submitter;
    const slots = this.gpu.slots;
    const imageId = this.imageId;
    for (let k = 0; k < g.groupCount; k++) {
      const s = slots[g.groupKey[k]]!;
      const a = g.groupStart[k];
      const b = g.groupStart[k + 1];
      if (s.merged) {
        s.vao.bind();
        sub.discard();
        for (let j = a; j < b; j++) {
          const e = start + g.order[j];
          const it = list.item[e];
          const cnt = this.countOf(e);
          const skip = opaque ? this.skipOf(it) : 0;
          if (cnt <= skip) continue;
          sub.push(items.firstIndex[it] + skip, cnt - skip);
          this.entriesDrawn++;
          if (opaque) {
            this.drawnImage[it] = imageId;
            this.drawnCount[it] = cnt;
            this.drawnGen[it] = items.gen[it];
          }
        }
        sub.flush();
      } else {
        for (let j = a; j < b; j++) {
          const e = start + g.order[j];
          const it = list.item[e];
          const cnt = this.countOf(e);
          const skip = opaque ? this.skipOf(it) : 0;
          if (cnt <= skip) continue;
          sub.drawInstanced(s.vao, items.firstIndex[it], items.indexCount[it], items.firstInstance[it] + skip, cnt - skip);
          this.entriesDrawn++;
          if (opaque) {
            this.drawnImage[it] = imageId;
            this.drawnCount[it] = cnt;
            this.drawnGen[it] = items.gen[it];
          }
        }
      }
    }
  }

  /** Draws entries [start, end) in list order (blended passes), fusing consecutive same-page ranges. */
  private drawInOrder(start: number, end: number): void {
    const list = this.list;
    const items = this.scene.items;
    const sub = this.submitter;
    let cur: VaoSlot | null = null;
    sub.discard();
    for (let e = start; e < end; e++) {
      const s = this.slotOf(e);
      if (!s) continue;
      const it = list.item[e];
      const cnt = list.count[e];
      if (s.merged) {
        if (s !== cur) {
          sub.flush();
          s.vao.bind();
          cur = s;
        }
        sub.push(items.firstIndex[it], cnt);
        this.entriesDrawn++;
      } else {
        sub.flush();
        cur = null;
        sub.drawInstanced(s.vao, items.firstIndex[it], items.indexCount[it], items.firstInstance[it], cnt);
        this.entriesDrawn++;
      }
    }
    sub.flush();
  }

  private present(): void {
    const gl = this.gl;
    const s = this.ctx.state;
    this.presentPending = false;
    this.presentCount++;
    const t = this.targets;
    const sel = this.host.selectionCount > 0;
    const xray = sel && this.xray !== null;
    if (xray) this.drawXray(); // into its own target, before the canvas is bound
    s.bindFramebuffer(null);
    s.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    s.setDepthTest(false);
    s.setBlend(false);
    const edges = this.edges !== null && t.normalTex !== null;
    if (sel || this.host.highlightActive || edges) {
      // outline width is in target pixels: scale with the device pixel ratio
      const canvas = this.ctx.canvas as HTMLCanvasElement;
      const dpr = t.height / (canvas.clientHeight || t.height);
      const o = this.overlay;
      // the x-ray draws the whole silhouette in its own colour: no selection outline under it
      const width = sel && !xray && o.outlineWidth > 0 ? Math.max(1, Math.round(o.outlineWidth * (dpr > 0 ? dpr : 1))) : 0;
      const tint = sel || this.host.highlightActive;
      this.overlayScratch.selectionTint = tint ? o.selectionTint : Renderer.NO_TINT;
      this.overlayScratch.highlightTint = tint ? o.highlightTint : Renderer.NO_TINT;
      this.overlayScratch.outlineColor = o.outlineColor;
      this.overlayScratch.outlineWidth = width;
      let es: EdgeStyle | null = null;
      if (edges) {
        es = this.edgeStyle;
        es.depthTex = t.depthTex;
        es.normalTex = t.normalTex;
      }
      this.post.drawComposite(t.colorTex!, t.idTex!, this.gpu.fragTex.texture, this.overlayScratch, 0, 0, es);
    } else {
      this.post.drawPresent(t.colorTex!);
    }
    if (xray) {
      // the border of the selection in the x-ray target over everything; the width is in CSS pixels, the
      // line covers `radius` target pixels on each side of a boundary
      const canvas = this.ctx.canvas as HTMLCanvasElement;
      const dpr = t.height / (canvas.clientHeight || t.height);
      const radius = Math.max(1, Math.round((this.xray!.width * (dpr > 0 ? dpr : 1)) / 2));
      s.setBlend(true);
      s.setBlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.post.drawXray(this.xrayTargets!.idTex!, this.xrayColor, radius);
      s.setBlend(false);
    }
  }

  /**
   * Selection x-ray pass: the selected fragments alone (ids with a depth test; no colour, no
   * normals) into the x-ray target, with the image's camera, independent of the progressive image. Only the draw
   * items holding a selected fragment are submitted, in full (the vertex shader drops the other
   * fragments of an item), so the cost follows the selection rather than the scene. Nothing is
   * drawn while the target is current: same image, selection and batching.
   */
  private drawXray(): void {
    const scene = this.scene;
    const structure = scene.batcher.structureVersion;
    let t = this.xrayTargets;
    if (!t) {
      t = this.xrayTargets = new RenderTargets(this.ctx, { color: false });
      this.xrayDirty = true;
    }
    if (t.resize(this.targets.width, this.targets.height)) this.xrayDirty = true;
    if (!this.xrayDirty && this.xrayImage === this.imageId && this.xrayStructure === structure) return;
    this.xrayDirty = false;
    this.xrayImage = this.imageId;
    if (this.xrayItemsStale || this.xrayStructure !== structure) this.collectXrayItems();
    this.xrayStructure = structure;

    t.clear(); // binds it: ids and depth cleared
    const k = this.xrayKey();
    this.ensureProgram(k);
    const prog = this.variants[k]!;
    if (prog !== this.prog) {
      const cam = this.camera; // unchanged since the image started (a change restarts the image)
      prog.setCamera(cam.view, cam.projection, cam.orthographic);
      if (prog.hasSectionPlanes) prog.setSectionPlanes(this.sectionView, this.sectionCount);
    }
    this.gpu.fragTex.bind(UBER_FRAG_TEX_UNIT);
    this.gpu.matTex.bind(UBER_MAT_TEX_UNIT);
    applyPassState(this.ctx, t, 'selectedId');
    prog.setPass('selectedId', false);

    // the pass is not part of the scene statistics
    const sub = this.submitter;
    const drawCalls = sub.drawCalls;
    const indices = sub.indicesDrawn;
    const instances = sub.instancesDrawn;
    const items = scene.items;
    let cur: VaoSlot | null = null;
    sub.discard();
    for (let i = 0; i < this.xrayItemCount; i++) {
      const it = this.xrayItems[i];
      const kind = items.kind[it];
      if (kind === ITEM_FREE) continue;
      if (kind === ITEM_INSTANCED) {
        sub.flush();
        cur = null;
        const slot = this.gpu.instancedSlot(items.page[it], items.instancePage[it]);
        if (slot) sub.drawInstanced(slot.vao, items.firstIndex[it], items.indexCount[it], items.firstInstance[it], items.instanceCount[it]);
      } else {
        const slot = this.gpu.mergedSlot(items.page[it]);
        if (!slot) continue;
        if (slot !== cur) {
          sub.flush();
          slot.vao.bind();
          cur = slot;
        }
        sub.push(items.firstIndex[it], items.indexCount[it]);
      }
    }
    sub.flush();
    sub.drawCalls = drawCalls;
    sub.indicesDrawn = indices;
    sub.instancesDrawn = instances;
  }

  /** Collects the draw items holding a selected fragment, each once (`xrayItems`). */
  private collectXrayItems(): void {
    const cap = this.scene.items.capacity;
    if (this.xrayMark.length < cap) {
      this.xrayMark = new Uint32Array(cap);
      this.xrayMarkGen = 0;
    }
    this.xrayMarkGen++;
    this.xrayItemCount = 0;
    this.scene.forEachSelectedFragment(this.collectXrayItem);
    this.xrayItemsStale = false;
  }

  private readonly collectXrayItem = (f: number): void => {
    const it = this.scene.fragments.item[f];
    if (it < 0 || this.xrayMark[it] === this.xrayMarkGen) return; // not batched yet, or seen
    this.xrayMark[it] = this.xrayMarkGen;
    if (this.xrayItemCount === this.xrayItems.length) {
      const a = new Int32Array(this.xrayItems.length * 2);
      a.set(this.xrayItems);
      this.xrayItems = a;
    }
    this.xrayItems[this.xrayItemCount++] = it;
  };
}

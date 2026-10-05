/**
 * Measurement plugin: distance between two points picked on model surfaces, with a magnet to
 * vertices and feature edges (`viewer.snap`). Built only on the public API.
 *
 *   const viewer = new Viewer(canvas, { plugins: [measurePlugin({ unit: 'm', decimals: 2 })] });
 *   createViewerUi(viewer);                                     // adds the "Measure" button
 *   const measure = viewer.getPlugin<MeasurePlugin>('measure')!;
 *   measure.activate();                                         // or headless: measure.add(a, b)
 *
 * Measurements live in world space: they stay where they are when models are hidden, unloaded or
 * moved with `model.setTransform` (they do not follow the model).
 */
import type { Model } from '../../loaders/types';
import type { SnapKind, SnapOptions, SnapResult, ViewerApi, ViewerTool } from '../../types';
import type { ToolbarToggle, ViewerUi } from '../../ui/ViewerUi';
import type { PluginContext, PluginInstance, ViewerPlugin } from '../types';
import { formatDistance } from './geometry';
import { MeasureOverlay, type OverlayMarker } from './MeasureOverlay';

type V3 = [number, number, number];

/** One end of a measurement. */
export interface MeasurePoint {
  /** World position (float64). */
  readonly position: V3;
  /** How it was snapped; null for points given to `add`. */
  readonly kind: SnapKind | null;
  readonly meshId?: number;
  readonly objectId?: number;
  readonly model?: Model;
}

export interface Measurement {
  readonly id: number;
  readonly start: MeasurePoint;
  readonly end: MeasurePoint;
  /** Euclidean distance between start and end (world units). */
  readonly distance: number;
  /** end - start per world axis. */
  readonly delta: V3;
}

export interface MeasureOptions {
  /** Plugin name (`viewer.getPlugin(name)`). Default 'measure'. */
  name?: string;
  /** Unit label appended by the default format, e.g. 'm'. Default none. */
  unit?: string;
  /** Decimals of the default format. Default 3. */
  decimals?: number;
  /** Replaces the default format (distance and the signed axis deltas). */
  format?: (distance: number) => string;
  /** Show the axis deltas (dx, dy, dz) as a second label line. Default true. */
  deltas?: boolean;
  /** Magnet tolerance for mouse / pen, CSS px. Default 12. */
  snapRadius?: number;
  /** Magnet tolerance for touch, CSS px. Default 24. */
  touchSnapRadius?: number;
  /** Snap to vertices and feature edges (false: plain surface points). Default true. */
  snap?: boolean;
  /** Crease angle (degrees) for feature edges. Default 20. */
  edgeAngle?: number;
  /** Line colour (CSS). Default orange. */
  color?: string;
  /** Add the "Measure" toolbar button (built-in UI) and the "Clear measurements" menu entry. Default true. */
  ui?: boolean;
}

export interface MeasureEvents {
  created: Measurement;
  removed: Measurement;
  /** The tool was activated / deactivated. */
  active: boolean;
}

/** The installed plugin's API (`viewer.getPlugin<MeasurePlugin>('measure')`). */
export interface MeasurePlugin extends PluginInstance {
  /** The measuring tool is the viewer's active tool. */
  readonly active: boolean;
  /** Makes measuring the active tool (clicks place points instead of selecting). */
  activate(): void;
  /** Leaves the tool (a half-done measurement is dropped; finished ones stay). */
  deactivate(): void;
  /** Toggles the tool; returns the new state. */
  toggle(): boolean;
  /** Finished measurements, oldest first (read-only snapshot). */
  readonly measurements: readonly Measurement[];
  /** Adds a measurement between two world points (programmatic / headless use). */
  add(start: ArrayLike<number>, end: ArrayLike<number>): Measurement;
  /** Removes a measurement; false when there is none with this id. */
  remove(id: number): boolean;
  /** Removes all measurements. */
  clear(): void;
  /** The label text for a distance (the configured format). */
  format(distance: number): string;
  on<K extends keyof MeasureEvents>(event: K, handler: (payload: MeasureEvents[K]) => void): () => void;
}

/** Creates the measurement plugin. */
export function measurePlugin(options: MeasureOptions = {}): ViewerPlugin<MeasurePlugin> {
  return {
    name: options.name ?? 'measure',
    install: (context) => new MeasureController(context, options),
  };
}

class MeasureController implements MeasurePlugin {
  private readonly viewer: ViewerApi;
  private readonly context: PluginContext;
  private readonly opts: MeasureOptions;
  private readonly list: Measurement[] = [];
  private snapshot: readonly Measurement[] | null = null;
  private nextId = 1;
  private readonly handlers: { [K in keyof MeasureEvents]: Set<(p: MeasureEvents[K]) => void> } = {
    created: new Set(),
    removed: new Set(),
    active: new Set(),
  };
  private readonly tool: ViewerTool;
  private isActive = false;
  /** Incremented on (de)activation: results of snaps started earlier are dropped. */
  private session = 0;

  // interaction state
  private pending: MeasurePoint | null = null;
  /** Magnet marker: the hover snap (mouse) or the last placed point (touch). */
  private marker: OverlayMarker | null = null;
  /** Current end of the rubber band (hover snap). */
  private rubberEnd: V3 | null = null;
  private hoverX = 0;
  private hoverY = 0;
  private hoverType = 'mouse';
  private hoverBusy = false;
  private hoverAgain = false;
  private hoverInside = false;
  private taps: Promise<void> = Promise.resolve();

  // DOM
  private overlay: MeasureOverlay | null = null;
  private toggleButton: ToolbarToggle | null = null;
  private readonly offView: () => void;
  private uiCleanup: (() => void) | null = null;
  private disposed = false;

  constructor(context: PluginContext, options: MeasureOptions) {
    this.context = context;
    this.viewer = context.viewer;
    this.opts = options;
    const decimals = options.decimals ?? 3;
    if (!(decimals >= 0 && decimals <= 20)) throw new RangeError(`measure: decimals must be in 0..20, got ${decimals}`);
    this.tool = {
      name: options.name ?? 'measure',
      cursor: 'crosshair',
      onTap: (x, y, info) => this.place(x, y, info.pointerType),
      onPointerMove: (x, y, info) => this.hover(x, y, info.pointerType),
      onPointerLeave: () => {
        this.hoverInside = false;
        this.marker = null;
        this.rubberEnd = null;
        this.render();
      },
      onEscape: () => this.cancelPending(),
      // a started measurement: right click cancels it, and no menu gets in the way
      onContextMenu: () => this.cancelPending(),
      onDeactivate: () => this.deactivated(),
    };
    // overlays follow the camera inside the animation frame (no lag, nothing when idle)
    this.offView = this.viewer.on('view', () => this.render());
    // context menu entry, owned by the plugin (removed with it); drawn by the built-in UI or the app
    if (options.ui !== false) {
      context.addContextMenuItem({
        label: 'Clear measurements',
        enabled: () => this.list.length > 0,
        onClick: () => this.clear(),
      });
    }
  }

  // --- API ------------------------------------------------------------------------------------

  get active(): boolean {
    return this.isActive;
  }

  activate(): void {
    if (this.disposed || this.isActive) return;
    this.viewer.setTool(this.tool);
    this.isActive = true;
    this.session++;
    if (this.toggleButton) this.toggleButton.on = true;
    this.emit('active', true);
  }

  deactivate(): void {
    if (this.viewer.getTool() === this.tool) this.viewer.setTool(null);
    else if (this.isActive) this.deactivated();
  }

  toggle(): boolean {
    if (this.isActive) this.deactivate();
    else this.activate();
    return this.isActive;
  }

  get measurements(): readonly Measurement[] {
    return (this.snapshot ??= Object.freeze(this.list.slice()));
  }

  add(start: ArrayLike<number>, end: ArrayLike<number>): Measurement {
    const a = toV3(start, 'start'), b = toV3(end, 'end');
    return this.create({ position: a, kind: null }, { position: b, kind: null });
  }

  remove(id: number): boolean {
    const i = this.list.findIndex((m) => m.id === id);
    if (i < 0) return false;
    const [m] = this.list.splice(i, 1);
    this.changed();
    this.emit('removed', m);
    return true;
  }

  clear(): void {
    const all = this.list.splice(0);
    if (all.length === 0) return;
    this.changed();
    for (const m of all) this.emit('removed', m);
  }

  format(distance: number): string {
    const f = this.opts.format;
    return f ? f(distance) : formatDistance(distance, this.opts.decimals ?? 3, this.opts.unit ?? '');
  }

  on<K extends keyof MeasureEvents>(event: K, handler: (payload: MeasureEvents[K]) => void): () => void {
    const set = this.handlers[event] as Set<(p: MeasureEvents[K]) => void>;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  // --- plugin hooks ---------------------------------------------------------------------------

  ui(ui: ViewerUi): () => void {
    if (this.opts.ui === false) return () => {};
    const toggle = ui.addToggle({
      label: 'Measure',
      title: 'Measure distances: click two points (snaps to vertices and edges). Esc cancels / leaves.',
      onClick: () => this.toggle(),
    });
    toggle.on = this.isActive;
    this.toggleButton = toggle;
    const cleanup = (): void => {
      toggle.remove();
      if (this.toggleButton === toggle) this.toggleButton = null;
      if (this.uiCleanup === cleanup) this.uiCleanup = null;
    };
    this.uiCleanup = cleanup;
    return cleanup;
  }

  dispose(): void {
    if (this.disposed) return;
    this.deactivate();
    this.disposed = true;
    this.offView();
    this.uiCleanup?.();
    this.overlay?.dispose();
    this.overlay = null;
    for (const k of Object.keys(this.handlers) as (keyof MeasureEvents)[]) this.handlers[k].clear();
  }

  // --- interaction ----------------------------------------------------------------------------

  private snapOptions(pointerType: string): SnapOptions {
    const touch = pointerType === 'touch';
    const snap = this.opts.snap ?? true;
    return {
      pointerType,
      radius: touch ? (this.opts.touchSnapRadius ?? 24) : (this.opts.snapRadius ?? 12),
      vertices: snap,
      edges: snap,
      edgeAngle: this.opts.edgeAngle,
    };
  }

  /** Hover (mouse / pen): one snap in flight; the latest position is snapped when it returns. */
  private hover(x: number, y: number, pointerType: string): void {
    this.hoverX = x;
    this.hoverY = y;
    this.hoverType = pointerType;
    this.hoverInside = true;
    if (this.hoverBusy) {
      this.hoverAgain = true;
      return;
    }
    this.runHover();
  }

  private runHover(): void {
    this.hoverBusy = true;
    this.hoverAgain = false;
    const session = this.session;
    this.viewer.snap(this.hoverX, this.hoverY, this.snapOptions(this.hoverType)).then(
      (r) => {
        this.hoverBusy = false;
        if (this.disposed || session !== this.session) return;
        if (this.hoverInside) {
          this.marker = r ? markerOf(r) : null;
          this.rubberEnd = r ? r.position : null;
          this.render();
        }
        if (this.hoverAgain && this.hoverInside) this.runHover();
      },
      () => {
        this.hoverBusy = false;
      },
    );
  }

  /** Click / tap: snaps are started at once and their results handled in click order. */
  private place(x: number, y: number, pointerType: string): void {
    const session = this.session;
    const snap = this.viewer.snap(x, y, this.snapOptions(pointerType));
    this.taps = this.taps
      .then(() => snap)
      .then((r) => {
        if (!r || this.disposed || session !== this.session) return; // background: nothing placed
        const p = pointOf(r);
        if (pointerType === 'touch') this.marker = markerOf(r); // no hover on touch: show the magnet result
        if (!this.pending) {
          this.pending = p;
          // mouse: the rubber band end is the latest hover snap (which may be newer than this click)
          if (pointerType === 'touch') this.rubberEnd = null;
          this.render();
        } else {
          const start = this.pending;
          const a = start.position, b = p.position;
          if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return; // a double click: keep waiting for the end
          this.pending = null;
          this.rubberEnd = null;
          this.create(start, p);
        }
      })
      .catch((e) => console.error('measure: placing a point failed', e));
  }

  /** Escape / right click: drops a started measurement. True when there was one. */
  private cancelPending(): boolean {
    if (!this.pending) return false;
    this.pending = null;
    this.rubberEnd = null;
    this.render();
    return true;
  }

  private deactivated(): void {
    if (!this.isActive) return;
    this.isActive = false;
    this.session++;
    this.pending = null;
    this.marker = null;
    this.rubberEnd = null;
    this.hoverInside = false;
    if (this.toggleButton) this.toggleButton.on = false;
    this.render();
    this.emit('active', false);
  }

  private create(start: MeasurePoint, end: MeasurePoint): Measurement {
    const a = start.position, b = end.position;
    const delta: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const m: Measurement = Object.freeze({
      id: this.nextId++,
      start: Object.freeze(start),
      end: Object.freeze(end),
      distance: Math.hypot(delta[0], delta[1], delta[2]),
      delta,
    });
    this.list.push(m);
    this.changed();
    this.emit('created', m);
    return m;
  }

  private changed(): void {
    this.snapshot = null;
    this.overlay?.sync(this.list.map((m) => m.id));
    this.render();
  }

  // --- drawing --------------------------------------------------------------------------------

  /** Positions everything; creates the overlay on first need (never without a DOM). */
  private render(): void {
    if (this.disposed) return;
    const busy = this.list.length > 0 || this.pending !== null || this.marker !== null;
    if (!this.overlay) {
      if (!busy || typeof document === 'undefined') return;
      this.overlay = new MeasureOverlay(this.viewer, this.context.overlay(), this.opts.color);
      this.overlay.sync(this.list.map((m) => m.id));
    }
    const o = this.overlay;
    const deltas = this.opts.deltas ?? true;
    for (const m of this.list) {
      o.drawMeasurement(m.id, m.start.position, m.end.position, this.format(m.distance), deltas ? this.deltaText(m.delta) : '');
    }
    const p = this.pending;
    const e = this.rubberEnd;
    if (p && e) {
      const d: V3 = [e[0] - p.position[0], e[1] - p.position[1], e[2] - p.position[2]];
      o.drawPending(p.position, e, this.format(Math.hypot(d[0], d[1], d[2])), deltas ? this.deltaText(d) : '');
    } else {
      o.drawPending(p ? p.position : null, null, '', '');
    }
    o.drawMarker(this.marker);
  }

  private deltaText(d: ArrayLike<number>): string {
    return `dx ${this.format(d[0])}  dy ${this.format(d[1])}  dz ${this.format(d[2])}`;
  }

  private emit<K extends keyof MeasureEvents>(event: K, payload: MeasureEvents[K]): void {
    for (const fn of Array.from(this.handlers[event] as Set<(p: MeasureEvents[K]) => void>)) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`measure: error in '${event}' handler`, e);
      }
    }
  }
}

function toV3(p: ArrayLike<number>, what: string): V3 {
  const v: V3 = [+p[0], +p[1], +p[2]];
  if (!(Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]))) {
    throw new TypeError(`measure: ${what} must be 3 finite numbers`);
  }
  return v;
}

function pointOf(r: SnapResult): MeasurePoint {
  const p: { -readonly [K in keyof MeasurePoint]: MeasurePoint[K] } = {
    position: r.position,
    kind: r.kind,
    meshId: r.meshId,
    objectId: r.objectId,
  };
  if (r.model) p.model = r.model;
  return p;
}

function markerOf(r: SnapResult): OverlayMarker {
  return r.edge ? { position: r.position, kind: r.kind, edge: r.edge } : { position: r.position, kind: r.kind };
}

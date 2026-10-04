/**
 * WebGL2 context creation, capability detection, context-loss handling, resource registry and
 * GPU memory accounting.
 */
import { GlState } from './GlState';

/** EXT_disjoint_timer_query_webgl2 (not in lib.dom). */
export interface TimerQueryExt {
  readonly QUERY_COUNTER_BITS_EXT: number;
  readonly TIME_ELAPSED_EXT: number;
  readonly TIMESTAMP_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
  queryCounterEXT(query: WebGLQuery, target: number): void;
}

/** WEBGL_provoking_vertex (not in lib.dom). */
export interface ProvokingVertexExt {
  readonly FIRST_VERTEX_CONVENTION_WEBGL: number;
  readonly LAST_VERTEX_CONVENTION_WEBGL: number;
  readonly PROVOKING_VERTEX_WEBGL: number;
  provokingVertexWEBGL(provokeMode: number): void;
}

export interface GlCaps {
  /** WEBGL_multi_draw, or null. */
  multiDraw: WEBGL_multi_draw | null;
  /** EXT_color_buffer_float: float colour attachments are renderable. */
  colorBufferFloat: boolean;
  /** EXT_disjoint_timer_query_webgl2, or null. */
  timerQuery: TimerQueryExt | null;
  /** OES_draw_buffers_indexed (per-draw-buffer blend state), or null. */
  drawBuffersIndexed: OES_draw_buffers_indexed | null;
  /** WEBGL_provoking_vertex, or null. When present the context is switched to first-vertex convention. */
  provokingVertex: ProvokingVertexExt | null;
  /**
   * Draft extension WEBGL_draw_instanced_base_vertex_base_instance present. Detected for information
   * only; the instanced path in this layer re-points the instance attribute instead.
   */
  baseInstance: boolean;
  maxTextureSize: number;
  maxDrawBuffers: number;
  maxVertexAttribs: number;
  maxTextureUnits: number;
}

export interface GlContextOptions {
  /** Canvas alpha channel. Default false (opaque canvas, cheaper compositing). */
  alpha?: boolean;
  /** Default 'high-performance'. */
  powerPreference?: WebGLPowerPreference;
  /** Default false. */
  preserveDrawingBuffer?: boolean;
  /** Default false. */
  desynchronized?: boolean;
}

/** Anything owning GL objects. `restore()` recreates them after a context restore. */
export interface GlResource {
  restore(): void;
  dispose(): void;
}

export type GlContextEvent = 'lost' | 'restored';

export interface GpuMemory {
  buffers: number;
  textures: number;
  renderTargets: number;
}

export function detectCaps(gl: WebGL2RenderingContext): GlCaps {
  const multiDraw = gl.getExtension('WEBGL_multi_draw');
  const colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
  const timerQuery = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
  const drawBuffersIndexed = gl.getExtension('OES_draw_buffers_indexed');
  const provokingVertex = gl.getExtension('WEBGL_provoking_vertex') as ProvokingVertexExt | null;
  const baseInstance = !!gl.getExtension('WEBGL_draw_instanced_base_vertex_base_instance');
  return {
    multiDraw,
    colorBufferFloat,
    timerQuery,
    drawBuffersIndexed,
    provokingVertex,
    baseInstance,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS) as number,
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number,
    maxTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number,
  };
}

export class GlContext {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  caps: GlCaps;
  readonly state: GlState;
  /** Bytes of GPU memory held by resources created through this context. */
  readonly memory: GpuMemory = { buffers: 0, textures: 0, renderTargets: 0 };

  private lost = false;
  private readonly resources: GlResource[] = [];
  private readonly listeners: Record<GlContextEvent, Array<() => void>> = { lost: [], restored: [] };
  private readonly onLost = (e: Event): void => {
    e.preventDefault(); // required for a later 'webglcontextrestored'
    this.lost = true;
    this.emit('lost');
  };
  private readonly onRestored = (): void => {
    this.lost = false;
    this.caps = detectCaps(this.gl);
    this.applyDefaults();
    this.state.invalidate();
    this.memory.buffers = this.memory.textures = this.memory.renderTargets = 0;
    // Creation order = dependency order (buffers before the VAOs that reference them).
    for (const r of this.resources.slice()) r.restore();
    this.emit('restored');
  };

  /** Creates a WebGL2 context on `canvas`. Throws when WebGL2 is unavailable. */
  static create(canvas: HTMLCanvasElement | OffscreenCanvas, options: GlContextOptions = {}): GlContext {
    const attribs: WebGLContextAttributes = {
      alpha: options.alpha ?? false,
      antialias: false, // we render to offscreen targets
      depth: false, // the default framebuffer only receives the presented image
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      powerPreference: options.powerPreference ?? 'high-performance',
      desynchronized: options.desynchronized ?? false,
    };
    const gl = canvas.getContext('webgl2', attribs) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('mk-viewer: WebGL2 is not available');
    return new GlContext(gl, canvas);
  }

  constructor(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.caps = detectCaps(gl);
    this.applyDefaults();
    this.state = new GlState(gl);
    canvas.addEventListener('webglcontextlost', this.onLost as EventListener, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored as EventListener, false);
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  /** Total GPU bytes tracked (buffers + data textures + render targets). */
  get gpuMemoryBytes(): number {
    return this.memory.buffers + this.memory.textures + this.memory.renderTargets;
  }

  /** Subscribe to 'lost' / 'restored'. Returns an unsubscribe function. */
  on(event: GlContextEvent, fn: () => void): () => void {
    const list = this.listeners[event];
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Registers a resource for `restore()` on context restore. Called by resource constructors. */
  track(r: GlResource): void {
    this.resources.push(r);
  }

  untrack(r: GlResource): void {
    const i = this.resources.indexOf(r);
    if (i >= 0) this.resources.splice(i, 1);
  }

  /** Disposes all tracked resources and detaches listeners. Does not lose the context. */
  dispose(): void {
    for (const r of this.resources.slice().reverse()) r.dispose();
    this.resources.length = 0;
    this.canvas.removeEventListener('webglcontextlost', this.onLost as EventListener, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored as EventListener, false);
    this.listeners.lost.length = 0;
    this.listeners.restored.length = 0;
  }

  private applyDefaults(): void {
    const pv = this.caps.provokingVertex;
    // Flat varyings carry the same value on all three vertices, so the convention does not change
    // results; first-vertex avoids ANGLE/D3D11 emulation cost of the GL last-vertex convention.
    if (pv) pv.provokingVertexWEBGL(pv.FIRST_VERTEX_CONVENTION_WEBGL);
  }

  private emit(event: GlContextEvent): void {
    for (const fn of this.listeners[event].slice()) fn();
  }
}

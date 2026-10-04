/**
 * Asynchronous id + depth readback for picking. `read()` runs a tiny resolve pass that copies a
 * rectangle of the id target and the depth texture (as float bits) into a small RGBA8 MRT target,
 * issues readPixels into a PIXEL_PACK_BUFFER and a fenceSync. `poll()` (call once per frame) checks
 * the fences without blocking and resolves the promises with getBufferSubData. The GPU pipeline is
 * never stalled.
 */
import type { GlContext, GlResource } from './GlContext';
import { UPLOAD_TEXTURE_UNIT } from './GlState';
import { Program } from './Program';
import type { RenderTargets } from './RenderTargets';
import { decodeFloatBytes, decodeIdBytes } from './pack';
import { FULLSCREEN_VS } from './shaders/common';
import { PICK_RESOLVE_FS } from './shaders/post';

export interface PixelRect {
  /** Left, in target pixels (GL convention: origin bottom-left). */
  x: number;
  /** Bottom, in target pixels (GL convention). */
  y: number;
  width: number;
  height: number;
  /** Fragment index per pixel, -1 = background. Row-major from the bottom row. */
  ids: Int32Array;
  /** Window-space depth in [0, 1] per pixel (1 = far plane / background). */
  depths: Float32Array;
}

export interface PixelSample {
  /** Target pixel (GL convention). */
  x: number;
  y: number;
  /** Fragment index, or -1 for background. */
  id: number;
  /** Window-space depth in [0, 1]; feed to unprojectDepth() (pack.ts) with x + 0.5, y + 0.5. */
  depth: number;
}

interface Pending {
  sync: WebGLSync;
  pbo: WebGLBuffer;
  x: number;
  y: number;
  w: number;
  h: number;
  resolve: (r: PixelRect | null) => void;
  frames: number;
}

/** Largest rectangle side one read can return. */
export const MAX_READ_SIZE = 32;

export class PixelReader implements GlResource {
  private program: Program;
  private fbo!: WebGLFramebuffer;
  private idTex!: WebGLTexture;
  private depthTex!: WebGLTexture;
  private vao!: WebGLVertexArrayObject;
  private pending: Pending[] = [];
  private freePbos: WebGLBuffer[] = [];
  private readonly drawList: number[];
  private readonly offLost: () => void;

  constructor(private readonly ctx: GlContext) {
    const gl = ctx.gl;
    this.drawList = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1];
    this.program = new Program(ctx, FULLSCREEN_VS, PICK_RESOLVE_FS, 'pick resolve');
    this.program.setSampler('u_idTex', 0);
    this.program.setSampler('u_depthTex', 1);
    this.createObjects();
    ctx.track(this);
    this.offLost = ctx.on('lost', () => this.failAll());
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Reads one pixel. Coordinates in target pixels, GL convention (origin bottom-left); for CSS
   * coordinates use: x = floor(cssX * dpr), y = targetHeight - 1 - floor(cssY * dpr).
   * Resolves null when the context is lost or the pixel is outside the target.
   */
  async readPixel(targets: RenderTargets, x: number, y: number): Promise<PixelSample | null> {
    const r = await this.read(targets, x, y, 1, 1);
    if (!r) return null;
    return { x, y, id: r.ids[0], depth: r.depths[0] };
  }

  /**
   * Reads a rectangle (up to MAX_READ_SIZE square) of ids and depths from the current content of
   * `targets`. Pixels outside the target read as background (id -1, depth 1).
   */
  read(targets: RenderTargets, x: number, y: number, width = 1, height = 1): Promise<PixelRect | null> {
    const ctx = this.ctx;
    const gl = ctx.gl;
    x = Math.floor(x);
    y = Math.floor(y);
    const w = Math.min(MAX_READ_SIZE, Math.max(1, width | 0));
    const h = Math.min(MAX_READ_SIZE, Math.max(1, height | 0));
    if (ctx.isLost || !targets.idTex || !targets.depthTex) return Promise.resolve(null);
    if (x + w <= 0 || y + h <= 0 || x >= targets.width || y >= targets.height) {
      return Promise.resolve(null);
    }
    const state = ctx.state;

    // 1. resolve pass into the small RGBA8 MRT target
    state.bindFramebuffer(this.fbo);
    gl.drawBuffers(this.drawList);
    state.setViewport(0, 0, w, h);
    state.setBlend(false);
    state.setDepthTest(false);
    const p = this.program.use();
    p.setIvec2('u_origin', x, y);
    state.bindTexture(0, targets.idTex);
    state.bindTexture(1, targets.depthTex);
    state.bindVao(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. async readback into a PBO: ids at 0, depth bits at w*h*4
    const bytes = w * h * 4;
    const pbo = this.acquirePbo();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes * 2, gl.STREAM_READ);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (!sync) {
      this.freePbos.push(pbo);
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.pending.push({ sync, pbo, x, y, w, h, resolve, frames: 0 });
    });
  }

  /** Checks pending reads without blocking; call once per frame. */
  poll(): void {
    if (this.pending.length === 0) return;
    const gl = this.ctx.gl;
    if (this.ctx.isLost) {
      this.failAll();
      return;
    }
    let write = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      p.frames++;
      const status = gl.clientWaitSync(p.sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED && p.frames < 120) {
        this.pending[write++] = p;
        continue;
      }
      gl.deleteSync(p.sync);
      if (status === gl.WAIT_FAILED || status === gl.TIMEOUT_EXPIRED) {
        this.freePbos.push(p.pbo);
        p.resolve(null);
        continue;
      }
      const n = p.w * p.h;
      const raw = new Uint8Array(n * 8);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, raw);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.freePbos.push(p.pbo);
      const ids = new Int32Array(n);
      const depths = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        ids[k] = decodeIdBytes(raw, k * 4);
        depths[k] = decodeFloatBytes(raw, n * 4 + k * 4);
      }
      p.resolve({ x: p.x, y: p.y, width: p.w, height: p.h, ids, depths });
    }
    this.pending.length = write;
  }

  restore(): void {
    this.freePbos = [];
    this.createObjects();
  }

  dispose(): void {
    const gl = this.ctx.gl;
    this.offLost();
    this.failAll();
    for (const b of this.freePbos) gl.deleteBuffer(b);
    this.freePbos = [];
    this.ctx.state.forgetFramebuffer(this.fbo);
    gl.deleteFramebuffer(this.fbo);
    this.ctx.state.forgetTexture(this.idTex);
    this.ctx.state.forgetTexture(this.depthTex);
    gl.deleteTexture(this.idTex);
    gl.deleteTexture(this.depthTex);
    this.ctx.state.forgetVao(this.vao);
    gl.deleteVertexArray(this.vao);
    this.program.dispose();
    this.ctx.untrack(this);
  }

  private failAll(): void {
    const pend = this.pending;
    this.pending = [];
    for (const p of pend) {
      if (!this.ctx.gl.isContextLost()) {
        this.ctx.gl.deleteSync(p.sync);
        this.freePbos.push(p.pbo);
      }
      p.resolve(null);
    }
  }

  private acquirePbo(): WebGLBuffer {
    const b = this.freePbos.pop() ?? this.ctx.gl.createBuffer();
    if (!b) throw new Error('mk-viewer: createBuffer failed (pixel reader)');
    return b;
  }

  private createObjects(): void {
    const gl = this.ctx.gl;
    const state = this.ctx.state;
    const mk = (): WebGLTexture => {
      const t = gl.createTexture();
      if (!t) throw new Error('mk-viewer: createTexture failed (pixel reader)');
      state.bindTexture(UPLOAD_TEXTURE_UNIT, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, MAX_READ_SIZE, MAX_READ_SIZE);
      return t;
    };
    this.idTex = mk();
    this.depthTex = mk();
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('mk-viewer: createFramebuffer failed (pixel reader)');
    this.fbo = fbo;
    state.bindFramebuffer(fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.idTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.depthTex, 0);
    gl.drawBuffers(this.drawList);
    state.bindFramebuffer(null);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('mk-viewer: createVertexArray failed (pixel reader)');
    this.vao = vao;
  }
}

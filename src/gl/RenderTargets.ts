/**
 * Offscreen scene target: colour (RGBA8, sRGB-encoded values), id (RGBA8, fragment index + 1) and
 * depth (DEPTH_COMPONENT32F texture, falls back to DEPTH_COMPONENT24). All attachments are
 * textures so post passes and the pick resolve can sample them.
 *
 * Nothing here clears implicitly: the target keeps its content across frames, which is what the
 * progressive renderer needs (clear only when restarting the image).
 */
import type { GlContext, GlResource } from './GlContext';
import { UPLOAD_TEXTURE_UNIT } from './GlState';

export type DrawBufferMode = 'all' | 'color' | 'id' | 'none';

export class RenderTargets implements GlResource {
  width = 0;
  height = 0;
  framebuffer: WebGLFramebuffer;
  colorTex: WebGLTexture | null = null;
  idTex: WebGLTexture | null = null;
  depthTex: WebGLTexture | null = null;
  /** DEPTH_COMPONENT32F or DEPTH_COMPONENT24, whichever made the framebuffer complete. */
  depthFormat = 0;

  private drawMode: DrawBufferMode | null = null;
  private readonly buffersAll: number[];
  private readonly buffersColor: number[];
  private readonly buffersId: number[];
  private readonly buffersNone: number[];
  private readonly clearColor = new Float32Array(4);
  private readonly clearZero = new Float32Array(4);
  private readonly clearDepthValue = new Float32Array([1]);

  constructor(private readonly ctx: GlContext) {
    const gl = ctx.gl;
    this.buffersAll = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1];
    this.buffersColor = [gl.COLOR_ATTACHMENT0, gl.NONE];
    this.buffersId = [gl.NONE, gl.COLOR_ATTACHMENT1];
    this.buffersNone = [gl.NONE, gl.NONE];
    this.framebuffer = this.createFramebuffer();
    ctx.track(this);
  }

  get byteSize(): number {
    return this.width * this.height * 12;
  }

  /**
   * Resizes all attachments (content is lost). Returns true when the size changed.
   * Use the drawing-buffer size of the canvas so present() is a 1:1 copy.
   */
  resize(width: number, height: number): boolean {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height) return false;
    this.width = width;
    this.height = height;
    this.allocate();
    return true;
  }

  /** Binds the framebuffer and sets the viewport to the full target. */
  bind(): void {
    this.ctx.state.bindFramebuffer(this.framebuffer);
    this.ctx.state.setViewport(0, 0, this.width, this.height);
  }

  /**
   * Selects which attachments fragment outputs go to (target must be bound):
   * 'all' = colour + id (opaque pass), 'color' = colour only (blended passes, background),
   * 'id' = id only (e.g. a transparent pick pass), 'none' = depth only.
   */
  setDrawBuffers(mode: DrawBufferMode): void {
    if (this.drawMode === mode) return;
    this.drawMode = mode;
    const list =
      mode === 'all'
        ? this.buffersAll
        : mode === 'color'
          ? this.buffersColor
          : mode === 'id'
            ? this.buffersId
            : this.buffersNone;
    this.ctx.gl.drawBuffers(list);
  }

  /**
   * Starts a new image: colour = (r, g, b, a) (sRGB-encoded), id = 0 (background), depth = 1.
   * Binds the target, leaves draw buffers = 'all' and the depth mask enabled.
   */
  clear(r = 0, g = 0, b = 0, a = 1): void {
    const gl = this.ctx.gl;
    this.bind();
    this.setDrawBuffers('all');
    this.ctx.state.setDepthMask(true);
    this.clearColor[0] = r;
    this.clearColor[1] = g;
    this.clearColor[2] = b;
    this.clearColor[3] = a;
    gl.clearBufferfv(gl.COLOR, 0, this.clearColor);
    gl.clearBufferfv(gl.COLOR, 1, this.clearZero);
    gl.clearBufferfv(gl.DEPTH, 0, this.clearDepthValue);
  }

  /** Clears id and depth only (colour is about to be overwritten, e.g. by the background pass). */
  clearIdAndDepth(): void {
    const gl = this.ctx.gl;
    this.bind();
    this.setDrawBuffers('all');
    this.ctx.state.setDepthMask(true);
    gl.clearBufferfv(gl.COLOR, 1, this.clearZero);
    gl.clearBufferfv(gl.DEPTH, 0, this.clearDepthValue);
  }

  /**
   * Copies the colour attachment to the canvas (default framebuffer) with blitFramebuffer.
   * Alternative to PostPasses.present(). Leaves the default framebuffer bound for drawing.
   */
  blitColorToCanvas(canvasWidth: number, canvasHeight: number): void {
    const gl = this.ctx.gl;
    const state = this.ctx.state;
    state.bindReadFramebuffer(this.framebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    state.bindDrawFramebuffer(null);
    gl.blitFramebuffer(
      0, 0, this.width, this.height,
      0, 0, canvasWidth, canvasHeight,
      gl.COLOR_BUFFER_BIT, gl.NEAREST,
    );
    state.bindFramebuffer(null);
  }

  restore(): void {
    this.framebuffer = this.createFramebuffer();
    this.colorTex = this.idTex = this.depthTex = null;
    this.allocatedBytes = 0;
    this.drawMode = null;
    const w = this.width;
    const h = this.height;
    this.width = this.height = 0;
    if (w > 0) this.resize(w, h);
  }

  dispose(): void {
    const gl = this.ctx.gl;
    this.deleteTextures();
    this.ctx.state.forgetFramebuffer(this.framebuffer);
    gl.deleteFramebuffer(this.framebuffer);
    this.ctx.untrack(this);
  }

  private createFramebuffer(): WebGLFramebuffer {
    const fb = this.ctx.gl.createFramebuffer();
    if (!fb) throw new Error('mk-viewer: createFramebuffer failed');
    return fb;
  }

  private deleteTextures(): void {
    const gl = this.ctx.gl;
    for (const t of [this.colorTex, this.idTex, this.depthTex]) {
      if (t) {
        this.ctx.state.forgetTexture(t);
        gl.deleteTexture(t);
      }
    }
    this.colorTex = this.idTex = this.depthTex = null;
    this.ctx.memory.renderTargets = Math.max(0, this.ctx.memory.renderTargets - this.allocatedBytes);
    this.allocatedBytes = 0;
  }

  private allocatedBytes = 0;

  private makeTexture(internalFormat: number): WebGLTexture {
    const gl = this.ctx.gl;
    const t = gl.createTexture();
    if (!t) throw new Error('mk-viewer: createTexture failed (render target)');
    this.ctx.state.bindTexture(UPLOAD_TEXTURE_UNIT, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, this.width, this.height);
    return t;
  }

  private allocate(): void {
    const gl = this.ctx.gl;
    const state = this.ctx.state;
    this.deleteTextures();
    this.colorTex = this.makeTexture(gl.RGBA8);
    this.idTex = this.makeTexture(gl.RGBA8);

    state.bindFramebuffer(this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.idTex, 0);

    let status = 0;
    for (const fmt of [gl.DEPTH_COMPONENT32F, gl.DEPTH_COMPONENT24]) {
      if (this.depthTex) {
        state.forgetTexture(this.depthTex);
        gl.deleteTexture(this.depthTex);
      }
      this.depthTex = this.makeTexture(fmt);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTex, 0);
      status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status === gl.FRAMEBUFFER_COMPLETE) {
        this.depthFormat = fmt;
        break;
      }
    }
    if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
      throw new Error(`mk-viewer: scene framebuffer incomplete (0x${status.toString(16)})`);
    }
    this.drawMode = null;
    this.setDrawBuffers('all');
    this.allocatedBytes = this.byteSize;
    this.ctx.memory.renderTargets += this.allocatedBytes;
  }
}

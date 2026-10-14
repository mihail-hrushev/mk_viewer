/**
 * A colour-only framebuffer (one RGBA8 texture): the output of a screenshot, where the present /
 * composite passes draw instead of the canvas and the pixels are read back from. Nothing here
 * clears implicitly.
 */
import type { GlContext, GlResource } from './GlContext';
import { UPLOAD_TEXTURE_UNIT } from './GlState';

export class ColorTarget implements GlResource {
  width = 0;
  height = 0;
  framebuffer: WebGLFramebuffer;
  colorTex: WebGLTexture | null = null;
  private allocatedBytes = 0;

  constructor(private readonly ctx: GlContext) {
    this.framebuffer = this.createFramebuffer();
    ctx.track(this);
  }

  /** Allocates the texture at this size (content is lost). Returns true when the size changed. */
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
   * Reads the whole target as RGBA8 into `out` (`width * height * 4` bytes, rows from the bottom,
   * GL convention). Synchronous: waits for the GPU.
   */
  readPixels(out: Uint8Array | Uint8ClampedArray): void {
    const gl = this.ctx.gl;
    this.ctx.state.bindFramebuffer(this.framebuffer);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  }

  restore(): void {
    this.framebuffer = this.createFramebuffer();
    this.colorTex = null;
    this.allocatedBytes = 0;
    const w = this.width;
    const h = this.height;
    this.width = this.height = 0;
    if (w > 0) this.resize(w, h);
  }

  dispose(): void {
    const gl = this.ctx.gl;
    this.deleteTexture();
    this.ctx.state.forgetFramebuffer(this.framebuffer);
    gl.deleteFramebuffer(this.framebuffer);
    this.ctx.untrack(this);
  }

  private createFramebuffer(): WebGLFramebuffer {
    const fb = this.ctx.gl.createFramebuffer();
    if (!fb) throw new Error('mk-viewer: createFramebuffer failed');
    return fb;
  }

  private deleteTexture(): void {
    if (!this.colorTex) return;
    this.ctx.state.forgetTexture(this.colorTex);
    this.ctx.gl.deleteTexture(this.colorTex);
    this.colorTex = null;
    this.ctx.memory.renderTargets -= this.allocatedBytes;
    this.allocatedBytes = 0;
  }

  private allocate(): void {
    const gl = this.ctx.gl;
    const state = this.ctx.state;
    this.deleteTexture();
    const t = gl.createTexture();
    if (!t) throw new Error('mk-viewer: createTexture failed (colour target)');
    state.bindTexture(UPLOAD_TEXTURE_UNIT, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.width, this.height);
    this.colorTex = t;
    state.bindFramebuffer(this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
      throw new Error(`mk-viewer: colour framebuffer incomplete (0x${status.toString(16)})`);
    }
    this.allocatedBytes = this.width * this.height * 4;
    this.ctx.memory.renderTargets += this.allocatedBytes;
  }
}

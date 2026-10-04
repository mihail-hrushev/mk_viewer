/**
 * Minimal WebGL2 state cache. Every bind / enable that goes through here is skipped when the GL
 * state already matches. All modules in src/gl route their binds through this object, so code that
 * talks to `gl` directly for these states must call `invalidate()` afterwards.
 */

const MAX_TEXTURE_UNITS = 16;

/**
 * Texture unit used by src/gl for texture creation and uploads, so uploads never disturb the
 * bindings of units used for drawing. Renderers should bind their textures to units 0..14.
 */
export const UPLOAD_TEXTURE_UNIT = MAX_TEXTURE_UNITS - 1;

export class GlState {
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private readFramebuffer: WebGLFramebuffer | null = null;
  private drawFramebuffer: WebGLFramebuffer | null = null;
  private arrayBuffer: WebGLBuffer | null = null;
  private activeUnit = 0;
  private readonly textures: (WebGLTexture | null)[] = new Array(MAX_TEXTURE_UNITS).fill(null);

  private blend = false;
  private blendSrcRgb = 1; // ONE
  private blendDstRgb = 0; // ZERO
  private blendSrcAlpha = 1;
  private blendDstAlpha = 0;
  private depthTest = false;
  private depthMask = true;
  private depthFunc = 0x0201; // LESS
  private cullFace = false;
  private vpX = 0;
  private vpY = 0;
  private vpW = -1;
  private vpH = -1;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.invalidate();
  }

  /**
   * Forces GL into a known state and makes the cache match it. Call after context restore or after
   * foreign code touched GL state.
   */
  invalidate(): void {
    const gl = this.gl;
    this.program = null;
    gl.useProgram(null);
    this.vao = null;
    gl.bindVertexArray(null);
    this.readFramebuffer = this.drawFramebuffer = null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.arrayBuffer = null;
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    for (let i = 0; i < MAX_TEXTURE_UNITS; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.textures[i] = null;
    }
    this.activeUnit = 0;
    gl.activeTexture(gl.TEXTURE0);

    this.blend = false;
    gl.disable(gl.BLEND);
    this.blendSrcRgb = this.blendSrcAlpha = gl.ONE;
    this.blendDstRgb = this.blendDstAlpha = gl.ZERO;
    gl.blendFuncSeparate(gl.ONE, gl.ZERO, gl.ONE, gl.ZERO);
    gl.blendEquation(gl.FUNC_ADD);
    this.depthTest = false;
    gl.disable(gl.DEPTH_TEST);
    this.depthMask = true;
    gl.depthMask(true);
    this.depthFunc = gl.LESS;
    gl.depthFunc(gl.LESS);
    this.cullFace = false;
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    this.vpW = this.vpH = -1;

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  useProgram(p: WebGLProgram | null): void {
    if (this.program !== p) {
      this.program = p;
      this.gl.useProgram(p);
    }
  }

  bindVao(v: WebGLVertexArrayObject | null): void {
    if (this.vao !== v) {
      this.vao = v;
      this.gl.bindVertexArray(v);
    }
  }

  get boundVao(): WebGLVertexArrayObject | null {
    return this.vao;
  }

  /** Binds `fb` as both read and draw framebuffer. */
  bindFramebuffer(fb: WebGLFramebuffer | null): void {
    if (this.readFramebuffer !== fb || this.drawFramebuffer !== fb) {
      this.readFramebuffer = this.drawFramebuffer = fb;
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fb);
    }
  }

  bindReadFramebuffer(fb: WebGLFramebuffer | null): void {
    if (this.readFramebuffer !== fb) {
      this.readFramebuffer = fb;
      this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, fb);
    }
  }

  bindDrawFramebuffer(fb: WebGLFramebuffer | null): void {
    if (this.drawFramebuffer !== fb) {
      this.drawFramebuffer = fb;
      this.gl.bindFramebuffer(this.gl.DRAW_FRAMEBUFFER, fb);
    }
  }

  get boundDrawFramebuffer(): WebGLFramebuffer | null {
    return this.drawFramebuffer;
  }

  /** ARRAY_BUFFER binding is global (not VAO state), so it is safe to cache. */
  bindArrayBuffer(b: WebGLBuffer | null): void {
    if (this.arrayBuffer !== b) {
      this.arrayBuffer = b;
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, b);
    }
  }

  /**
   * Binds a TEXTURE_2D to a texture unit and leaves that unit active, so texture calls that act on
   * "the bound texture" (texSubImage2D, texParameteri, ...) right after this call target `tex` even
   * when the binding itself was already cached.
   */
  bindTexture(unit: number, tex: WebGLTexture | null): void {
    if (this.activeUnit !== unit) {
      this.activeUnit = unit;
      this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    }
    if (this.textures[unit] !== tex) {
      this.textures[unit] = tex;
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
    }
  }

  /** Forget a deleted texture so a later texture object reusing the slot is rebound. */
  forgetTexture(tex: WebGLTexture): void {
    for (let i = 0; i < MAX_TEXTURE_UNITS; i++) if (this.textures[i] === tex) this.textures[i] = null;
  }

  forgetBuffer(b: WebGLBuffer): void {
    if (this.arrayBuffer === b) this.arrayBuffer = null;
  }

  forgetVao(v: WebGLVertexArrayObject): void {
    if (this.vao === v) {
      this.vao = null;
      this.gl.bindVertexArray(null);
    }
  }

  forgetFramebuffer(fb: WebGLFramebuffer): void {
    if (this.readFramebuffer === fb || this.drawFramebuffer === fb) this.bindFramebuffer(null);
  }

  forgetProgram(p: WebGLProgram): void {
    if (this.program === p) this.useProgram(null);
  }

  setBlend(enabled: boolean): void {
    if (this.blend !== enabled) {
      this.blend = enabled;
      if (enabled) this.gl.enable(this.gl.BLEND);
      else this.gl.disable(this.gl.BLEND);
    }
  }

  setBlendFunc(srcRgb: number, dstRgb: number, srcAlpha = srcRgb, dstAlpha = dstRgb): void {
    if (
      this.blendSrcRgb !== srcRgb ||
      this.blendDstRgb !== dstRgb ||
      this.blendSrcAlpha !== srcAlpha ||
      this.blendDstAlpha !== dstAlpha
    ) {
      this.blendSrcRgb = srcRgb;
      this.blendDstRgb = dstRgb;
      this.blendSrcAlpha = srcAlpha;
      this.blendDstAlpha = dstAlpha;
      this.gl.blendFuncSeparate(srcRgb, dstRgb, srcAlpha, dstAlpha);
    }
  }

  setDepthTest(enabled: boolean): void {
    if (this.depthTest !== enabled) {
      this.depthTest = enabled;
      if (enabled) this.gl.enable(this.gl.DEPTH_TEST);
      else this.gl.disable(this.gl.DEPTH_TEST);
    }
  }

  setDepthMask(write: boolean): void {
    if (this.depthMask !== write) {
      this.depthMask = write;
      this.gl.depthMask(write);
    }
  }

  setDepthFunc(func: number): void {
    if (this.depthFunc !== func) {
      this.depthFunc = func;
      this.gl.depthFunc(func);
    }
  }

  setCullFace(enabled: boolean): void {
    if (this.cullFace !== enabled) {
      this.cullFace = enabled;
      if (enabled) this.gl.enable(this.gl.CULL_FACE);
      else this.gl.disable(this.gl.CULL_FACE);
    }
  }

  setViewport(x: number, y: number, w: number, h: number): void {
    if (this.vpX !== x || this.vpY !== y || this.vpW !== w || this.vpH !== h) {
      this.vpX = x;
      this.vpY = y;
      this.vpW = w;
      this.vpH = h;
      this.gl.viewport(x, y, w, h);
    }
  }
}

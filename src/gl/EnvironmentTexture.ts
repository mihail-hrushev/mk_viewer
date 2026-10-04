/**
 * Equirectangular environment map for image-based lighting: RGBA16F with an explicit, CPU-built mip
 * chain (float data uploaded into a half-float texture, valid WebGL2 without extensions; half-float
 * textures are filterable in core WebGL2). LINEAR_MIPMAP_LINEAR, repeat in u (azimuth), clamp in v.
 * Sampled with textureLod only. Without an image it holds a 1x1 black texel, so the sampler of the
 * uber program is always complete. Keeps its CPU levels and re-uploads them after a context restore.
 */
import type { GlContext, GlResource } from './GlContext';
import { UPLOAD_TEXTURE_UNIT } from './GlState';

/** RGBA float texels, rows top to bottom. Level k+1 is half of level k in both axes (min 1). */
export interface EnvironmentTextureLevel {
  width: number;
  height: number;
  data: Float32Array;
}

const PLACEHOLDER: EnvironmentTextureLevel[] = [{ width: 1, height: 1, data: new Float32Array(4) }];

export class EnvironmentTexture implements GlResource {
  texture: WebGLTexture;
  /** GPU bytes held (8 per texel). */
  byteSize = 0;
  private levels: EnvironmentTextureLevel[] | null = null;

  constructor(private readonly ctx: GlContext) {
    this.texture = this.create();
    this.upload();
    ctx.track(this);
  }

  /** True while an environment image (not the placeholder) is loaded. */
  get hasImage(): boolean {
    return this.levels !== null;
  }

  /** Replaces the image (null = placeholder). The level array is kept for context restore. */
  setLevels(levels: EnvironmentTextureLevel[] | null): void {
    if (levels) checkChain(levels, this.ctx.caps.maxTextureSize);
    this.levels = levels;
    if (this.ctx.isLost) return; // uploaded on restore
    this.release();
    this.texture = this.create();
    this.upload();
  }

  bind(unit: number): void {
    this.ctx.state.bindTexture(unit, this.texture);
  }

  restore(): void {
    this.byteSize = 0; // the context reset the memory counters
    this.texture = this.create();
    this.upload();
  }

  dispose(): void {
    this.release();
    this.levels = null;
    this.ctx.untrack(this);
  }

  private release(): void {
    this.ctx.state.forgetTexture(this.texture);
    this.ctx.gl.deleteTexture(this.texture);
    this.ctx.memory.textures -= this.byteSize;
    this.byteSize = 0;
  }

  private create(): WebGLTexture {
    const t = this.ctx.gl.createTexture();
    if (!t) throw new Error('mk-viewer: createTexture failed (environment)');
    return t;
  }

  private upload(): void {
    const gl = this.ctx.gl;
    const levels = this.levels ?? PLACEHOLDER;
    const mip = levels.length > 1;
    this.ctx.state.bindTexture(UPLOAD_TEXTURE_UNIT, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels.length - 1);
    let bytes = 0;
    for (let i = 0; i < levels.length; i++) {
      const l = levels[i];
      gl.texImage2D(gl.TEXTURE_2D, i, gl.RGBA16F, l.width, l.height, 0, gl.RGBA, gl.FLOAT, l.data);
      bytes += l.width * l.height * 8;
    }
    this.byteSize = bytes;
    this.ctx.memory.textures += bytes;
  }
}

function checkChain(levels: EnvironmentTextureLevel[], maxSize: number): void {
  if (levels.length === 0) throw new Error('mk-viewer: environment has no levels');
  const l0 = levels[0];
  if (l0.width > maxSize || l0.height > maxSize) {
    throw new Error(`mk-viewer: environment ${l0.width} x ${l0.height} exceeds MAX_TEXTURE_SIZE ${maxSize}`);
  }
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    const w = Math.max(1, l0.width >> i);
    const h = Math.max(1, l0.height >> i);
    if (l.width !== w || l.height !== h || l.data.length < w * h * 4) {
      throw new Error(`mk-viewer: environment mip level ${i} must be ${w} x ${h} RGBA`);
    }
  }
}

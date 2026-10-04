/**
 * RGBA32F 2D data texture mirroring a Float32Array (fragment records, material records): fixed
 * width, height grows with the data. Row-range dirty uploads with texSubImage2D. NEAREST, read in
 * shaders with texelFetch only (no float filtering extension needed).
 */
import type { GlContext, GlResource } from './GlContext';
import type { DirtyRanges } from './DirtyRanges';
import { UPLOAD_TEXTURE_UNIT } from './GlState';

export class DataTexture implements GlResource {
  texture: WebGLTexture;
  /** Rows allocated on the GPU. */
  height = 0;
  uploadedBytes = 0;
  private data: Float32Array | null = null;

  constructor(
    private readonly ctx: GlContext,
    /** Width in texels (FRAG_TEX_WIDTH or MAT_TEX_WIDTH). */
    readonly width: number,
    readonly label = 'data texture',
  ) {
    if (width > ctx.caps.maxTextureSize) {
      throw new Error(
        `mk-viewer: ${label} needs width ${width} but MAX_TEXTURE_SIZE is ${ctx.caps.maxTextureSize}`,
      );
    }
    this.texture = this.create();
    ctx.track(this);
  }

  /** Floats per texture row. */
  get rowFloats(): number {
    return this.width * 4;
  }

  get byteSize(): number {
    return this.width * this.height * 16;
  }

  /** Rows needed to hold `floatCount` floats. */
  rowsFor(floatCount: number): number {
    return Math.ceil(floatCount / this.rowFloats);
  }

  /**
   * Sets / replaces the mirrored array. Grows the texture when the array needs more rows than are
   * allocated, uploading everything; returns true in that case. Otherwise the caller uploads what
   * changed (`uploadRows`, `uploadFloats`, `uploadAll`).
   */
  setSource(data: Float32Array): boolean {
    this.data = data;
    const rows = Math.max(1, this.rowsFor(data.length));
    if (rows > this.height) {
      this.allocate(rows);
      this.uploadAll();
      return true;
    }
    return false;
  }

  /** Uploads rows [rowStart, rowEnd) from the source (clamped; a partially filled last row is OK). */
  uploadRows(rowStart: number, rowEnd: number): void {
    const data = this.data;
    if (!data || this.ctx.isLost) return;
    const gl = this.ctx.gl;
    const rf = this.rowFloats;
    const fullRows = Math.floor(data.length / rf);
    const r0 = Math.max(0, rowStart | 0);
    const r1 = Math.min(Math.ceil(rowEnd), this.height, Math.ceil(data.length / rf));
    if (r1 <= r0) return;
    this.ctx.state.bindTexture(UPLOAD_TEXTURE_UNIT, this.texture);
    const fullEnd = Math.min(r1, fullRows);
    if (fullEnd > r0) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r0, this.width, fullEnd - r0, gl.RGBA, gl.FLOAT, data, r0 * rf);
      this.uploadedBytes += (fullEnd - r0) * rf * 4;
    }
    if (r1 > fullRows && fullRows >= r0) {
      const texels = Math.floor((data.length - fullRows * rf) / 4);
      if (texels > 0) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, fullRows, texels, 1, gl.RGBA, gl.FLOAT, data, fullRows * rf);
        this.uploadedBytes += texels * 16;
      }
    }
  }

  /** Uploads the rows covering floats [floatStart, floatEnd). */
  uploadFloats(floatStart: number, floatEnd: number): void {
    const rf = this.rowFloats;
    this.uploadRows(Math.floor(floatStart / rf), Math.ceil(floatEnd / rf));
  }

  /** Uploads the rows covering records [first, end) of `floatsPerRecord` floats each. */
  uploadRecords(first: number, end: number, floatsPerRecord: number): void {
    this.uploadFloats(first * floatsPerRecord, end * floatsPerRecord);
  }

  /** Uploads every range of `ranges` (units = floats). Does not clear `ranges`. */
  uploadRanges(ranges: DirtyRanges): void {
    for (let i = 0; i < ranges.count; i++) this.uploadFloats(ranges.start(i), ranges.end(i));
  }

  uploadAll(): void {
    this.uploadRows(0, this.height);
  }

  /** Binds to a texture unit. */
  bind(unit: number): void {
    this.ctx.state.bindTexture(unit, this.texture);
  }

  restore(): void {
    this.texture = this.create();
    const h = this.height;
    this.height = 0;
    if (h > 0) {
      this.allocate(h);
      this.uploadAll();
    }
  }

  dispose(): void {
    this.ctx.state.forgetTexture(this.texture);
    this.ctx.gl.deleteTexture(this.texture);
    this.ctx.memory.textures -= this.byteSize;
    this.height = 0;
    this.data = null;
    this.ctx.untrack(this);
  }

  private create(): WebGLTexture {
    const gl = this.ctx.gl;
    const t = gl.createTexture();
    if (!t) throw new Error(`mk-viewer: createTexture failed (${this.label})`);
    this.ctx.state.bindTexture(UPLOAD_TEXTURE_UNIT, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    return t;
  }

  private allocate(rows: number): void {
    const max = this.ctx.caps.maxTextureSize;
    if (rows > max) {
      throw new Error(`mk-viewer: ${this.label} needs ${rows} rows but MAX_TEXTURE_SIZE is ${max}`);
    }
    const gl = this.ctx.gl;
    const before = this.byteSize;
    this.ctx.state.bindTexture(UPLOAD_TEXTURE_UNIT, this.texture);
    // Mutable storage (texImage2D) so the same texture object can be re-specified when growing.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.width, rows, 0, gl.RGBA, gl.FLOAT, null);
    this.height = rows;
    this.ctx.memory.textures += this.byteSize - before;
  }
}

/**
 * A GPU buffer mirroring a CPU-side page owned by someone else (vertex page, index page, instance
 * buffer). Only dirty byte ranges are uploaded. When the owner grows its page (new, larger typed
 * array), `setSource()` reallocates the GPU storage **in the same WebGLBuffer object**, so VAOs that
 * reference this buffer stay valid.
 */
import type { GlContext, GlResource } from './GlContext';
import type { DirtyRanges } from './DirtyRanges';

export type BufferKind = 'vertex' | 'index' | 'instance';

export interface MirroredBufferOptions {
  /** Default STATIC_DRAW for vertex/index, DYNAMIC_DRAW for instance. */
  usage?: number;
  label?: string;
}

export class MirroredBuffer implements GlResource {
  buffer: WebGLBuffer;
  /** Bytes allocated on the GPU. */
  byteCapacity = 0;
  /** Cumulative bytes uploaded (statistics). */
  uploadedBytes = 0;
  readonly label: string;
  private source: Uint8Array | null = null;
  private readonly usage: number;
  private readonly target: number;

  constructor(
    private readonly ctx: GlContext,
    readonly kind: BufferKind,
    options: MirroredBufferOptions = {},
  ) {
    const gl = ctx.gl;
    this.target = kind === 'index' ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
    this.usage = options.usage ?? (kind === 'instance' ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    this.label = options.label ?? kind;
    this.buffer = this.create();
    ctx.track(this);
  }

  /** The CPU page currently mirrored (as bytes), or null. */
  get sourceBytes(): Uint8Array | null {
    return this.source;
  }

  /**
   * Sets / replaces the mirrored CPU page. If it is larger than the GPU allocation, the GPU buffer
   * is reallocated to `view.byteLength` and the whole page uploaded; returns true in that case
   * (pending dirty ranges can then be dropped). Otherwise only the reference changes and the caller
   * uploads what changed.
   */
  setSource(view: ArrayBufferView): boolean {
    this.source =
      view instanceof Uint8Array ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    if (view.byteLength > this.byteCapacity) {
      this.allocate(view.byteLength, true);
      return true;
    }
    return false;
  }

  /** Grows the GPU allocation without a CPU page (contents undefined until uploaded). */
  reserve(byteLength: number): void {
    if (byteLength > this.byteCapacity) this.allocate(byteLength, false);
  }

  /** Uploads source bytes [byteStart, byteEnd). Clamped to the source and the allocation. */
  upload(byteStart: number, byteEnd: number): void {
    const src = this.source;
    if (!src || this.ctx.isLost) return;
    const start = Math.max(0, Math.floor(byteStart));
    const end = Math.min(Math.ceil(byteEnd), src.byteLength, this.byteCapacity);
    if (end <= start) return;
    this.bind();
    this.ctx.gl.bufferSubData(this.target, start, src, start, end - start);
    this.uploadedBytes += end - start;
  }

  /** Uploads every range in `ranges` (units = bytes). Does not clear `ranges`. */
  uploadRanges(ranges: DirtyRanges): void {
    for (let i = 0; i < ranges.count; i++) this.upload(ranges.start(i), ranges.end(i));
  }

  uploadAll(): void {
    if (this.source) this.upload(0, this.source.byteLength);
  }

  restore(): void {
    this.buffer = this.create();
    const cap = this.byteCapacity;
    this.byteCapacity = 0;
    if (cap > 0) this.allocate(Math.max(cap, this.source?.byteLength ?? 0), true);
  }

  dispose(): void {
    this.ctx.state.forgetBuffer(this.buffer);
    this.ctx.gl.deleteBuffer(this.buffer);
    this.ctx.memory.buffers -= this.byteCapacity;
    this.byteCapacity = 0;
    this.source = null;
    this.ctx.untrack(this);
  }

  private create(): WebGLBuffer {
    const b = this.ctx.gl.createBuffer();
    if (!b) throw new Error(`mk-viewer: createBuffer failed (${this.label})`);
    return b;
  }

  /**
   * Binds the buffer to its natural target. Index buffers are bound with no VAO bound, because the
   * ELEMENT_ARRAY_BUFFER binding is VAO state and must not leak into a page VAO.
   */
  private bind(): void {
    const state = this.ctx.state;
    if (this.target === this.ctx.gl.ELEMENT_ARRAY_BUFFER) {
      state.bindVao(null);
      this.ctx.gl.bindBuffer(this.target, this.buffer);
    } else {
      state.bindArrayBuffer(this.buffer);
    }
  }

  private allocate(byteLength: number, withData: boolean): void {
    const gl = this.ctx.gl;
    this.bind();
    const src = this.source;
    if (withData && src && src.byteLength === byteLength) {
      gl.bufferData(this.target, src, this.usage);
      this.uploadedBytes += byteLength;
    } else {
      gl.bufferData(this.target, byteLength, this.usage);
      if (withData && src) {
        const n = Math.min(src.byteLength, byteLength);
        gl.bufferSubData(this.target, 0, src, 0, n);
        this.uploadedBytes += n;
      }
    }
    this.ctx.memory.buffers += byteLength - this.byteCapacity;
    this.byteCapacity = byteLength;
  }
}

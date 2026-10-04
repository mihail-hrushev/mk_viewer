/**
 * Draw submission for geometry pages. Accumulate (firstIndex, indexCount) ranges of draw items that
 * live in one page, then `flush()` issues a single multiDrawElementsWEBGL (or a loop of
 * drawElements without the extension). Index-adjacent ranges are fused on push. No allocation per
 * call: scratch Int32Arrays grow on demand and are reused.
 */
import { INDEX_BYTES } from '../layout';
import type { GlContext } from './GlContext';
import type { GeometryVao } from './GeometryVao';

export class DrawSubmitter {
  /** Set false to force the fallback loop (debug / comparison). */
  useMultiDraw = true;
  /** Statistics since the last `resetStats()`. */
  drawCalls = 0;
  indicesDrawn = 0;
  instancesDrawn = 0;

  private counts = new Int32Array(256);
  private offsets = new Int32Array(256);
  private n = 0;
  private lastEnd = -1;

  constructor(private readonly ctx: GlContext) {}

  get pending(): number {
    return this.n;
  }

  /** Triangles submitted since the last reset (indices / 3, includes instances). */
  get trianglesDrawn(): number {
    return Math.floor(this.indicesDrawn / 3);
  }

  resetStats(): void {
    this.drawCalls = 0;
    this.indicesDrawn = 0;
    this.instancesDrawn = 0;
  }

  /** Queues a range of the currently bound page's index buffer. */
  push(firstIndex: number, indexCount: number): void {
    if (indexCount <= 0) return;
    const n = this.n;
    if (n > 0 && firstIndex === this.lastEnd) {
      this.counts[n - 1] += indexCount; // contiguous with the previous range
      this.lastEnd += indexCount;
      return;
    }
    if (n === this.counts.length) this.grow();
    this.counts[n] = indexCount;
    this.offsets[n] = firstIndex * INDEX_BYTES;
    this.lastEnd = firstIndex + indexCount;
    this.n = n + 1;
  }

  /** Drops queued ranges without drawing. */
  discard(): void {
    this.n = 0;
    this.lastEnd = -1;
  }

  /**
   * Draws all queued ranges with the bound VAO and program, then clears the queue.
   * The caller binds the page VAO (`vao.bind()`) before pushing/flushing.
   */
  flush(mode: number = this.ctx.gl.TRIANGLES): void {
    const n = this.n;
    if (n === 0) return;
    const gl = this.ctx.gl;
    const md = this.useMultiDraw ? this.ctx.caps.multiDraw : null;
    let indices = 0;
    for (let i = 0; i < n; i++) indices += this.counts[i];
    if (md) {
      md.multiDrawElementsWEBGL(mode, this.counts, 0, gl.UNSIGNED_INT, this.offsets, 0, n);
      this.drawCalls++;
    } else {
      for (let i = 0; i < n; i++) gl.drawElements(mode, this.counts[i], gl.UNSIGNED_INT, this.offsets[i]);
      this.drawCalls += n;
    }
    this.indicesDrawn += indices;
    this.n = 0;
    this.lastEnd = -1;
  }

  /**
   * Convenience: binds `vao` and draws `n` ranges taken from SoA arrays starting at `start`
   * (firsts[start + i], counts[start + i]).
   */
  drawRanges(
    vao: GeometryVao,
    firsts: ArrayLike<number>,
    counts: ArrayLike<number>,
    start: number,
    n: number,
    mode?: number,
  ): void {
    vao.bind();
    this.discard();
    for (let i = start, e = start + n; i < e; i++) this.push(firsts[i], counts[i]);
    this.flush(mode);
  }

  /**
   * One instanced draw of an instanced page: index range [firstIndex, firstIndex + indexCount),
   * instances [instanceStart, instanceStart + instanceCount) of the page's instance buffer.
   */
  drawInstanced(
    vao: GeometryVao,
    firstIndex: number,
    indexCount: number,
    instanceStart: number,
    instanceCount: number,
    mode: number = this.ctx.gl.TRIANGLES,
  ): void {
    if (indexCount <= 0 || instanceCount <= 0) return;
    vao.setInstanceStart(instanceStart); // binds the VAO
    this.ctx.gl.drawElementsInstanced(
      mode,
      indexCount,
      this.ctx.gl.UNSIGNED_INT,
      firstIndex * INDEX_BYTES,
      instanceCount,
    );
    this.drawCalls++;
    this.indicesDrawn += indexCount * instanceCount;
    this.instancesDrawn += instanceCount;
  }

  /**
   * Instanced equivalent of drawRanges: `n` chunks from SoA arrays starting at `start`, one
   * drawElementsInstanced each. (multiDrawElementsInstancedWEBGL cannot help here: every sub-draw
   * would start at the same instance, and the instance range start is what differs per chunk.)
   */
  drawInstancedRanges(
    vao: GeometryVao,
    firsts: ArrayLike<number>,
    counts: ArrayLike<number>,
    instanceStarts: ArrayLike<number>,
    instanceCounts: ArrayLike<number>,
    start: number,
    n: number,
    mode: number = this.ctx.gl.TRIANGLES,
  ): void {
    for (let i = start, e = start + n; i < e; i++) {
      this.drawInstanced(vao, firsts[i], counts[i], instanceStarts[i], instanceCounts[i], mode);
    }
  }

  private grow(): void {
    const c = new Int32Array(this.counts.length * 2);
    c.set(this.counts);
    this.counts = c;
    const o = new Int32Array(this.offsets.length * 2);
    o.set(this.offsets);
    this.offsets = o;
  }
}

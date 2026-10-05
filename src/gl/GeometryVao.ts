/**
 * Vertex array objects for geometry pages. Both page kinds feed the same attribute locations so a
 * single uber-shader program draws both paths:
 *
 *   location 0  a_position  vec3  <- u16 x3 normalized   (byte offset VERTEX_POSITION_OFFSET)
 *   location 1  a_normal    vec2  <- i8 x2 normalized     (byte offset VERTEX_NORMAL_OFFSET)
 *   location 2  a_fragment  uint  <- u32 integer attribute:
 *                 merged page:    per vertex, byte offset VERTEX_FRAGMENT_OFFSET, stride MERGED_VERTEX_STRIDE
 *                 instanced page: per instance (divisor 1) from a separate u32 instance buffer
 *
 * WebGL2 has no baseInstance, so the instanced VAO re-points location 2 at
 * `instanceStart * 4` bytes into the instance buffer (`setInstanceStart`). That is one
 * vertexAttribIPointer call (plus an ARRAY_BUFFER bind, cached) and is skipped when unchanged.
 */
import {
  INDEX_BYTES,
  MERGED_VERTEX_STRIDE,
  SHARED_VERTEX_STRIDE,
  VERTEX_FRAGMENT_OFFSET,
  VERTEX_NORMAL_OFFSET,
  VERTEX_POSITION_OFFSET,
} from '../layout';
import type { GlContext, GlResource } from './GlContext';
import type { MirroredBuffer } from './MirroredBuffer';

export const ATTRIB_POSITION = 0;
export const ATTRIB_NORMAL = 1;
export const ATTRIB_FRAGMENT = 2;

export class GeometryVao implements GlResource {
  vao: WebGLVertexArrayObject;
  private instanceStart = 0;

  private constructor(
    private readonly ctx: GlContext,
    readonly vertexBuffer: MirroredBuffer,
    readonly indexBuffer: MirroredBuffer,
    /** Present for instanced pages. */
    readonly instanceBuffer: MirroredBuffer | null,
  ) {
    this.vao = this.build();
    ctx.track(this);
  }

  /** VAO for a merged page (MERGED_VERTEX_STRIDE vertices carrying the fragment index). */
  static merged(ctx: GlContext, vertices: MirroredBuffer, indices: MirroredBuffer): GeometryVao {
    return new GeometryVao(ctx, vertices, indices, null);
  }

  /**
   * VAO for a shared/instanced page (SHARED_VERTEX_STRIDE vertices) with the fragment index taken
   * per instance from `instances` (u32 fragment indices).
   */
  static instanced(
    ctx: GlContext,
    vertices: MirroredBuffer,
    indices: MirroredBuffer,
    instances: MirroredBuffer,
  ): GeometryVao {
    return new GeometryVao(ctx, vertices, indices, instances);
  }

  get isInstanced(): boolean {
    return this.instanceBuffer !== null;
  }

  /** Byte offset into the index buffer of index number `firstIndex`. */
  static indexByteOffset(firstIndex: number): number {
    return firstIndex * INDEX_BYTES;
  }

  bind(): void {
    this.ctx.state.bindVao(this.vao);
  }

  /**
   * Instanced pages only: makes gl_InstanceID 0 read the fragment index at `instanceStart` in the
   * instance buffer. Binds this VAO. No-op when the start did not change.
   */
  setInstanceStart(instanceStart: number): void {
    const ib = this.instanceBuffer;
    if (!ib) return;
    this.ctx.state.bindVao(this.vao);
    if (instanceStart === this.instanceStart) return;
    this.instanceStart = instanceStart;
    const gl = this.ctx.gl;
    this.ctx.state.bindArrayBuffer(ib.buffer);
    gl.vertexAttribIPointer(ATTRIB_FRAGMENT, 1, gl.UNSIGNED_INT, 4, instanceStart * 4);
  }

  restore(): void {
    this.vao = this.build();
  }

  dispose(): void {
    this.ctx.state.forgetVao(this.vao);
    this.ctx.gl.deleteVertexArray(this.vao);
    this.ctx.untrack(this);
  }

  private build(): WebGLVertexArrayObject {
    const gl = this.ctx.gl;
    const state = this.ctx.state;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('mk-viewer: createVertexArray failed');
    // VAOs are created lazily in the middle of a pass (GpuScene slots, Renderer.drawInOrder), where
    // ranges may already be queued for the bound VAO: restore that binding afterwards, or the queued
    // draw is flushed against the wrong (default) VAO.
    const prev = state.boundVao;
    state.bindVao(vao);
    const stride = this.instanceBuffer ? SHARED_VERTEX_STRIDE : MERGED_VERTEX_STRIDE;

    state.bindArrayBuffer(this.vertexBuffer.buffer);
    gl.enableVertexAttribArray(ATTRIB_POSITION);
    gl.vertexAttribPointer(ATTRIB_POSITION, 3, gl.UNSIGNED_SHORT, true, stride, VERTEX_POSITION_OFFSET);
    gl.enableVertexAttribArray(ATTRIB_NORMAL);
    gl.vertexAttribPointer(ATTRIB_NORMAL, 2, gl.BYTE, true, stride, VERTEX_NORMAL_OFFSET);

    gl.enableVertexAttribArray(ATTRIB_FRAGMENT);
    if (this.instanceBuffer) {
      state.bindArrayBuffer(this.instanceBuffer.buffer);
      gl.vertexAttribIPointer(ATTRIB_FRAGMENT, 1, gl.UNSIGNED_INT, 4, this.instanceStart * 4);
      gl.vertexAttribDivisor(ATTRIB_FRAGMENT, 1);
    } else {
      gl.vertexAttribIPointer(ATTRIB_FRAGMENT, 1, gl.UNSIGNED_INT, stride, VERTEX_FRAGMENT_OFFSET);
    }

    // ELEMENT_ARRAY_BUFFER binding is VAO state.
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer.buffer);
    state.bindVao(prev);
    return vao;
  }
}

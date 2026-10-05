/**
 * Fullscreen passes: present (1:1 copy of the colour target), composite (present + selection
 * overlay, optionally the edge display), background gradient and selection outline. Each draw binds
 * its program, textures (units 0..4) and an empty VAO, then draws one triangle. Framebuffer, viewport, blending and depth state are set by the caller (see recipes in
 * the method docs).
 */
import type { GlContext, GlResource } from './GlContext';
import { Program } from './Program';
import { FULLSCREEN_VS } from './shaders/common';
import { BACKGROUND_FS, COMPOSITE_FS, OUTLINE_FS, PRESENT_FS, compositeFragmentSource } from './shaders/post';

/** Selection / hover overlay settings of `drawComposite`. */
export interface OverlayStyle {
  /** Linear rgb + tint amount of selected fragments. */
  selectionTint: ArrayLike<number>;
  /** Linear rgb + tint amount of the hovered (highlighted) object. */
  highlightTint: ArrayLike<number>;
  /** sRGB rgb + alpha of the selection outline. */
  outlineColor: ArrayLike<number>;
  /** Outline width in target pixels; 0 disables the outline. */
  outlineWidth: number;
}

/** Edge display settings of `drawComposite` (see COMPOSITE_FS, EDGES variant). */
export interface EdgeStyle {
  /** sRGB rgb + opacity of the lines. */
  color: ArrayLike<number>;
  /** Cosine of the crease angle: neighbouring face normals with a smaller dot product get a line. */
  cosAngle: number;
  /** Clip planes and projection the depth target was rendered with. */
  near: number;
  far: number;
  orthographic: boolean;
  /** World size of one target pixel at view distance 1 (perspective) or anywhere (orthographic). */
  pixelSize: number;
  depthTex: WebGLTexture | null;
  /** Face normals (RenderTargets normal attachment). */
  normalTex: WebGLTexture | null;
}

export class PostPasses implements GlResource {
  readonly present: Program;
  readonly composite: Program;
  /** Composite with the edge display, compiled on first use. */
  private compositeEdges: Program | null = null;
  readonly background: Program;
  readonly outline: Program;
  private vao: WebGLVertexArrayObject;

  constructor(private readonly ctx: GlContext) {
    this.present = new Program(ctx, FULLSCREEN_VS, PRESENT_FS, 'present');
    this.present.setSampler('u_colorTex', 0);
    this.composite = new Program(ctx, FULLSCREEN_VS, COMPOSITE_FS, 'composite');
    this.composite.setSampler('u_colorTex', 0);
    this.composite.setSampler('u_idTex', 1);
    this.composite.setSampler('u_fragTex', 2);
    this.background = new Program(ctx, FULLSCREEN_VS, BACKGROUND_FS, 'background');
    this.outline = new Program(ctx, FULLSCREEN_VS, OUTLINE_FS, 'outline');
    this.outline.setSampler('u_idTex', 0);
    this.outline.setSampler('u_fragTex', 1);
    this.vao = this.createVao();
    ctx.track(this);
  }

  /** Draws the attribute-less fullscreen triangle with the currently bound program. */
  drawFullscreen(): void {
    this.ctx.state.bindVao(this.vao);
    this.ctx.gl.drawArrays(this.ctx.gl.TRIANGLES, 0, 3);
  }

  /**
   * Copies `colorTex` 1:1 into the bound framebuffer. Recipe: state.bindFramebuffer(null),
   * viewport = drawing buffer, blend off, depth test off. The canvas drawing-buffer size must
   * equal the target size (offset shifts the source if not).
   */
  drawPresent(colorTex: WebGLTexture, offsetX = 0, offsetY = 0): void {
    const p = this.present.use();
    p.setIvec2('u_offset', offsetX, offsetY);
    this.ctx.state.bindTexture(0, colorTex);
    this.drawFullscreen();
  }

  /** Compiles the edge-display composite program ahead of its first use (outside the frame loop). */
  prepareEdges(): void {
    if (this.compositeEdges) return;
    const p = new Program(this.ctx, FULLSCREEN_VS, compositeFragmentSource({ edges: true }), 'composite+edges');
    p.setSampler('u_colorTex', 0);
    p.setSampler('u_idTex', 1);
    p.setSampler('u_fragTex', 2);
    p.setSampler('u_depthTex', 3);
    p.setSampler('u_normalTex', 4);
    this.compositeEdges = p;
  }

  /**
   * Like drawPresent, plus the selection / hover overlay (tint from the id target + fragment flags,
   * selection outline), see COMPOSITE_FS, and the edge display when `edges` is given. Same recipe
   * as drawPresent. Uses texture units 0..2 (0..4 with edges).
   */
  drawComposite(
    colorTex: WebGLTexture,
    idTex: WebGLTexture,
    fragTex: WebGLTexture,
    style: OverlayStyle,
    offsetX = 0,
    offsetY = 0,
    edges: EdgeStyle | null = null,
  ): void {
    if (edges) this.prepareEdges();
    const p = edges ? this.compositeEdges!.use() : this.composite.use();
    const s = style.selectionTint, h = style.highlightTint, o = style.outlineColor;
    p.setVec4('u_selectionColor', s[0], s[1], s[2], s[3]);
    p.setVec4('u_highlightColor', h[0], h[1], h[2], h[3]);
    p.setVec4('u_outlineColor', o[0], o[1], o[2], o[3] ?? 1);
    const outline = Math.max(0, style.outlineWidth | 0);
    p.setInt('u_outlineWidth', outline);
    p.setInt('u_overlay', s[3] > 0 || h[3] > 0 || outline > 0 ? 1 : 0);
    p.setIvec2('u_offset', offsetX, offsetY);
    const st = this.ctx.state;
    st.bindTexture(0, colorTex);
    st.bindTexture(1, idTex);
    st.bindTexture(2, fragTex);
    if (edges) {
      const c = edges.color;
      p.setVec4('u_edgeColor', c[0], c[1], c[2], c[3] ?? 1);
      p.setVec4('u_edgeParams', edges.cosAngle, edges.near, edges.far, edges.orthographic ? 1 : 0);
      p.setFloat('u_edgePixel', edges.pixelSize);
      st.bindTexture(3, edges.depthTex);
      st.bindTexture(4, edges.normalTex);
    }
    this.drawFullscreen();
  }

  /**
   * Vertical gradient, sRGB colours (top at the top of the viewport). Recipe: scene target bound,
   * `targets.setDrawBuffers('color')`, depth test off, depth write off, blend off.
   */
  drawBackground(
    top: ArrayLike<number>,
    bottom: ArrayLike<number>,
  ): void {
    const p = this.background.use();
    p.setVec3('u_topColor', top[0], top[1], top[2]);
    p.setVec3('u_bottomColor', bottom[0], bottom[1], bottom[2]);
    this.drawFullscreen();
  }

  /**
   * Outer selection outline from the id target and fragment flags. Recipe: after present, same
   * framebuffer (canvas), blend on with SRC_ALPHA / ONE_MINUS_SRC_ALPHA, depth test off.
   * `color` is sRGB rgb + alpha; `width` in pixels (1..3 looks right).
   */
  drawOutline(
    idTex: WebGLTexture,
    fragTex: WebGLTexture,
    color: ArrayLike<number>,
    width = 2,
    offsetX = 0,
    offsetY = 0,
  ): void {
    const p = this.outline.use();
    p.setVec4('u_outlineColor', color[0], color[1], color[2], color[3] ?? 1);
    p.setInt('u_outlineWidth', Math.max(1, width | 0));
    p.setIvec2('u_offset', offsetX, offsetY);
    this.ctx.state.bindTexture(0, idTex);
    this.ctx.state.bindTexture(1, fragTex);
    this.drawFullscreen();
  }

  restore(): void {
    this.vao = this.createVao();
  }

  dispose(): void {
    this.ctx.state.forgetVao(this.vao);
    this.ctx.gl.deleteVertexArray(this.vao);
    this.present.dispose();
    this.composite.dispose();
    this.compositeEdges?.dispose();
    this.background.dispose();
    this.outline.dispose();
    this.ctx.untrack(this);
  }

  private createVao(): WebGLVertexArrayObject {
    const vao = this.ctx.gl.createVertexArray();
    if (!vao) throw new Error('mk-viewer: createVertexArray failed');
    return vao;
  }
}

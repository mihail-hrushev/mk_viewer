/**
 * Typed wrapper around the uber-shader Program: cached uniform locations, pass presets and frame
 * uniforms. One instance per variant (with / without section planes).
 */
import { FragFlags, MAX_SECTION_PLANES } from '../layout';
import type { GlContext } from './GlContext';
import { Program } from './Program';
import { MaterialFilter, PassKind, uberFragmentSource, uberVertexSource } from './shaders/uber';

/** Texture units the uber program samples from. */
export const UBER_FRAG_TEX_UNIT = 0;
export const UBER_MAT_TEX_UNIT = 1;

export interface LightingParams {
  /** View space, towards the light (normalized on set). */
  keyLightDir: [number, number, number];
  keyLightColor: [number, number, number];
  skyColor: [number, number, number];
  groundColor: [number, number, number];
  /**
   * Tone contrast: the lit colour is raised to this power before display. 1 = none; above 1
   * deepens dark and mid tones and leaves full brightness unchanged.
   */
  contrast: number;
}

/** Defaults: light from upper-left-behind the camera, cool sky, warm-dark ground (linear). */
export const DEFAULT_LIGHTING: LightingParams = {
  keyLightDir: [-0.35, 0.6, 0.72],
  keyLightColor: [1.05, 1.03, 1.0],
  // Ambient is kept low so surfaces turned away from the key light read clearly darker than lit
  // ones; raising these flattens the image.
  skyColor: [0.25, 0.27, 0.31],
  groundColor: [0.045, 0.045, 0.05],
  contrast: 1.35,
};

export type UberPass = 'opaque' | 'transparent' | 'transparentId' | 'ghost';

export class UberProgram {
  readonly program: Program;
  readonly hasSectionPlanes: boolean;
  private readonly sectionScratch = new Float32Array(MAX_SECTION_PLANES * 4);

  private uFlagMask: WebGLUniformLocation | null = null;
  private uFlagValue: WebGLUniformLocation | null = null;
  private uMaterialFilter: WebGLUniformLocation | null = null;
  private uPassKind: WebGLUniformLocation | null = null;
  private uWriteId: WebGLUniformLocation | null = null;
  private locProgram: WebGLProgram | null = null;

  // Persistent settings, re-applied after a context restore.
  private lighting: LightingParams = DEFAULT_LIGHTING;
  private readonly upView = new Float32Array([0, 1, 0]);
  private readonly ghost = new Float32Array([0.6, 0.65, 0.7, 0.12]);
  private sectionCount = 0;

  constructor(
    private readonly ctx: GlContext,
    options: { sectionPlanes?: boolean } = {},
  ) {
    this.hasSectionPlanes = !!options.sectionPlanes;
    this.program = new Program(
      ctx,
      uberVertexSource(),
      uberFragmentSource({ sectionPlanes: this.hasSectionPlanes }),
      this.hasSectionPlanes ? 'uber+section' : 'uber',
    );
    this.program.setSampler('u_fragTex', UBER_FRAG_TEX_UNIT);
    this.program.setSampler('u_matTex', UBER_MAT_TEX_UNIT);
    this.applyPersistent();
    // Program.restore() runs before 'restored' listeners, so uniforms can be re-applied here.
    this.offRestored = ctx.on('restored', () => this.applyPersistent());
  }

  private readonly offRestored: () => void;

  dispose(): void {
    this.offRestored();
    this.program.dispose();
  }

  private applyPersistent(): void {
    this.program.use();
    this.setLighting(this.lighting);
    this.setUpView(this.upView[0], this.upView[1], this.upView[2]);
    this.program.setVec4('u_ghostColor', this.ghost[0], this.ghost[1], this.ghost[2], this.ghost[3]);
    this.setOrthographic(false);
    if (this.hasSectionPlanes) this.setSectionPlanes(this.sectionScratch, this.sectionCount);
    this.setPass('opaque');
  }

  /** Binds the program. */
  use(): this {
    this.program.use();
    return this;
  }

  /** Per-frame camera uniforms (column-major). */
  setCamera(view: Float32Array, projection: Float32Array, orthographic = false): void {
    this.program.use();
    this.program.setMat4('u_viewMatrix', view);
    this.program.setMat4('u_projMatrix', projection);
    this.program.setInt('u_orthographic', orthographic ? 1 : 0);
  }

  setOrthographic(ortho: boolean): void {
    this.program.use();
    this.program.setInt('u_orthographic', ortho ? 1 : 0);
  }

  /** World up in view space = normalize(mat3(view) * worldUp). Update when the camera changes. */
  setUpView(x: number, y: number, z: number): void {
    const l = Math.hypot(x, y, z) || 1;
    this.upView[0] = x / l;
    this.upView[1] = y / l;
    this.upView[2] = z / l;
    this.program.use();
    this.program.setVec3('u_upView', x / l, y / l, z / l);
  }

  setLighting(p: LightingParams): void {
    this.lighting = p;
    this.program.use();
    const d = p.keyLightDir;
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    this.program.setVec3('u_keyLightDir', d[0] / l, d[1] / l, d[2] / l);
    this.program.setVec3('u_keyLightColor', p.keyLightColor[0], p.keyLightColor[1], p.keyLightColor[2]);
    this.program.setVec3('u_skyColor', p.skyColor[0], p.skyColor[1], p.skyColor[2]);
    this.program.setVec3('u_groundColor', p.groundColor[0], p.groundColor[1], p.groundColor[2]);
    this.program.setFloat('u_contrast', p.contrast);
  }

  /** Linear rgb + opacity. */
  setGhostColor(r: number, g: number, b: number, opacity: number): void {
    this.ghost.set([r, g, b, opacity]);
    this.program.use();
    this.program.setVec4('u_ghostColor', r, g, b, opacity);
  }

  /**
   * View-space section planes (count vec4s, see planesToViewSpace in pack.ts). Only on the
   * section-plane variant; ignored otherwise.
   */
  setSectionPlanes(planes: ArrayLike<number>, count: number): void {
    if (!this.hasSectionPlanes) return;
    const n = Math.min(count, MAX_SECTION_PLANES);
    const s = this.sectionScratch;
    if (planes !== s) {
      s.fill(0);
      for (let i = 0; i < n * 4; i++) s[i] = planes[i];
    }
    this.sectionCount = n;
    this.program.use();
    this.program.setVec4v('u_sectionPlanes', s, MAX_SECTION_PLANES);
    this.program.setInt('u_sectionPlaneCount', n);
  }

  /**
   * Fragment filter: a fragment is drawn when (flags & mask) == value. Include FragFlags.Visible in
   * both to skip hidden fragments.
   */
  setFlagFilter(mask: number, value: number): void {
    this.program.use();
    this.cacheLocations();
    const gl = this.ctx.gl;
    gl.uniform1ui(this.uFlagMask, mask >>> 0);
    gl.uniform1ui(this.uFlagValue, value >>> 0);
  }

  /**
   * Binds the program and sets the pass uniforms. GL state (blend, depth, draw buffers) is the
   * caller's job, see `applyPassState`.
   *  - opaque:        visible, not ghosted, opaque materials; writes colour + id
   *  - transparent:   visible, not ghosted, transparent materials; premultiplied colour, no id
   *  - transparentId: same fragments as transparent, writes ids (draw with drawBuffers 'id')
   *  - ghost:         visible + ghosted, any material; faint colour, no id
   * `materialFilter` false skips the per-vertex material opacity test (use when draw items are
   * already split into opaque / transparent).
   */
  setPass(pass: UberPass, materialFilter = true): void {
    this.program.use();
    this.cacheLocations();
    const gl = this.ctx.gl;
    const V = FragFlags.Visible;
    const G = FragFlags.Ghosted;
    let kind: number = PassKind.Opaque;
    let filter: number = MaterialFilter.Any;
    let mask = V | G;
    let value = V;
    let writeId = 0;
    switch (pass) {
      case 'opaque':
        filter = MaterialFilter.OpaqueOnly;
        writeId = 1;
        break;
      case 'transparent':
        kind = PassKind.Transparent;
        filter = MaterialFilter.TransparentOnly;
        break;
      case 'transparentId':
        kind = PassKind.Transparent;
        filter = MaterialFilter.TransparentOnly;
        writeId = 1;
        break;
      case 'ghost':
        kind = PassKind.Ghost;
        value = V | G;
        break;
    }
    gl.uniform1i(this.uPassKind, kind);
    gl.uniform1i(this.uMaterialFilter, materialFilter ? filter : MaterialFilter.Any);
    gl.uniform1ui(this.uFlagMask, mask);
    gl.uniform1ui(this.uFlagValue, value);
    gl.uniform1i(this.uWriteId, writeId);
  }

  private cacheLocations(): void {
    if (this.locProgram === this.program.program) return;
    this.locProgram = this.program.program;
    const p = this.program;
    this.uFlagMask = p.uniform('u_flagMask');
    this.uFlagValue = p.uniform('u_flagValue');
    this.uMaterialFilter = p.uniform('u_materialFilter');
    this.uPassKind = p.uniform('u_passKind');
    this.uWriteId = p.uniform('u_writeId');
  }
}

/**
 * Applies the GL state of a scene pass (scene target must be bound with `targets.bind()`):
 *  - opaque:        depth test LESS, depth write, no blend, drawBuffers all
 *  - transparent:   depth test LEQUAL, no depth write, blend ONE / ONE_MINUS_SRC_ALPHA, drawBuffers color
 *  - transparentId: depth test LEQUAL, depth write, no blend, drawBuffers id
 *  - ghost:         same as transparent
 */
export function applyPassState(
  ctx: GlContext,
  targets: { setDrawBuffers(mode: 'all' | 'color' | 'id' | 'none'): void },
  pass: UberPass,
): void {
  const gl = ctx.gl;
  const s = ctx.state;
  s.setDepthTest(true);
  s.setCullFace(false);
  if (pass === 'opaque') {
    s.setDepthFunc(gl.LESS);
    s.setDepthMask(true);
    s.setBlend(false);
    targets.setDrawBuffers('all');
  } else if (pass === 'transparentId') {
    s.setDepthFunc(gl.LEQUAL);
    s.setDepthMask(true);
    s.setBlend(false);
    targets.setDrawBuffers('id');
  } else {
    s.setDepthFunc(gl.LEQUAL);
    s.setDepthMask(false);
    s.setBlend(true);
    s.setBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    targets.setDrawBuffers('color');
  }
}

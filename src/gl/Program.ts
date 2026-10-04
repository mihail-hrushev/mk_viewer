/**
 * Shader program: compile + link with readable logs, uniform location cache, typed setters.
 * Attribute locations are fixed in GLSL with layout(location = N), so no binding is needed here.
 */
import type { GlContext, GlResource } from './GlContext';

/** Formats a shader info log with the numbered source lines it refers to. */
export function formatShaderError(label: string, stage: string, source: string, log: string): string {
  const lines = source.split('\n');
  const referenced = new Set<number>();
  // ANGLE/Chrome: "ERROR: 0:42: ..."; Firefox: "ERROR: 0:42: ..." or "0(42) : error ..."
  const re = /(?:\d+:(\d+):|\d+\((\d+)\))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    const n = parseInt(m[1] ?? m[2], 10);
    if (n > 0) referenced.add(n);
  }
  const width = String(lines.length).length;
  const numbered = lines
    .map((l, i) => `${referenced.has(i + 1) ? '>' : ' '}${String(i + 1).padStart(width, ' ')}| ${l}`)
    .join('\n');
  return `mk-viewer: ${stage} shader of "${label}" failed to compile:\n${log.trim()}\n\n${numbered}`;
}

export class ShaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShaderError';
  }
}

export class Program implements GlResource {
  program: WebGLProgram;
  private locations = new Map<string, WebGLUniformLocation | null>();
  /** Persistent sampler -> unit assignments, re-applied after restore. */
  private samplers = new Map<string, number>();

  constructor(
    private readonly ctx: GlContext,
    readonly vertexSource: string,
    readonly fragmentSource: string,
    readonly label = 'program',
  ) {
    this.program = this.build();
    ctx.track(this);
  }

  /** Binds the program (cached). */
  use(): this {
    this.ctx.state.useProgram(this.program);
    return this;
  }

  /** Cached uniform location lookup (null for unknown / optimised-out uniforms). */
  uniform(name: string): WebGLUniformLocation | null {
    let loc = this.locations.get(name);
    if (loc === undefined) {
      loc = this.ctx.gl.getUniformLocation(this.program, name);
      this.locations.set(name, loc);
    }
    return loc;
  }

  // Setters assume the program is bound (call use() first).
  setInt(name: string, v: number): void {
    this.ctx.gl.uniform1i(this.uniform(name), v);
  }
  setUint(name: string, v: number): void {
    this.ctx.gl.uniform1ui(this.uniform(name), v >>> 0);
  }
  setFloat(name: string, v: number): void {
    this.ctx.gl.uniform1f(this.uniform(name), v);
  }
  setVec2(name: string, x: number, y: number): void {
    this.ctx.gl.uniform2f(this.uniform(name), x, y);
  }
  setIvec2(name: string, x: number, y: number): void {
    this.ctx.gl.uniform2i(this.uniform(name), x, y);
  }
  setVec3(name: string, x: number, y: number, z: number): void {
    this.ctx.gl.uniform3f(this.uniform(name), x, y, z);
  }
  setVec4(name: string, x: number, y: number, z: number, w: number): void {
    this.ctx.gl.uniform4f(this.uniform(name), x, y, z, w);
  }
  setVec3v(name: string, v: Float32List): void {
    this.ctx.gl.uniform3fv(this.uniform(name), v);
  }
  /** Sets a vec4 or vec4[] uniform; `count` vec4s from `v` (all of `v` when omitted). */
  setVec4v(name: string, v: Float32Array, count?: number): void {
    this.ctx.gl.uniform4fv(this.uniform(name), v, 0, (count ?? v.length >> 2) * 4);
  }
  setMat4(name: string, m: Float32Array): void {
    this.ctx.gl.uniformMatrix4fv(this.uniform(name), false, m);
  }
  /** Assigns a sampler uniform to a texture unit once; kept across context restore. */
  setSampler(name: string, unit: number): void {
    this.samplers.set(name, unit);
    this.use();
    this.ctx.gl.uniform1i(this.uniform(name), unit);
  }

  restore(): void {
    this.locations.clear();
    this.program = this.build();
    if (this.samplers.size) {
      this.use();
      for (const [name, unit] of this.samplers) this.ctx.gl.uniform1i(this.uniform(name), unit);
    }
  }

  dispose(): void {
    this.ctx.state.forgetProgram(this.program);
    this.ctx.gl.deleteProgram(this.program);
    this.ctx.untrack(this);
  }

  private build(): WebGLProgram {
    const gl = this.ctx.gl;
    const vs = this.compile(gl.VERTEX_SHADER, this.vertexSource, 'vertex');
    const fs = this.compile(gl.FRAGMENT_SHADER, this.fragmentSource, 'fragment');
    const program = gl.createProgram();
    if (!program) throw new ShaderError(`mk-viewer: createProgram failed for "${this.label}"`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      const vsLog = gl.getShaderInfoLog(vs) ?? '';
      const fsLog = gl.getShaderInfoLog(fs) ?? '';
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new ShaderError(
        `mk-viewer: program "${this.label}" failed to link:\n${log}\n${vsLog}\n${fsLog}`.trim(),
      );
    }
    gl.detachShader(program, vs);
    gl.detachShader(program, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  private compile(type: number, source: string, stage: string): WebGLShader {
    const gl = this.ctx.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new ShaderError(`mk-viewer: createShader failed for "${this.label}"`);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(shader) ?? '';
      gl.deleteShader(shader);
      throw new ShaderError(formatShaderError(this.label, stage, source, log));
    }
    return shader;
  }
}

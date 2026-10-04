/**
 * Shared GLSL ES 3.00 chunks and the source assembler.
 */
import {
  FRAG_FLAGS,
  FRAG_RECORDS_PER_ROW,
  FRAG_TEXELS,
  FragFlags,
  MAT_RECORDS_PER_ROW,
  MAT_TEXELS,
  MAX_SECTION_PLANES,
} from '../../layout';

export type ShaderDefines = Record<string, number | string | boolean | undefined>;

/**
 * Assembles a complete shader: `#version 300 es` (must be the very first line), then `#define`s,
 * then the body. `true` defines as 1, `false` / undefined are omitted.
 */
export function assembleShader(body: string, defines: ShaderDefines = {}): string {
  let out = '#version 300 es\n';
  for (const key of Object.keys(defines)) {
    const v = defines[key];
    if (v === false || v === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid shader define name: ${key}`);
    out += `#define ${key} ${v === true ? 1 : v}\n`;
  }
  return out + body;
}

export const PRECISION = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
`;

/**
 * Texel / component positions the shaders hard-code, derived from layout.ts (a unit test checks
 * these against the float offsets).
 */
export const SHADER_RECORD_ASSUMPTIONS = {
  matrixTexels: [0, 1, 2],
  dequantScaleTexel: 3, // xyz
  materialTexel: 3, // w
  dequantOffsetTexel: 4, // xyz
  flagsTexel: Math.floor(FRAG_FLAGS / 4), // w
  colorTexel: 5, // rgb + strength
  matColorTexel: 0, // rgb + opacity
  matParamsTexel: 1, // metalness, roughness, emissive
} as const;

/** Constants mirrored from src/layout.ts. */
export const LAYOUT_CONSTANTS = /* glsl */ `
const uint FRAG_PER_ROW = ${FRAG_RECORDS_PER_ROW}u;
const uint FRAG_TEXELS_PER_RECORD = ${FRAG_TEXELS}u;
const uint MAT_PER_ROW = ${MAT_RECORDS_PER_ROW}u;
const uint MAT_TEXELS_PER_RECORD = ${MAT_TEXELS}u;
const uint FLAG_VISIBLE = ${FragFlags.Visible}u;
const uint FLAG_SELECTED = ${FragFlags.Selected}u;
const uint FLAG_GHOSTED = ${FragFlags.Ghosted}u;
const uint FLAG_HIGHLIGHTED = ${FragFlags.Highlighted}u;
const uint FLAG_NOT_PICKABLE = ${FragFlags.NotPickable}u;
const int MAX_SECTION_PLANES = ${MAX_SECTION_PLANES};
`;

/** Texel coordinate helpers (fragment record texel 0 / material record texel 0). */
export const RECORD_ADDRESSING = /* glsl */ `
ivec2 fragTexel0(uint index) {
  return ivec2(int((index % FRAG_PER_ROW) * FRAG_TEXELS_PER_RECORD), int(index / FRAG_PER_ROW));
}
ivec2 matTexel0(uint index) {
  return ivec2(int((index % MAT_PER_ROW) * MAT_TEXELS_PER_RECORD), int(index / MAT_PER_ROW));
}
`;

/** Octahedral decode, mirror of octDecode() in src/gl/pack.ts. */
export const OCT_DECODE = /* glsl */ `
vec3 octDecode(vec2 e) {
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return n; // caller normalizes (after the cofactor transform)
}
`;

/** Packs a u32 into RGBA8 output (exact: k / 255 round-trips through UNORM8). */
export const PACK_U32 = /* glsl */ `
vec4 packU32(uint v) {
  return vec4(uvec4(v, v >> 8u, v >> 16u, v >> 24u) & 255u) / 255.0;
}
uint unpackU32(vec4 t) {
  uvec4 b = uvec4(t * 255.0 + 0.5);
  return b.r | (b.g << 8u) | (b.b << 16u) | (b.a << 24u);
}
`;

export const SRGB = /* glsl */ `
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`;

/** Attribute-less fullscreen triangle (draw 3 vertices with an empty VAO). */
export const FULLSCREEN_VS = assembleShader(/* glsl */ `
precision highp float;
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`);

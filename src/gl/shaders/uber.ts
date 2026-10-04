/**
 * The uber-shader: one program for all scene geometry (merged and instanced pages, every material,
 * opaque / transparent / ghost passes).
 *
 * Attributes (see GeometryVao): 0 a_position (vec3, unorm16), 1 a_normal (vec2, snorm8 octahedral),
 * 2 a_fragment (uint fragment index).
 *
 * Uniforms
 *   u_fragTex          sampler2D  fragment record texture (RGBA32F, FRAG_TEX_WIDTH wide)
 *   u_matTex           sampler2D  material record texture (RGBA32F, MAT_TEX_WIDTH wide)
 *   u_viewMatrix       mat4       world -> view (rigid)
 *   u_projMatrix       mat4       view -> clip
 *   u_flagMask         uint       fragment passes when (flags & u_flagMask) == u_flagValue
 *   u_flagValue        uint
 *   u_materialFilter   int        0 = no material test, 1 = opaque materials only (opacity >= 1),
 *                                 2 = transparent materials only (opacity < 1)
 *   u_passKind         int        0 = opaque, 1 = transparent (premultiplied alpha out),
 *                                 2 = ghost (flat faint colour, no material)
 *   u_writeId          int        1 = write fragment index + 1 to the id output, 0 = write 0
 *   u_orthographic     int        1 for orthographic projection (constant view direction)
 *   u_keyLightDir      vec3       view space, unit, pointing towards the light
 *   u_keyLightColor    vec3       linear
 *   u_skyColor         vec3       linear hemisphere colour (up)
 *   u_groundColor      vec3       linear hemisphere colour (down)
 *   u_contrast         float      tone curve exponent (1 = none, > 1 deepens darks)
 *   u_upView           vec3       world up expressed in view space (mat3(view) * up), unit
 *   u_ghostColor       vec4       linear rgb + opacity
 *   u_sectionPlaneCount int       (SECTION_PLANES variant only)
 *   u_sectionPlanes    vec4[MAX_SECTION_PLANES]  view space, discard where dot(xyz, p) + w > 0
 *
 * Outputs: location 0 o_color (sRGB-encoded RGBA8), location 1 o_id (fragment index + 1, RGBA8).
 */
import {
  LAYOUT_CONSTANTS,
  OCT_DECODE,
  PACK_U32,
  PRECISION,
  RECORD_ADDRESSING,
  SRGB,
  assembleShader,
} from './common';

export interface UberShaderOptions {
  /**
   * Compile section-plane clipping (contains `discard`). Use a separate variant without it while no
   * planes are active: on many GPUs the mere presence of `discard` disables early depth testing.
   */
  sectionPlanes?: boolean;
}

const UBER_VS = /* glsl */ `
${PRECISION}
${LAYOUT_CONSTANTS}

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec2 a_normal;
layout(location = 2) in uint a_fragment;

uniform highp sampler2D u_fragTex;
uniform highp sampler2D u_matTex;
uniform mat4 u_viewMatrix;
uniform mat4 u_projMatrix;
uniform uint u_flagMask;
uniform uint u_flagValue;
uniform int u_materialFilter;

out vec3 v_viewPos;
out vec3 v_normal;
flat out uint v_fragment;
flat out uint v_flags;
flat out uint v_material;

${RECORD_ADDRESSING}
${OCT_DECODE}

void main() {
  uint index = a_fragment;
  ivec2 fc = fragTexel0(index);
  // texel 4: dequant offset xyz, flags; texel 3: dequant scale xyz, material id
  vec4 t4 = texelFetch(u_fragTex, fc + ivec2(4, 0), 0);
  uint flags = uint(t4.w);
  vec4 t3 = texelFetch(u_fragTex, fc + ivec2(3, 0), 0);
  uint material = uint(t3.w);

  bool reject = (flags & u_flagMask) != u_flagValue;
  if (!reject && u_materialFilter != 0) {
    float opacity = texelFetch(u_matTex, matTexel0(material), 0).a;
    reject = (opacity < 1.0) == (u_materialFilter == 1);
  }
  if (reject) {
    // Same clipped point for every vertex of the fragment: its triangles are degenerate and
    // outside the clip volume, so they are dropped before rasterization.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    v_viewPos = vec3(0.0);
    v_normal = vec3(0.0, 0.0, 1.0);
    v_fragment = 0u;
    v_flags = 0u;
    v_material = 0u;
    return;
  }

  // texels 0..2: rows of the 3x4 world matrix
  vec4 r0 = texelFetch(u_fragTex, fc, 0);
  vec4 r1 = texelFetch(u_fragTex, fc + ivec2(1, 0), 0);
  vec4 r2 = texelFetch(u_fragTex, fc + ivec2(2, 0), 0);

  // Linear part and translation are taken to view space separately, so the two large terms (the
  // fragment's translation and the view offset, both ~ distance from the scene origin) cancel once
  // per fragment instead of per vertex: content far from the origin is then off by at most
  // ulp(distance) as a rigid shift, instead of every vertex snapping to that grid (wobbly parts).
  vec3 lp = a_position * t3.xyz + t4.xyz;
  vec3 lin = vec3(dot(r0.xyz, lp), dot(r1.xyz, lp), dot(r2.xyz, lp));
  mat3 v3 = mat3(u_viewMatrix);
  vec3 tView = v3 * vec3(r0.w, r1.w, r2.w) + u_viewMatrix[3].xyz;
  vec4 view = vec4(v3 * lin + tView, 1.0);
  gl_Position = u_projMatrix * view;

  // Normal: cofactor of the 3x3 (= det * inverse-transpose), correct under non-uniform scale.
  // n * mat3(c0, c1, c2) = (dot(n, c0), dot(n, c1), dot(n, c2)). The sign is fixed in the fragment
  // shader (normals are faced towards the viewer), so mirrored transforms need no det test.
  vec3 n = octDecode(a_normal);
  vec3 nWorld = n * mat3(cross(r1.xyz, r2.xyz), cross(r2.xyz, r0.xyz), cross(r0.xyz, r1.xyz));
  v_normal = mat3(u_viewMatrix) * nWorld;
  v_viewPos = view.xyz;
  v_fragment = index;
  v_flags = flags;
  v_material = material;
}
`;

const UBER_FS = /* glsl */ `
${PRECISION}
${LAYOUT_CONSTANTS}

uniform highp sampler2D u_fragTex;
uniform highp sampler2D u_matTex;
uniform int u_passKind;
uniform int u_writeId;
uniform int u_orthographic;
uniform vec3 u_keyLightDir;
uniform vec3 u_keyLightColor;
uniform vec3 u_skyColor;
uniform vec3 u_groundColor;
uniform float u_contrast;
uniform vec3 u_upView;
uniform vec4 u_ghostColor;
#ifdef SECTION_PLANES
uniform int u_sectionPlaneCount;
uniform vec4 u_sectionPlanes[MAX_SECTION_PLANES];
#endif

in vec3 v_viewPos;
in vec3 v_normal;
flat in uint v_fragment;
flat in uint v_flags;
flat in uint v_material;

layout(location = 0) out vec4 o_color;
layout(location = 1) out vec4 o_id;

const float PI = 3.14159265;

${RECORD_ADDRESSING}
${PACK_U32}
${SRGB}

vec3 hemisphere(vec3 dir) {
  return mix(u_groundColor, u_skyColor, dot(dir, u_upView) * 0.5 + 0.5);
}

void main() {
#ifdef SECTION_PLANES
  for (int i = 0; i < MAX_SECTION_PLANES; ++i) {
    if (i >= u_sectionPlaneCount) break;
    vec4 plane = u_sectionPlanes[i];
    if (dot(plane.xyz, v_viewPos) + plane.w > 0.0) discard;
  }
#endif

  vec3 V = u_orthographic != 0 ? vec3(0.0, 0.0, 1.0) : normalize(-v_viewPos);
  vec3 N = normalize(v_normal);
  // Two-sided lighting: face the normal towards the viewer (handles mirrored transforms,
  // inconsistent winding and the inside of section cuts).
  if (dot(N, V) < 0.0) N = -N;
  float NdotV = max(dot(N, V), 1e-4);

  if (u_passKind == 2) {
    // Ghost: faint, unlit-ish, no material lookup, never pickable.
    vec3 g = u_ghostColor.rgb * (0.55 + 0.45 * NdotV);
    float a = u_ghostColor.a;
    o_color = vec4(linearToSrgb(g) * a, a);
    o_id = vec4(0.0);
    return;
  }

  ivec2 mc = matTexel0(v_material);
  vec4 m0 = texelFetch(u_matTex, mc, 0);                   // base rgb (linear), opacity
  vec4 m1 = texelFetch(u_matTex, mc + ivec2(1, 0), 0);     // metalness, roughness, emissive
  vec4 ov = texelFetch(u_fragTex, fragTexel0(v_fragment) + ivec2(5, 0), 0); // override rgb, strength

  vec3 base = mix(m0.rgb, ov.rgb, clamp(ov.a, 0.0, 1.0));
  float metal = clamp(m1.x, 0.0, 1.0);
  float rough = clamp(m1.y, 0.045, 1.0);
  float emissive = max(m1.z, 0.0);

  vec3 diffuseColor = base * (1.0 - metal);
  vec3 F0 = mix(vec3(0.04), base, metal);

  // Camera-attached key light: GGX / Smith-Schlick / Schlick-Fresnel.
  vec3 L = u_keyLightDir;
  vec3 H = normalize(L + V);
  float NdotL = max(dot(N, L), 0.0);
  float NdotH = max(dot(N, H), 0.0);
  float VdotH = max(dot(V, H), 0.0);
  float a = rough * rough;
  float a2 = a * a;
  float dd = NdotH * NdotH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = (rough + 1.0) * (rough + 1.0) * 0.125;
  float vis = 0.25 / ((NdotL * (1.0 - k) + k) * (NdotV * (1.0 - k) + k));
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);
  vec3 direct = (diffuseColor * (1.0 - F) + PI * D * vis * F) * NdotL * u_keyLightColor;

  // Hemisphere ambient, diffuse + roughness-blurred specular (no environment map needed).
  vec3 Fenv = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - NdotV, 5.0);
  vec3 R = reflect(-V, N);
  vec3 envSpec = mix(hemisphere(R), 0.5 * (u_skyColor + u_groundColor), rough);
  vec3 ambient = diffuseColor * hemisphere(N) * (1.0 - Fenv) + envSpec * Fenv;

  // Contrast curve on the lit colour: darks and mids go down, full brightness stays where it is.
  vec3 lit = pow(min(direct + ambient, vec3(1.0)), vec3(u_contrast));
  vec3 color = lit + base * emissive;

  // Selection / hover tint is not applied here: it is a screen-space overlay composited at present
  // time (COMPOSITE_FS), so changing it never restarts the progressive image.

  vec3 srgb = linearToSrgb(color);
  if (u_passKind == 1) {
    float alpha = clamp(m0.a, 0.0, 1.0);
    o_color = vec4(srgb * alpha, alpha); // premultiplied: blend ONE, ONE_MINUS_SRC_ALPHA
  } else {
    o_color = vec4(srgb, 1.0);
  }

  bool pickable = u_writeId != 0 && (v_flags & (FLAG_NOT_PICKABLE | FLAG_GHOSTED)) == 0u;
  o_id = packU32(pickable ? v_fragment + 1u : 0u);
}
`;

export function uberVertexSource(): string {
  return assembleShader(UBER_VS);
}

export function uberFragmentSource(options: UberShaderOptions = {}): string {
  return assembleShader(UBER_FS, { SECTION_PLANES: !!options.sectionPlanes });
}

/** Pass kinds for u_passKind. */
export const PassKind = { Opaque: 0, Transparent: 1, Ghost: 2 } as const;
/** Values for u_materialFilter. */
export const MaterialFilter = { Any: 0, OpaqueOnly: 1, TransparentOnly: 2 } as const;

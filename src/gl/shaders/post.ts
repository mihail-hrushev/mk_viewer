/**
 * Fullscreen post shaders. All use FULLSCREEN_VS (attribute-less triangle, 3 vertices).
 */
import { LAYOUT_CONSTANTS, OCT_DECODE, PACK_U32, PRECISION, RECORD_ADDRESSING, SRGB, assembleShader } from './common';

/**
 * Present: copies the colour target 1:1 to the bound framebuffer.
 * u_colorTex (sampler2D), u_offset (ivec2, source pixel = gl_FragCoord + offset).
 */
export const PRESENT_FS = assembleShader(/* glsl */ `
${PRECISION}
uniform highp sampler2D u_colorTex;
uniform ivec2 u_offset;
out vec4 o_color;
void main() {
  o_color = texelFetch(u_colorTex, ivec2(gl_FragCoord.xy) + u_offset, 0);
}
`);

/**
 * Background gradient, colours given sRGB-encoded (as in the public API). Writes location 0 only:
 * draw it with drawBuffers = [COLOR_ATTACHMENT0, NONE].
 * u_topColor, u_bottomColor (vec3, sRGB).
 */
export const BACKGROUND_FS = assembleShader(/* glsl */ `
${PRECISION}
uniform vec3 u_topColor;
uniform vec3 u_bottomColor;
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() {
  vec3 c = mix(u_bottomColor, u_topColor, clamp(v_uv.y, 0.0, 1.0));
  // +-0.5 LSB dither against banding in subtle gradients
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  o_color = vec4(c + n / 255.0, 1.0);
}
`);

/**
 * Selection outline over the id target. A pixel gets the outline colour when it is not selected
 * and a neighbour at distance u_outlineWidth is (outer outline); otherwise it is discarded.
 * Selection is looked up from the fragment record flags (FragFlags.Selected) using the id.
 * Blend with SRC_ALPHA, ONE_MINUS_SRC_ALPHA over the presented image.
 * u_idTex, u_fragTex (sampler2D), u_outlineColor (vec4, sRGB rgb + alpha), u_outlineWidth (int px),
 * u_offset (ivec2, same meaning as for present).
 */
export const OUTLINE_FS = assembleShader(/* glsl */ `
${PRECISION}
${LAYOUT_CONSTANTS}
uniform highp sampler2D u_idTex;
uniform highp sampler2D u_fragTex;
uniform vec4 u_outlineColor;
uniform int u_outlineWidth;
uniform ivec2 u_offset;
out vec4 o_color;

${RECORD_ADDRESSING}
${PACK_U32}

bool isSelected(uint id) {
  if (id == 0u) return false;
  float flags = texelFetch(u_fragTex, fragTexel0(id - 1u) + ivec2(4, 0), 0).w;
  return (uint(flags) & FLAG_SELECTED) != 0u;
}

const ivec2 DIRS[8] = ivec2[8](
  ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1),
  ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1)
);

void main() {
  ivec2 size = textureSize(u_idTex, 0);
  ivec2 p = ivec2(gl_FragCoord.xy) + u_offset;
  uint centerId = unpackU32(texelFetch(u_idTex, p, 0));
  if (isSelected(centerId)) discard;
  uint lastId = centerId;
  bool lastSel = false;
  bool edge = false;
  for (int i = 0; i < 8; ++i) {
    ivec2 q = clamp(p + DIRS[i] * u_outlineWidth, ivec2(0), size - 1);
    uint id = unpackU32(texelFetch(u_idTex, q, 0));
    if (id != lastId) {
      lastId = id;
      lastSel = isSelected(id);
    }
    if (lastSel) {
      edge = true;
      break;
    }
  }
  if (!edge) discard;
  o_color = u_outlineColor;
}
`);

/**
 * Present with selection / hover overlay: copies the colour target 1:1 and, per pixel, looks up the
 * fragment under it in the id target and its flags in the fragment texture:
 *  - Selected fragments are tinted towards u_selectionColor, hovered (Highlighted) ones towards
 *    u_highlightColor (both linear rgb + amount, mixed in linear space);
 *  - pixels not selected but with a selected fragment at distance u_outlineWidth get the outline
 *    colour (u_outlineWidth 0 disables the outline search).
 * Selection / hover therefore never require re-rendering the scene: changing the flags only needs
 * the fragment texture row upload and one present. The id target holds pickable, non-ghosted
 * fragments only (transparent ones after the transparent-id pass), so only those are tinted.
 * Blend off. u_colorTex, u_idTex, u_fragTex (sampler2D), u_selectionColor, u_highlightColor (vec4),
 * u_outlineColor (vec4, sRGB rgb + alpha), u_outlineWidth (int px), u_offset (ivec2, as present),
 * u_overlay (int, 0: no tint and no outline, the flags are not looked up).
 *
 * EDGES variant (`compositeFragmentSource({ edges: true })`) also draws the edge display: lines
 * where neighbouring pixels of the target (+-1 px in x and y) differ in
 *  - face normal (u_normalTex, RG8 octahedral, written by the uber EDGES variant) by more than the
 *    crease angle; coplanar triangles share the normal, so diagonals of flat faces never show;
 *  - depth (u_depthTex, as "nearness" 1 / view depth, which is linear across planes): a step more
 *    than twice the gentler of the steps beside it plus 1.5 pixel footprints plus the depth
 *    quantization noise; planes at grazing angles and smooth curves stay clean: silhouettes and
 *    occlusion edges;
 *  - fragment id (u_idTex, both non-zero): touching, coplanar meshes.
 * A depth line goes on the nearer pixel, a crease / id line on a fixed side; the pixel across gets
 * EDGE_SOFT of it, which softens staircases (about 1 device pixel at any pixel ratio). Lines are
 * mixed in after the selection tint and before the selection outline.
 * u_depthTex, u_normalTex (sampler2D), u_edgeColor (vec4, sRGB rgb + opacity), u_edgeParams (vec4:
 * cos(crease angle), near, far, orthographic 0/1 of the image's camera), u_edgePixel (float: world
 * size of one pixel at view distance 1 (perspective) or anywhere (orthographic)).
 */
const COMPOSITE_BODY = /* glsl */ `
${PRECISION}
${LAYOUT_CONSTANTS}
uniform highp sampler2D u_colorTex;
uniform highp sampler2D u_idTex;
uniform highp sampler2D u_fragTex;
uniform vec4 u_selectionColor;
uniform vec4 u_highlightColor;
uniform vec4 u_outlineColor;
uniform int u_outlineWidth;
uniform ivec2 u_offset;
uniform int u_overlay;
#ifdef EDGES
uniform highp sampler2D u_depthTex;
uniform highp sampler2D u_normalTex;
uniform vec4 u_edgeColor;
uniform vec4 u_edgeParams;
uniform float u_edgePixel;
#endif
out vec4 o_color;

${RECORD_ADDRESSING}
${PACK_U32}
${SRGB}

uint flagsOf(uint id) {
  if (id == 0u) return 0u;
  return uint(texelFetch(u_fragTex, fragTexel0(id - 1u) + ivec2(4, 0), 0).w);
}

const ivec2 DIRS[8] = ivec2[8](
  ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1),
  ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1)
);

#ifdef EDGES
${OCT_DECODE}

const float EDGE_SOFT = 0.35;

// "Nearness" of target pixel q: larger is nearer, and linear in screen space across any plane
// (perspective: 1 / view depth; orthographic: -view depth). Background: -1e20.
float nearness(ivec2 q) {
  float d = texelFetch(u_depthTex, q, 0).r;
  if (d >= 1.0) return -1e20;
  float n = u_edgeParams.y;
  float f = u_edgeParams.z;
  if (u_edgeParams.w != 0.0) return -(n + d * (f - n));
  return (f * (1.0 - d) + n * d) / (n * f); // 1 - d is exact near 1
}

vec3 normalAt(ivec2 q) {
  return normalize(octDecode(texelFetch(u_normalTex, q, 0).rg * 2.0 - 1.0));
}

// Line weight pixel p gets from the boundary to its neighbour p + dir (0..1).
float edgeTo(ivec2 p, ivec2 dir, ivec2 maxp, float lc, vec3 nc, uint idc) {
  ivec2 q = clamp(p + dir, ivec2(0), maxp);
  float lq = nearness(q);
  bool bgc = lc < -1e19;
  bool bgq = lq < -1e19;
  if (bgc && bgq) return 0.0;
  float nearSide = lc >= lq ? 1.0 : EDGE_SOFT;
  if (bgc || bgq) return nearSide; // silhouette against the background
  // Depth: planes are linear in nearness, so the step across the boundary is compared with the
  // steps beside it. More than twice the gentler side's step (+ 1.5 pixel footprints + depth
  // quantization) is an occlusion edge; planes at any angle and smooth curves are not.
  float lo = nearness(clamp(p - dir, ivec2(0), maxp));
  float lqq = nearness(clamp(p + 2 * dir, ivec2(0), maxp));
  float slope = 1e20;
  if (lo > -1e19) slope = abs(lc - lo);
  if (lqq > -1e19) slope = min(slope, abs(lqq - lq));
  if (slope > 1e19) slope = 0.0;
  float n = u_edgeParams.y;
  float f = u_edgeParams.z;
  bool ortho = u_edgeParams.w != 0.0;
  // 1.5 footprints as a nearness step: perspective |1/zc - 1/zq| = |dz| / (zc zq)
  float foot = ortho ? 1.5 * u_edgePixel : 1.5 * u_edgePixel * min(lc, lq);
  float noise = ortho ? (f - n) * 2.4e-7 : (f - n) / (n * f) * 2.4e-7;
  float tol = 2.0 * slope + foot + noise;
  float e = smoothstep(tol, 2.0 * tol, abs(lq - lc)) * nearSide;
  // crease and id lines: on the pixel whose neighbour lies towards +x / +y
  float fixedSide = dir.x + dir.y > 0 ? 1.0 : EDGE_SOFT;
  float c = u_edgeParams.x;
  float crease = smoothstep(c + 0.02, c - 0.02, dot(nc, normalAt(q)));
  uint idq = unpackU32(texelFetch(u_idTex, q, 0));
  if (idc != idq && idc != 0u && idq != 0u) crease = 1.0;
  return max(e, crease * fixedSide);
}

float edgeWeight(ivec2 p, uint idc) {
  ivec2 maxp = textureSize(u_depthTex, 0) - 1;
  float lc = nearness(p);
  vec3 nc = normalAt(p);
  float w = edgeTo(p, ivec2(1, 0), maxp, lc, nc, idc);
  w = max(w, edgeTo(p, ivec2(-1, 0), maxp, lc, nc, idc));
  w = max(w, edgeTo(p, ivec2(0, 1), maxp, lc, nc, idc));
  w = max(w, edgeTo(p, ivec2(0, -1), maxp, lc, nc, idc));
  return w;
}
#endif

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + u_offset;
  vec4 c = texelFetch(u_colorTex, p, 0);
  uint centerId = unpackU32(texelFetch(u_idTex, p, 0));
  // the fragment flags are a dependent fetch into a large texture: skip it without an overlay
  uint f = u_overlay != 0 ? flagsOf(centerId) : 0u;
  bool sel = (f & FLAG_SELECTED) != 0u;
  if ((f & (FLAG_SELECTED | FLAG_HIGHLIGHTED)) != 0u) {
    vec3 lin = srgbToLinear(c.rgb);
    if (sel) lin = mix(lin, u_selectionColor.rgb, u_selectionColor.a);
    if ((f & FLAG_HIGHLIGHTED) != 0u) lin = mix(lin, u_highlightColor.rgb, u_highlightColor.a);
    c.rgb = linearToSrgb(lin);
  }
#ifdef EDGES
  c.rgb = mix(c.rgb, u_edgeColor.rgb, edgeWeight(p, centerId) * u_edgeColor.a);
#endif
  if (u_outlineWidth > 0 && !sel) {
    ivec2 size = textureSize(u_idTex, 0);
    uint lastId = centerId;
    bool lastSel = false;
    bool edge = false;
    // ring at the full width, plus one at half width for wide outlines (thin objects stay outlined)
    for (int k = 0; k < 2 && !edge; ++k) {
      int r = k == 0 ? u_outlineWidth : u_outlineWidth / 2;
      if (k == 1 && r < 2) break;
      for (int i = 0; i < 8; ++i) {
        ivec2 q = clamp(p + DIRS[i] * r, ivec2(0), size - 1);
        uint id = unpackU32(texelFetch(u_idTex, q, 0));
        if (id != lastId) {
          lastId = id;
          lastSel = (flagsOf(id) & FLAG_SELECTED) != 0u;
        }
        if (lastSel) {
          edge = true;
          break;
        }
      }
    }
    if (edge) c.rgb = mix(c.rgb, u_outlineColor.rgb, u_outlineColor.a);
  }
  o_color = vec4(c.rgb, 1.0);
}
`;

/** Source of COMPOSITE_FS, optionally with the edge display (EDGES define). */
export function compositeFragmentSource(options: { edges?: boolean } = {}): string {
  return assembleShader(COMPOSITE_BODY, { EDGES: !!options.edges });
}

export const COMPOSITE_FS = compositeFragmentSource();

/**
 * Pick resolve: copies a small rectangle of the id target and the depth texture into two RGBA8
 * attachments (depth as raw float32 bits), so both can be read back with plain RGBA/UNSIGNED_BYTE
 * readPixels, which every WebGL2 implementation supports (depth cannot be read directly).
 * u_idTex, u_depthTex (sampler2D), u_origin (ivec2, bottom-left of the rect in target pixels).
 */
export const PICK_RESOLVE_FS = assembleShader(/* glsl */ `
${PRECISION}
uniform highp sampler2D u_idTex;
uniform highp sampler2D u_depthTex;
uniform ivec2 u_origin;
layout(location = 0) out vec4 o_id;
layout(location = 1) out vec4 o_depth;
void main() {
  ivec2 size = textureSize(u_idTex, 0);
  ivec2 p = u_origin + ivec2(gl_FragCoord.xy);
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, size))) {
    o_id = vec4(0.0);                       // background
    o_depth = vec4(0.0, 0.0, 128.0, 63.0) / 255.0; // 1.0f = 0x3F800000
    return;
  }
  o_id = texelFetch(u_idTex, p, 0);
  uint b = floatBitsToUint(texelFetch(u_depthTex, p, 0).r);
  o_depth = vec4(uvec4(b, b >> 8u, b >> 16u, b >> 24u) & 255u) / 255.0;
}
`);

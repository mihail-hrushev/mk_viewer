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
 * Edge detection over a scene target (the EDGES variant of COMPOSITE_FS; kept as a chunk of its own
 * so that another pass can run it on another target). The host shader declares `u_idTex`
 * (sampler2D, fragment index + 1) and includes PACK_U32 first. Lines are found where neighbouring pixels of the target (+-1 px in x and y) differ
 * in
 *  - face normal (u_normalTex, RG8 octahedral, written by the uber EDGES variant) by more than the
 *    crease angle; coplanar triangles share the normal, so diagonals of flat faces never show;
 *    a pair bridged by a face within the crease angle of both beside it (another neighbour of p or a
 *    diagonal one) only meets at a vertex (diagonal facets of a tessellated smooth surface) and gets
 *    no line;
 *  - depth (u_depthTex, as "nearness" 1 / view depth, which is linear across planes): a step more
 *    than twice the gentler of the steps beside it plus 1.5 pixel footprints plus the depth
 *    quantization noise; planes at grazing angles and smooth curves stay clean: silhouettes and
 *    occlusion edges;
 *  - fragment id (u_idTex, both non-zero): touching, coplanar meshes.
 * A depth line goes on the nearer pixel, a crease / id line on a fixed side; the pixel across gets
 * EDGE_SOFT of it, which softens staircases (about 1 device pixel at any pixel ratio).
 * `edgeWeight(p, idAtP)` is the line weight 0..1 of target pixel p.
 * u_depthTex, u_normalTex (sampler2D), u_edgeParams (vec4: cos(crease angle), near, far,
 * orthographic 0/1 of the camera the target was rendered with), u_edgePixel (float: world size of
 * one pixel at view distance 1 (perspective) or anywhere (orthographic)).
 */
const EDGE_DETECT = /* glsl */ `
uniform highp sampler2D u_depthTex;
uniform highp sampler2D u_normalTex;
uniform vec4 u_edgeParams;
uniform float u_edgePixel;

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

// 1 for face normals within the crease angle of each other, 0 beyond it (smooth around it).
float alike(vec3 a, vec3 b) {
  float c = u_edgeParams.x;
  return smoothstep(c - 0.02, c + 0.02, dot(a, b));
}

// A neighbour of the pixel: nearness, fragment id, face normal (fetched once, shared by the tests of
// all four directions).
struct Texel {
  float l;
  uint id;
  vec3 n;
};

Texel texelAt(ivec2 q, ivec2 maxp) {
  q = clamp(q, ivec2(0), maxp);
  return Texel(nearness(q), unpackU32(texelFetch(u_idTex, q, 0)), normalAt(q));
}

// Line weight pixel p (not background) gets from the boundary to its neighbour q = p + dir (0..1).
// o = p - dir; crease: the crease line weight towards q (see edgeWeight).
float edgeTo(ivec2 p, ivec2 dir, ivec2 maxp, float lc, uint idc, Texel q, Texel o, float crease) {
  float lq = q.l;
  float nearSide = lc >= lq ? 1.0 : EDGE_SOFT;
  if (lq < -1e19) return nearSide; // silhouette against the background
  // Depth: planes are linear in nearness, so the step across the boundary is compared with the
  // steps beside it. More than twice the gentler side's step (+ 1.5 pixel footprints + depth
  // quantization) is an occlusion edge; planes at any angle and smooth curves are not.
  float lo = o.l;
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
  if (idc != q.id && idc != 0u && q.id != 0u) crease = 1.0;
  return max(e, crease * fixedSide);
}

float edgeWeight(ivec2 p, uint idc) {
  ivec2 maxp = textureSize(u_depthTex, 0) - 1;
  Texel px = texelAt(p + ivec2(1, 0), maxp);
  Texel mx = texelAt(p - ivec2(1, 0), maxp);
  Texel py = texelAt(p + ivec2(0, 1), maxp);
  Texel my = texelAt(p - ivec2(0, 1), maxp);
  float lc = nearness(p);
  // background: the far side of a silhouette
  if (lc < -1e19) return max(max(px.l, mx.l), max(py.l, my.l)) > -1e19 ? EDGE_SOFT : 0.0;
  vec3 nc = normalAt(p);
  // Crease towards each neighbour: its face normal differs from p's by more than the crease angle.
  vec4 d = vec4(dot(nc, px.n), dot(nc, mx.n), dot(nc, py.n), dot(nc, my.n));
  float c = u_edgeParams.x;
  vec4 s = smoothstep(c - 0.02, c + 0.02, d);
  vec4 crease = 1.0 - s;
  if (any(lessThan(s, vec4(1.0)))) {
    // A crease line separates two faces along a shared edge. Faces that only share a vertex (the
    // diagonal facets of a tessellated smooth surface, compared across the vertex) may differ by
    // more than the crease angle although no edge between them does, which would leave an isolated
    // dot. There a third face within the crease angle of both lies beside the pair: no line. First
    // at the two other neighbours of p, which must belong to the same fragment.
    vec4 v = vec4(px.l > -1e19 && px.id == idc, mx.l > -1e19 && mx.id == idc,
                  py.l > -1e19 && py.id == idc, my.l > -1e19 && my.id == idc);
    vec4 sv = s * v;
    // faces of the x neighbours alike the faces of the y neighbours: +x+y, +x-y, -x+y, -x-y
    vec4 xy = vec4(alike(px.n, py.n), alike(px.n, my.n), alike(mx.n, py.n), alike(mx.n, my.n));
    vec4 bridged = vec4(
      max(min(sv.z, xy.x), min(sv.w, xy.y)),  // +x across +y or -y
      max(min(sv.z, xy.z), min(sv.w, xy.w)),  // -x
      max(min(sv.x, xy.x), min(sv.y, xy.z)),  // +y across +x or -x
      max(min(sv.x, xy.y), min(sv.y, xy.w))); // -y
    // A neighbour on p's or q's own face is alike both by s already (a crease near the angle is
    // soft): only what a bridging face adds beyond that removes the line.
    vec4 keep = 1.0 - clamp((bridged - s) / max(crease, 1e-4), 0.0, 1.0);
    // Otherwise the bridging face may lie beside q, at a diagonal neighbour (normal only: the
    // cleared background normal faces away and never bridges). Only faces less than twice the
    // crease angle apart can be bridged, so most real creases skip these fetches.
    float c2 = 2.0 * c * c - 1.0 - 0.05; // cos(2 * crease angle), with the smoothstep margin
    if (any(greaterThan(keep * crease * step(c2, d), vec4(0.0)))) {
      vec3 dpp = normalAt(clamp(p + ivec2(1, 1), ivec2(0), maxp));
      vec3 dpm = normalAt(clamp(p + ivec2(1, -1), ivec2(0), maxp));
      vec3 dmp = normalAt(clamp(p + ivec2(-1, 1), ivec2(0), maxp));
      vec3 dmm = normalAt(clamp(p + ivec2(-1, -1), ivec2(0), maxp));
      vec4 sd = vec4(alike(nc, dpp), alike(nc, dpm), alike(nc, dmp), alike(nc, dmm));
      bridged = max(bridged, vec4(
        max(min(sd.x, alike(dpp, px.n)), min(sd.y, alike(dpm, px.n))),
        max(min(sd.z, alike(dmp, mx.n)), min(sd.w, alike(dmm, mx.n))),
        max(min(sd.x, alike(dpp, py.n)), min(sd.z, alike(dmp, py.n))),
        max(min(sd.y, alike(dpm, my.n)), min(sd.w, alike(dmm, my.n)))));
      keep = 1.0 - clamp((bridged - s) / max(crease, 1e-4), 0.0, 1.0);
    }
    crease *= keep;
  }
  float w = edgeTo(p, ivec2(1, 0), maxp, lc, idc, px, mx, crease.x);
  w = max(w, edgeTo(p, ivec2(-1, 0), maxp, lc, idc, mx, px, crease.y));
  w = max(w, edgeTo(p, ivec2(0, 1), maxp, lc, idc, py, my, crease.z));
  w = max(w, edgeTo(p, ivec2(0, -1), maxp, lc, idc, my, py, crease.w));
  return w;
}
`;

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
 * EDGES variant (`compositeFragmentSource({ edges: true })`) also draws the edge display: the lines
 * of EDGE_DETECT over the scene target (depth, normals, ids of the image's camera), mixed in after
 * the selection tint and before the selection outline. u_edgeColor (vec4, sRGB rgb + opacity) plus
 * the EDGE_DETECT uniforms.
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
uniform vec4 u_edgeColor;
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
${EDGE_DETECT}
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
 * Selection x-ray: the borders of the selected objects from a second scene target holding only the
 * selected fragments (Renderer's x-ray pass: their ids with a depth test, everything else 0),
 * drawn over the presented image so that the selection shows through whatever is in front of it.
 * A pixel gets the line when a pixel within u_radius of it (8 directions, every distance up to
 * the radius) is on the other side of the selection: selected (id != 0) next to not selected, or
 * the reverse. That is the silhouette of the selection against everything else, holes included,
 * on both sides of the boundary, so the line is about 2 * u_radius pixels wide. Boundaries between
 * selected objects, creases and edges inside them are not lines. Other pixels are discarded. Recipe: after
 * composite / present, same framebuffer (canvas), blend on with SRC_ALPHA / ONE_MINUS_SRC_ALPHA,
 * depth test off.
 * u_idTex (sampler2D, the x-ray target's ids), u_color (vec4, sRGB rgb + opacity), u_radius (int,
 * target pixels, >= 1), u_offset (ivec2, as present).
 */
export const XRAY_FS = assembleShader(/* glsl */ `
${PRECISION}
uniform highp sampler2D u_idTex;
uniform vec4 u_color;
uniform int u_radius;
uniform ivec2 u_offset;
out vec4 o_color;

${PACK_U32}

const ivec2 DIRS[8] = ivec2[8](
  ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1),
  ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1)
);

void main() {
  ivec2 size = textureSize(u_idTex, 0);
  ivec2 p = ivec2(gl_FragCoord.xy) + u_offset;
  bool selected = unpackU32(texelFetch(u_idTex, p, 0)) != 0u;
  bool border = false;
  for (int d = 1; d <= u_radius && !border; ++d) {
    for (int i = 0; i < 8; ++i) {
      ivec2 q = clamp(p + DIRS[i] * d, ivec2(0), size - 1);
      if ((unpackU32(texelFetch(u_idTex, q, 0)) != 0u) != selected) {
        border = true;
        break;
      }
    }
  }
  if (!border) discard;
  o_color = u_color;
}
`);

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

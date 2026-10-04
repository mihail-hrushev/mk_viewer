/**
 * Fullscreen post shaders. All use FULLSCREEN_VS (attribute-less triangle, 3 vertices).
 */
import { LAYOUT_CONSTANTS, PACK_U32, PRECISION, RECORD_ADDRESSING, assembleShader } from './common';

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

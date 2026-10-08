/**
 * Binary layouts shared by the CPU data core (src/core) and the GPU layer (src/gl, src/render).
 * These are the contract between modules: change them only together with every reader/writer.
 */

// ---------------------------------------------------------------------------
// Vertex formats (little-endian, interleaved)
// ---------------------------------------------------------------------------

/**
 * Shared-geometry vertex, used for instanced drawing. 8 bytes:
 *   0  u16 x3  position, quantized to 0..65535 inside the geometry's local AABB (normalized attribute)
 *   6  i8  x2  octahedron-encoded unit normal (snorm attribute)
 * The fragment index comes from a per-instance u32 attribute.
 */
export const SHARED_VERTEX_STRIDE = 8;

/**
 * Merged-batch vertex, used for consolidated geometry. 12 bytes:
 *   0  u16 x3  position (same encoding as above, still in its source geometry's local quantized space)
 *   6  i8  x2  octahedron-encoded normal
 *   8  u32     fragment index (integer attribute)
 * Because positions stay in geometry-local quantized space and every vertex carries its fragment
 * index, moving/hiding/recolouring a fragment never touches vertex data, only the fragment record.
 */
export const MERGED_VERTEX_STRIDE = 12;

export const VERTEX_POSITION_OFFSET = 0;
export const VERTEX_NORMAL_OFFSET = 6;
export const VERTEX_FRAGMENT_OFFSET = 8;

/** Index buffers are always u32. */
export const INDEX_BYTES = 4;

// ---------------------------------------------------------------------------
// Fragment record: one per drawable instance, stored in an RGBA32F data texture
// ---------------------------------------------------------------------------

/** Floats per fragment record (6 RGBA texels). */
export const FRAG_FLOATS = 24;
export const FRAG_TEXELS = 6;
/** Records per texture row. Texture width = FRAG_RECORDS_PER_ROW * FRAG_TEXELS texels. */
export const FRAG_RECORDS_PER_ROW = 512;
export const FRAG_TEX_WIDTH = FRAG_RECORDS_PER_ROW * FRAG_TEXELS;

/**
 * Float offsets inside a record.
 * texel 0..2: rows of the 3x4 affine world matrix W (row r = [m_r0, m_r1, m_r2, t_r])
 * texel 3   : dequantization scale xyz, materialId
 * texel 4   : dequantization offset xyz, flags (FragFlags bitfield stored as a float)
 * texel 5   : colour override rgb (linear) + blend strength a (0 = no override)
 *
 * Vertex shader: local = a_position(0..1) * scale + offset; world = W * vec4(local, 1).
 * Normals are transformed by the cofactor matrix of W's 3x3 (correct under non-uniform scale).
 */
export const FRAG_MATRIX = 0;
export const FRAG_DEQUANT_SCALE = 12;
export const FRAG_MATERIAL = 15;
export const FRAG_DEQUANT_OFFSET = 16;
export const FRAG_FLAGS = 19;
export const FRAG_COLOR = 20;

export const enum FragFlags {
  /** Slot is in use and should be drawn. Cleared = vertex shader collapses the fragment. */
  Visible = 1,
  Selected = 2,
  /** Drawn faint and non-pickable (context around isolated objects). */
  Ghosted = 4,
  /** Hover highlight. */
  Highlighted = 8,
  /** Excluded from the id buffer. */
  NotPickable = 16,
  /**
   * Hidden by the client (`setVisible(false)`, `isolate(..., true)`): alive, Visible cleared. Tells
   * a hidden fragment from a removed slot (flags 0), so the ghost-hidden pass can draw it faintly.
   */
  Hidden = 32,
}

// ---------------------------------------------------------------------------
// Material record: RGBA32F data texture, 2 texels per material
// ---------------------------------------------------------------------------

export const MAT_FLOATS = 8;
export const MAT_TEXELS = 2;
export const MAT_RECORDS_PER_ROW = 512;
export const MAT_TEX_WIDTH = MAT_RECORDS_PER_ROW * MAT_TEXELS;

/** texel 0: base colour rgb (linear) + opacity; texel 1: metalness, roughness, emissive strength, reserved */
export const MAT_COLOR = 0;
export const MAT_METALNESS = 4;
export const MAT_ROUGHNESS = 5;
export const MAT_EMISSIVE = 6;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_SECTION_PLANES = 6;

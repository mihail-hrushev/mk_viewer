# mk-viewer architecture

A dependency-free WebGL2 viewer library for very large scenes (millions of objects) whose geometry
is created at runtime through an API. Design follows the principles in
`Specs/viewer_specification.md`: no scene graph, flat typed arrays, consolidation, BVH culling with
screen-size rejection, progressive time-budgeted rendering, compact vertex data, GPU picking.

Hard rules

- Zero runtime dependencies. No Three.js, no proprietary code or formats. TypeScript, WebGL2.
- No per-object JS objects on hot paths. Scene state lives in typed arrays (structure of arrays).
- No allocation in the per-frame path (reuse scratch arrays).
- Public API is `src/types.ts` (`ViewerApi`). Binary layouts are `src/layout.ts`. Both are contracts.

## Modules and ownership

```
src/layout.ts      shared binary layouts (contract)
src/types.ts       public API types (contract)
src/math/          vec3/mat4/aabb/frustum helpers on plain Float32Array, no classes on hot paths
src/camera/        Camera (view/projection, perspective + ortho), OrbitControls, fit-to-bounds
src/primitives/    pure functions returning GeometryData (box, sphere, cylinder, cone, plane, torus, extrusion)
src/core/          CPU scene data: FragmentList, GeometryStore, MaterialStore, Batcher, DrawList BVH + traversal
src/gl/            thin WebGL2 layer: context/caps, Program, mirrored buffers, data textures, render targets,
                   GLSL sources (uber-shader), async pixel reader
src/render/        Renderer: progressive frame loop, passes, picking, overlays
src/Viewer.ts      public Viewer class implementing ViewerApi
src/index.ts       library entry (exports Viewer + types)
examples/          demo pages served by `npm run dev`
```

## Data model

**Fragment** = one placed mesh (geometry + material + transform + objectId). `FragmentList` holds
all fragments as SoA typed arrays indexed by fragment index (= MeshId): the GPU record
(`Float32Array`, `FRAG_FLOATS` per fragment, layout in `layout.ts`), world AABB (6 floats),
geometry id, objectId, CPU flags. Capacity grows by doubling; removed slots go on a free list.
Dirty ranges are tracked so the GPU data texture is updated with minimal `texSubImage2D` calls.

Everything per-object that can change at runtime (transform, visibility, selection, ghosting,
colour override, material) lives in the fragment record and is read by the vertex shader from the
fragment data texture. Changing any of it is a few floats written + a small texture upload; vertex
buffers are never touched.

**Geometry** is quantized on creation: positions to u16 inside the mesh's local AABB, normals to
2-byte octahedral. Identical geometry is deduplicated by content hash. The dequantization
scale/offset is copied into each fragment record.

**Materials** live in a data texture; one uber-shader handles all of them, so there are no
per-material state changes. Only opaque vs transparent matters for pass ordering.

## Consolidation: how draw calls stay low

Two drawing paths, same shader (fragment index arrives as a per-vertex or a per-instance attribute):

1. **Merged batches.** Geometry used by few fragments is copied into large shared vertex/index
   pages (`MERGED_VERTEX_STRIDE`), each vertex stamped with its fragment index. Fragments added
   together are sorted spatially (Morton order of AABB centre) and cut into batches of bounded
   size (target ~64k vertices). A batch is one contiguous index range in a page. Inside a batch,
   fragments are ordered largest-first, so a distant batch can be drawn with a shortened index
   count to drop its smallest members for free.
2. **Instanced chunks.** Geometry used by many fragments (threshold, e.g. >= 16 uses, or very large
   meshes) is stored once (`SHARED_VERTEX_STRIDE`) and drawn with `drawElementsInstanced`;
   the per-instance attribute is a u32 fragment index. Instances are grouped into spatially
   coherent chunks so they can be culled.

Each batch / chunk is a **draw item**: bounds, page, index range, instance range, opaque or
transparent. Draw items are stored SoA. Draw items in the same page share one VAO and are
submitted together with `WEBGL_multi_draw` when available (fallback: loop of draw calls).

Dynamic behaviour: `addMesh`/`addMeshes` queue fragments; the Batcher flushes the queue once per
frame into new batches (so adding 100k meshes in one tick yields a few dozen batches). Removal
clears the Visible flag immediately and records the hole; a time-sliced idle task compacts batches
with many holes and merges undersized batches. Transform changes update the fragment record and
grow/refit the owning draw item's bounds.

## Culling and ordering

A BVH is built over **draw items** (thousands, not millions), so it rebuilds in about a
millisecond whenever items change. Traversal per frame: frustum-cull subtrees, reject items whose
projected size is below the pixel threshold, emit items front-to-back with large-on-screen items
first. The traversal is resumable: it produces an ordered list once per camera pose and the
renderer consumes it over several frames.

## Progressive rendering

- Camera moving: each frame restarts, draws the ordered list until the frame budget is spent,
  presents. Frame rate is held; small/far detail is what gets dropped.
- Camera still: frames do not clear; each continues where the previous stopped and presents the
  accumulated image, until the list is exhausted (`frameComplete`). The still pass uses a finer
  pixel threshold.
- The budget is enforced through an adaptive triangles-per-frame estimate corrected by measured
  frame time (and `EXT_disjoint_timer_query_webgl2` when available), since GL calls are asynchronous.

Rendering goes to an offscreen target (colour + id + depth) that is blitted to the canvas, which is
what makes accumulation across frames possible.

## Picking and overlays

The id attachment stores fragment index + 1. `pick()` reads one pixel asynchronously (PBO +
`fenceSync`) plus depth to reconstruct the world position; no CPU raycast. Selection/hover tint and
ghosting are flag bits in the fragment record evaluated in the shader; selection outline is a
post-pass over the id buffer. Section planes are uniforms (max `MAX_SECTION_PLANES`) with
`discard` in the fragment shader. Transparent materials and ghosted fragments draw in a second,
blended pass that does not write ids for ghosted fragments.

## Quality bar

- Unit tests (Vitest, node environment) for everything that does not need a GL context.
- `npm run typecheck`, `npm test` and `npm run build` must pass.
- Target: 1M+ meshes / 50M+ triangles navigable at display refresh rate on a mid-range GPU.

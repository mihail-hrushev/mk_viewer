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
src/loaders/       model loader plugins: contract, registry, loadModel, glTF + OBJ plugins, scheduler
src/Viewer.ts      public Viewer class implementing ViewerApi (incl. model loading / federation)
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
   coherent chunks so they can be culled. Geometry of >= 1024 vertices that gets new users while
   others sit in merged batches (typically a second model sharing it) also switches to instancing,
   and the merged batches holding it are rebuilt, so shared geometry is stored on the GPU once.

Each batch / chunk is a **draw item**: bounds, page, index range, instance range, opaque or
transparent. Draw items are stored SoA. Draw items in the same page share one VAO and are
submitted together with `WEBGL_multi_draw` when available (fallback: loop of draw calls).

Dynamic behaviour: `addMesh`/`addMeshes` queue fragments; the Batcher flushes the queue once per
frame into new batches (so adding 100k meshes in one tick yields a few dozen batches). Removal
clears the Visible flag immediately and records the hole; a time-sliced idle task compacts batches
with many holes, merges undersized batches and moves batches out of sparse sealed pages so their GPU
buffers are released (e.g. after a model is unloaded). Transform changes update the fragment record
and grow the owning item's bounds at once; at the next flush the moved items are refitted exactly
(bounds also shrink), an item whose moved members drifted away from unmoved ones (an item shared by
two models, one re-placed) is split by re-batching moved and unmoved members apart, and many refits
at once rebuild the BVH. Bulk adds reuse runs of recycled fragment slots, so load / unload cycles
do not grow the slot range.

## Models and federation

`src/loaders/` holds the plugin contract, registry, `loadModel` and the built-in glTF / OBJ plugins
(see its README). `Viewer.load` runs a plugin through a tracking `LoadContext` and keeps the loaded
`Model`s: each owns disjoint objectId ranges from the viewer's single allocator (`allocObjectIds`,
starting at 2^30), so `getModelOf` is a binary search over a sorted run table. Per-model visibility,
isolation, bounds and fit go through `{ first, count }` objectId ranges (no per-object arrays);
`model.setTransform` re-places all meshes through the bulk `setTransforms` path from a snapshot of the
load-time matrices (no accumulated error). Unload removes meshes and releases geometry (ref-counted,
so geometry shared with another model stays) and materials (slots recycled once unused). Concurrent
loads share one FIFO scheduler (one slice per macrotask, round-robin) that is frame-paced in
browsers: all loads together get half the frame interval (8..50 ms) per animation frame, so each
frame batches and uploads a bounded amount of new content and the picture fills in progressively.
The first model is framed progressively while it loads (until the user moves the camera); later
models never move the camera unless asked.

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
`fenceSync`) plus depth to reconstruct the world position; no CPU raycast. Selection, hover and
ghosting are flag bits in the fragment record. Ghosting is evaluated in the scene shader (changing it
restarts the image). Selection/hover tint and the selection outline are a screen-space overlay
composited at present time from the id buffer + fragment flags, so changing them uploads the texture
row and re-presents the accumulated image without clearing or redrawing it; only pickable,
non-ghosted fragments already in the id buffer are tinted. Section planes are uniforms (max `MAX_SECTION_PLANES`) with
`discard` in the fragment shader. Transparent materials and ghosted fragments draw in a second,
blended pass that does not write ids for ghosted fragments.

## Quality bar

- Unit tests (Vitest, node environment) for everything that does not need a GL context.
- `npm run typecheck`, `npm test` and `npm run build` must pass.
- Target: 1M+ meshes / 50M+ triangles navigable at display refresh rate on a mid-range GPU.

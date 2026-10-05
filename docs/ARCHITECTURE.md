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
src/camera/        Camera (view/projection, perspective + ortho), OrbitControls (DOM wiring),
                   gestures.ts (DOM-free mouse/touch gesture recognizer), orbitMath, fit-to-bounds
src/primitives/    pure functions returning GeometryData (box, sphere, cylinder, cone, plane, torus, extrusion)
src/core/          CPU scene data: FragmentList, GeometryStore, MaterialStore, Batcher, DrawList BVH + traversal
src/gl/            thin WebGL2 layer: context/caps, Program, mirrored buffers, data textures, render targets,
                   GLSL sources (uber-shader), async pixel reader
src/render/        Renderer: progressive frame loop, passes, picking, overlays
src/loaders/       model loader plugins: contract, registry, loadModel, glTF + OBJ plugins, scheduler
src/plugins/       viewer plugin contract, overlay layer, built-in plugins (measure, color); public API only
src/ui/            optional built-in UI (toolbar, panels, context menu drawing); public API only
src/Viewer.ts      public Viewer class implementing ViewerApi (incl. model loading / federation)
src/index.ts       library entry (exports Viewer, loaders, primitives and the public types)
examples/          demo pages served by `npm run dev` (public API only; examples/index.html lists them)
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

**Lighting** is computed in view space: a camera-attached key light plus a sky / ground hemisphere.
Optional image-based lighting (`setEnvironment`) is a compile-time variant of the uber-shader
(`ENVIRONMENT`, so the default program stays bit-identical). It uses SH irradiance for diffuse and
an RGBA16F equirect map with a CPU-built, solid-angle-weighted mip chain (`EnvironmentTexture`,
sampled with `textureLod` by roughness) for specular. A per-image `u_envMatrix` maps view space to
the environment frame (world up -> +Y, plus `rotation`). The CPU side (`src/render/environment.ts`:
.hdr parser, `studio` preset, preparation) is pure and unit-tested.

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

**Batch groups.** Every fragment carries a `batchGroup` (`MeshParams.batchGroup`, default 0).
Fragments of different groups are never consolidated into the same draw item, and idle merging of
undersized items only merges within a group. `viewer.load` gives every model its own group, so a
model's items can be culled, re-placed and unloaded without rebuilding another model's batches.
Geometry shared between groups is still stored once (instanced, see above).

Dynamic behaviour: `addMesh`/`addMeshes` queue fragments; the Batcher flushes the queue once per
frame into new batches (so adding 100k meshes in one tick yields a few dozen batches). Removal
clears the Visible flag immediately and records the hole; a time-sliced idle task compacts batches
with many holes, merges undersized batches and moves batches out of sparse sealed pages so their GPU
buffers are released (e.g. after a model is unloaded). Transform changes update the fragment record
and grow the owning item's bounds at once; at the next flush the moved items are refitted exactly
(bounds also shrink), an item whose moved members drifted away from unmoved ones (e.g. part of an item's
meshes re-placed) is split by re-batching moved and unmoved members apart, and many refits
at once rebuild the BVH. Bulk adds reuse runs of recycled fragment slots, so load / unload cycles
do not grow the slot range. The per-flush scratch arrays (sort keys, queue) are released after a
flush of more than 2^18 fragments, so a one-off bulk add of millions does not keep ~28 bytes per
fragment of scratch alive.

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
  `src/render/BudgetController.ts`: multiplicative decrease on missed vsync / GPU or CPU overrun,
  cautious increase only while frames are budget-limited and on time, a soft ceiling at the last
  overrun. The measured GPU time is exposed as `stats.gpuMs`. On a discrete GPU (README, Performance)
  moving frames are rarely budget-limited; what is drawn while moving is set by frustum and
  `cullPixelSize` culling.

Rendering goes to an offscreen target (colour + id + depth) that is blitted to the canvas, which is
what makes accumulation across frames possible.

**Edge display** (`setEdges`) is screen-space and costs nothing while off. On, it adds an RG8 normal
attachment (`RenderTargets.setNormals`) written by an `EDGES` variant of the uber-shader (variants
are keyed by section planes / environment / edges): the octahedral view-space face normal from
`dFdx`/`dFdy` of the view position, so coplanar triangles share it exactly and diagonals vanish.
The 'all' and 'id' draw-buffer modes include it, so the transparent-id pass writes the normals of
the nearest transparent surface together with its depth and id. Lines are computed at present time
by the `EDGES` variant of `COMPOSITE_FS` from depth (as 1 / view depth, linear across planes, so a
step is compared with the steps beside it), normals (crease angle) and ids (touching meshes). A
crease between two pixels is dropped when a pixel beside the pair (another 4-neighbour, else a
diagonal one) holds a face within the crease angle of both: that pair only meets at a vertex
(diagonal facets of a tessellated smooth surface), which would otherwise leave isolated dots. Since
they are derived from whatever the targets hold when presenting, they are right on partial
progressive images and never accumulate; colour / angle changes only re-present. Near / far /
projection used for linearizing are snapshotted per image.

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

`snap()` (src/core/snap.ts) refines a pick on the CPU copy of the quantized geometry: the query
sphere is mapped into the mesh's u16 space as a box, triangles are rejected on raw u16 coordinates
(a lazily built uniform grid for meshes of 50k+ triangles, LRU-bounded), candidates are transformed
with the fragment matrix in float64 origin-relative space, and the nearest vertex / feature edge
(boundary or crease, adjacency by quantized end points) is chosen by its distance to the view ray.
Plugin overlays (measurement lines) are DOM over the canvas positioned with `worldToScreen` in the
`view` event, which the renderer's camera-change hook emits inside the frame before presenting.

## Viewer plugins and the context menu

Viewer plugins (`src/plugins/`, guide: [`PLUGIN_API.md`](PLUGIN_API.md)) are `{ name, install(context) }`
objects installed by `ViewerOptions.plugins` / `use()` and removed by `removePlugin()` or
`dispose()`. The context gives the public `ViewerApi`, the shared overlay layer and
`addContextMenuItem`; the viewer keeps the removers of what a plugin registered through its context
and runs them after the plugin's `dispose()`. Plugins use the public API only (built-in ones too).

The context menu is split in two. The viewer (DOM-free) owns the entries and the decision: a
`contextmenu` event that was not the end of a right-button pan (`controls.dragged`) and was not
consumed by the active tool is picked, selects the object under the pointer when it is outside the
selection (`autoSelect`, no tool), evaluates every entry's `visible` / `enabled` once and emits
`contextMenu` with the listed entries. The built-in UI's `ContextMenu` only draws such a request (in a
microtask, so any handler may `preventDefault()` to draw its own) and closes on outside press,
Escape, wheel, scroll and the `view` event. Nothing runs per frame.

## Input

`OrbitControls` only wires pointer events to `gestures.ts`, a DOM-free recognizer (unit tested in
node). Mouse/pen: left drag orbits, right/middle/shift+left drag pans, wheel zooms toward the cursor.
Touch: one finger orbits after leaving a tap slop circle (no jump), two fingers pan by the midpoint
and pinch-zoom about it (twist ignored), lifting one of two fingers continues as an orbit without a
jump. Taps (within slop and, for touch, a max duration) select; a double click / tap sets the orbit
pivot through a GPU pick. The canvas gets `touch-action: none`. Hover highlight is mouse/pen only.
An active tool (`setTool`, used by viewer plugins) receives taps instead of selection; the controls
then report double taps as taps (`doubleTapEnabled = false`) and the hover highlight is off.

## Quality bar

- Unit tests (Vitest, node environment) for everything that does not need a GL context.
- `npm run typecheck`, `npm test` and `npm run build` must pass.
- Target: 1M+ meshes / 50M+ triangles navigable at display refresh rate on a mid-range GPU.
  Measured numbers and their conditions are in the README (Performance); `examples/stress.html`
  has a reproducible benchmark (`?bench=1`, result in `window.benchmark`).
- Packaging: `vite build` (ESM + UMD, global `MKViewer`) and `tsc -p tsconfig.build.json`
  (declarations, `stripInternal`: members tagged `@internal`, such as `Viewer.renderer`, are reachable
  at runtime for diagnostics but are not part of the typed API). `examples/dist-usage/` loads both
  builds without a bundler.

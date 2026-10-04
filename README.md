# mk-viewer

A fast WebGL2 3D viewer library for very large scenes: millions of meshes, tens of millions of
triangles, and an API for creating, changing and removing geometry at runtime, every frame if you
want. Model formats load through plugins (glTF/GLB and OBJ are built in), and several models can be
loaded side by side (federation). Mouse, touch (pinch, taps) and pen all work.

**What it is:** a TypeScript library with zero runtime dependencies and no proprietary code or
formats. It is about 90 kB gzipped (ES module build). It renders opaque and transparent triangle
meshes with a PBR-style material (colour, metalness, roughness, emissive), GPU picking, selection,
isolation and ghosting, colour overrides and section planes.

**What it is not:** a game engine or a general scene graph. It draws triangles only: no textures,
lines, points, shadows or skinned animation. Materials are a colour plus a few parameters.

```
npm run dev     # then open http://localhost:5173/ (examples)
```

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [The scene API by task](#the-scene-api-by-task)
- [Loading models and federation](#loading-models-and-federation)
- [Writing a loader plugin](#writing-a-loader-plugin)
- [Controls](#controls)
- [Built-in toolbar and model tree](#built-in-toolbar-and-model-tree)
- [How it stays fast](#how-it-stays-fast)
- [Performance](#performance)
- [Limitations and known issues](#limitations-and-known-issues)
- [Development](#development)

## Install

The package is not on the npm registry yet. Build it, or install the tarball that `npm pack` makes:

```sh
npm run build && npm pack          # -> mk-viewer-0.1.0.tgz
npm install ./mk-viewer-0.1.0.tgz  # in your project
```

```ts
import { Viewer, gltfLoader } from 'mk-viewer';
```

The package holds `dist/mk-viewer.js` (ES module), `dist/mk-viewer.umd.cjs` (UMD, global
`MKViewer`), source maps and TypeScript declarations (`dist/types`).

**Without a bundler**, copy the built file next to your page. As an ES module
(from [`examples/dist-usage/esm.html`](examples/dist-usage/esm.html)):

```html
<script type="module">
  import { Viewer, gltfLoader } from '../../dist/mk-viewer.js';

  const viewer = new Viewer(document.getElementById('c'), { loaders: [gltfLoader] });
</script>
```

As a classic script (from [`examples/dist-usage/umd.html`](examples/dist-usage/umd.html)):

```html
<script src="../../dist/mk-viewer.umd.cjs"></script>
<script>
  var viewer = new MKViewer.Viewer(document.getElementById('c'));
</script>
```

## Quick start

From [`examples/quickstart.ts`](examples/quickstart.ts). The canvas just needs a CSS size; the
viewer follows it.

```ts
// The minimal mk-viewer scene. In your own project: import { Viewer } from 'mk-viewer';
import { Viewer } from '../src/index';

const canvas = document.querySelector('canvas')!;
const viewer = new Viewer(canvas); // y is up; orbit / pan / zoom / pick are built in

// Geometry is created once and can be placed any number of times.
const ground = viewer.primitives.plane(24, 24);
const box = viewer.primitives.box([1, 1, 1]);
const grey = viewer.createMaterial({ color: [0.75, 0.76, 0.78] });
const orange = viewer.createMaterial({ color: [0.95, 0.55, 0.15], roughness: 0.5 });
const glass = viewer.createMaterial({ color: [0.4, 0.65, 1, 0.35] }); // alpha < 1: transparent

viewer.addMesh({ geometry: ground, material: grey });

// Column-major 4x4 matrices: scale (sx, sy, sz), then translate (x, y, z).
const place = (x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
  [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1];

for (let i = 0; i < 10; i++) {
  for (let j = 0; j < 10; j++) {
    const h = 0.5 + ((i * 7 + j * 3) % 10) / 3;
    viewer.addMesh({ geometry: box, material: orange, transform: place(i * 2 - 9, h / 2, j * 2 - 9, 1, h, 1), objectId: i * 10 + j });
  }
}
viewer.addMesh({ geometry: box, material: glass, transform: place(0, 2.5, 0, 6, 5, 6) });

viewer.fitToView();
viewer.on('pick', (hit) => console.log(hit ? `picked object ${hit.objectId}` : 'picked nothing'));
```

### Examples

`npm run dev` serves them; [`examples/index.html`](examples/index.html) lists them. Each is one HTML
page plus one TypeScript file using only the public API.

| example | shows |
| --- | --- |
| [quickstart](examples/quickstart.ts) | the scene above |
| [dynamic](examples/dynamic.ts) | meshes created, moved, recoloured and removed every frame |
| [stress](examples/stress.ts) | `?n=3000000&m=100000`: millions of instanced + unique meshes, live stats, a benchmark |
| [models](examples/models.ts) | open / drop / `?url=` several glTF, GLB, OBJ files; per-model show, hide, isolate, fit, unload |
| [interaction](examples/interaction.ts) | selection events, isolate and ghosting, colour overrides, section planes, fit to selection |
| [custom-loader](examples/custom-loader.ts) | a ~60-line loader plugin for a made-up format ([blox-loader.ts](examples/blox-loader.ts)) |
| [dist-usage](examples/dist-usage/) | the built library without a bundler (run `npm run build` first) |

## The scene API by task

The full, commented API is [`src/types.ts`](src/types.ts) (`ViewerApi`, `ViewerOptions`,
`ViewerEvents`). Conventions: right-handed, y up by default (`new Viewer(canvas, { up: 'z' })` for
z up), 4x4 matrices column-major (glTF layout), colours sRGB in 0..1, angles in radians. Every call
below may be made at any time, including inside your own animation loop. You never need to request a
redraw.

### Geometry

`viewer.primitives` creates box, sphere, cylinder, cone, plane, torus and extrusion geometry. Your
own geometry is a triangle list (from [stress.ts](examples/stress.ts)):

```ts
const geometry = viewer.createGeometry(boxGeometry(1 + rnd() * 4, 2 + rnd() * 20, 1 + rnd() * 4));
```

`GeometryData` is `{ positions, indices?, normals? }`. Without `indices` the positions are separate
triangles, and missing normals are computed (flat without indices, smooth with them). The data is
copied and compressed at once, so you may reuse or drop your arrays. `releaseGeometry(id)` frees it
once no mesh uses it. The raw generators (`box`, `sphere`, ... `extrusion`, `triangulate`) are also
exported if you want the arrays themselves.

### Materials

```ts
const orange = viewer.createMaterial({ color: [0.95, 0.55, 0.15], roughness: 0.5 });
const glass = viewer.createMaterial({ color: [0.4, 0.65, 1, 0.35] }); // alpha < 1: transparent
```

`updateMaterial(id, params)` changes it for every mesh that uses it; `releaseMaterial(id)` retires it.

### Meshes and bulk instancing

`addMesh({ geometry, material, transform?, objectId? })` places a geometry and returns a `MeshId`.
To place one geometry many times, pass all matrices in one `addMeshes` call (from
[stress.ts](examples/stress.ts), which adds 3 million boxes this way):

```ts
if (N > 0) viewer.addMeshes({ geometry: viewer.primitives.box([1, 1, 1]), material: materials, transforms });
```

`transforms` holds 16 numbers per instance back to back (`Float32Array`, or `Float64Array` for
large coordinates). `material` is one id or one per instance, `objectIds` is optional. It returns the
first `MeshId`; the others follow consecutively.

### Updating and removing

From [dynamic.ts](examples/dynamic.ts), which does all of this every frame:

```ts
viewer.setTransforms(firstLink, links); // one call moves all 160 meshes (MeshIds firstLink..)
```

```ts
viewer.setTransform(pistons[k], m);
```

```ts
viewer.remove(b.mesh);
viewer.releaseGeometry(b.geometry); // freed now that no mesh uses it
```

`setMaterial(meshId, material)` reassigns a material; `getTransforms(first, count)` reads matrices
back; `clear()` removes everything.

### Object ids and per-object state

Every mesh carries an `objectId` (default: its `MeshId`), and picking, selection, visibility,
isolation and colour overrides work on objectIds. Give several meshes one objectId to make them act
as one object. From [interaction.ts](examples/interaction.ts), where a table is five meshes:

```ts
/** One object made of several meshes that share its objectId. */
function object(name: string, parts: { material: number; transform: number[]; geometry?: number }[]): number {
  const objectId = nextId++;
  names.set(objectId, name);
  for (const p of parts) viewer.addMesh({ geometry: p.geometry ?? unit, material: p.material, transform: p.transform, objectId });
  return objectId;
}
```

The per-object calls take one id, an array, or a `{ first, count }` range:

```ts
'isolate-ghost': () => viewer.isolate(sel()),
'isolate-hide': () => viewer.isolate(sel(), true),
```

```ts
viewer.setVisible(sel(), false);
```

```ts
viewer.setColor(sel(), palette[paint++ % palette.length]);
```

`setColor(ids, null)` restores the material colour, and a 4th component blends the override
(`[1, 1, 1, 0.7]` is 70 % white over the material). `showAll()` ends isolation and shows hidden
objects. Ids for your own data should not collide with loaded models: `allocObjectIds(n)` reserves a
range no model will receive (model ids start at 2^30).

### Selection, picking and events

Click / tap selection and hover highlight are built in (`autoSelect: false` turns them off). Events
(from [interaction.ts](examples/interaction.ts)):

```ts
viewer.on('pick', (hit) => note(hit ? `pick: ${names.get(hit.objectId)} at ${hit.position.map((v) => v.toFixed(2)).join(', ')}` : 'pick: background'));
viewer.on('hover', (hit) => ($('hover').textContent = hit ? `hover: ${names.get(hit.objectId)}` : ''));
```

`select(ids)` / `getSelection()` set and read the selection, and the `selection` event reports
changes. `await viewer.pick(x, y)` picks at canvas CSS pixels yourself. Other events: `camera`,
`frameComplete`, `modelLoaded`, `modelUnloaded`, `loadProgress`. `on()` returns an unsubscribe
function.

### Camera

```ts
viewer.setCamera({ eye: [24, 20, 26], target: [0, 6, 0] });
```

```ts
'fit-sel': () => viewer.fitToView(sel().length ? sel() : undefined, true),
```

`fitToView(ids?, animate?)` frames objects or the whole scene, `getCamera()` returns
`{ eye, target, up, fov, orthographic }`, and `getBounds(ids?)` returns world bounds.

### Section planes

Up to 6 planes. Geometry on the positive side of the normal is cut away (from
[interaction.ts](examples/interaction.ts)):

```ts
viewer.setSectionPlanes([{ normal, point }]);
```

### Stats

`viewer.stats` gives `fps`, `frameMs` (CPU), `gpuMs` (GPU time of the scene passes, when the browser
exposes timer queries), `meshes`, `triangles`, `drawItems`, `drawCalls`, `trianglesDrawn`, `progress`
(0..1 of the current image) and `gpuMemoryBytes`.

## Loading models and federation

Loader plugins are registered explicitly, so only the formats you import are bundled. From
[models.ts](examples/models.ts):

```ts
const viewer = new Viewer($<HTMLCanvasElement>('c'), {
  up: params.get('up') === 'y' ? 'y' : 'z',
  loaders: [gltfLoader, objLoader], // plugins are registered explicitly; only these are bundled
});
```

```ts
function load(input: string | File, files?: File[], x = 0): LoadTask {
  const task = viewer.load(input, {
    // a multi-file .gltf dropped together with its .bin files: resolve them by name
    resolve: files ? (uri) => files.find((f) => f.name === uri.split('/').pop()) : undefined,
    // placement: column-major matrix, here a shift by x along the x axis
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1],
  });
```

`load()` takes a URL, `File`/`Blob`, `ArrayBuffer` or `Uint8Array` and returns a `LoadTask`: a
promise of the `Model` with `abort()` and `onProgress()`. Content appears while it loads, and the
first model is framed automatically.

**Federation:** call `load` several times. Loads run concurrently and share the frame time. Each
model gets its own objectId range, so `hit.model` / `viewer.getModelOf(objectId)` tell which model
an object belongs to. The `transform` option above places a model (composed in float64, so
georeferenced coordinates keep their precision). The models page loads a URL list side by side
(`models.html?url=a.glb,b.glb&offset=160`):

```ts
(params.get('url') ?? '').split(',').filter(Boolean).forEach((url, k) => load(url, undefined, k * offset));
```

Each `Model` (see `src/loaders/types.ts`) has `stats`, `bounds`, a metadata `hierarchy` (node names,
parents), `getProperties(objectId)`, and `setVisible`, `isolate`, `fitToView`, `setTransform`,
`unload`. From [models.ts](examples/models.ts):

```ts
    row.append(
      vis,
      name,
      button('fit', () => m.fitToView(true)),
      button('isolate', () => m.isolate()),
      button('unload', () => m.unload()),
    );
```

The glTF plugin reads glTF 2.0 / GLB with `EXT_mesh_gpu_instancing` and `KHR_mesh_quantization`.
Textures are ignored. `createGltfLoader(options)` sets the objectId granularity and plugs in decoders
for compressed meshes.

## Writing a loader plugin

A plugin is an object with a `name`, `extensions`, an optional `canLoad` sniffer and an async
`load(source, ctx)` that builds the model through the `LoadContext` it gets. The context records what
the plugin creates, so `unload()`, abort and failure clean up by themselves. It also converts the up
axis, applies the user's placement, hands out objectIds and stores names and properties. The
complete example is [`examples/blox-loader.ts`](examples/blox-loader.ts) (a made-up text format,
~60 lines), registered like this in [custom-loader.ts](examples/custom-loader.ts):

```ts
viewer.registerLoader(bloxLoader);
```

The core of its loop:

```ts
        const objectId = ctx.allocObjectIds(1); // scene-unique id for picking / selection
        ctx.addMesh({
          geometry: unitBox,
          material,
          objectId,
          transform: [n[3], 0, 0, 0, 0, n[4], 0, 0, 0, 0, n[5], 0, n[0], n[1], n[2], 1], // model-local
        });
        ctx.hierarchy.addNode(root, name, objectId); // name shown on pick, part of model.hierarchy
```

The contract, the detection rules and a do/don't list are in
[`src/loaders/README.md`](src/loaders/README.md).

## Controls

| action | mouse / pen | touch |
| --- | --- | --- |
| orbit | left drag | one finger drag |
| pan | right or middle drag, shift + left drag | two finger drag |
| zoom | wheel (toward the cursor) | pinch (about the fingers' midpoint) |
| select | click (ctrl / shift + click toggles) | tap |
| clear selection | click on the background | tap on the background |
| zoom to object (3x its size away, becomes the orbit centre) | double click | double tap |
| hover highlight | move | (none) |

Keyboard: `W` / `S` move the camera forward / backward along the view direction, `A` / `D` shift it
left / right, `E` / `C` move it up / down along the world up axis; hold `Shift` to move four times faster. Speed follows the zoom level (the distance to
the orbit centre). The keys are read by physical position, so they work on any keyboard layout, and
only while the pointer is over the canvas or the canvas has focus.

Moving with the keys switches to first-person mode: a left drag then looks around from where the
camera stands instead of orbiting. Double click an object (or fit the view) to orbit again, around that object.

The canvas gets `touch-action: none`, so the page does not scroll or zoom under the viewer. Your page
should still use a viewport meta tag and keep its own controls finger-sized (see
`examples/shared.css`). `new Viewer(canvas, { controls: false })` turns the built-in controls off.

## Built-in toolbar and model tree

The viewer itself draws no UI. `createViewerUi` adds an optional overlay on the canvas: a toolbar at
the bottom centre and the model tree panel it opens.

```ts
import { Viewer, createViewerUi, gltfLoader } from 'mk-viewer';

const viewer = new Viewer(canvas, { loaders: [gltfLoader] });
const ui = createViewerUi(viewer);
ui.addButton({ label: 'Top', title: 'Top view', onClick: () => { /* your action */ } });
```

- **Tree** opens the node structure of every loaded model as the file defines it, with a filter by
  node name (case-insensitive; matches are shown with the path leading to them).
- Clicking a node selects its objects, including everything below it, and zooms the camera to them
  the same way a double click on an object does. Clicking a model row frames the model.
- Shift + click (or ctrl / cmd + click) on a node adds it to the selection, or removes it when it
  is already in; the camera then frames everything selected.
- Selecting objects on the canvas highlights their nodes and reveals the first one in the open tree.
- **Models** opens the models panel: open files (or drop them on the canvas), follow running loads
  with a cancel button, and show / hide, fit, isolate or unload each model. `ui.models.footer` is an
  empty container for your own content, and `ui.models.showError(text)` reports a failed load.
- Both panels are `.mkv-panel` windows: drag the header to move them; they stay inside the canvas.
  `new Panel(ui.element, { title, dock, height })` creates more of them for your own content.
- **Fit** frames the whole scene; **Show all** clears selection, hiding and isolation.
- A right click on the canvas (long press on touch) opens a menu with **Hide selected**,
  **Hide unselected** and **Show all**. Right-clicking an object that is not selected selects it
  first; a right-button drag still pans. Add your own entries with
  `ui.addMenuItem({ label, onClick: (selection) => ... })`.

Rows are virtualised, so trees with hundreds of thousands of nodes stay responsive. The styles are
injected under the `mkv-` class prefix; `ui.dispose()` removes everything.

## How it stays fast

The viewer keeps no object per mesh. Scene state lives in flat typed arrays. Meshes are merged into
a few hundred **draw items**: geometry used many times is drawn instanced, and geometry used a few
times is copied into large shared buffers. Draw items in one buffer go out in one multi-draw call. A
bounding volume hierarchy over the draw items culls what is off screen or smaller than a couple of
pixels. Vertex data is compressed (16-bit positions, 2-byte normals).

Rendering is progressive and has a time budget. While the camera moves, each frame draws the
nearest and largest items first until the frame budget is spent, so the frame rate holds and small
far-away detail drops out. When the camera stops, the following frames add the rest until the image
is complete (`frameComplete`). Then the viewer stops rendering. The budget adapts to the measured GPU
and CPU time.

What you can do to benefit:

- **Reuse geometry.** Create a shape once and place it many times. Each extra placement then costs a
  ~100-byte per-mesh record instead of another copy of the vertices.
- **Add in bulk.** One `addMeshes` with a million matrices is far cheaper than a million `addMesh`
  calls. Meshes added in one frame are batched together anyway, but per-call overhead remains.
- **Share objectIds** for meshes that form one object, and use `{ first, count }` ranges for
  per-object calls on large sets.
- **Avoid per-frame churn of visibility, colour and isolation on huge scenes.** Each change is cheap
  to apply, but it restarts the progressive image. On a scene that takes many frames to complete you
  would only ever see the partial image. Selection and hover do not restart it.
- **Transparency costs more.** Transparent meshes are drawn in a second, blended pass. While the
  camera moves only the nearest ones that fit the budget are drawn, and an image containing them has
  to restart instead of continuing.
- Keep `pixelRatio` at its default (at most 2) on high-density screens. Fill cost grows with the
  pixel count.

## Performance

Measured with [`examples/stress.html`](examples/stress.html) (`?bench=1` or the Benchmark button;
the result is in `window.benchmark`) and the same camera path driven on the
[models](examples/models.html) page for FactoryDemo. The path is one orbit around the scene in
8 s, zooming in to 30 % of the distance half-way. The first 0.5 s is not counted.

**Conditions:** Chrome 154 headless (`--headless=new --use-angle=d3d11 --force_high_performance_gpu`),
WebGL renderer `ANGLE (NVIDIA, NVIDIA RTX 2000 Ada Generation Laptop GPU (0x000028B8) Direct3D11
vs_5_0 ps_5_0, D3D11)`, Intel Core i9-13900H, Windows 11. Canvas 1920x1080, device pixel ratio 1.
Each scene ran in a fresh browser. Headless Chrome paces `requestAnimationFrame` to 60 Hz (measured
60.5 Hz), so frame intervals can only show whether 60 fps was held, never more. The GPU and CPU
columns show the actual cost per frame against that 16.7 ms. GPU time comes from
`EXT_disjoint_timer_query_webgl2` and covers the scene passes, not the final compositing.
FactoryDemo is a 262 MB GLB (40,098 meshes, 9.46M triangles), served from localhost, so its load
time includes the transfer and parsing.

| scene | meshes / triangles | load (build) | first pixels | first complete image | frame interval while moving min / median / p95 | GPU ms median / p95 | CPU ms median / p95 | drawn while moving (median): items / calls / triangles | complete after stop | GPU memory | JS heap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stress 100k instanced + 100k unique | 200k / 2.4M | 561 ms | 741 ms | 826 ms | 16.4 / 16.7 / 16.8 | 3.1 / 6.8 | 0.2 / 0.4 | 90 / 46 / 2.07M | 16 ms | 146 MB | 221 MB |
| stress 1M instanced + 100k unique | 1.1M / 13.2M | 616 ms | 912 ms | 1.04 s | 16.3 / 16.7 / 16.8 | 4.2 / 4.6 | 0.3 / 0.5 | 237 / 193 / 4.12M | 34 ms | 314 MB | 492 MB |
| stress 3M instanced + 100k unique | 3.1M / 37.2M | 1.01 s | 1.68 s | 2.04 s | 16.4 / 16.7 / 16.8 | 3.2 / 4.4 | 0.4 / 0.8 | 176 / 134 / 2.75M | 67 ms | 514 MB | 816 MB |
| FactoryDemo.glb | 40k / 9.46M | 1.82 s | 531 ms | 1.84 s | 16.4 / 16.7 / 16.9 | 5.0 / 5.8 | 0.4 / 0.6 | 437 / 335 / 8.30M | 17 ms | 346 MB | 482 MB |
| FactoryDemo.glb loaded twice (federation) | 80k / 18.9M | 3.5 to 4.5 s | 868 ms | 4.58 s | 16.4 / 16.7 / 16.8 | 5.2 / 6.2 | 0.9 / 1.9 | 881 / 848 / 7.0M | 31 ms | 314 MB | 912 MB |

How to read it: 60 fps held in every case with the GPU at roughly a third of the frame. For the
stress scenes, "build" is the time of the JavaScript API calls that create the scene. JS heap was
read after a forced garbage collection. Two copies of FactoryDemo use less GPU memory than one: the
second copy reuses the geometry, which is then switched to instanced drawing and stored once. The
federation load time varied between 3.46 s and 4.49 s over two runs. While moving, the triangles
drawn are a subset of the scene. The rest is off screen or below 2 pixels (`cullPixelSize`). On this
GPU the frame budget almost never cut a frame short (6 of 480 frames in the 3M scene). The still
image uses a 0.5-pixel threshold.

These numbers come from one discrete laptop GPU. Integrated and mobile GPUs will be slower; the
renderer then drops more detail while moving and needs more frames to complete the image. Nothing
here was measured on a phone or tablet.

## Limitations and known issues

- **Large coordinates.** Coordinates around 1e7 (georeferenced) work: the scene is rendered relative
  to a float64 origin picked from the first mesh. Meshes far from that origin are shifted rigidly by
  float32 rounding: up to 1 mm within 1.6e4 units, 4 mm at 1e5, 31 mm at 1e6. Keep federated models
  within ~1e5 units of each other.
- **CPU memory.** The viewer keeps CPU copies of its GPU buffers (for compaction and WebGL context
  restore) plus about 160 bytes of state per mesh. For FactoryDemo that is 322 MB of the 482 MB JS
  heap. For 3 million meshes the heap is about 0.8 GB.
- **Transparent content restarts the image.** A progressive image that contains blended
  (transparent or ghosted) content cannot be continued after new content arrives, so it is redrawn
  from scratch.
- **Objects not yet drawn are not pickable.** Picking reads the GPU id buffer of the image on screen.
  While a heavy image is still being refined, small objects that are not drawn yet cannot be picked
  or hovered.
- **No textures, lines or points.** Triangles with per-material colour only.
- **Compressed glTF.** Draco and meshopt compressed glTF files need a decoder plugged into
  `createGltfLoader({ primitiveDecoders })`. None is bundled (zero dependencies). Without one, the load
  fails with an error that names the missing extension.
- **Browser support.** WebGL2 is required, with `MAX_TEXTURE_SIZE` of at least 3072 (per-mesh data
  lives in a 3072-texel-wide texture). The constructor throws with a clear message otherwise.
  `WEBGL_multi_draw` and GPU timer queries are used when present. Tested in desktop Chrome
  (hardware and SwiftShader) with touch emulation. Safari, Firefox and real mobile devices have not
  been measured.
- The ES module build is not minified (310 kB, 89 kB gzipped); your bundler minifies it. The UMD
  build is minified (214 kB, 70 kB gzipped).

## Development

```sh
npm run dev        # Vite dev server: examples at http://localhost:5173/
npm test           # unit tests (Vitest, node)
npm run typecheck  # tsc --noEmit
npm run build      # dist/: ES module + UMD + source maps + d.ts
```

Architecture notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Loader plugins:
[`src/loaders/README.md`](src/loaders/README.md).

## License

MIT, see [LICENSE](LICENSE).

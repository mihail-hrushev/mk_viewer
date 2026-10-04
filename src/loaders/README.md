# Model loader plugins

Model formats are loaded by plugins, so every application can add or replace loaders for its own
formats and workflows. A plugin turns bytes into viewer content using **only** the `LoadContext`
it is given. The context wraps `ViewerApi` and handles bookkeeping that every loader would otherwise
repeat: unload, abort cleanup, objectIds, metadata, up-axis and global transforms, progress, bounds.

```ts
import { loadModel, registerDefaultLoaders, defaultRegistry } from 'mk-viewer';

registerDefaultLoaders();                  // glTF (.glb/.gltf) + OBJ; or defaultRegistry.register(gltfLoader)
defaultRegistry.register(myIfcLoader);     // your own format

const task = loadModel(viewer, fileOrUrlOrBuffer, { up: 'z', onProgress: (p) => bar(p.fraction) });
cancelButton.onclick = () => task.abort(); // the scene is left clean
const model = await task;                  // Model: stats, bounds, hierarchy, getProperties, unload()
```

## The contract (`types.ts`)

```ts
interface LoaderPlugin<O> {
  name: string;                       // 'ifc'
  extensions: string[];               // ['ifc', 'ifc.gz']
  mimeTypes?: string[];
  up?: 'y' | 'z';                     // native up axis; the context converts, not you
  canLoad?(probe: { fileName?; mimeType?; header: Uint8Array }): boolean;  // cheap sniffing
  load(source: LoaderSource, ctx: LoadContext<O>): Promise<void | { name?; info? }>;
}
```

Detection order: `options.loader` > file extension (the longest match wins, then the most recent
registration) > mime type > `canLoad` on the first 256 bytes. If several plugins claim an extension,
`canLoad` decides. Registering a plugin with the same `name` replaces the old one.

`LoaderSource` gives the same access whatever the input is (URL, File/Blob, ArrayBuffer, Uint8Array):
`bytes()` (no copy for in-memory inputs), `text()`, `stream()`, `readRange()`, and `resolve(uri)`
for sibling files (`data:` URIs, URL-relative paths, or `LoadOptions.resolve` for dropped files).
Download progress is reported for you.

`LoadContext` gives you:

| member | purpose |
| --- | --- |
| `createGeometry / createMaterial / addMesh / addMeshes` | tracked versions of the `ViewerApi` calls: the model owns what they create |
| `allocObjectIds(n)` | scene-unique objectIds (meshes without an objectId get a fresh one automatically) |
| `hierarchy.addNode(parent, name?, objectId?)`, `hierarchy.addNodes(parents, objectIds?, nameFn?)` | metadata tree stored in columns; names can be resolved lazily |
| `setProperties(objectId, props)`, `setPropertyProvider(fn)` | sparse explicit properties, or lazy lookup |
| `shouldYield() / yield() / yieldIfNeeded()` | cooperative time slicing (default 8 ms per slice) |
| `progress(f, stage)`, `warn(msg)`, `signal`, `throwIfAborted()` | reporting and cancellation |
| `options` | your plugin's typed options (`loadModel(..., { options })`) |
| `rootTransform` | the global transform + up conversion the context applies (read-only) |

## Minimal skeleton

```ts
import type { LoaderPlugin } from 'mk-viewer';

export const xyzLoader: LoaderPlugin<{ scale: number }> = {
  name: 'xyz',
  extensions: ['xyz'],
  up: 'z',
  canLoad: ({ header }) => header[0] === 0x58,
  async load(source, ctx) {
    const bytes = await source.bytes();
    const parts = parse(bytes);                         // your parser
    const material = ctx.createMaterial({ color: [0.7, 0.7, 0.7] });
    const firstId = ctx.allocObjectIds(parts.length);
    const root = ctx.hierarchy.addNode(-1, source.name);
    for (let i = 0; i < parts.length; i++) {
      const geometry = ctx.createGeometry({ positions: parts[i].positions, indices: parts[i].indices });
      ctx.addMesh({ geometry, material, transform: parts[i].matrix, objectId: firstId + i });
      ctx.hierarchy.addNode(root, parts[i].name, firstId + i);
      if (ctx.shouldYield()) { ctx.progress(i / parts.length); await ctx.yield(); }
    }
  },
};
```

`obj/ObjLoader.ts` is a complete commented example to start from. `gltf/GltfLoader.ts` shows how
to load large files: zero-copy views, instancing, and columnar metadata.

## Do

- **Yield.** Call `await ctx.yieldIfNeeded()` in every loop that can run long, or
  `if (ctx.shouldYield()) await ctx.yield()` in very hot loops. The page stays responsive and the
  viewer can show partly loaded content while you load.
- **Let abort errors propagate.** `yield()` throws an `AbortError` after `task.abort()`. Do not
  catch and ignore it: the context removes everything you added. Pass `ctx.signal` to your own
  `fetch` and worker calls.
- **Reuse geometry.** Call `createGeometry` once per unique shape and place it many times with
  `addMesh`/`addMeshes`. The viewer then draws it instanced. If one geometry has many placements,
  use one `addMeshes` call with all its matrices.
- **Compose transforms in float64.** Pass `Float64Array` matrices so georeferenced coordinates
  survive. The viewer rebases them to a local origin. Matrices are column-major.
- **Use `allocObjectIds`** for picking/selection ids. Choose the granularity that matters to users
  (e.g. one id per building element, not per triangle strip), and link ids to hierarchy nodes so
  `model.getProperties(id)` and the tree work.
- **Store metadata compactly.** Use `hierarchy.addNodes` with a parent array and a lazy name callback
  over data you already have. Do not create one JS object per node.
- **Pass typed-array views** to `createGeometry` instead of copies. The viewer copies and quantizes
  the data at once, so views on the file buffer are safe and avoid doubling memory.
- **Declare `up`** and let the user's `LoadOptions.up/transform` do the rest.

## Don't

- Don't call `ctx.viewer.addMesh` etc. directly. Content created that way is not tracked, so
  `unload()` and abort cleanup can't remove it. Use `ctx.viewer` only for queries.
- Don't keep references to the file buffer after `load()` resolves, for example in property
  providers. Keep only what lookups need.
- Don't convert axes or apply the user transform yourself.
- Don't throw for recoverable problems in big files. Skip the bad part and `ctx.warn()` once per
  kind of problem, not once per element.
- Don't hold module-level state in the plugin object. One plugin instance can serve several
  concurrent loads.

# Writing viewer plugins

This guide is for developers who want to add their own tools, overlays, menu entries or panels to
mk-viewer. It assumes you have read the [README](../README.md) and know the `ViewerApi` from there;
it does not assume you have read the source. Everything below is what the code does today.

A **viewer plugin** adds behaviour to a running viewer and lives as long as the viewer (or until it
is removed). It is not a **loader plugin**: a loader plugin turns a file format into viewer content
during `viewer.load()` and has its own contract, described in
[`src/loaders/README.md`](../src/loaders/README.md).

Contents

- [The contract](#the-contract)
- [Lifecycle](#lifecycle)
- [What a plugin can use](#what-a-plugin-can-use)
  - [Events](#events)
  - [Picking and selection](#picking-and-selection)
  - [Per-object state and colour overrides](#per-object-state-and-colour-overrides)
  - [The context menu](#the-context-menu)
  - [Tools: taking over clicks](#tools-taking-over-clicks)
  - [Snapping](#snapping)
  - [Overlays: DOM over the canvas](#overlays-dom-over-the-canvas)
  - [The built-in UI](#the-built-in-ui)
  - [Models](#models)
- [Rules](#rules)
- [Walkthrough: the colour plugin](#walkthrough-the-colour-plugin)
- [A larger example: the measurement plugin](#a-larger-example-the-measurement-plugin)

## The contract

A plugin is an object with a `name` and an `install` function. Plugins are usually made by a
factory that takes options, so the same plugin can be configured per application:

```ts
import type { PluginContext, PluginInstance, ViewerPlugin } from 'mk-viewer';

interface ViewerPlugin<T extends PluginInstance = PluginInstance> {
  readonly name: string;                     // unique per viewer
  install(context: PluginContext): T | void; // called once, when the plugin is installed
}

interface PluginContext {
  readonly viewer: ViewerApi;                // the whole public viewer API
  readonly name: string;                     // the plugin's name
  overlay(): HTMLElement;                    // shared DOM layer over the canvas, created on first call
  addContextMenuItem(item: ContextMenuItem): () => void; // menu entry owned by the plugin
}

interface PluginInstance {                   // what install returns: your own API plus two hooks
  ui?(ui: ViewerUi): void | (() => void);    // the built-in UI exists: add toolbar buttons
  dispose?(): void;                          // removePlugin() or viewer.dispose()
}
```

`install` returns the plugin's **instance**: any object you like (your plugin's public API), which may
also carry the two optional hooks. Returning nothing is allowed; the instance is then `{}`.

The smallest useful plugin:

```ts
import type { ViewerPlugin } from 'mk-viewer';

export function pickLogPlugin(): ViewerPlugin {
  return {
    name: 'pick-log',
    install({ viewer }) {
      const off = viewer.on('pick', (hit) => console.log(hit ? `picked ${hit.objectId}` : 'background'));
      return { dispose: off };
    },
  };
}
```

## Lifecycle

**Registering.** An application installs plugins when it creates the viewer, or later:

```ts
import { Viewer, createViewerUi, colorPlugin, measurePlugin, type MeasurePlugin } from 'mk-viewer';

const viewer = new Viewer(canvas, { plugins: [measurePlugin(), colorPlugin()] }); // in this order
createViewerUi(viewer);                                         // optional built-in UI
const measure = viewer.getPlugin<MeasurePlugin>('measure')!;     // a plugin's own API
viewer.use(pickLogPlugin());                                    // later: returns the instance
viewer.plugins;                                                 // ['measure', 'color', 'pick-log']
viewer.removePlugin('pick-log');                                // uninstall; true when it was installed
```

**Install.** `install(context)` runs once, synchronously, during `new Viewer(...)` (at the end of
construction, after edges / environment options were applied) or during `viewer.use()`. The scene
may be empty and the built-in UI may not exist yet. Subscribe to events, prepare state, return your
API. Then the viewer emits `pluginInstalled`.

- A second plugin with the same name throws. A plugin without a string `name` or an `install`
  function throws a `TypeError`.
- If `install` throws, the plugin is not installed and the error is rethrown as
  `mk-viewer: viewer plugin '<name>' failed to install: <message>` (with `cause`). Context menu
  entries the plugin added through its context are removed again; anything else (event
  subscriptions, DOM, scene changes) you must undo yourself before throwing. During
  `new Viewer(...)` the half-built viewer is then disposed (earlier plugins are disposed in reverse
  order) and the constructor throws; with `use()` the viewer stays usable.

**UI hook.** If the instance has `ui(ui)`, the built-in UI (`createViewerUi`) calls it when the UI is
created, or right away if the UI already exists when the plugin is installed. Errors in it are
logged, not thrown. It may return a cleanup function.

**Removal.** `viewer.removePlugin(name)`:

1. removes the plugin from `viewer.plugins` (`getPlugin(name)` is then undefined, and the name can be
   installed again),
2. calls the instance's `dispose()` (errors are logged),
3. removes the context menu entries added with `context.addContextMenuItem`,
4. emits `pluginRemoved` `{ name, instance }`; the built-in UI then calls the cleanup your `ui()`
   hook returned.

**Viewer disposal.** `viewer.dispose()` disposes all plugins in reverse install order (steps 2 and 3
above, no `pluginRemoved` event) while the viewer still works, then ends the active tool and removes
the overlay layer. `ui.dispose()` calls every `ui()` cleanup.

So `dispose()` must undo everything the plugin did that the viewer does not track for it: event
subscriptions, its active tool, its DOM, toolbar buttons (in case the UI outlives the plugin), and
scene changes that should not outlive it.

## What a plugin can use

`context.viewer` is the complete public `ViewerApi` (`src/types.ts`; the README describes it by
task). There is no separate, smaller plugin API: a plugin can do anything an application can. The
parts plugins typically need are below.

### Events

`viewer.on(event, handler)` returns an unsubscribe function. Handler errors are caught and logged.

| event | payload | when |
| --- | --- | --- |
| `pick` | `PickResult \| null` | a click / tap selected (or hit the background); not while a tool is active |
| `hover` | `PickResult \| null` | the object under the mouse / pen changed (only with `autoSelect` or a listener) |
| `selection` | `number[]` | the selection changed (`select`, clicks, the tree, right click) |
| `camera` | `CameraState` | the camera moved (world coordinates) |
| `view` | `{ width, height }` | camera or canvas size changed; inside the animation frame, before the image is shown |
| `frameComplete` | `ViewerStats` | the progressive image is complete |
| `modelLoaded` / `modelUnloaded` | `Model` | a `viewer.load()` finished / a model was unloaded |
| `loadProgress` | `ViewerLoadProgress` | progress of a running load |
| `environment` | `EnvironmentInfo \| null` | the lighting environment changed |
| `pluginInstalled` / `pluginRemoved` | `{ name, instance }` | a viewer plugin was installed / removed |
| `contextMenu` | `ContextMenuRequest` | a context menu was requested (see below) |

### Picking and selection

- `await viewer.pick(x, y)` reads the GPU id buffer at canvas CSS pixel (x, y): `{ meshId,
  objectId, model?, position, distance }` or null. It reflects the image on screen, so objects the
  progressive renderer has not drawn yet are not pickable. It resolves a frame or two later.
- `viewer.select(objectIds)`, `viewer.getSelection()` (a copy), the `selection` event.
- Clicks select by themselves (`autoSelect`, default on). Ctrl / shift click toggles.

Selection, picking, visibility and colours all work on **objectIds**. One object may consist of many
meshes; every per-object call affects all of them.

### Per-object state and colour overrides

```ts
viewer.setColor(ids, [1, 0, 0]);        // override the colour of every mesh of these objects
viewer.setColor(ids, [1, 1, 1, 0.3]);   // 4th value: blend strength over the material (not opacity)
viewer.setColor(ids, null);             // remove the override: material colour again
viewer.getColor(objectId);              // [r, g, b, strength] or null when there is no override
viewer.getColoredObjects();             // every object with an override, whoever set it
viewer.clearColors();                   // remove every override
viewer.setVisible(ids, false);
viewer.isolate(ids);                    // ghost everything else (isolate(ids, true) hides it)
viewer.showAll();
viewer.getBounds(ids);                  // world bounds, float64
viewer.zoomToObjects(ids);              // what a double click does
```

`ids` is one objectId, an array (or typed array) of them, or a `{ first, count }` range (e.g. a
model's). Colours are sRGB 0..1. A colour override is stored in the per-mesh GPU record, so it costs a
few float writes and a small texture upload however many meshes there are; it works the same for
merged and instanced geometry, keeps transparent materials transparent, and stays through
progressive redraws. There is one override per mesh: a later `setColor` replaces an earlier one,
whoever set it. The viewer remembers which objects have an override, so a plugin can see colours
it did not set: `getColoredObjects()` lists them in the order they were first coloured (only
objects that still have meshes, exactly those for which `getColor` is not null). Before applying
its own colouring a plugin can reset them all with `clearColors()`, or save them with `getColor`
and restore them afterwards. Selection and hover are drawn as a tint over it, so a selected red object looks
red-violet until it is deselected.

### The context menu

The viewer collects context menu entries; the built-in UI draws them. A **right click that is not
the end of a right-button pan** (and a long press on touch, where the browser reports one as a
`contextmenu` event) opens the menu:

1. If a tool is active and its `onContextMenu` returns true, the right click is consumed and nothing
   else happens.
2. The viewer picks under the pointer. If the object there is not selected, it becomes the selection
   (only with `autoSelect` and no active tool). Right-clicking inside the selection or on the
   background keeps the selection.
3. Every entry's `visible` and `enabled` are evaluated with the resulting `ContextMenuContext`, and
   the `contextMenu` event is emitted with the listed entries.
4. The built-in UI shows them (unless a handler called `preventDefault()`), and closes the menu on a
   press outside it, Escape, wheel, page scroll, camera movement or canvas resize.

A plugin adds entries through its context, so they disappear with the plugin:

```ts
const remove = context.addContextMenuItem({
  label: 'Hide',
  order: 0,                                   // optional: sort key and group, default 0
  visible: (c) => c.hit !== null,             // optional: only when an object was right-clicked
  enabled: (c) => c.selection.length > 0,     // optional: listed but greyed out otherwise
  onClick: (c) => viewer.setVisible(c.selection, false),
});
remove(); // optional: removes it earlier
```

The callbacks receive the same `ContextMenuContext` for one menu:

```ts
interface ContextMenuContext {
  readonly x: number;                 // canvas CSS pixels of the right click
  readonly y: number;
  readonly pointerType: string;       // 'mouse' | 'pen' | 'touch'
  readonly hit: PickResult | null;    // the object under the pointer (null: background)
  readonly selection: readonly number[]; // what the menu acts on (objectIds), possibly empty
}
```

- Entries are sorted by `order`, equal orders in registration order. Equal orders form a group; the
  built-in menu draws a line between groups. The built-in UI's own entries (Hide selected, Hide
  unselected, Show all) use -100, so plugin entries (default 0) come after them.
- `visible` and `enabled` run once per opened menu, synchronously. Keep them cheap (a selection of a
  million objects is possible) and free of side effects. Errors are logged and hide / disable the
  entry; an error in `onClick` is logged.
- `onClick` runs after the menu closed.
- Without the built-in UI the entries still exist; the application draws them from the
  `contextMenu` event (below). Applications use `viewer.addContextMenuItem(item)` for their own
  entries (same item type, removed only by the returned function).

**Drawing your own menu.** An application (or a plugin providing a different menu look) handles the
`contextMenu` event, calls `preventDefault()` synchronously to keep the built-in menu from showing,
and runs the chosen entry:

```ts
viewer.on('contextMenu', (req) => {
  req.preventDefault();
  myMenu.show(req.x, req.y, req.items.map((e) => ({ text: e.label, disabled: !e.enabled, choose: () => e.run() })));
});
```

`viewer.openContextMenu(x, y)` opens the menu from code (for example from a keyboard shortcut) as a
right click at that point would, and resolves with the request (or null if a newer one superseded
it). The older `ui.addMenuItem({ label, onClick: (selection) => ... })` of the built-in UI still
works and maps onto the same mechanism.

### Tools: taking over clicks

A plugin that needs the clicks (measure, place, cut) makes itself the **active tool**:

```ts
import type { ViewerTool } from 'mk-viewer';

const tool: ViewerTool = {
  name: 'place',
  cursor: 'crosshair',                          // default 'crosshair'
  onTap(x, y, info) { /* a click / tap, never the end of a drag; info.pointerType, info.modifier */ },
  onPointerMove(x, y, info) { /* mouse / pen hover, no button pressed */ },
  onPointerLeave() { /* left the canvas, or a camera drag started */ },
  onEscape() { return false; },                 // true: handled, the tool stays active
  onContextMenu(x, y) { return false; },        // true: consumed, no context menu
  onDeactivate(reason) { /* 'api' | 'replaced' | 'escape' | 'dispose' */ },
};
viewer.setTool(tool);   // viewer.setTool(null) ends it; viewer.getTool() is the active one
```

While a tool is active, clicks go to `onTap` instead of selecting, double click does not zoom (both
clicks arrive as taps), the hover highlight is off and the cursor is the tool's. Camera navigation
keeps working. Only one tool is active: activating another calls the previous one's
`onDeactivate('replaced')`, and Escape ends it unless `onEscape` returns true (an open context menu
takes the Escape first). Keep your own "active" flag in sync through `onDeactivate`.

### Snapping

`await viewer.snap(x, y, { pointerType })` picks and then moves the point to the nearest vertex, else
the nearest feature edge (boundary or crease), else keeps the surface point, within a screen
tolerance (12 CSS px, 24 for touch). The result is a `PickResult` plus `kind` (`'vertex' | 'edge' |
'surface'`), `hit` (the raw surface point) and, for edges, the edge's end points. Positions are
float64 world coordinates. Options: `radius`, `vertices`, `edges`, `edgeAngle`.

### Overlays: DOM over the canvas

- `context.overlay()` returns a pointer-transparent element covering the canvas, shared by all
  plugins and created on first call. It follows the canvas rectangle and lies below the built-in UI.
  Give elements that should receive input `pointer-events: auto`. Remove your own children in
  `dispose()`; the layer itself goes away with the viewer.
- `viewer.worldToScreen(point, out?)` projects a float64 world point to canvas CSS pixels with depth,
  `inFront` and `inView`; pass a reused `out` object to avoid allocation.
- Reposition overlay DOM in the `view` event: it fires inside the animation frame whenever the camera
  moves or the canvas is resized, before that frame is shown, and never while idle.

### The built-in UI

The UI is optional (`createViewerUi(viewer)`) and created after the viewer, so never assume it
exists. Put toolbar code in the `ui(ui)` hook:

- `ui.addToggle({ label, title, onClick })` returns `{ element, on, remove() }`: a toolbar button
  whose on / off look you set (`toggle.on = active`).
- `ui.addButton({ label, title, onClick })` for plain actions (returns the `<button>`).
- `ui.element` is the UI overlay; `new Panel(ui.element, { title })` makes a movable, resizable
  panel (`resizable: false` drops the footer grip).
- Return a function that removes what you added. It runs on `ui.dispose()` and when the plugin is
  removed; call it from `dispose()` as well, in case the plugin is disposed without the UI knowing.

### Models

`viewer.models`, `viewer.getModelOf(objectId)`, `viewer.groupByModel(ids)`, the `modelLoaded` /
`modelUnloaded` events, and per model `name`, `bounds`, `objectIdRange`, `hierarchy` (node names and
structure), `getProperties(objectId)`, `setVisible`, `isolate`, `fitToView`, `setTransform`,
`unload`. Every loaded model owns its own
objectId ranges, so per-object calls never mix models up.

Properties are searchable. `viewer.findObjects(query)` searches every loaded model and returns
`objectIds` (sorted, ready for `select`, `isolate`, `setColor`, `fitToView`), `hits` for list
queries and the per-model `matches`; `viewer.propertyKeys()` lists the keys there are. Per model,
`model.properties` has the same `find(query)` plus `keys()`, `values(key)` and `objectsUnder(node)`,
and `model.hierarchy.properties(node, inherited)` reads one node's properties (with `inherited`,
merged with its ancestors'). A query is `{ key, equals | in | startsWith | matches | min / max,
caseSensitive? }`; the README section [Properties and search](../README.md#properties-and-search)
has the details. Colouring every fabrication part:

```ts
const { objectIds } = viewer.findObjects({ key: 'Category', equals: 'FABRICATION' });
viewer.setColor(objectIds, [0.1, 0.6, 1]);
```

## Rules

**Public API only.** Import only from the package entry (`'mk-viewer'`; inside this repository
`src/index.ts` or the public type modules). Do not import from `src/core`, `src/gl` or `src/render`,
and do not use members of `Viewer` tagged `@internal` (`renderer`, `scene`, `camera`, `ctx`,
`controls`, ...): they are not in the published typings and change without notice. If you need
something that is not public, that is a gap in the plugin API; report it rather than reaching in.

**Clean up.** In `dispose()`:

- call every unsubscribe function `viewer.on` returned;
- end your tool (`if (viewer.getTool() === tool) viewer.setTool(null)`);
- remove your DOM (overlay children, toolbar buttons via your `ui()` cleanup);
- undo scene state that belongs to the plugin (section planes, temporary colours, isolation) unless
  it is the user's work that should stay (the colour plugin keeps the colours it applied).

Context menu entries added with `context.addContextMenuItem` are removed for you.

**Hot paths.** Handlers of `view`, `hover`, `onPointerMove` and the like run per frame or per pointer
event. Do not allocate there (reuse arrays and the `out` argument of `worldToScreen`), do not call
`invalidate()` to animate your own DOM (follow `view` instead), and keep at most one async `pick` /
`snap` in flight per purpose (drop results that arrive after the state they were for). Do not keep a
JS object per scene object: work with objectId arrays, typed arrays and `{ first, count }` ranges.

**World coordinates.** Use float64 world coordinates in your data and API, as the viewer does. The
viewer handles its internal origin for large (georeferenced) coordinates.

**Errors.** The viewer catches and logs errors thrown from your event handlers, tool callbacks, menu
callbacks and `ui()` hook, so one plugin cannot break another. Errors in `install` are thrown.

## Walkthrough: the colour plugin

`colorPlugin` (`src/plugins/color/colorPlugin.ts`, exported from the package) is deliberately small:
it adds **Red** and **Reset colour** to the context menu. The user right-clicks an object (it becomes
the selection), chooses **Red**, and the object turns red; **Reset colour** gives it its material
colour back, or, when no coloured object is selected any more, removes every colour override in
the viewer (`viewer.clearColors()`), whoever set it.
Here is the whole plugin:

```ts
import type { Color, ContextMenuContext, PluginInstance, ViewerPlugin } from 'mk-viewer';

export interface ColorPluginOptions {
  name?: string;              // default 'color'
  color?: Color;              // default [1, 0, 0]
  label?: string;             // default 'Red'
  resetLabel?: string | null; // default 'Reset colour'; null: no reset entry
  order?: number;             // menu group of both entries, default 0
}

export interface ColorPlugin extends PluginInstance {
  readonly color: Color;
  apply(objectIds?: ArrayLike<number>): void; // default: the selection
  reset(objectIds?: ArrayLike<number>): void; // default: the selection if coloured, else every override
}

export function colorPlugin(options: ColorPluginOptions = {}): ViewerPlugin<ColorPlugin> {
  const color: Color = options.color ? (options.color.slice() as Color) : [1, 0, 0];
  if (!color.every((c) => c >= 0 && c <= 1)) throw new RangeError(`color plugin: colour components must be in 0..1, got ${color}`);
  return {
    name: options.name ?? 'color',
    install({ viewer, addContextMenuItem }) {
      const anyColored = (ids: ArrayLike<number>): boolean => {
        for (let i = 0; i < ids.length; i++) if (viewer.getColor(ids[i]) !== null) return true;
        return false;
      };

      const apply = (ids: ArrayLike<number> = viewer.getSelection()): void => {
        if (ids.length > 0) viewer.setColor(ids, color);
      };
      const reset = (ids?: ArrayLike<number>): void => {
        if (ids === undefined) {
          ids = viewer.getSelection();
          // nothing coloured is selected (e.g. a click elsewhere deselected it): remove every colour
          if (!anyColored(ids)) {
            viewer.clearColors();
            return;
          }
        }
        if (ids.length > 0) viewer.setColor(ids, null);
      };
      const hasSelection = (c: ContextMenuContext): boolean => c.selection.length > 0;
      const canReset = (c: ContextMenuContext): boolean => anyColored(c.selection) || viewer.getColoredObjects().length > 0;
      const order = options.order ?? 0;

      // owned by the plugin: removed again by viewer.removePlugin() and viewer.dispose()
      addContextMenuItem({
        label: options.label ?? 'Red',
        order,
        enabled: hasSelection,
        onClick: (c) => apply(c.selection),
      });
      const resetLabel = options.resetLabel === undefined ? 'Reset colour' : options.resetLabel;
      if (resetLabel !== null) {
        addContextMenuItem({
          label: resetLabel,
          title: 'Restore the material colour of the selected objects, or of all coloured objects when none is selected',
          order,
          enabled: canReset,
          onClick: (c) => (anyColored(c.selection) ? reset(c.selection) : viewer.clearColors()),
        });
      }

      return {
        get color() {
          return color.slice() as Color;
        },
        apply,
        reset,
      };
    },
  };
}
```

Step by step:

1. **Factory and options.** `colorPlugin(options)` validates its options when it is called, so a bad
   colour fails at the call site, not inside the viewer. The plugin object is just `{ name, install }`.
2. **Install.** `install` destructures what it needs from the context: the viewer and
   `addContextMenuItem`. It does not touch the DOM, so it works without the built-in UI and in
   tests.
3. **Menu entries.** Both entries act on `c.selection`, which is what the user right-clicked (the
   viewer selected it before building the menu) or the existing selection when they right-clicked
   inside it. **Red** is disabled with nothing selected. **Reset colour** acts on the selection when
   a selected object has an override (`viewer.getColor`; the check stops at the first coloured one).
   Otherwise, typically because a click elsewhere deselected the coloured object, it removes every
   colour override with `viewer.clearColors()`, also those set by the application or other
   plugins. The viewer remembers which objects are coloured (`viewer.getColoredObjects()`), so the
   plugin keeps no state of its own and the entry is never dead while a colour is still visible.
   Both live in group 0, after the built-in entries.
4. **The scene change** is one `viewer.setColor` call. Nothing else is needed for merged or
   instanced meshes, transparent materials, several loaded models or the progressive renderer.
5. **Instance.** The returned object is the plugin's public API: `apply(ids?)`, `reset(ids?)` and
   `color`, usable without any menu:

   ```ts
   const paint = viewer.getPlugin<ColorPlugin>('color')!;
   paint.apply(viewer.groupByModel(viewer.getSelection()).get(viewer.models[0]) ?? []);
   ```

6. **Cleanup.** There is nothing to dispose: no event subscriptions, no tool, no DOM, and the menu
   entries are owned by the context. The colours themselves are user edits and stay after
   `removePlugin('color')`; `viewer.clearColors()` or `viewer.setColor(ids, null)` removes them.

Registering it, as [`examples/models.ts`](../examples/models.ts) does (try it on
`/examples/models.html`):

```ts
const viewer = new Viewer(canvas, {
  plugins: [measurePlugin({ decimals: 3 }), sectionPlugin(), colorPlugin()],
});
const ui = createViewerUi(viewer); // draws the context menu
```

Variations need no library change: `colorPlugin({ name: 'paint-blue', color: [0.1, 0.4, 1], label:
'Blue', resetLabel: null })` installed next to the red one adds a **Blue** entry; a "Hide" plugin is
the `addContextMenuItem` example in [The context menu](#the-context-menu).

What it would take to go further, using the same API: remembering the colour an object had before
(read `getColor` before `setColor` and keep `{ objectId, colour }` per changed object), or a colour
picker panel (in the `ui()` hook, with `new Panel(ui.element, { title })`).

## A larger example: the measurement plugin

`measurePlugin()` (`src/plugins/measure/`) shows the rest of the API in one plugin of about 450
lines plus its overlay:

- a **tool** (`setTool`) with `onTap`, `onPointerMove`, `onEscape`, `onContextMenu` (a right click
  cancels a started measurement instead of opening the menu) and `onDeactivate`;
- **snapping** for every pointer move with at most one `snap` in flight, and click results handled
  in click order;
- an **overlay** (SVG lines and labels in `context.overlay()`) repositioned in the `view` event with a
  reused `ScreenPoint`, with lines cut at the eye plane before projecting;
- a **toolbar toggle** in the `ui()` hook whose state follows `onDeactivate`, and a **context menu
  entry** ("Clear measurements") added through the context;
- a **headless API** (`activate()`, `add(a, b)`, `measurements`, `remove(id)`, `clear()`, its own
  `on('created' | 'removed' | 'active')` events) with the UI as a thin layer over it;
- a complete `dispose()`.

[`examples/section-plugin.ts`](../examples/section-plugin.ts) is a ~60-line plugin outside the library
(a "Cut" toggle that puts a section plane above the selection), written against the package exports
only.

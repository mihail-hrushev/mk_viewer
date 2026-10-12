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
- [A panel plugin: the status legend](#a-panel-plugin-the-status-legend)

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
import { Viewer, createViewerUi, colorPlugin, measurePlugin, setsPlugin, statusPlugin, type MeasurePlugin } from 'mk-viewer';

const viewer = new Viewer(canvas, { plugins: [measurePlugin(), colorPlugin(), statusPlugin(), setsPlugin(), selectionPlugin()] }); // in this order
createViewerUi(viewer);                                         // optional built-in UI
const measure = viewer.getPlugin<MeasurePlugin>('measure')!;     // a plugin's own API
viewer.use(pickLogPlugin());                                    // later: returns the instance
viewer.plugins;                                                 // ['measure', 'color', 'status', 'pick-log']
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
| `selection` | `number[]` | the selection changed (`select`, clicks, the tree) |
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
2. The viewer picks under the pointer. The menu acts on the selection (`c.selection`), or on the
   object under the pointer when nothing is selected. The selection itself is never changed by a
   right click, so the user can select by hand and right-click anywhere, including over another
   object.
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
  built-in menu draws a line between groups. The built-in UI's own entries use -100 (Hide selected, Hide
  unselected, Show all) and -90 (Properties), so plugin entries (default 0) come after them.
- `visible` and `enabled` run once per opened menu, synchronously. Keep them cheap (a selection of a
  million objects is possible) and free of side effects. Errors are logged and hide / disable the
  entry; an error in `onClick` is logged.
- `onClick` runs after the menu closed.
- `color` (sRGB, 0..1) draws a swatch before the label.
- An entry with `items` instead of `onClick` is a **submenu**: its items are the same type (so they
  can nest), evaluated with the same context and sorted the same way. The built-in menu opens it on
  hover or click, beside its row. A disabled submenu does not open, and a submenu whose items are
  all hidden is listed but disabled. `enabled` of the submenu itself is the place for a condition
  all its items share (the colour plugin disables **Change colour** with nothing selected):

  ```ts
  context.addContextMenuItem({
    label: 'Change colour',
    enabled: (c) => c.selection.length > 0,
    items: [
      { label: 'Red', color: [1, 0, 0], onClick: (c) => viewer.setColor(c.selection, [1, 0, 0]) },
      { label: 'Blue', color: [0, 0, 1], onClick: (c) => viewer.setColor(c.selection, [0, 0, 1]) },
    ],
  });
  ```
- Without the built-in UI the entries still exist; the application draws them from the
  `contextMenu` event (below). Applications use `viewer.addContextMenuItem(item)` for their own
  entries (same item type, removed only by the returned function).

**Drawing your own menu.** An application (or a plugin providing a different menu look) handles the
`contextMenu` event, calls `preventDefault()` synchronously to keep the built-in menu from showing,
and runs the chosen entry:

```ts
viewer.on('contextMenu', (req) => {
  req.preventDefault();
  const rows = (items) => items.map((e) => ({ text: e.label, disabled: !e.enabled, swatch: e.color, children: e.items && rows(e.items), choose: () => e.run() }));
  myMenu.show(req.x, req.y, rows(req.items));
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
- `ui.settings.addToggle({ label, title, get, set })` adds an on / off switch for a setting of the
  plugin to the Settings panel (next to Show edges, Selected x-ray and Ghost hidden) and returns a function that
  removes it; `get` is re-read whenever the panel opens.
- `ui.models.addFileHandler((file) => boolean)` lets the plugin claim files opened with the Models
  panel's file picker or dropped on the viewer: every file is offered to the handlers first, in
  registration order, and one that returns true takes the file (it is then not loaded as a model).
  Returns a function that unregisters the handler. The status plugin takes `.csv` / `.tsv` / `.txt`
  row files this way.
- `ui.hierarchy.setSelectedNodesProvider((objectIds) => nodes)` lets the plugin decide which nodes
  the model tree highlights for a selection (`{ model, node }` refs); null restores the default
  (the topmost nodes whose subtree is entirely selected). `ui.hierarchy.updateSelection()` re-reads
  the selection when the answer changed without a selection change. The selection plugin provides
  its nodes at the current level this way.
- Return a function that removes what you added. It runs on `ui.dispose()` and when the plugin is
  removed; call it from `dispose()` as well, in case the plugin is disposed without the UI knowing.

The status plugin ([below](#a-panel-plugin-the-status-legend)) is a complete toggle-plus-panel
example.

### Models

`viewer.models`, `viewer.getModelOf(objectId)`, `viewer.groupByModel(ids)`, the `modelLoaded` /
`modelUnloaded` events, and per model `name`, `bounds`, `objectIdRange`, `hierarchy` (node names and
structure), `getProperties(objectId)`, `setVisible`, `isolate`, `fitToView`, `setTransform`,
`unload`. Every loaded model owns its own
objectId ranges, so per-object calls never mix models up.

Properties are searchable. `viewer.findObjects(query)` searches every loaded model and returns
`objectIds` (sorted, ready for `select`, `isolate`, `setColor`, `fitToView`), `hits` for list
queries and the per-model `matches`; `viewer.propertyKeys()` lists the keys there are. Per model,
`model.properties` has the same `find(query)` plus `keys()`, `values(key)`, `objectsUnder(node)` and
`nodesOf(objectIds)` (the topmost nodes whose subtree is entirely listed: what the tree highlights
for a selection),
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
it adds the submenu **Change colour** (named colours with a swatch) and **Reset colour** to the
context menu. The user selects an object (or just right-clicks one), opens **Change colour** and
chooses **Blue**, and the object turns blue; **Reset colour** gives it its material colour back, or,
when no coloured object is selected any more, removes every colour override in the viewer
(`viewer.clearColors()`), whoever set it.
Here is the whole plugin:

```ts
import type { Color, ContextMenuContext, PluginInstance, ViewerPlugin } from 'mk-viewer';

/** A named colour of the "Change colour" submenu. */
export interface NamedColor {
  /** Label of the submenu entry. */
  label: string;
  /** sRGB colour, components in 0..1. */
  color: Color;
}

/** The palette the submenu lists by default. */
export const DEFAULT_COLORS: readonly NamedColor[] = Object.freeze(
  (
    [
      ['Red', [1, 0, 0]],
      ['Orange', [1, 0.5, 0]],
      ['Yellow', [1, 0.9, 0]],
      ['Green', [0, 0.7, 0.2]],
      ['Cyan', [0, 0.8, 0.9]],
      ['Blue', [0.1, 0.4, 1]],
      ['Purple', [0.6, 0.2, 0.9]],
      ['Magenta', [1, 0.2, 0.7]],
      ['Grey', [0.5, 0.5, 0.5]],
      ['White', [1, 1, 1]],
    ] as [string, Color][]
  ).map(([label, color]) => Object.freeze({ label, color: Object.freeze(color) as Color })),
);

export interface ColorPluginOptions {
  /** Plugin name (`viewer.getPlugin(name)`). Default 'color'. */
  name?: string;
  /** The colours of the submenu, in this order. Default `DEFAULT_COLORS` (Red, Orange, ..., White). */
  colors?: NamedColor[];
  /** The colour `apply()` uses when none is passed. Default: the first of `colors`. */
  color?: Color;
  /** Label of the submenu. Default 'Change colour'. */
  label?: string;
  /** Label of the entry that removes the colour; null for no such entry. Default 'Reset colour'. */
  resetLabel?: string | null;
  /** `ContextMenuItem.order` of both entries (their group in the menu). Default 0. */
  order?: number;
}

/** The installed plugin's API (`viewer.getPlugin<ColorPlugin>('color')`). */
export interface ColorPlugin extends PluginInstance {
  /** The colour `apply()` uses by default. */
  readonly color: Color;
  /** The colours of the submenu. */
  readonly colors: readonly NamedColor[];
  /** Colours these objects (default: the current selection) with `color` (default: `this.color`). */
  apply(objectIds?: ArrayLike<number>, color?: Color): void;
  /**
   * Removes the colour override of these objects. Default: the selected objects when one of them
   * is coloured, otherwise every override in the viewer (`viewer.clearColors()`).
   */
  reset(objectIds?: ArrayLike<number>): void;
}

const checkColor = (color: Color, what: string): Color => {
  if (!Array.isArray(color) || (color.length !== 3 && color.length !== 4) || !color.every((c) => typeof c === 'number' && c >= 0 && c <= 1)) {
    throw new RangeError(`color plugin: ${what} must be an [r, g, b] or [r, g, b, a] colour with components in 0..1, got ${color}`);
  }
  return color.slice() as Color;
};

/** Creates the colour plugin. */
export function colorPlugin(options: ColorPluginOptions = {}): ViewerPlugin<ColorPlugin> {
  const colors: readonly NamedColor[] = Object.freeze(
    (options.colors ?? DEFAULT_COLORS).map((c, i) => {
      if (!c || typeof c.label !== 'string') throw new TypeError(`color plugin: colors[${i}] needs a string label`);
      return Object.freeze({ label: c.label, color: Object.freeze(checkColor(c.color, `colors[${i}].color`)) as Color });
    }),
  );
  if (colors.length === 0 && !options.color) throw new RangeError('color plugin: `colors` is empty and no `color` was given');
  const color: Color = options.color ? checkColor(options.color, '`color`') : (colors[0].color.slice() as Color);
  return {
    name: options.name ?? 'color',
    install({ viewer, addContextMenuItem }) {
      const anyColored = (ids: ArrayLike<number>): boolean => {
        for (let i = 0; i < ids.length; i++) if (viewer.getColor(ids[i]) !== null) return true;
        return false;
      };

      const apply = (ids: ArrayLike<number> = viewer.getSelection(), c: Color = color): void => {
        if (ids.length > 0) viewer.setColor(ids, c);
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
      if (colors.length > 0) {
        addContextMenuItem({
          label: options.label ?? 'Change colour',
          title: 'Colour the selected objects',
          order,
          enabled: hasSelection,
          // one entry per colour, with a swatch; the submenu is disabled with nothing selected
          items: colors.map((c) => ({ label: c.label, color: c.color, onClick: (ctx) => apply(ctx.selection, c.color) })),
        });
      }
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
        colors,
        apply,
        reset,
      };
    },
  };
}
```

Step by step:

1. **Factory and options.** `colorPlugin(options)` validates its options when it is called, so a bad
   colour fails at the call site, not inside the viewer. The palette (`colors`, default
   `DEFAULT_COLORS`) is frozen so the plugin's API can hand it out as it is. The plugin object is
   just `{ name, install }`.
2. **Install.** `install` destructures what it needs from the context: the viewer and
   `addContextMenuItem`. It does not touch the DOM, so it works without the built-in UI and in
   tests.
3. **Menu entries.** Both entries act on `c.selection`: the selection, or the object the user
   right-clicked when nothing is selected (the viewer does not select it). **Change colour** is a submenu (`items`, one action per palette colour, `color` for
   the swatch) and is disabled with nothing selected, so its items need no check of their own.
   **Reset colour** acts on the selection when
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
  plugins: [measurePlugin({ decimals: 3 }), sectionPlugin(), colorPlugin(), statusPlugin(), setsPlugin()],
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

## A panel plugin: the status legend

`statusPlugin()` (`src/plugins/status/`) has no tool and no overlay: it is a **panel** over a
**headless, asynchronous** API, and shows the parts the other two examples do not. The user pastes
rows `Tag  Status  State  Colour` (tab, semicolon or comma separated; only the tag is mandatory,
see the [README](../README.md#viewer-plugins-and-the-measurement-tool)) or drops `.csv` / `.tsv` /
`.txt` files of such rows on the viewer or the panel, the plugin matches the tags against the
loaded models and shows a legend of statuses and states with counts, from which the user selects
and colours.

- **A toolbar toggle and a panel** in the `ui(ui)` hook: `ui.addToggle({ label, title, onClick: ()
  => panel.toggle() })` and `new Panel(ui.element, { title, dock: 'right', height: 'auto', onToggle:
  (open) => { toggle.on = open; } })`, so the button follows the panel whichever way it was closed.
  The panel's content (a textarea, buttons, the legend) goes into `panel.body`. The hook returns a
  cleanup that unsubscribes, removes the toggle and disposes the panel; `dispose()` calls the same
  cleanup. With the `ui: false` option the hook does nothing and the plugin is headless.
- **Row files** (`addFile(file)`, the file read with `file.text()` and parsed like pasted text;
  rows without a status column go under a status named after the file): the hook registers
  `ui.models.addFileHandler` for `.csv` / `.tsv` / `.txt` files dropped on the viewer, listens to
  `drop` on `panel.body` for files dropped on the panel, and offers an **Open…** file picker. The
  cleanup unregisters the handler and the listeners.
- **Matching through the property index**: one `viewer.findObjects({ key, in: tags })` per state
  (`key` defaults to `'name'`, the hierarchy node names; case-insensitive). The result's `objectIds`
  (sorted, unique; a tag that matches a group node brings its whole subtree) become the state's
  objects (the legend shows their number), and `hits` (per input value, the number of matching
  nodes, 0 = not found) is kept as `StatusState.hits`, so a caller can tell which tags were not
  found.
- **Async resolution, one state per task**: `resolve()` walks the unresolved states with a
  `setTimeout(0)` between them, so the legend shows up at once with pending counts ("…"), repaints
  after every state and does not starve a running model load. `add()` and the `modelLoaded` /
  `modelUnloaded` events (which invalidate every state) call `resolve()`; calling it while it runs
  returns the running promise and makes the loop start over. `resolve(true)` re-matches everything.
- **Colour overrides as plugin state**: `applyColors()` is `viewer.setColor(objectIds, color)` per
  state; `remove(status)`, `clear()`, `resetColors()` and `dispose()` set the same objects back to
  `null`. Unlike the colour plugin's user edits, these colours belong to the legend and go with it.
- **A `changed` event the panel re-renders from**: every change of the legend (rows added, a status
  removed or checked, a state resolved) emits `changed`; the panel's only subscriber rebuilds the
  legend from `plugin.statuses` (a snapshot: copied arrays, live objects) and keeps nothing but
  which statuses are unfolded. The headless API is complete without the panel, and tests use it
  without a DOM.

```ts
import { Viewer, createViewerUi, statusPlugin, type StatusPlugin } from 'mk-viewer';

const viewer = new Viewer(canvas, { plugins: [statusPlugin({ key: 'name', label: 'Status' })] });
createViewerUi(viewer);                                     // toolbar button "Status" opens the panel
const status = viewer.getPlugin<StatusPlugin>('status')!;

status.on('changed', () => console.log(status.statuses));  // what the panel listens to
status.add('304-SP001\tErection\tFab\tyellow\n440-SP003\tErection\tErected\t#00ff00');
await status.resolve();                                     // matched against every loaded model
status.statuses[0].states[0].hits;                          // Int32Array, matches per tag (0 = not found)
status.select('Erection', 'Fab');                           // viewer.select(objectIdsOf(...))
status.applyColors(['Erection']);                           // setColor per state; remove() undoes it
```

`setsPlugin()` (`src/plugins/sets/`) is the same shape without colours: a list of saved property
searches (a key and pasted values, `viewer.findObjects` with `in`), each with its count, missing
values and select / isolate / remove, re-resolved when models change. Read it for the minimal
version of a panel plugin over an asynchronous headless API.

`selectionPlugin()` (`src/plugins/selection/`) changes what a **click** selects without being a
tool: it installs a **selection resolver** (`viewer.setSelectionResolver(hit => objectIds | null)`),
the hook the viewer calls after every selecting click to map the picked object to what the click
selects (its spool, its parent node, ...). A plain click selects the resolved objects, Ctrl / Shift
adds or removes them as a whole, the context menu acts on them when nothing is selected, and the
hover highlight stays on the object. One resolver at a time: a plugin that installs one removes it
in `dispose()`. The plugin also reads the selection as *nodes* at the current level (a selected
object's level node when all its objects are selected, else the object's own node) to offer
Parent / Child / Sibling.

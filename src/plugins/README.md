# Viewer plugins

A **viewer plugin** adds behaviour and UI to a running viewer: a measuring tool, a section box,
annotations, a custom panel. It is installed once per viewer at startup and uses only the public
`ViewerApi`.

Not to be confused with **loader plugins** (`src/loaders/README.md`): a loader plugin reads a file
format during `viewer.load()` and is registered with `loaders: [...]` / `registerLoader`. A viewer
plugin is registered with `plugins: [...]` / `use()` and lives as long as the viewer.

```ts
import { Viewer, createViewerUi, gltfLoader, measurePlugin, type MeasurePlugin } from 'mk-viewer';

const viewer = new Viewer(canvas, {
  loaders: [gltfLoader],                              // file formats
  plugins: [measurePlugin({ unit: 'm' }), myPlugin()], // tools / UI, installed in this order
});
createViewerUi(viewer);                               // optional: plugins add their toolbar buttons
const measure = viewer.getPlugin<MeasurePlugin>('measure')!;
viewer.use(anotherPlugin());                          // later installs work too
```

[`examples/models.ts`](../../examples/models.ts) registers the built-in measurement plugin and
[`examples/section-plugin.ts`](../../examples/section-plugin.ts), a ~60-line third-party plugin
written against the public exports only.

## The contract (`types.ts`)

```ts
interface ViewerPlugin<T extends PluginInstance> {
  readonly name: string;                     // unique per viewer
  install(context: PluginContext): T | void; // called once
}
interface PluginContext {
  readonly viewer: ViewerApi;
  overlay(): HTMLElement;  // shared pointer-transparent layer over the canvas (created on first call)
}
interface PluginInstance {                   // what install returns: your API plus two optional hooks
  ui?(ui: ViewerUi): void | (() => void);    // built-in UI exists: add buttons / menu items
  dispose?(): void;                          // viewer.dispose()
}
```

- `new Viewer(canvas, { plugins })` installs in order at the end of construction; `viewer.use(p)`
  installs later and returns the instance; `viewer.getPlugin<T>(name)` finds it; `viewer.plugins`
  lists the names. A second plugin with the same name throws.
- If `install` throws, the error names the plugin. In the constructor the viewer is then disposed
  (already installed plugins are disposed in reverse order) and the constructor throws; with `use()`
  the viewer stays usable. Undo your own side effects before throwing.
- `viewer.dispose()` disposes plugins in reverse install order, before the viewer itself goes away.

## Minimal skeleton

```ts
import type { ViewerPlugin, PluginInstance } from 'mk-viewer';

export interface HelloPlugin extends PluginInstance {
  count(): number;
}

export function helloPlugin(options: { greeting?: string } = {}): ViewerPlugin<HelloPlugin> {
  return {
    name: 'hello',
    install({ viewer }) {
      let picks = 0;
      const off = viewer.on('pick', (hit) => {
        if (hit) picks++;
      });
      return {
        count: () => picks,
        ui(ui) {
          const b = ui.addButton({ label: 'Hello', onClick: () => alert(options.greeting ?? 'hi') });
          return () => b.remove();
        },
        dispose: off,
      };
    },
  };
}
```

## Tools: taking over clicks

A tool that needs the clicks (measure, place, cut...) makes itself the viewer's active tool:

```ts
const tool: ViewerTool = {
  name: 'place',
  cursor: 'crosshair',                                  // default 'crosshair'
  onTap(x, y, { pointerType, modifier }) { ... },        // click / tap, never the end of a drag
  onPointerMove(x, y, info) { ... },                     // mouse / pen hover, no button, no camera drag
  onPointerLeave() { ... },                              // left the canvas or a camera drag started
  onEscape() { return halfDone ? (cancel(), true) : false }, // true: handled, the tool stays
  onContextMenu(x, y) { return halfDone ? (cancel(), true) : false }, // true: no context menu
  onDeactivate(reason) { ... },                          // 'api' | 'replaced' | 'escape' | 'dispose'
};
viewer.setTool(tool);   // viewer.setTool(null) to leave; viewer.getTool() is the active one
```

While a tool is active: clicks / taps go to `onTap` instead of selecting, double click / double tap
does not zoom (both clicks arrive as taps), the hover highlight is off, and the cursor is the tool's.
Orbit, pan, zoom and WASD keep working. Only one tool is active: activating another calls the first
one's `onDeactivate('replaced')`. Escape deactivates the tool unless `onEscape` returns true.
Everything is restored when the tool is deactivated. Keep your own "active" state in sync through
`onDeactivate`, since the user (Escape) or another tool can end yours.

Helpers tools typically need:

- `await viewer.snap(x, y, { pointerType })`: GPU pick plus magnet to the nearest vertex, else
  feature edge, else surface point, within a screen tolerance (12 CSS px, 24 for touch). Returns the
  float64 world position, `kind`, ids, model, and for an edge its end points.
- `viewer.worldToScreen(point, out?)`: canvas CSS pixels, depth and visibility of a world point.
- `viewer.on('view', ...)`: fires inside the animation frame whenever the camera moves (including
  every frame of an animated transition) or the canvas is resized, before that frame is shown.
  Reposition your overlay DOM there: it stays glued to the model, and nothing runs while idle.

## UI contributions

The built-in UI is optional and created after the viewer, so never assume it exists. Put UI code in
the instance's `ui(ui)` hook: `createViewerUi` calls it for plugins installed before, and for plugins
installed after the UI exists. Return a function that removes what you added (called by
`ui.dispose()`), and remove it in `dispose()` too.

- `ui.addToggle({ label, title, onClick })` returns `{ element, on, remove() }`: a toolbar button
  whose on / off look you set (`toggle.on = active`), so it stays right when Escape or another tool
  ends your tool.
- `ui.addButton({ label, onClick })` for plain actions; `ui.addMenuItem({ label, enabled, onClick })`
  adds to the right-click menu and returns a remover.
- `ui.element` is the UI overlay; `new Panel(ui.element, { title })` makes a movable panel. For
  drawings over the model (lines, labels) use `context.overlay()`, which exists with and without the
  built-in UI.

## Do

- Work headless first: expose an API (`activate()`, `add()`, events) and make the UI a thin layer.
- Use world coordinates in your API and data (float64 arrays); the viewer handles its internal
  origin for large (georeferenced) coordinates.
- Unsubscribe every `viewer.on(...)` and remove your DOM in `dispose()`.
- Keep `view` handlers cheap and allocation-free (reuse a `ScreenPoint` with `worldToScreen`).
- Cut lines at the eye plane before projecting: `worldToScreen` of a point behind the camera
  (`inFront: false`) is meaningless.

## Don't

- Don't import from `src/core`, `src/gl`, `src/render` or use members tagged `@internal`.
- Don't call `invalidate()` to animate your own DOM; follow the `view` event instead.
- Don't listen to raw canvas clicks to implement a tool: the active-tool mechanism already filters
  drags, double clicks, touch and the context menu, and restores selection afterwards.
- Don't keep the tool active after your plugin is disposed (`deactivate` in `dispose`).

## The measurement plugin

`measurePlugin(options)` (`src/plugins/measure/`): the "Measure" toolbar button or
`measure.activate()`; hover shows the magnet (square: vertex, diamond: edge with the edge
highlighted, circle: surface); click the start, a dashed rubber band shows the live distance, click
the end. Escape (or right click) drops a started measurement, a second Escape leaves the tool; the
right-click menu has "Clear measurements". Touch: tap twice. API: `active`, `activate()`,
`deactivate()`, `toggle()`, `measurements` (start / end with snap kind and ids, distance, axis
deltas), `add(start, end)`, `remove(id)`, `clear()`, `format(d)`, `on('created' | 'removed' |
'active', fn)`. Options: `unit`, `decimals` (3), `format`, `deltas` (true), `snapRadius` (12),
`touchSnapRadius` (24), `snap` (true), `edgeAngle` (20 degrees), `color`, `ui` (true), `name`.

Measurements belong to world space: they stay where they are when models are hidden or unloaded,
and they do not follow a model moved with `model.setTransform`.

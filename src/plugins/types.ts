/**
 * Viewer plugin contract (see docs/PLUGIN_API.md).
 *
 * A viewer plugin adds behaviour and UI to a running viewer (a measurement tool, a section box, an
 * annotation layer...). It is a different thing from a *loader* plugin (src/loaders/types.ts),
 * which only turns a file format into viewer content during `viewer.load`.
 *
 *   const viewer = new Viewer(canvas, { plugins: [measurePlugin(), myPlugin({ ... })] });
 *   const measure = viewer.getPlugin<MeasurePlugin>('measure');
 *
 * Plugins use only the public `ViewerApi` they get through the context.
 */
import type { ContextMenuItem, ViewerApi } from '../types';
import type { ViewerUi } from '../ui/ViewerUi';

/**
 * What `install` returns: the plugin's own public API (anything), plus two optional hooks the viewer
 * and the built-in UI call.
 */
export interface PluginInstance {
  /**
   * Called when the built-in UI is created (`createViewerUi`), or right away at install when it
   * already exists. Add toolbar buttons, menu items and DOM here. May return a function that removes
   * them again (called by `ui.dispose()`, and when the plugin is removed with `viewer.removePlugin`,
   * after `dispose()`); `dispose()` should remove them too.
   */
  ui?(ui: ViewerUi): void | (() => void);
  /**
   * Called by `viewer.removePlugin(name)` and by `viewer.dispose()` (plugins are disposed in reverse
   * install order). Unsubscribe events, end your tool, remove your DOM and undo scene changes that
   * should not outlive the plugin.
   */
  dispose?(): void;
}

/** What the viewer hands to `ViewerPlugin.install`. */
export interface PluginContext {
  /** The viewer the plugin is installed on. */
  readonly viewer: ViewerApi;
  /** The plugin's name (`ViewerPlugin.name`). */
  readonly name: string;
  /**
   * A pointer-transparent layer over the canvas for the plugin's own DOM (labels, SVG), shared by
   * all plugins of this viewer and created on first call. It follows the canvas rectangle and lies
   * below the built-in UI. Set `pointer-events: auto` on elements that should receive input.
   */
  overlay(): HTMLElement;
  /**
   * `viewer.addContextMenuItem` owned by this plugin: the entry is also removed when the plugin is
   * removed (`viewer.removePlugin`), when its `install` throws, and when the viewer is disposed.
   * The returned function removes it earlier.
   */
  addContextMenuItem(item: ContextMenuItem): () => void;
}

/**
 * A viewer plugin: usually created by a factory taking options, e.g. `measurePlugin({ unit: 'm' })`.
 * Install it with `new Viewer(canvas, { plugins: [p] })` or `viewer.use(p)`.
 */
export interface ViewerPlugin<T extends PluginInstance = PluginInstance> {
  /** Unique per viewer; `viewer.getPlugin(name)` returns the installed instance. */
  readonly name: string;
  /**
   * Called once per viewer. Subscribe to events, create DOM, return the public API. When it throws,
   * the plugin is not installed (and a viewer under construction is disposed): undo what was done
   * before throwing.
   */
  install(context: PluginContext): T | void;
}

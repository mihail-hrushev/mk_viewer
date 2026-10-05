/**
 * Colour plugin: a context menu entry "Red" that colours the selected objects, and "Reset colour"
 * that gives them their material colour back. Deliberately small; it is the worked example of
 * docs/PLUGIN_API.md and uses only the public plugin contract and `ViewerApi`.
 *
 *   const viewer = new Viewer(canvas, { plugins: [colorPlugin()] });
 *   createViewerUi(viewer);                      // draws the context menu
 *   // right-click an object -> "Red"
 *   viewer.getPlugin<ColorPlugin>('color')!.apply([objectId]);   // or headless
 *
 * Colours are `viewer.setColor` overrides: they stay when the plugin is removed, and "Reset colour"
 * removes any override of the selected objects (also one set by the application).
 */
import type { Color, ContextMenuContext } from '../../types';
import type { PluginInstance, ViewerPlugin } from '../types';

export interface ColorPluginOptions {
  /** Plugin name (`viewer.getPlugin(name)`). Default 'color'. */
  name?: string;
  /** sRGB colour applied by the menu entry. Default red [1, 0, 0]. */
  color?: Color;
  /** Label of the menu entry. Default 'Red'. */
  label?: string;
  /** Label of the entry that removes the colour; null for no such entry. Default 'Reset colour'. */
  resetLabel?: string | null;
  /** `ContextMenuItem.order` of both entries (their group in the menu). Default 0. */
  order?: number;
}

/** The installed plugin's API (`viewer.getPlugin<ColorPlugin>('color')`). */
export interface ColorPlugin extends PluginInstance {
  /** The colour the plugin applies. */
  readonly color: Color;
  /** Colours these objects (default: the current selection). */
  apply(objectIds?: ArrayLike<number>): void;
  /** Removes the colour override of these objects (default: the current selection). */
  reset(objectIds?: ArrayLike<number>): void;
}

/** Creates the colour plugin. */
export function colorPlugin(options: ColorPluginOptions = {}): ViewerPlugin<ColorPlugin> {
  const color: Color = options.color ? (options.color.slice() as Color) : [1, 0, 0];
  if (!color.every((c) => c >= 0 && c <= 1)) throw new RangeError(`color plugin: colour components must be in 0..1, got ${color}`);
  return {
    name: options.name ?? 'color',
    install({ viewer, addContextMenuItem }) {
      const apply = (ids: ArrayLike<number> = viewer.getSelection()): void => {
        if (ids.length > 0) viewer.setColor(ids, color);
      };
      const reset = (ids: ArrayLike<number> = viewer.getSelection()): void => {
        if (ids.length > 0) viewer.setColor(ids, null);
      };
      const hasSelection = (c: ContextMenuContext): boolean => c.selection.length > 0;
      const anyColored = (c: ContextMenuContext): boolean => c.selection.some((id) => viewer.getColor(id) !== null);
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
        addContextMenuItem({ label: resetLabel, order, enabled: anyColored, onClick: (c) => reset(c.selection) });
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

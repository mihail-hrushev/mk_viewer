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
 * Colours are `viewer.setColor` overrides: they stay when the plugin is removed. "Reset colour"
 * removes the override of the selected objects when one of them is coloured; otherwise, e.g. after
 * a click elsewhere deselected the coloured object, it removes every colour override in the viewer
 * (`viewer.clearColors()`), also those set by the application or other plugins.
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
  /**
   * Removes the colour override of these objects. Default: the selected objects when one of them
   * is coloured, otherwise every override in the viewer (`viewer.clearColors()`).
   */
  reset(objectIds?: ArrayLike<number>): void;
}

/** Creates the colour plugin. */
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

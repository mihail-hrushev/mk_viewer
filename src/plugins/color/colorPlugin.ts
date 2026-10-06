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
 * removes the override of the selected objects when one of them is coloured (also an override set
 * by the application); otherwise, e.g. after a click elsewhere deselected the coloured object, it
 * removes the colour of every object the plugin coloured.
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
   * is coloured, otherwise every object the plugin coloured (`resetAll()`).
   */
  reset(objectIds?: ArrayLike<number>): void;
  /** Removes the colour of every object the plugin coloured (not overrides set by the application). */
  resetAll(): void;
}

/** Creates the colour plugin. */
export function colorPlugin(options: ColorPluginOptions = {}): ViewerPlugin<ColorPlugin> {
  const color: Color = options.color ? (options.color.slice() as Color) : [1, 0, 0];
  if (!color.every((c) => c >= 0 && c <= 1)) throw new RangeError(`color plugin: colour components must be in 0..1, got ${color}`);
  return {
    name: options.name ?? 'color',
    install({ viewer, addContextMenuItem }) {
      const colored = new Set<number>(); // objects coloured by the plugin, so "Reset colour" can find them again
      const isColored = (id: number): boolean => viewer.getColor(id) !== null;
      const anyColored = (ids: Iterable<number>): boolean => {
        for (const id of ids) if (isColored(id)) return true;
        return false;
      };

      const apply = (ids: ArrayLike<number> = viewer.getSelection()): void => {
        if (ids.length === 0) return;
        viewer.setColor(ids, color);
        for (let i = 0; i < ids.length; i++) colored.add(ids[i]);
      };
      const resetAll = (): void => {
        const ids = Array.from(colored).filter(isColored); // an id may have been reset or unloaded since
        colored.clear();
        if (ids.length > 0) viewer.setColor(ids, null);
      };
      const reset = (ids?: ArrayLike<number>): void => {
        if (ids === undefined) {
          const selection = viewer.getSelection();
          ids = selection;
          if (!anyColored(selection)) {
            // nothing coloured is selected (e.g. a click elsewhere deselected it): undo the colouring
            resetAll();
            return;
          }
        }
        if (ids.length === 0) return;
        viewer.setColor(ids, null);
        for (let i = 0; i < ids.length; i++) colored.delete(ids[i]);
      };
      const hasSelection = (c: ContextMenuContext): boolean => c.selection.length > 0;
      const canReset = (c: ContextMenuContext): boolean => anyColored(c.selection) || anyColored(colored);
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
          onClick: (c) => (anyColored(c.selection) ? reset(c.selection) : resetAll()),
        });
      }

      return {
        get color() {
          return color.slice() as Color;
        },
        apply,
        reset,
        resetAll,
      };
    },
  };
}

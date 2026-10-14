/**
 * Colour plugin: a context menu submenu "Change colour" listing named colours (with a swatch) that
 * colour the selected objects, and "Reset colour" that gives them their material colour back.
 * Deliberately small; it is the worked example of docs/PLUGIN_API.md and uses only the public
 * plugin contract and `ViewerApi`.
 *
 *   const viewer = new Viewer(canvas, { plugins: [colorPlugin()] });
 *   createViewerUi(viewer);                      // draws the context menu
 *   // right-click an object -> "Change colour" -> "Blue"
 *   viewer.getPlugin<ColorPlugin>('color')!.apply([objectId], [0, 0, 1]);   // or headless
 *
 * Colours are `viewer.setColor` overrides: they stay when the plugin is removed. "Reset colour"
 * removes the override of the selected objects when one of them is coloured; otherwise, e.g. after
 * a click elsewhere deselected the coloured object, it removes every colour override in the viewer
 * (`viewer.clearColors()`), also those set by the application or other plugins.
 */
import type { Color, ContextMenuContext } from '../../types';
import type { PluginInstance, ViewerPlugin } from '../types';
import { DEFAULT_COLORS, type NamedColor } from '../../colors';

// the palette lives in src/colors (shared with the settings panel); still part of the plugin's API
export { DEFAULT_COLORS } from '../../colors';
export type { NamedColor } from '../../colors';

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

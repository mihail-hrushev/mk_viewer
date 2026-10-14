/**
 * The default colour set: named sRGB colours shared by the colour plugin's "Change colour" submenu
 * and the settings panel's colour swatches. Neutral module so `src/ui` does not depend on
 * `src/plugins`.
 */
import type { Color } from './types';

/** A named colour (a palette entry: a submenu entry or a swatch). */
export interface NamedColor {
  /** Label of the entry. */
  label: string;
  /** sRGB colour, components in 0..1. */
  color: Color;
}

/** The palette the colour plugin's submenu lists by default. */
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

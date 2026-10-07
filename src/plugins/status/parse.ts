/**
 * Parsing for the status plugin: the pasted rows (tab separated `Tag  Status  State  Colour`) and
 * the colour column (`#rgb`, `#rrggbb` or one of the named colours below). Pure functions, no DOM.
 */
import type { Color } from '../../types';

/** One parsed input row, defaults applied. */
export interface StatusRow {
  /** Name of the model item (matched against hierarchy node names). */
  tag: string;
  /** Status entity the row belongs to; `DEFAULT_STATUS` when the column is empty. */
  status: string;
  /** State label within the status; the tag itself when the column is empty. */
  state: string;
  /** Colour of the state as written; `DEFAULT_COLOR_NAME` when the column is empty. */
  color: string;
  /** The colour resolved to sRGB 0..1, or null when the text is not a colour. */
  rgb: Color | null;
}

export const DEFAULT_STATUS = 'Default';
export const DEFAULT_COLOR_NAME = '#DDDDDD';

/** Named colours accepted in the colour column (CSS values); lower case keys. */
export const NAMED_COLORS: Readonly<Record<string, string>> = {
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  magenta: '#ff00ff',
  cyan: '#00ffff',
  pink: '#ffc0cb',
  lime: '#00ff00',
  coral: '#ff7f50',
  gray: '#808080',
  grey: '#808080',
  white: '#ffffff',
  black: '#000000',
  maroon: '#800000',
  orange: '#ffa500',
  purple: '#800080',
  navy: '#000080',
  teal: '#008080',
  olive: '#808000',
  silver: '#c0c0c0',
  brown: '#a52a2a',
  violet: '#ee82ee',
  indigo: '#4b0082',
  gold: '#ffd700',
  salmon: '#fa8072',
  turquoise: '#40e0d0',
  beige: '#f5f5dc',
  tan: '#d2b48c',
  khaki: '#f0e68c',
  crimson: '#dc143c',
  aqua: '#00ffff',
  fuchsia: '#ff00ff',
  orchid: '#da70d6',
  skyblue: '#87ceeb',
  steelblue: '#4682b4',
  tomato: '#ff6347',
  chocolate: '#d2691e',
  darkgreen: '#006400',
  darkblue: '#00008b',
  darkred: '#8b0000',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  lightblue: '#add8e6',
  lightgreen: '#90ee90',
};

/**
 * Parses a colour: `#rgb`, `#rrggbb` (case-insensitive, the `#` optional) or a name of
 * `NAMED_COLORS`. Returns sRGB 0..1 or null.
 */
export function parseColor(text: string): Color | null {
  const t = text.trim().toLowerCase();
  if (t === '') return null;
  const named = NAMED_COLORS[t];
  const hex = named ?? (t.startsWith('#') ? t : `#${t}`);
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(hex);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** sRGB 0..1 to `#rrggbb` (for swatches). */
export function colorToHex(c: Color): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/**
 * Splits one line into its columns. Lines with a tab are split on tabs (so tags and states may
 * contain spaces, as in a spreadsheet paste); lines without one are split on runs of whitespace,
 * so a hand-typed `tag status state colour` works too.
 */
export function splitRow(line: string): string[] {
  const cells = line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/);
  return cells.map((c) => c.trim());
}

/**
 * Parses pasted text into rows. Empty lines and lines without a tag are skipped. Columns beyond
 * the fourth are ignored. Defaults: status `Default`, state = tag, colour `#DDDDDD`. A colour that
 * cannot be parsed keeps its text and gets `rgb: null`; the caller decides what to do with it.
 */
export function parseStatusRows(text: string): StatusRow[] {
  const rows: StatusRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const [tag = '', status = '', state = '', color = ''] = splitRow(raw);
    if (tag === '') continue;
    const colorText = color === '' ? DEFAULT_COLOR_NAME : color;
    rows.push({
      tag,
      status: status === '' ? DEFAULT_STATUS : status,
      state: state === '' ? tag : state,
      color: colorText,
      rgb: parseColor(colorText),
    });
  }
  return rows;
}

/**
 * Parsing for the status plugin: the rows (`Tag  Status  State  Colour`, pasted or from a CSV file;
 * tab, semicolon or comma separated) and the colour column (`#rgb`, `#rrggbb` or one of the named
 * colours below). Pure functions, no DOM.
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

/** File extensions (lower case, without the dot) accepted as status row files. */
export const STATUS_FILE_EXTENSIONS: readonly string[] = ['csv', 'tsv', 'txt'];

/** True when the file name has one of `STATUS_FILE_EXTENSIONS`. */
export function isStatusFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && STATUS_FILE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/** The file name without its directory and extension (`C:/x/Erection.csv` → `Erection`). */
export function statusNameOfFile(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

/** Strips the surrounding double quotes of a CSV cell (`""` inside is one quote) and trims it. */
function unquote(cell: string): string {
  const t = cell.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"').trim();
  return t;
}

/**
 * Splits one line into its columns. Lines with a tab are split on tabs (so tags and states may
 * contain spaces, as in a spreadsheet paste); otherwise lines with a semicolon are split on
 * semicolons and lines with a comma on commas (CSV files, either locale); lines without any are
 * split on runs of whitespace, so a hand-typed `tag status state colour` works too. Cells may be
 * double-quoted.
 */
export function splitRow(line: string): string[] {
  const sep = line.includes('\t') ? '\t' : line.includes(';') ? ';' : line.includes(',') ? ',' : null;
  const cells = sep ? line.split(sep) : line.trim().split(/\s+/);
  return cells.map(unquote);
}

export interface ParseStatusOptions {
  /** Status of the rows whose status column is empty. Default `DEFAULT_STATUS`. */
  defaultStatus?: string;
}

/** True for a header line `Tag  Status  State  Colour` (only the first cell is looked at). */
export function isHeaderRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells[0].toLowerCase() === 'tag';
}

/**
 * Parses pasted text or the content of a CSV file into rows. A leading byte order mark and a
 * header line (first cell `Tag`) are skipped, as are empty lines and lines without a tag. Columns
 * beyond the fourth are ignored. Defaults: status `Default` (or `options.defaultStatus`, e.g. the
 * file name), state = tag, colour `#DDDDDD`. A colour that cannot be parsed keeps its text and
 * gets `rgb: null`; the caller decides what to do with it.
 */
export function parseStatusRows(text: string, options: ParseStatusOptions = {}): StatusRow[] {
  const defaultStatus = options.defaultStatus?.trim() || DEFAULT_STATUS;
  const rows: StatusRow[] = [];
  let first = true;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const cells = splitRow(raw);
    const header = first && isHeaderRow(cells);
    first = false;
    if (header) continue;
    const [tag = '', status = '', state = '', color = ''] = cells;
    if (tag === '') continue;
    const colorText = color === '' ? DEFAULT_COLOR_NAME : color;
    rows.push({
      tag,
      status: status === '' ? defaultStatus : status,
      state: state === '' ? tag : state,
      color: colorText,
      rgb: parseColor(colorText),
    });
  }
  return rows;
}

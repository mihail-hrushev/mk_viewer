/**
 * Turns a node's property object into the rows the Properties panel shows. Top-level primitives
 * come first as plain rows; each top-level object (a category or property set, e.g. a glTF extras
 * category or an IFC `Pset_WallCommon`) becomes a group header followed by its properties, deeper
 * levels as dotted keys (`Sub.Prop`), down to the depth the property index flattens.
 */
import type { NodeProperties } from '../loaders/types';
import { MAX_DEPTH } from '../metadata/PropertyIndex';

export interface PropertyRow {
  /** `group`: a category header (`value` is empty); `prop`: a key/value row. */
  kind: 'group' | 'prop';
  /** Property key; for rows inside a group, relative to the group (`Sub.Prop`). */
  key: string;
  value: string;
  /** The top-level group the row belongs to, `undefined` for top-level properties. */
  group?: string;
}

export function propertyRows(props: NodeProperties | undefined): PropertyRow[] {
  const rows: PropertyRow[] = [];
  if (!props) return rows;
  const groups: string[] = [];
  for (const key in props) {
    const v = props[key];
    if (isPlainObject(v)) groups.push(key);
    else rows.push({ kind: 'prop', key, value: formatValue(v) });
  }
  for (const g of groups) {
    const start = rows.length;
    rows.push({ kind: 'group', key: g, value: '', group: g });
    addNested(props[g] as NodeProperties, '', 1, g, rows);
    if (rows.length === start + 1) rows.pop(); // empty category
  }
  return rows;
}

/** `obj` sits at index depth `depth` (the top-level group is depth 1 below the root keys). */
function addNested(obj: NodeProperties, prefix: string, depth: number, group: string, rows: PropertyRow[]): void {
  for (const k in obj) {
    const v = obj[k];
    const key = prefix + k;
    if (isPlainObject(v) && depth < MAX_DEPTH) addNested(v as NodeProperties, key + '.', depth + 1, group, rows);
    else rows.push({ kind: 'prop', key, value: formatValue(v), group });
  }
}

function isPlainObject(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A value as display text: primitives as text (numbers without float noise), arrays of primitives
 * joined with ", ", anything else as JSON.
 */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v) && v.every((e) => e === null || e === undefined || typeof e !== 'object')) {
    return v
      .filter((e) => e !== null && e !== undefined)
      .map((e) => (typeof e === 'number' ? formatNumber(e) : String(e)))
      .join(', ');
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 1.4999999999999998 -> 1.5: 12 significant digits drop binary rounding noise. */
function formatNumber(v: number): string {
  if (!Number.isFinite(v) || Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(12)));
}

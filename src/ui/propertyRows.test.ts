import { describe, expect, it } from 'vitest';
import { formatValue, propertyRows } from './propertyRows';

describe('propertyRows', () => {
  it('returns nothing for no properties', () => {
    expect(propertyRows(undefined)).toEqual([]);
    expect(propertyRows({})).toEqual([]);
  });

  it('puts top-level primitives first, then one header per category with its properties', () => {
    const rows = propertyRows({
      Item: { Name: 'Pipe 1', Type: 'Pipe' },
      tag: 'P-1',
      Element: { Length: 1.5, Closed: true, Note: null },
    });
    expect(rows).toEqual([
      { kind: 'prop', key: 'tag', value: 'P-1' },
      { kind: 'group', key: 'Item', value: '', group: 'Item' },
      { kind: 'prop', key: 'Name', value: 'Pipe 1', group: 'Item' },
      { kind: 'prop', key: 'Type', value: 'Pipe', group: 'Item' },
      { kind: 'group', key: 'Element', value: '', group: 'Element' },
      { kind: 'prop', key: 'Length', value: '1.5', group: 'Element' },
      { kind: 'prop', key: 'Closed', value: 'true', group: 'Element' },
      { kind: 'prop', key: 'Note', value: '', group: 'Element' },
    ]);
  });

  it('shows deeper levels as dotted keys down to the index depth, then JSON', () => {
    const rows = propertyRows({ A: { B: { C: { D: { E: 1, F: { G: 2 } } } } } });
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ['A', ''],
      ['B.C.D.E', '1'], // indexed as A.B.C.D.E
      ['B.C.D.F', '{"G":2}'], // beyond the index depth
    ]);
  });

  it('drops empty categories', () => {
    expect(propertyRows({ Empty: {}, x: 1 })).toEqual([{ kind: 'prop', key: 'x', value: '1' }]);
  });
});

describe('formatValue', () => {
  it('formats primitives, arrays and objects', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(undefined)).toBe('');
    expect(formatValue('a')).toBe('a');
    expect(formatValue(false)).toBe('false');
    expect(formatValue(42)).toBe('42');
    expect(formatValue(['a', 1, null, true])).toBe('a, 1, true');
    expect(formatValue([{ a: 1 }])).toBe('[{"a":1}]');
  });

  it('drops float noise but keeps real precision', () => {
    expect(formatValue(1.4999999999999998)).toBe('1.5');
    expect(formatValue(0.1 + 0.2)).toBe('0.3');
    expect(formatValue(1.23456789)).toBe('1.23456789');
    expect(formatValue(1e-7)).toBe('1e-7');
    expect(formatValue(NaN)).toBe('NaN');
  });
});

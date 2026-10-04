import { describe, expect, it } from 'vitest';
import type { ModelHierarchy } from '../loaders/types';
import { MODEL_ROW, TreeModel, type TreeSource } from './TreeModel';

/** names[i], parents[i] (-1 = root), objectIds[i] (NaN = none) */
function hierarchy(names: string[], parents: number[], objectIds: number[]): ModelHierarchy {
  const kids = names.map((_, n) => Int32Array.from(parents.flatMap((p, i) => (p === n ? [i] : []))));
  return {
    nodeCount: names.length,
    roots: () => Int32Array.from(parents.flatMap((p, i) => (p === -1 ? [i] : []))),
    children: (n) => kids[n],
    parent: (n) => parents[n],
    name: (n) => names[n] || undefined,
    objectId: (n) => objectIds[n],
    nodeOfObject: (id) => objectIds.indexOf(id),
  };
}

// 0 Building
//   1 Level 1
//     2 Wall A      (obj 100)
//     3 Pump P-101  (obj 101)
//   4 Level 2
//     5 Pump P-202  (obj 102)
//       6 Flange    (obj 103)
const source: TreeSource = {
  name: 'plant.glb',
  hierarchy: hierarchy(
    ['Building', 'Level 1', 'Wall A', 'Pump P-101', 'Level 2', 'Pump P-202', 'Flange'],
    [-1, 0, 1, 1, 0, 4, 5],
    [NaN, NaN, 100, 101, NaN, 102, 103],
  ),
};

const labels = (t: TreeModel) => Array.from({ length: t.rowCount }, (_, r) => `${'.'.repeat(t.rowDepth[r])}${t.label(r)}`);
const rowOf = (t: TreeModel, label: string) => labels(t).findIndex((l) => l.replace(/^\.+/, '') === label);

describe('TreeModel', () => {
  it('shows a single model opened to its roots and expands on toggle', () => {
    const t = new TreeModel();
    t.setSources([source]);
    expect(labels(t)).toEqual(['plant.glb', '.Building']);
    expect(t.rowNode[0]).toBe(MODEL_ROW);
    t.toggle(rowOf(t, 'Building'));
    expect(labels(t)).toEqual(['plant.glb', '.Building', '..Level 1', '..Level 2']);
    t.toggle(rowOf(t, 'Level 1'));
    expect(labels(t)).toEqual(['plant.glb', '.Building', '..Level 1', '...Wall A', '...Pump P-101', '..Level 2']);
    expect(t.hasChildren(rowOf(t, 'Wall A'))).toBe(false);
    t.toggle(rowOf(t, 'Building'));
    expect(labels(t)).toEqual(['plant.glb', '.Building']);
  });

  it('several models start collapsed', () => {
    const t = new TreeModel();
    const other: TreeSource = { name: 'b.glb', hierarchy: hierarchy(['Root'], [-1], [7]) };
    t.setSources([source, other]);
    expect(labels(t)).toEqual(['plant.glb', 'b.glb']);
    t.toggle(1);
    expect(labels(t)).toEqual(['plant.glb', 'b.glb', '.Root']);
  });

  it('filters by name, case-insensitively, keeping the paths to the matches', () => {
    const t = new TreeModel();
    t.setSources([source]);
    t.setFilter('PUMP');
    expect(t.matchCount).toBe(2);
    expect(labels(t)).toEqual(['plant.glb', '.Building', '..Level 1', '...Pump P-101', '..Level 2', '...Pump P-202']);
    expect(t.isMatch(rowOf(t, 'Pump P-101'))).toBe(true);
    expect(t.isMatch(rowOf(t, 'Level 1'))).toBe(false);
    // a match can be opened by hand to see what is below it
    t.toggle(rowOf(t, 'Pump P-202'));
    expect(labels(t)).toContain('....Flange');
    t.setFilter('nothing like this');
    expect(t.matchCount).toBe(0);
    expect(labels(t)).toEqual(['plant.glb']);
    t.setFilter('');
    expect(labels(t)[1]).toBe('.Building');
  });

  it('collects the objectIds of a node and everything below it', () => {
    const t = new TreeModel();
    t.setSources([source]);
    t.toggle(rowOf(t, 'Building'));
    expect(t.collectObjectIds(rowOf(t, 'Level 2')).sort()).toEqual([102, 103]);
    expect(t.collectObjectIds(rowOf(t, 'Building')).sort()).toEqual([100, 101, 102, 103]);
    expect(t.collectObjectIds(0).length).toBe(4);
  });

  it('reveals the node of an object by expanding its ancestors', () => {
    const t = new TreeModel();
    t.setSources([source]);
    const row = t.reveal(source, 103);
    expect(t.label(row)).toBe('Flange');
    expect(labels(t)).toEqual(['plant.glb', '.Building', '..Level 1', '..Level 2', '...Pump P-202', '....Flange']);
    expect(t.reveal(source, 999)).toBe(-1);
  });
});

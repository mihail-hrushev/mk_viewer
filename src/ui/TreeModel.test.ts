import { describe, expect, it } from 'vitest';
import type { ModelHierarchy } from '../loaders/types';
import { MODEL_ROW, TreeModel, type TreeSource, type VirtualTreeGroup, type VirtualTreeNode } from './TreeModel';

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
    properties: () => undefined,
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
    expect(t.revealNode(source, source.hierarchy.nodeOfObject(103))).toBe(row);
    expect(t.revealNode(source, 9999)).toBe(-1);
    expect(t.revealNode({ name: 'other', hierarchy: source.hierarchy }, 0)).toBe(-1);
  });

  describe('virtual groups', () => {
    let floors: Record<string, string> = { s1: 'red', s2: 'green' };
    const scaffolds = (): VirtualTreeNode[] => [
      { id: 's1', label: 'Scaffold A', children: [{ id: 's1/f1', label: 'Floor 1', badge: { color: floors.s1, title: 'blocked' } }, { id: 's1/f2', label: 'Floor 2' }] },
      { id: 's2', label: 'Scaffold B', children: [{ id: 's2/f1', label: 'Floor 1', badge: { color: floors.s2 } }] },
    ];
    const group = (extra: Partial<VirtualTreeGroup> = {}): VirtualTreeGroup => ({ id: 'scaffolds', label: 'Scaffolds', children: scaffolds, ...extra });

    it('shows a group without any model, expanded to its top-level nodes', () => {
      const t = new TreeModel();
      t.addGroup(group());
      expect(labels(t)).toEqual(['Scaffolds', '.Scaffold A', '.Scaffold B']);
      expect(t.isModelRow(0)).toBe(true);
      expect(t.isGroupRow(0)).toBe(true);
      expect(t.groupOf(0)?.id).toBe('scaffolds');
      expect(t.groupNode(0)).toBeUndefined();
      expect(t.groupNode(1)?.id).toBe('s1');
      expect(t.hasChildren(1)).toBe(true);
      expect(t.collectObjectIds(1)).toEqual([]);
      t.toggle(rowOf(t, 'Scaffold A'));
      expect(labels(t)).toEqual(['Scaffolds', '.Scaffold A', '..Floor 1', '..Floor 2', '.Scaffold B']);
      expect(t.groupNode(2)?.badge).toEqual({ color: 'red', title: 'blocked' });
      expect(t.hasChildren(2)).toBe(false);
      t.toggle(0);
      expect(labels(t)).toEqual(['Scaffolds']);
      expect(t.isExpanded(0)).toBe(false);
    });

    it('can start collapsed', () => {
      const t = new TreeModel();
      t.addGroup(group({ collapsed: true }));
      expect(labels(t)).toEqual(['Scaffolds']);
    });

    it('comes after the models, or before them with a negative order', () => {
      const t = new TreeModel();
      t.setSources([source]);
      t.addGroup(group({ collapsed: true }));
      t.addGroup({ id: 'b', label: 'Bookmarks', children: () => [], order: -1 });
      t.addGroup({ id: 'c', label: 'Clashes', children: () => [], order: 5 });
      t.addGroup({ id: 'm', label: 'Markups', children: () => [] });
      expect(labels(t)).toEqual(['Bookmarks', 'plant.glb', '.Building', 'Scaffolds', 'Markups', 'Clashes']);
      expect(t.isGroupRow(1)).toBe(false);
      expect(t.groupOf(1)).toBeUndefined();
      expect(t.groupList.map((g) => g.id)).toEqual(['b', 'scaffolds', 'm', 'c']);
      // model rows keep their indices (rowModel >= 0)
      expect(t.rowModel[1]).toBe(0);
      expect(t.removeGroup('b')).toBe(true);
      expect(t.removeGroup('b')).toBe(false);
      expect(labels(t)[0]).toBe('plant.glb');
    });

    it('keeps expansion state across refreshes and replacements by node id', () => {
      floors = { s1: 'red', s2: 'green' };
      const t = new TreeModel();
      t.addGroup(group());
      t.toggle(rowOf(t, 'Scaffold B'));
      expect(labels(t)).toEqual(['Scaffolds', '.Scaffold A', '.Scaffold B', '..Floor 1']);
      floors = { s1: 'green', s2: 'red' };
      t.refreshGroup('scaffolds');
      expect(labels(t)).toEqual(['Scaffolds', '.Scaffold A', '.Scaffold B', '..Floor 1']);
      expect(t.groupNode(3)?.badge?.color).toBe('red');
      t.toggle(0);
      t.addGroup(group({ label: 'Scaffolds (2)' })); // same id: replaced in place, state kept
      expect(labels(t)).toEqual(['Scaffolds (2)']);
      t.toggle(0);
      expect(labels(t)).toEqual(['Scaffolds (2)', '.Scaffold A', '.Scaffold B', '..Floor 1']);
      expect(t.groupList.length).toBe(1);
    });

    it('filters virtual nodes too, with the paths to the matches', () => {
      const t = new TreeModel();
      t.setSources([source]);
      t.addGroup(group({ collapsed: true }));
      t.setFilter('floor 2');
      expect(t.matchCount).toBe(1);
      expect(labels(t)).toEqual(['plant.glb', 'Scaffolds', '.Scaffold A', '..Floor 2']);
      expect(t.isMatch(rowOf(t, 'Floor 2'))).toBe(true);
      expect(t.isMatch(rowOf(t, 'Scaffold A'))).toBe(false);
      expect(t.isExpanded(rowOf(t, 'Scaffold A'))).toBe(true);
      t.setFilter('pump');
      expect(labels(t)).toEqual(['plant.glb', '.Building', '..Level 1', '...Pump P-101', '..Level 2', '...Pump P-202', 'Scaffolds']);
      t.setFilter('');
      expect(labels(t)).toEqual(['plant.glb', '.Building', 'Scaffolds']);
    });

    it('reveals a virtual node by expanding its ancestors', () => {
      const t = new TreeModel();
      t.addGroup(group({ collapsed: true }));
      const row = t.revealGroupNode('scaffolds', 's2/f1');
      expect(row).toBe(3);
      expect(t.groupNode(row)?.id).toBe('s2/f1');
      expect(labels(t)).toEqual(['Scaffolds', '.Scaffold A', '.Scaffold B', '..Floor 1']);
      expect(t.revealGroupNode('scaffolds', 'nope')).toBe(-1);
      expect(t.revealGroupNode('nope', 's1')).toBe(-1);
    });

    it('survives a throwing provider', () => {
      const t = new TreeModel();
      const err = console.error;
      console.error = () => {};
      try {
        t.addGroup({ id: 'x', label: 'Broken', children: () => { throw new Error('boom'); } });
      } finally {
        console.error = err;
      }
      expect(labels(t)).toEqual(['Broken']);
      expect(t.hasChildren(0)).toBe(false);
    });

    it('rows without visible / setVisible have no eye and count as shown', () => {
      const t = new TreeModel();
      t.setSources([source]);
      t.addGroup(group());
      t.addGroup({ id: 'half', label: 'Half', children: () => [], visible: () => false }); // no setVisible
      for (let r = 0; r < t.rowCount; r++) {
        expect(t.hasVisibility(r)).toBe(false);
        expect(t.isShown(r)).toBe(true);
        expect(t.toggleVisibility(r)).toBe(false);
      }
    });

    it('the eye of a group header toggles visible() and dims the group', () => {
      let on = true;
      const calls: boolean[] = [];
      const t = new TreeModel();
      t.addGroup(group({ visible: () => on, setVisible: (v) => { calls.push(v); on = v; } }));
      const header = 0;
      expect(t.hasVisibility(header)).toBe(true);
      expect(t.hasVisibility(rowOf(t, 'Scaffold A'))).toBe(false); // only top-level rows
      expect(t.isShown(header)).toBe(true);
      expect(t.toggleVisibility(rowOf(t, 'Scaffold A'))).toBe(false);
      expect(t.toggleVisibility(header)).toBe(true);
      expect(calls).toEqual([false]);
      expect(t.isShown(header)).toBe(false);
      expect(t.isShown(rowOf(t, 'Scaffold B'))).toBe(false); // node rows follow their group
      // the eye neither expands / collapses nor changes the rows
      expect(labels(t)).toEqual(['Scaffolds', '.Scaffold A', '.Scaffold B']);
      t.toggleVisibility(header);
      expect(calls).toEqual([false, true]);
      expect(t.isShown(header)).toBe(true);
    });

    it('re-reads visible() on refresh and readVisibility, and reports changes', () => {
      let on = true;
      const t = new TreeModel();
      t.addGroup(group({ visible: () => on, setVisible: (v) => (on = v) }));
      on = false;
      expect(t.isShown(0)).toBe(true); // cached until re-read
      t.refreshGroup('scaffolds');
      expect(t.isShown(0)).toBe(false);
      on = true;
      expect(t.readVisibility()).toBe(true);
      expect(t.isShown(0)).toBe(true);
      expect(t.readVisibility()).toBe(false);
    });

    it('model rows get an eye from their source, also under a name filter', () => {
      let shown = true;
      const m: TreeSource = { ...source, visible: () => shown, setVisible: (v) => (shown = v) };
      const t = new TreeModel();
      t.setSources([m]);
      t.addGroup(group());
      expect(t.hasVisibility(0)).toBe(true);
      t.setFilter('pump');
      expect(labels(t)[0]).toBe('plant.glb');
      t.toggleVisibility(0);
      expect(shown).toBe(false);
      expect(t.isShown(0)).toBe(false);
      expect(t.isShown(rowOf(t, 'Pump P-101'))).toBe(false);
      expect(t.isShown(rowOf(t, 'Scaffolds'))).toBe(true);
      expect(t.hasVisibility(rowOf(t, 'Scaffolds'))).toBe(false);
      // a model hidden elsewhere: re-read on readVisibility (or setSources)
      shown = true;
      expect(t.readVisibility()).toBe(true);
      expect(t.isShown(0)).toBe(true);
      shown = false;
      t.setSources([m]);
      expect(t.isShown(0)).toBe(false);
    });

    it('a throwing visible() / setVisible() is logged and counts as shown', () => {
      const t = new TreeModel();
      const err = console.error;
      const logged: unknown[] = [];
      console.error = (...a: unknown[]) => logged.push(a);
      try {
        t.addGroup(group({ visible: () => { throw new Error('v'); }, setVisible: () => { throw new Error('s'); } }));
        expect(t.isShown(0)).toBe(true);
        expect(t.toggleVisibility(0)).toBe(true);
      } finally {
        console.error = err;
      }
      expect(t.isShown(0)).toBe(true);
      expect(logged.length).toBeGreaterThanOrEqual(2);
    });
  });
});

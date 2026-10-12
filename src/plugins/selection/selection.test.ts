/**
 * Selection plugin on the real Viewer (fake GL, a synthetic loader with a three-level hierarchy:
 * root > iso nodes > spool nodes > part meshes): levels and the click resolver, the selected
 * nodes, Parent / Child / Sibling, model changes, disposal. Also the viewer's own
 * `setSelectionResolver` click semantics.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from '../../__tests__/headlessViewer';
import type { LoadContext, LoaderPlugin } from '../../loaders';
import { box } from '../../primitives';
import type { PickResult } from '../../types';
import type { ViewerUi } from '../../ui/ViewerUi';
import { DEFAULT_LEVELS, levelNode, selectionPlugin, type SelectionPlugin } from './selectionPlugin';

/**
 * Synthetic format: root "R" > `isos` iso nodes "I<i>" (property Isometric) > `spools` spool nodes
 * "S<i>-<s>" (property Spool) > `parts` part meshes "P<i>-<s>-<p>", plus one loose mesh "Loose"
 * under the root.
 */
interface TreeOptions {
  isos: number;
  spools: number;
  parts: number;
}
const treeLoader: LoaderPlugin<TreeOptions> = {
  name: 'tree',
  extensions: ['tree'],
  up: 'y',
  async load(_source, ctx: LoadContext<TreeOptions>) {
    const { isos = 2, spools = 2, parts = 2 } = ctx.options;
    const mat = ctx.createMaterial({ color: [0.5, 0.5, 0.5] });
    const geom = ctx.createGeometry(box([1, 1, 1]));
    const first = ctx.allocObjectIds(isos * spools * parts + 1);
    const root = ctx.hierarchy.addNode(-1, 'R');
    let id = first;
    const T = (x: number) => {
      const m = new Float64Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      m[12] = x;
      return m;
    };
    for (let i = 0; i < isos; i++) {
      const iso = ctx.hierarchy.addNode(root, `I${i}`, undefined, { Isometric: `I${i}` });
      for (let s = 0; s < spools; s++) {
        const spool = ctx.hierarchy.addNode(iso, `S${i}-${s}`, undefined, { Spool: `S${i}-${s}` });
        for (let p = 0; p < parts; p++) {
          ctx.addMesh({ geometry: geom, material: mat, transform: T(id - first), objectId: id });
          ctx.hierarchy.addNode(spool, `P${i}-${s}-${p}`, id);
          id++;
        }
      }
    }
    ctx.addMesh({ geometry: geom, material: mat, transform: T(id - first), objectId: id });
    ctx.hierarchy.addNode(root, 'Loose', id);
  },
};

let hv: HeadlessViewer | null = null;
afterEach(() => {
  hv?.dispose();
  hv = null;
});

const input = () => new Uint8Array(1);
const LEVELS = [{ label: 'Part' }, { label: 'Spool', key: 'Spool' }, { label: 'Iso', key: 'Isometric' }, { label: 'Up', up: 1 }, { label: 'Top', up: Infinity }];

async function setup(opts: Partial<TreeOptions> = {}, levels = LEVELS) {
  hv = createHeadlessViewer({ loaders: [treeLoader], plugins: [selectionPlugin({ levels })] });
  const v = hv.viewer;
  const model = await v.load(input(), { name: 'a.tree', options: { isos: 2, spools: 2, parts: 2, ...opts } });
  const sel = v.getPlugin<SelectionPlugin>('selection')!;
  const h = model.hierarchy;
  const byName = (name: string): number => {
    for (let n = 0; n < h.nodeCount; n++) if (h.name(n) === name) return n;
    throw new Error(`no node ${name}`);
  };
  const idOf = (name: string): number => h.objectId(byName(name));
  const hit = (name: string): PickResult => ({ meshId: 0, objectId: idOf(name), model, position: [0, 0, 0], distance: 1 });
  const names = (): string[] => sel.nodes.map((n) => n.model.hierarchy.name(n.node)!).sort();
  return { v, sel, model, h, byName, idOf, hit, names };
}

describe('selection plugin', () => {
  it('levels: options, default, setLevel; levelNode by steps and by key', async () => {
    const { sel, model, byName } = await setup();
    expect(sel.levels.map((l) => l.label)).toEqual(['Part', 'Spool', 'Iso', 'Up', 'Top']);
    expect(sel.level).toBe(0);
    sel.setLevel(2);
    expect(sel.level).toBe(2);
    sel.setLevel(9);
    sel.setLevel(-1);
    expect(sel.level).toBe(2);
    expect(DEFAULT_LEVELS.map((l) => [l.label, l.up])).toEqual([['Object', 0], ['Parent', 1], ['Top', Infinity]]);
    expect(() => selectionPlugin({ levels: [] }).install({ viewer: hv!.viewer } as never)).toThrow(/empty/);
    expect(() => selectionPlugin({ levels: [{} as never] }).install({ viewer: hv!.viewer } as never)).toThrow(/label/);

    const part = byName('P1-0-1');
    expect(levelNode(model, part, { label: '' })).toBe(part);
    expect(levelNode(model, part, { label: '', up: 1 })).toBe(byName('S1-0'));
    expect(levelNode(model, part, { label: '', up: 2 })).toBe(byName('I1'));
    expect(levelNode(model, part, { label: '', up: 5 })).toBe(byName('I1')); // stops below the root
    expect(levelNode(model, part, { label: '', up: Infinity })).toBe(byName('I1'));
    expect(levelNode(model, part, { label: '', key: 'Spool' })).toBe(byName('S1-0'));
    expect(levelNode(model, part, { label: '', key: 'Isometric' })).toBe(byName('I1'));
    expect(levelNode(model, part, { label: '', key: 'Nope' })).toBe(part); // no such ancestor: the object
    expect(levelNode(model, byName('Loose'), { label: '', up: Infinity })).toBe(byName('Loose'));
    expect(levelNode(model, byName('S0-1'), { label: '', key: 'Spool' })).toBe(byName('S0-1')); // the node itself counts
  });

  it('resolve and the click resolver: level, toggle adds or removes the whole group', async () => {
    const { v, sel, idOf, hit } = await setup();
    expect(Array.from(sel.resolve(idOf('P0-0-0')))).toEqual([idOf('P0-0-0')]);
    expect(sel.resolve(12345).length).toBe(1); // unknown object: itself
    sel.setLevel(1);
    expect(sel.resolve(idOf('P0-0-0')).length).toBe(2); // the spool's two parts
    sel.setLevel(2);
    expect(sel.resolve(idOf('P0-0-0')).length).toBe(4); // the iso's four parts
    expect(sel.resolve(idOf('Loose')).length).toBe(1);

    // the viewer's click path uses the resolver (selectPicked is what a tap does after the pick)
    sel.setLevel(1);
    v.selectPicked(hit('P0-0-0'), false);
    expect(v.getSelection().length).toBe(2);
    v.selectPicked(hit('P0-0-1'), false); // the same spool: unchanged
    expect(v.getSelection().length).toBe(2);
    v.selectPicked(hit('P0-1-0'), true); // Ctrl: adds the second spool
    expect(v.getSelection().length).toBe(4);
    v.selectPicked(hit('P0-0-1'), true); // Ctrl on a fully selected spool: removes it
    expect(v.getSelection().length).toBe(2);
    v.select([idOf('P1-0-0')]);
    v.selectPicked(hit('P1-0-1'), true); // Ctrl on a partly selected spool: completes it
    expect(v.getSelection().length).toBe(2);
    v.selectPicked(null, true); // Ctrl on the background: keeps
    expect(v.getSelection().length).toBe(2);
    v.selectPicked(null, false); // background: clears
    expect(v.getSelection()).toEqual([]);
    // the context menu's target follows the level when nothing is selected
    expect(v.contextMenuAt(0, 0, 'mouse', hit('P1-1-0')).selection.length).toBe(2);
    expect(v.getSelection()).toEqual([]);

    // removing the plugin restores plain clicks
    v.removePlugin('selection');
    v.selectPicked(hit('P0-0-0'), false);
    expect(v.getSelection().length).toBe(1);
  });

  it('selected nodes: the topmost fully selected nodes; Parent, Child, Sibling', async () => {
    const { v, sel, idOf, names } = await setup();
    const changes: number[] = [];
    sel.on('changed', () => changes.push(sel.nodes.length));
    expect(sel.nodes).toEqual([]);
    v.select([idOf('P0-0-0')]);
    expect(names()).toEqual(['P0-0-0']);
    v.select([idOf('P0-0-0'), idOf('P0-0-1')]); // the whole spool
    expect(names()).toEqual(['S0-0']);
    v.select([idOf('P0-0-0'), idOf('P0-0-1'), idOf('P1-1-0')]);
    expect(names()).toEqual(['P1-1-0', 'S0-0']);
    v.select(v.models[0].objectIds()); // everything: the root
    expect(names()).toEqual(['R']);

    // Parent: parts -> their spool; Child: spool -> parts; Sibling: a part -> the spool's parts
    v.select([idOf('P0-0-0')]);
    sel.parent();
    expect(names()).toEqual(['S0-0']);
    expect(v.getSelection().length).toBe(2);
    sel.parent();
    expect(names()).toEqual(['I0']);
    expect(v.getSelection().length).toBe(4);
    sel.child();
    expect(names()).toEqual(['S0-0', 'S0-1']);
    expect(v.getSelection().length).toBe(4); // the same objects, finer nodes
    sel.child();
    expect(names()).toEqual(['P0-0-0', 'P0-0-1', 'P0-1-0', 'P0-1-1']);
    sel.child(); // leaves stay
    expect(names()).toEqual(['P0-0-0', 'P0-0-1', 'P0-1-0', 'P0-1-1']);
    v.select([idOf('P0-0-0'), idOf('P1-0-0')]);
    sel.sibling();
    expect(names()).toEqual(['P0-0-0', 'P0-0-1', 'P1-0-0', 'P1-0-1']);
    expect(v.getSelection().length).toBe(4);
    sel.parent();
    expect(names()).toEqual(['S0-0', 'S1-0']);
    sel.sibling();
    expect(names()).toEqual(['S0-0', 'S0-1', 'S1-0', 'S1-1']);
    expect(v.getSelection().length).toBe(8);
    sel.parent();
    sel.parent(); // I0, I1 -> R
    expect(names()).toEqual(['R']);
    sel.parent(); // the root stays
    expect(names()).toEqual(['R']);
    expect(v.getSelection().length).toBe(9);
    sel.sibling(); // a root's siblings are the roots
    expect(names()).toEqual(['R']);
    expect(changes.length).toBeGreaterThan(10);

    // the loose mesh is a node of its own under the root
    v.select([idOf('Loose')]);
    sel.sibling();
    expect(names()).toEqual(['I0', 'I1', 'Loose']);
    sel.parent(); // nothing selected after Child of nothing: no-op
    v.select([]);
    expect(sel.nodes).toEqual([]);
    sel.parent();
    sel.child();
    sel.sibling();
    expect(v.getSelection()).toEqual([]);
  });

  it('a second model: nodes per model; unloading recomputes', async () => {
    const { v, sel, idOf, names } = await setup();
    const m2 = await v.load(input(), { name: 'b.tree', options: { isos: 1, spools: 1, parts: 2 } });
    const p2 = m2.hierarchy.objectId(m2.hierarchy.nodeOfObject(m2.objectIds()[0]));
    v.select([idOf('P0-0-0'), p2]);
    expect(sel.nodes.map((n) => n.model.name).sort()).toEqual(['a.tree', 'b.tree']);
    sel.parent();
    expect(names()).toEqual(['S0-0', 'S0-0']); // one spool in each model
    expect(v.getSelection().length).toBe(4);
    m2.unload();
    expect(names()).toEqual(['S0-0']);
  });

  it('removing the plugin clears the resolver and the nodes; ui: false skips the panel', async () => {
    const { v, sel, idOf } = await setup();
    v.select([idOf('P0-0-0')]);
    expect(sel.nodes.length).toBe(1);
    v.removePlugin('selection');
    expect(sel.nodes).toEqual([]);
    sel.parent(); // disposed: no-op
    expect(v.getSelection().length).toBe(1);

    const s = v.use(selectionPlugin({ ui: false, name: 's2' })) as SelectionPlugin;
    const calls: string[] = [];
    const fakeUi = { addToggle: () => calls.push('toggle') } as unknown as ViewerUi;
    const cleanup = s.ui!(fakeUi);
    expect(calls).toEqual([]);
    expect(typeof cleanup).toBe('function');
    expect(s.levels.map((l) => l.label)).toEqual(['Object', 'Parent', 'Top']);
  });
});

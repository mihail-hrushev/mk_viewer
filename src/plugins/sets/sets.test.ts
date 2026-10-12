/**
 * Sets plugin: value parsing, and the headless API on the real Viewer (fake GL, a synthetic
 * loader whose nodes carry names and a Tag property): matching, counts, missing values,
 * selection, isolation, removal, re-resolution when models change, disposal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from '../../__tests__/headlessViewer';
import type { LoadContext, LoaderPlugin } from '../../loaders';
import { box } from '../../primitives';
import type { ViewerUi } from '../../ui/ViewerUi';
import { parseSetValues, setLabel, setsPlugin, type SetsPlugin } from './setsPlugin';

/**
 * Synthetic format: a root, `groups` group nodes named "G<k>" each with `perGroup` leaf meshes
 * named "P<k>-<i>" (with properties Tag = "T<n>" and Batch = "<k>"), plus one loose leaf "Loose".
 */
interface NamedOptions {
  groups: number;
  perGroup: number;
}
const namedLoader: LoaderPlugin<NamedOptions> = {
  name: 'named',
  extensions: ['named'],
  up: 'y',
  async load(_source, ctx: LoadContext<NamedOptions>) {
    const groups = ctx.options.groups ?? 2;
    const perGroup = ctx.options.perGroup ?? 3;
    const mat = ctx.createMaterial({ color: [0.5, 0.5, 0.5] });
    const geom = ctx.createGeometry(box([1, 1, 1]));
    const first = ctx.allocObjectIds(groups * perGroup + 1);
    const root = ctx.hierarchy.addNode(-1, 'root');
    let id = first;
    const T = (x: number) => {
      const m = new Float64Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      m[12] = x;
      return m;
    };
    for (let g = 0; g < groups; g++) {
      const gn = ctx.hierarchy.addNode(root, `G${g}`);
      for (let i = 0; i < perGroup; i++) {
        ctx.addMesh({ geometry: geom, material: mat, transform: T(id - first), objectId: id });
        ctx.hierarchy.addNode(gn, `P${g}-${i}`, id, { Tag: `T${id - first}`, Batch: String(g) });
        id++;
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

async function setup(opts: Partial<NamedOptions> = {}): Promise<{ v: HeadlessViewer['viewer']; sets: SetsPlugin }> {
  hv = createHeadlessViewer({ loaders: [namedLoader], plugins: [setsPlugin()] });
  const v = hv.viewer;
  await v.load(input(), { name: 'a.named', options: { groups: 2, perGroup: 3, ...opts } });
  return { v, sets: v.getPlugin<SetsPlugin>('sets')! };
}

describe('sets plugin: values', () => {
  it('parseSetValues splits on lines, tabs, semicolons and commas; trims; drops empties and duplicates', () => {
    expect(parseSetValues('140')).toEqual(['140']);
    expect(parseSetValues(' 140 \r\n141\n\n 142\t143;144,145,')).toEqual(['140', '141', '142', '143', '144', '145']);
    expect(parseSetValues('a\nA\nb\n a ')).toEqual(['a', 'b']);
    expect(parseSetValues('CMPUBB #2\nspace kept')).toEqual(['CMPUBB #2', 'space kept']); // spaces never separate
    expect(parseSetValues('')).toEqual([]);
    expect(parseSetValues(' \n\t, ')).toEqual([]);
  });

  it('setLabel', () => {
    expect(setLabel('Batch', ['140'])).toBe('Batch = 140');
    expect(setLabel('Batch', ['140', '141'])).toBe('Batch in 2 values');
  });
});

describe('sets plugin: headless API', () => {
  it('add resolves asynchronously: counts, hits, missing values; labels and ids', async () => {
    const { sets } = await setup();
    const changes: number[] = [];
    sets.on('changed', () => changes.push(sets.sets.length));
    expect(sets.add('Batch', '')).toBeNull();
    expect(sets.add('', '1')).toBeNull();
    const a = sets.add('Batch', '1')!;
    expect([a.id, a.label, a.key, a.values, a.resolved, a.objectIds.length, a.hits]).toEqual([1, 'Batch = 1', 'Batch', ['1'], false, 0, null]);
    const b = sets.add('name', ['G0', 'Loose', 'nope', 7])!;
    expect(b.label).toBe('name in 4 values');
    expect(sets.sets.map((s) => s.id)).toEqual([1, 2]);
    expect(sets.objectIdsOf(1).length).toBe(0); // nothing matched synchronously
    await sets.resolve();
    expect(sets.sets.every((s) => s.resolved)).toBe(true);
    expect(sets.objectIdsOf(1).length).toBe(3); // the leaves of G1
    expect(sets.objectIdsOf(2).length).toBe(4); // G0's three leaves + Loose
    expect(Array.from(sets.sets[1].hits!)).toEqual([1, 1, 0, 0]);
    expect(sets.missingValuesOf(2)).toEqual(['nope', '7']);
    expect(sets.missingValuesOf(1)).toEqual([]);
    expect(sets.missingValuesOf(99)).toEqual([]);
    expect(sets.objectIdsOf(99).length).toBe(0);
    expect(changes.length).toBeGreaterThanOrEqual(4); // 2 adds + 2 resolutions
    // the snapshot's values are copies
    (sets.sets[0].values as string[]).push('x');
    expect(sets.sets[0].values).toEqual(['1']);
  });

  it('select replaces or adds to the selection; isolate shows some or all sets', async () => {
    const { v, sets } = await setup();
    const a = sets.add('Batch', '0')!;
    const b = sets.add('name', 'Loose')!;
    await sets.resolve();
    sets.select(a.id);
    expect(v.getSelection().length).toBe(3);
    sets.select(b.id, true);
    expect(v.getSelection().length).toBe(4);
    sets.select(b.id);
    expect(v.getSelection().length).toBe(1);
    sets.select(99);
    expect(v.getSelection()).toEqual([]);
    sets.select(a.id, true); // nothing selected: just the set
    expect(v.getSelection().length).toBe(3);

    const flags = v.scene.fragments.flags;
    const count = (bit: number) => Array.from(v.models[0].meshIds()).filter((f) => flags[f] & bit).length;
    expect(count(1)).toBe(7);
    sets.isolate([a.id]);
    expect([count(1), count(4)]).toEqual([3, 0]);
    v.showAll();
    sets.isolate(undefined, false); // every set, others ghosted
    expect([count(1), count(4)]).toEqual([7, 3]);
    v.showAll();
    sets.isolate([99]); // unknown: nothing to show
    expect(count(1)).toBe(0);
    v.showAll();
  });

  it('remove and clear', async () => {
    const { sets } = await setup();
    const a = sets.add('Batch', '0')!;
    sets.add('Batch', '1');
    expect(sets.remove(a.id)).toBe(true);
    expect(sets.remove(a.id)).toBe(false);
    expect(sets.sets.map((s) => s.label)).toEqual(['Batch = 1']);
    sets.clear();
    expect(sets.sets).toEqual([]);
    expect(sets.add('Batch', '1')!.id).toBe(3); // ids are never reused
  });

  it('re-resolves when a model is loaded or unloaded; force re-runs resolved sets', async () => {
    const { v, sets } = await setup();
    const a = sets.add('name', 'P0-0\nP1-0')!;
    await sets.resolve();
    expect(sets.objectIdsOf(a.id).length).toBe(2);
    const m2 = await v.load(input(), { name: 'b.named', options: { groups: 1, perGroup: 1 } });
    expect(sets.sets[0].resolved).toBe(false); // invalidated synchronously
    await sets.resolve();
    expect(sets.objectIdsOf(a.id).length).toBe(3); // P0-0 of both models, P1-0 of the first
    expect(Array.from(sets.sets[0].hits!)).toEqual([2, 1]);
    m2.unload();
    await sets.resolve();
    expect(sets.objectIdsOf(a.id).length).toBe(2);
    await sets.resolve(true);
    expect(sets.objectIdsOf(a.id).length).toBe(2);
  });

  it('resolve while resolving restarts over every set once', async () => {
    const { sets } = await setup({ groups: 3 });
    sets.add('Batch', '0');
    sets.add('Batch', '1');
    const p1 = sets.resolve();
    sets.add('name', 'G2');
    const p2 = sets.resolve();
    expect(p2).toBe(p1);
    await p1;
    for (const s of sets.sets) expect(s.resolved, s.label).toBe(true);
    expect(sets.objectIdsOf(3).length).toBe(3);
  });

  it('removing the plugin empties the list; add after disposal is refused; ui: false skips the panel', async () => {
    const { v, sets } = await setup();
    sets.add('Batch', '0');
    await sets.resolve();
    v.removePlugin('sets');
    expect(sets.sets).toEqual([]);
    expect(sets.add('Batch', '0')).toBeNull();
    expect(v.getPlugin('sets')).toBeUndefined();

    const s = v.use(setsPlugin({ ui: false, name: 'st' })) as SetsPlugin;
    const calls: string[] = [];
    const fakeUi = { addToggle: () => calls.push('toggle') } as unknown as ViewerUi;
    const cleanup = s.ui!(fakeUi);
    expect(calls).toEqual([]);
    expect(typeof cleanup).toBe('function');
  });
});

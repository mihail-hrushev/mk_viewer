/**
 * Status plugin: row / colour parsing, and the headless API on the real Viewer (fake GL, a
 * synthetic loader whose nodes carry names): matching, counts, selection, colours, removal,
 * re-resolution when models change, disposal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from '../../__tests__/headlessViewer';
import type { LoadContext, LoaderPlugin } from '../../loaders';
import { box } from '../../primitives';
import type { ViewerUi } from '../../ui/ViewerUi';
import {
  DEFAULT_COLOR_NAME,
  DEFAULT_STATUS,
  NAMED_COLORS,
  STATUS_FILE_EXTENSIONS,
  colorToHex,
  detectSeparator,
  isStatusFile,
  parseColor,
  parseStatusRows,
  splitRow,
  statusNameOfFile,
} from './parse';
import { statusPlugin, type StatusPlugin } from './statusPlugin';

/**
 * Synthetic format: a root, `groups` group nodes named "G<k>" each with `perGroup` leaf meshes
 * named "P<k>-<i>" (with a property Tag = "T<n>"), plus one loose leaf "Loose".
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
        ctx.hierarchy.addNode(gn, `P${g}-${i}`, id, { Tag: `T${id - first}` });
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

async function setup(opts: Partial<NamedOptions> = {}): Promise<{ v: HeadlessViewer['viewer']; status: StatusPlugin }> {
  hv = createHeadlessViewer({ loaders: [namedLoader], plugins: [statusPlugin()] });
  const v = hv.viewer;
  await v.load(input(), { name: 'a.named', options: { groups: 2, perGroup: 3, ...opts } });
  return { v, status: v.getPlugin<StatusPlugin>('status')! };
}

describe('status plugin: parsing', () => {
  it('parses colours: hex (3 or 6 digits, # optional), names, invalid', () => {
    expect(parseColor('#00ff00')).toEqual([0, 1, 0]);
    expect(parseColor('00FF00')).toEqual([0, 1, 0]);
    expect(parseColor('#f00')).toEqual([1, 0, 0]);
    expect(parseColor(' Red ')).toEqual([1, 0, 0]);
    expect(parseColor('lime')).toEqual([0, 1, 0]);
    expect(parseColor('grey')).toEqual(parseColor('gray'));
    expect(parseColor(DEFAULT_COLOR_NAME)).toEqual([221 / 255, 221 / 255, 221 / 255]);
    expect(parseColor('')).toBeNull();
    expect(parseColor('#12345')).toBeNull();
    expect(parseColor('notacolour')).toBeNull();
    for (const [name, hex] of Object.entries(NAMED_COLORS)) expect(colorToHex(parseColor(name)!), name).toBe(hex);
    expect(colorToHex([1, 0.5, 0])).toBe('#ff8000');
  });

  it('splits on tabs when there are any, else semicolons, else commas; never on spaces', () => {
    expect(splitRow('a b\tStatus X\t\tred')).toEqual(['a b', 'Status X', '', 'red']);
    expect(splitRow('  CMPUBB #2 ')).toEqual(['CMPUBB #2']);
    expect(splitRow('a b; Status X;;red')).toEqual(['a b', 'Status X', '', 'red']);
    // the separator of the whole text applies to every line, so a lone tag keeps its comma
    expect(detectSeparator('a,b\tS\nc,d\n')).toBe('\t');
    expect(splitRow('c,d', '\t')).toEqual(['c,d']);
    expect(detectSeparator('CMPUBB #2\nCPP4W540 #2\n')).toBeNull();
    expect(parseStatusRows('CMPUBB #2\nCPP4W540 #2\n').map((r) => [r.tag, r.status, r.state])).toEqual([
      ['CMPUBB #2', DEFAULT_STATUS, 'CMPUBB #2'],
      ['CPP4W540 #2', DEFAULT_STATUS, 'CPP4W540 #2'],
    ]);
    expect(parseStatusRows('CMPUBB #2\tS\nC1F2NK3\n').map((r) => [r.tag, r.status])).toEqual([
      ['CMPUBB #2', 'S'],
      ['C1F2NK3', DEFAULT_STATUS],
    ]);
    expect(splitRow('a b,Status X,,red')).toEqual(['a b', 'Status X', '', 'red']);
    // a tab wins over a semicolon, a semicolon over a comma
    expect(splitRow('a;b\tc,d')).toEqual(['a;b', 'c,d']);
    expect(splitRow('a,b;c')).toEqual(['a,b', 'c']);
    // double-quoted cells (Excel CSV): quotes stripped, "" is one quote
    expect(splitRow('"304-SP001";"Erection";"Fab ""A""";"#ff0"')).toEqual(['304-SP001', 'Erection', 'Fab "A"', '#ff0']);
    expect(splitRow('"a,b",c')).toEqual(['"a', 'b"', 'c']); // a separator inside quotes is not supported
  });

  it('parses CSV files: BOM, header line, semicolons, a default status', () => {
    const csv = '\uFEFFTag;Status;State;Colour\r\n304-SP001;Erection;Fab;yellow\r\n440-SP003;;Erected;\r\n';
    expect(parseStatusRows(csv).map((r) => [r.tag, r.status, r.state, r.color])).toEqual([
      ['304-SP001', 'Erection', 'Fab', 'yellow'],
      ['440-SP003', DEFAULT_STATUS, 'Erected', DEFAULT_COLOR_NAME],
    ]);
    expect(parseStatusRows(csv, { defaultStatus: 'Painting' })[1].status).toBe('Painting');
    expect(parseStatusRows('x', { defaultStatus: '  ' })[0].status).toBe(DEFAULT_STATUS);
    // the header is only skipped as the first non-empty line; "tag" later is a tag
    expect(parseStatusRows('\n  \ntag\nTAG,S\n').map((r) => r.tag)).toEqual(['TAG']);
    expect(parseStatusRows('a\nTag\n').map((r) => r.tag)).toEqual(['a', 'Tag']);
    // a one-column file: a tag per line
    expect(parseStatusRows('A\nB\n', { defaultStatus: 'Erection' }).map((r) => [r.tag, r.status, r.state])).toEqual([
      ['A', 'Erection', 'A'],
      ['B', 'Erection', 'B'],
    ]);
  });

  it('recognises row files by extension and names the status after the file', () => {
    expect(STATUS_FILE_EXTENSIONS).toEqual(['csv', 'tsv', 'txt']);
    expect(isStatusFile('Erection.csv')).toBe(true);
    expect(isStatusFile('a.TSV')).toBe(true);
    expect(isStatusFile('notes.txt')).toBe(true);
    expect(isStatusFile('model.glb')).toBe(false);
    expect(isStatusFile('csv')).toBe(false);
    expect(statusNameOfFile('Erection.csv')).toBe('Erection');
    expect(statusNameOfFile('C:\\x\\Painting status.CSV')).toBe('Painting status');
    expect(statusNameOfFile('/a/b/.csv')).toBe('.csv');
    expect(statusNameOfFile('noext')).toBe('noext');
  });

  it('parses rows with defaults and skips empty lines and lines without a tag', () => {
    const rows = parseStatusRows('304-SP001\tErection\tFab\tyellow\r\n\n440-SP003\tErection\tErected\t#00ff00\n\tx\ty\tz\nnoMatch\n  \nT2\t\t\tpurple\nT3\tS\tSt\tnope');
    expect(rows.map((r) => [r.tag, r.status, r.state, r.color])).toEqual([
      ['304-SP001', 'Erection', 'Fab', 'yellow'],
      ['440-SP003', 'Erection', 'Erected', '#00ff00'],
      ['noMatch', DEFAULT_STATUS, 'noMatch', DEFAULT_COLOR_NAME],
      ['T2', DEFAULT_STATUS, 'T2', 'purple'],
      ['T3', 'S', 'St', 'nope'],
    ]);
    expect(rows[0].rgb).toEqual([1, 1, 0]);
    expect(rows[2].rgb).toEqual(parseColor(DEFAULT_COLOR_NAME));
    expect(rows[4].rgb).toBeNull();
  });
});

describe('status plugin: headless API', () => {
  it('builds the legend from rows, matches tags to node names asynchronously, counts per state', async () => {
    const { v, status } = await setup();
    const changes: number[] = [];
    status.on('changed', () => changes.push(status.statuses.flatMap((s) => s.states).filter((s) => s.resolved).length));
    const r = status.add('P0-0\tErection\tFab\tyellow\nG1\tErection\tErected\t#00ff00\nnoMatch\tErection\tNoMatch\tred\nloose\n');
    expect(r).toEqual({ rows: 4, invalidColors: [] });
    // nothing matched synchronously: the legend is there with pending counts
    let [erection, def] = status.statuses;
    expect(erection.name).toBe('Erection');
    expect(erection.checked).toBe(false);
    expect(erection.states.map((s) => [s.name, s.colorText, s.resolved, s.objectIds.length])).toEqual([
      ['Fab', 'yellow', false, 0],
      ['Erected', '#00ff00', false, 0],
      ['NoMatch', 'red', false, 0],
    ]);
    expect(def.name).toBe(DEFAULT_STATUS);
    expect(def.states[0].name).toBe('loose');
    expect(changes).toEqual([0]);

    await status.resolve();
    [erection, def] = status.statuses;
    const fab = erection.states[0];
    expect(fab.resolved).toBe(true);
    expect(fab.objectIds.length).toBe(1); // the leaf P0-0
    expect(Array.from(fab.hits!)).toEqual([1]);
    expect(fab.color).toEqual([1, 1, 0]);
    expect(erection.states[1].objectIds.length).toBe(3); // the group G1: its 3 leaves (the group has no own object)
    expect(erection.states[2].objectIds.length).toBe(0);
    expect(Array.from(erection.states[2].hits!)).toEqual([0]);
    expect(def.states[0].objectIds.length).toBe(1); // case-insensitive: "loose" finds "Loose"
    // one 'changed' per resolved state, states resolved one at a time
    expect(changes).toEqual([0, 1, 2, 3, 4]);
    // the snapshot is a copy
    (erection.states as unknown[]).length = 0;
    expect(status.statuses[0].states.length).toBe(3);
    expect(v.getSelection()).toEqual([]);
  });

  it('later rows merge: known states get tags (no duplicates), a non-default colour recolours, a tag may be in two states', async () => {
    const { status } = await setup();
    status.add('P0-0\tS\tA\tred\nP0-1\tS\tA\tred');
    const r = status.add('p0-0\tS\tA\nP0-0\tS\tB\tblue\nP0-2\tS\tA\tgreen\nP1-0\tS\tC\tbogus\nP1-1\tS\tC\t#DDDDDD');
    expect(r).toEqual({ rows: 5, invalidColors: ['bogus'] });
    await status.resolve();
    const [s] = status.statuses;
    expect(s.states.map((st) => [st.name, st.tags, st.colorText, st.objectIds.length])).toEqual([
      ['A', ['P0-0', 'P0-1', 'P0-2'], 'green', 3],
      ['B', ['P0-0'], 'blue', 1],
      ['C', ['P1-0', 'P1-1'], DEFAULT_COLOR_NAME, 2],
    ]);
    expect(status.objectIdsOf('S').length).toBe(5); // P0-0 counted once in the union
    expect(status.objectIdsOf('S', 'B')).toEqual(s.states[1].objectIds);
    expect(status.objectIdsOf('nope').length).toBe(0);
    expect(status.objectIdsOf('S', 'nope').length).toBe(0);
  });

  it('select, applyColors (checked statuses by default), resetColors, remove and clear undo the colours', async () => {
    const { v, status } = await setup();
    status.add('P0-0\tS1\tA\tred\nG1\tS1\tB\t#00ff00\nLoose\tS2\tL\tblue');
    await status.resolve();
    status.select('S1', 'B');
    expect(v.getSelection().length).toBe(3);
    status.select('S1');
    expect(v.getSelection().length).toBe(4);
    // add = true: union with the current selection (no duplicates, sorted)
    status.select('S2', 'L', true);
    expect(v.getSelection().length).toBe(5);
    status.select('S1', 'A', true);
    expect(v.getSelection().length).toBe(5);
    const sel = v.getSelection();
    expect(sel).toEqual([...sel].sort((a, b) => a - b));
    status.select('S2', 'nope', true); // an unknown state adds nothing
    expect(v.getSelection().length).toBe(5);
    v.select([]);
    status.select('S2', 'L', true); // nothing selected: just the state
    expect(v.getSelection().length).toBe(1);

    status.applyColors(); // nothing checked
    expect(v.getColoredObjects().length).toBe(0);
    status.setChecked('S1', true);
    expect(status.statuses[0].checked).toBe(true);
    status.applyColors();
    expect(v.getColoredObjects().length).toBe(4);
    const a = status.objectIdsOf('S1', 'A')[0];
    const b = status.objectIdsOf('S1', 'B')[0];
    expect(v.getColor(a)).toEqual([1, 0, 0, 1]);
    expect(v.getColor(b)).toEqual([0, 1, 0, 1]);
    status.applyColors(['S2']); // explicit list ignores the check boxes
    expect(v.getColoredObjects().length).toBe(5);
    status.resetColors(['S1']);
    expect(v.getColoredObjects().length).toBe(1);
    status.applyColors(['S1']);
    expect(status.remove('S1')).toBe(true);
    expect(status.remove('S1')).toBe(false);
    expect(v.getColoredObjects().length).toBe(1); // only S2's object stays coloured
    expect(status.statuses.map((s) => s.name)).toEqual(['S2']);
    status.clear();
    expect(status.statuses).toEqual([]);
    expect(v.getColoredObjects().length).toBe(0);
  });

  it('isolate shows only the checked statuses (hiding or ghosting the rest); showAll undoes it', async () => {
    const { v, status } = await setup();
    status.add('P0-0\tS1\tA\tred\nG1\tS1\tB\tblue\nP0-1\tS2\tC\tgreen');
    await status.resolve();
    const flags = v.scene.fragments.flags;
    const count = (bit: number) => Array.from(v.models[0].meshIds()).filter((f) => flags[f] & bit).length;
    expect(count(1)).toBe(7);
    status.setChecked('S1', true);
    status.isolate(); // the checked statuses, others hidden
    expect([count(1), count(4)]).toEqual([4, 0]); // P0-0 and the 3 leaves of G1
    v.showAll();
    status.isolate(['S2'], false); // an explicit list, others ghosted
    expect([count(1), count(4)]).toEqual([7, 6]);
    v.showAll();
    expect([count(1), count(4)]).toEqual([7, 0]);
    status.setChecked('S1', false);
    status.isolate(); // nothing checked: nothing to show
    expect(count(1)).toBe(0);
    v.showAll();
  });

  it('re-resolves when a model is loaded or unloaded; force re-runs resolved states', async () => {
    const { v, status } = await setup();
    status.add('P0-0\tS\tA\nP1-0\tS\tA');
    await status.resolve();
    expect(status.objectIdsOf('S').length).toBe(2);
    const m2 = await v.load(input(), { name: 'b.named', options: { groups: 1, perGroup: 1 } });
    expect(status.statuses[0].states[0].resolved).toBe(false); // invalidated synchronously
    await status.resolve();
    expect(status.objectIdsOf('S').length).toBe(3); // P0-0 of both models, P1-0 of the first
    m2.unload();
    await status.resolve();
    expect(status.objectIdsOf('S').length).toBe(2);
    await status.resolve(true);
    expect(status.objectIdsOf('S').length).toBe(2);
  });

  it('resolve while resolving restarts over every state once', async () => {
    const { status } = await setup({ groups: 3 });
    status.add('P0-0\tS\tA\nP1-0\tS\tB\nP2-0\tS\tC');
    const p1 = status.resolve();
    status.add('G0\tT\tX');
    const p2 = status.resolve();
    expect(p2).toBe(p1);
    await p1;
    for (const s of status.statuses) for (const st of s.states) expect(st.resolved, `${s.name}/${st.name}`).toBe(true);
    expect(status.objectIdsOf('T').length).toBe(3);
  });

  it('removing the plugin removes the colours and empties the legend; ui: false skips the panel', async () => {
    const { v, status } = await setup();
    status.add('P0-0\tS\tA\tred');
    await status.resolve();
    status.applyColors(['S']);
    expect(v.getColoredObjects().length).toBe(1);
    v.removePlugin('status');
    expect(v.getColoredObjects().length).toBe(0);
    expect(status.statuses).toEqual([]);
    expect(v.getPlugin('status')).toBeUndefined();

    const st = v.use(statusPlugin({ ui: false, name: 'st' })) as StatusPlugin;
    const calls: string[] = [];
    const fakeUi = { addToggle: () => calls.push('toggle') } as unknown as ViewerUi;
    const cleanup = st.ui!(fakeUi);
    expect(calls).toEqual([]);
    expect(typeof cleanup).toBe('function');
  });

  it('addFile reads a CSV file, skips its header and names the status after the file when the column is empty', async () => {
    const { status } = await setup();
    const csv = new File(['﻿Tag;Status;State;Colour\r\nP0-0;;Fab;yellow\r\nG1;Painting;Done;#00ff00\r\n'], 'Erection.csv', { type: 'text/csv' });
    const r = await status.addFile(csv);
    expect(r).toEqual({ rows: 2, invalidColors: [] });
    const tags = new File(['loose\nP0-1\n'], 'Hydrotest.txt');
    expect(await status.addFile(tags)).toEqual({ rows: 2, invalidColors: [] });
    await status.resolve();
    expect(status.statuses.map((s) => [s.name, s.states.map((st) => [st.name, st.colorText, st.objectIds.length])])).toEqual([
      ['Erection', [['Fab', 'yellow', 1]]],
      ['Painting', [['Done', '#00ff00', 3]]],
      ['Hydrotest', [['loose', DEFAULT_COLOR_NAME, 1], ['P0-1', DEFAULT_COLOR_NAME, 1]]],
    ]);
    // after disposal the file's rows are dropped
    hv!.viewer.removePlugin('status');
    expect(await status.addFile(tags)).toEqual({ rows: 0, invalidColors: [] });
    expect(status.statuses).toEqual([]);
  });

  it('a custom key matches another property', async () => {
    hv = createHeadlessViewer({ loaders: [namedLoader], plugins: [statusPlugin({ key: 'Tag' })] });
    const status = hv.viewer.getPlugin<StatusPlugin>('status')!;
    await hv.viewer.load(input(), { name: 'a.named', options: { groups: 1, perGroup: 2 } });
    status.add('T1\tS\tA\nP0-0\tS\tA');
    await status.resolve();
    expect(status.objectIdsOf('S').length).toBe(1);
    expect(Array.from(status.statuses[0].states[0].hits!)).toEqual([1, 0]);
  });
});

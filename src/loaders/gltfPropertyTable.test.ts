/**
 * glTF `MK_property_table`: node properties stored as a key/value row table in the BIN chunk must
 * behave exactly like the same properties written as nested node `extras`.
 */
import { describe, expect, it, vi } from 'vitest';
import { GltfBuilder, TRI } from './__tests__/gltfBuilder';
import { createMockViewer } from './__tests__/mockViewer';
import { LoaderRegistry, loadModel, registerDefaultLoaders, type Model, type NodeProperties } from './index';
import { propertyRows } from '../ui/propertyRows';

const registry = registerDefaultLoaders(new LoaderRegistry());
const load = (bytes: Uint8Array) => loadModel(createMockViewer(), bytes, { registry, name: 'test.glb' });

// node builtins without @types/node
const nodeRequire = (globalThis as any).process?.getBuiltinModule as ((id: string) => any) | undefined;
const fs = nodeRequire?.('node:fs');
const pathMod = nodeRequire?.('node:path');
const proc = (globalThis as any).process;

type Props = Record<string, Record<string, string | number | boolean>>;

/**
 * Node properties of the test scene, by node: 0 is the scene root (none), 1-2 groups, 3-6 leaves
 * (5 has none). Covers every value type, a string and a number with the same text, dotted names,
 * inherited categories overridden by a child, non-ASCII text and `__proto__` as a property name.
 */
function sceneProps(): (Props | undefined)[] {
  const proto: Record<string, string> = {};
  Object.defineProperty(proto, '__proto__', { value: 'p', enumerable: true, writable: true, configurable: true });
  return [
    undefined,
    { Item: { Name: 'Unit 1', Type: 'Group' }, 'SmartPlant 3D': { Area: 'A-100', Approved: true } },
    { Item: { Name: 'Spool 7', Type: 'Group' }, EP3D: { Spool: 'SP-7', Count: 2 } },
    { Item: { Name: 'Pipe 1', Type: 'Geometry' }, 'SmartPlant 3D': { Weight: 12.5, Tag: '1', Approved: false } },
    { Item: { Name: 'Pipe 2 éß "q"', Type: 'Geometry' }, 'SmartPlant 3D': { Weight: 1, Tag: 'x' }, 'Dotted.Cat': { 'a.b': 'dot', ...proto } },
    undefined,
    { Item: { Name: 'Valve', Type: 'Geometry' }, EP3D: { Date: '2024-05-01T00:00:00.0000000', Count: 2 } },
  ];
}

/** Builds the scene; properties as node extras, or as an MK_property_table (key accessor u16/u32). */
function buildScene(props: (Props | undefined)[], mode: 'extras' | 'u16' | 'u32', opts: { extraKeys?: number } = {}): Uint8Array {
  const b = new GltfBuilder();
  const mesh = b.mesh([{ attributes: { POSITION: b.accessor(TRI, 'VEC3') } }]);
  // 0 root -> 1 -> 3, 4 ; 0 -> 2 -> 5, 6
  const kids = [[1, 2], [3, 4], [5, 6], [], [], [], []];
  for (let i = 0; i < kids.length; i++) {
    const n: any = { name: `n${i}` };
    if (kids[i].length) n.children = kids[i];
    else n.mesh = mesh;
    if (mode === 'extras' && props[i]) n.extras = props[i];
    b.node(n, i === 0);
  }
  if (mode !== 'extras') {
    const keys: [string, string][] = [];
    const values: (string | number | boolean)[] = [];
    const keyId = new Map<string, number>();
    const valId = new Map<string, number>();
    const rowKey: number[] = [], rowVal: number[] = [];
    const nodeStart = [0];
    const row = (cat: string, prop: string, v: string | number | boolean) => {
      const kk = JSON.stringify([cat, prop]);
      let k = keyId.get(kk);
      if (k === undefined) keyId.set(kk, (k = keys.push([cat, prop]) - 1));
      const vk = typeof v + ':' + String(v); // the string '1' and the number 1 stay separate values
      let w = valId.get(vk);
      if (w === undefined) valId.set(vk, (w = values.push(v) - 1));
      rowKey.push(k);
      rowVal.push(w);
    };
    for (let i = 0; i < kids.length; i++) {
      const p = props[i];
      if (p) for (const cat of Object.keys(p)) for (const prop of Object.keys(p[cat])) row(cat, prop, p[cat][prop]);
      if (i === kids.length - 1) for (let e = 0; e < (opts.extraKeys ?? 0); e++) row('Wide', `k${e}`, e);
      nodeStart.push(rowKey.length);
    }
    const ext = {
      version: 1,
      keys,
      values,
      nodeStart: b.accessor(Uint32Array.from(nodeStart), 'SCALAR'),
      key: b.accessor(mode === 'u16' ? Uint16Array.from(rowKey) : Uint32Array.from(rowKey), 'SCALAR'),
      value: b.accessor(Uint32Array.from(rowVal), 'SCALAR'),
    };
    b.json.extensionsUsed = ['MK_property_table'];
    b.json.extensions = { MK_property_table: ext };
  }
  return b.glb();
}

/** Everything a client can observe about the node properties of a model. */
function observe(m: Model) {
  const h = m.hierarchy;
  const nodes: unknown[] = [];
  for (let i = 0; i < h.nodeCount; i++) {
    const own = h.properties(i);
    const inh = h.properties(i, true);
    nodes.push({
      own: own && JSON.stringify(own), // JSON keeps key order: display order must match too
      inherited: inh && JSON.stringify(inh),
      rows: propertyRows(inh),
      objectProps: Number.isNaN(h.objectId(i)) ? undefined : JSON.stringify(m.getProperties(h.objectId(i))),
    });
  }
  const idx = m.properties;
  const keys = idx.keys();
  const values = keys.map((k) => idx.values(k.key));
  const q = (query: Parameters<typeof idx.find>[0]) => {
    const r = idx.find(query);
    return { objectIds: Array.from(r.objectIds), nodes: Array.from(r.nodes), values: r.values, hits: r.hits && Array.from(r.hits) };
  };
  const finds = [
    q({ key: 'Item.Type', equals: 'group' }),
    q({ key: 'SmartPlant 3D.Weight', min: 2 }),
    q({ key: 'SmartPlant 3D.Tag', in: ['1', 'X', 'none'] }),
    q({ key: 'SmartPlant 3D.Approved', equals: 'true' }),
    q({ key: 'Dotted.Cat.a.b', equals: 'dot' }),
    q({ key: 'EP3D.Count', equals: 2 }),
    q({ key: 'name', startsWith: 'n' }),
  ];
  return { nodes, keys, values, finds };
}

describe('glTF loader: MK_property_table', () => {
  it.each(['u16', 'u32'] as const)('rows (%s key accessor) behave exactly like nested extras', async (mode) => {
    const props = sceneProps();
    const ref = await load(buildScene(props, 'extras'));
    const tab = await load(buildScene(props, mode));
    expect(tab.warnings).toEqual([]);
    const a = observe(ref), b = observe(tab);
    expect(b).toEqual(a);
    // sanity: the reference really contains what the test is about
    expect(tab.hierarchy.properties(0)).toBeUndefined();
    expect(tab.hierarchy.properties(5)).toBeUndefined();
    expect(tab.hierarchy.properties(4)).toEqual(props[4]);
    expect(Object.prototype.hasOwnProperty.call(tab.hierarchy.properties(4)!['Dotted.Cat'], '__proto__')).toBe(true);
    expect(({} as any).p).toBeUndefined();
    expect(tab.hierarchy.properties(3, true)!['SmartPlant 3D']).toEqual({ Weight: 12.5, Tag: '1', Approved: false });
    expect(b.keys.map((k) => k.key)).toContain('Dotted.Cat.a.b');
    expect(b.finds[2].hits).toEqual([1, 1, 0]);
    expect(b.finds[3].nodes).toEqual([1]);
  });

  it('a uint32 key accessor with more than 65535 keys', async () => {
    const props = sceneProps();
    const m = await load(buildScene(props, 'u32', { extraKeys: 70000 }));
    expect(m.warnings).toEqual([]);
    const own = m.hierarchy.properties(6)!;
    expect(Object.keys(own.Wide as object).length).toBe(70000);
    expect((own.Wide as NodeProperties).k69999).toBe(69999);
    expect(m.properties.find({ key: 'Wide.k65536', equals: 65536 }).nodes).toEqual(Int32Array.from([6]));
    expect(m.properties.keys().length).toBe(70000 + new Set(observe(await load(buildScene(props, 'extras'))).keys.map((k) => k.key)).size);
  });

  it('nodes without rows keep their extras; the table wins otherwise', async () => {
    const b = new GltfBuilder();
    const mesh = b.mesh([{ attributes: { POSITION: b.accessor(TRI, 'VEC3') } }]);
    b.node({ name: 'root', children: [1, 2], extras: { Old: { a: 1 } } }, true);
    b.node({ name: 'a', mesh, extras: { Old: { a: 2 } } });
    b.node({ name: 'b', mesh });
    b.json.extensionsUsed = ['MK_property_table'];
    b.json.extensions = {
      MK_property_table: {
        version: 1,
        keys: [['New', 'x']],
        values: ['y'],
        nodeStart: b.accessor(Uint32Array.from([0, 0, 1, 1]), 'SCALAR'),
        key: b.accessor(Uint16Array.from([0]), 'SCALAR'),
        value: b.accessor(Uint32Array.from([0]), 'SCALAR'),
      },
    };
    const m = await load(b.glb());
    expect(m.hierarchy.properties(0)).toEqual({ Old: { a: 1 } });
    expect(m.hierarchy.properties(1)).toEqual({ New: { x: 'y' } });
    expect(m.hierarchy.properties(1, true)).toEqual({ Old: { a: 1 }, New: { x: 'y' } });
    expect(m.getProperties(m.hierarchy.objectId(1))!.extras).toEqual({ New: { x: 'y' } });
    expect(m.properties.keys().map((k) => k.key)).toEqual(['New.x', 'Old.a', 'name']);
  });

  it('an unknown version or an inconsistent table falls back to extras with a warning', async () => {
    const make = (ext: Record<string, unknown>) => {
      const b = new GltfBuilder();
      const mesh = b.mesh([{ attributes: { POSITION: b.accessor(TRI, 'VEC3') } }]);
      b.node({ name: 'a', mesh, extras: { E: { v: 1 } } }, true);
      b.json.extensionsUsed = ['MK_property_table'];
      b.json.extensions = {
        MK_property_table: {
          version: 1,
          keys: [['T', 'v']],
          values: [2],
          nodeStart: b.accessor(Uint32Array.from([0, 1]), 'SCALAR'),
          key: b.accessor(Uint16Array.from([0]), 'SCALAR'),
          value: b.accessor(Uint32Array.from([0]), 'SCALAR'),
          ...ext,
        },
      };
      return b.glb();
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const v2 = await load(make({ version: 2 }));
      expect(v2.hierarchy.properties(0)).toEqual({ E: { v: 1 } });
      expect(v2.warnings.join()).toMatch(/version 2 is not supported/);
      await load(make({ version: 3 }));
      expect(warn).toHaveBeenCalledTimes(1); // console: once per session
    } finally {
      warn.mockRestore();
    }
    const bad = await load(make({ values: [] })); // value index 0 out of range
    expect(bad.hierarchy.properties(0)).toEqual({ E: { v: 1 } });
    expect(bad.warnings.join()).toMatch(/MK_property_table ignored: .*row 0 is out of range/);
    const short = await load(make({ keys: [['T']] }));
    expect(short.warnings.join()).toMatch(/keys must be/);
    expect(short.hierarchy.properties(0)).toEqual({ E: { v: 1 } });
  });

  it('keepNames: false reads no table', async () => {
    const m = await loadModel(createMockViewer(), buildScene(sceneProps(), 'u16'), { registry, name: 't.glb', options: { keepNames: false } });
    expect(m.hierarchy.properties(3)).toBeUndefined();
    expect(m.properties.keys()).toEqual([]);
  });

  // files written by the MK Navisworks plugin's exporter (conformance)
  const samples: [string, string][] = [];
  if (fs && pathMod) {
    samples.push([pathMod.resolve(proc.cwd(), 'src/loaders/__tests__/fixtures/mk-property-table.glb'), 'mk-property-table.expected.json']);
    const dir = proc.env?.MK_PROPERTY_TABLE_SAMPLES; // folder with table-wide.glb (+ .expected.json), optional
    if (dir) samples.push([pathMod.join(dir, 'table-wide.glb'), 'table-wide.glb.expected.json']);
  }
  for (const [file, expected] of samples) {
    const present = fs.existsSync(file);
    it.skipIf(!present)(`plugin sample ${pathMod.basename(file)} decodes to the expected properties`, async () => {
      const exp = JSON.parse(fs.readFileSync(pathMod.join(pathMod.dirname(file), expected), 'utf8')) as Props[];
      const m = await load(new Uint8Array(fs.readFileSync(file)));
      expect(m.warnings).toEqual([]);
      expect(m.hierarchy.nodeCount).toBe(exp.length);
      for (let i = 0; i < exp.length; i++) {
        const own = m.hierarchy.properties(i);
        // display order matters: compare as JSON text
        expect(JSON.stringify(own ?? {})).toBe(JSON.stringify(exp[i]));
      }
    });
  }
});

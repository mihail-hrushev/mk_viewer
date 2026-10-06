/**
 * Integration: TestModels/SPOOLS-811.glb (9 MB, not in git; a PCF-derived spool model whose
 * isometric and spool group nodes carry `extras`). Checks the property index against the file's own
 * JSON and reports build / query times. Skips when the file is absent.
 */
import { describe, expect, it } from 'vitest';
import { createMockViewer } from './__tests__/mockViewer';
import { LoaderRegistry, loadModel, registerDefaultLoaders } from './index';

const nodeRequire = (globalThis as any).process?.getBuiltinModule as ((id: string) => any) | undefined;
const fs = nodeRequire?.('node:fs');
const pathMod = nodeRequire?.('node:path');
const proc = (globalThis as any).process;
const FILE = fs && pathMod ? pathMod.resolve(proc.cwd(), 'TestModels/SPOOLS-811.glb') : '';
const present = !!fs && fs.existsSync(FILE);

interface JsonNode {
  name?: string;
  mesh?: number;
  children?: number[];
  extras?: Record<string, string>;
}

function jsonNodes(): JsonNode[] {
  const buf: Uint8Array = fs.readFileSync(FILE);
  const jl = new DataView(buf.buffer, buf.byteOffset).getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jl))).nodes;
}

describe.skipIf(!present)('SPOOLS-811.glb property index', () => {
  it('finds thousands of spools in one query and reports misses', async () => {
    const nodes = jsonNodes();
    const v = createMockViewer();
    const registry = registerDefaultLoaders(new LoaderRegistry());
    const model = await loadModel(v, fs.readFileSync(FILE), { registry, name: 'SPOOLS-811.glb' });
    const h = model.hierarchy;
    expect(h.nodeCount).toBe(nodes.length);

    const buildMs = model.properties.build();
    const keys = model.properties.keys();
    const byKey = new Map(keys.map((k) => [k.key, k]));
    // every extras key of the file is indexed, with the right node counts
    const expectedCounts = new Map<string, number>();
    const spools: string[] = [];
    for (const n of nodes) {
      if (!n.extras) continue;
      for (const k of Object.keys(n.extras)) expectedCounts.set(k, (expectedCounts.get(k) ?? 0) + 1);
      if (n.extras.Spool) spools.push(n.extras.Spool);
    }
    for (const [k, c] of expectedCounts) expect(byKey.get(k)?.count, k).toBe(c);
    expect(byKey.get('Weight')!.numeric).toBe(true);
    expect(byKey.get('Spool')!.distinct).toBe(new Set(spools).size);

    // a list query with every spool (lower-cased, some padded) plus unknown values
    const list = spools.map((s, i) => (i % 3 === 0 ? ` ${s.toLowerCase()} ` : s));
    const missing = ['NOPE-1', 'NOPE-2', 'NOPE-3'];
    const t0 = performance.now();
    const r = model.properties.find({ key: 'Spool', in: list.concat(missing) });
    const queryMs = performance.now() - t0;
    for (let i = 0; i < list.length; i++) expect(r.hits![i]).toBe(1);
    for (let i = 0; i < missing.length; i++) expect(r.hits![list.length + i]).toBe(0);
    expect(r.nodes.length).toBe(spools.length);
    // every spool's objects = its mesh children
    let expectedObjects = 0;
    for (const n of nodes) if (n.extras?.Spool) expectedObjects += (n.children ?? []).filter((c) => nodes[c].mesh !== undefined).length;
    expect(r.objectIds.length).toBe(expectedObjects);
    for (let i = 1; i < r.objectIds.length; i++) expect(r.objectIds[i]).toBeGreaterThan(r.objectIds[i - 1]);

    // a single spool: its objects are exactly the leaves below the node, and inherited properties work
    const one = model.properties.find({ key: 'Spool', equals: spools[5] });
    expect(one.nodes.length).toBe(1);
    const node = one.nodes[0];
    expect(h.properties(node)!.Spool).toBe(spools[5]);
    const leaf = h.children(node)[0];
    expect(h.properties(leaf)).toBeUndefined();
    expect(h.properties(leaf, true)!.Spool).toBe(spools[5]);
    expect(h.properties(leaf, true)!.Units).toBe('metre'); // from the root node
    expect(Array.from(one.objectIds)).toEqual(Array.from(model.properties.objectsUnder(node)));

    // numeric range on Weight
    const heavy = model.properties.find({ key: 'Weight', min: 100 });
    for (const val of heavy.values) expect(Number(val)).toBeGreaterThanOrEqual(100);
    const fab = model.properties.find({ key: 'Category', equals: 'fabrication' });
    expect(fab.nodes.length).toBe(nodes.filter((n) => n.extras?.Category === 'FABRICATION').length);

    console.log(
      `SPOOLS-811: ${h.nodeCount} nodes, ${keys.length} keys, index built in ${buildMs.toFixed(1)} ms; ` +
        `${list.length + missing.length}-value list query in ${queryMs.toFixed(2)} ms -> ${r.objectIds.length} objects`,
    );
  });
});

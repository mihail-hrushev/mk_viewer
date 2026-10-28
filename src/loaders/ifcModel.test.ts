/**
 * Integration: loads the first .ifc in TestModels/ (not in git) through `loadModel` with the
 * recording mock viewer. Skips when there is none.
 */
import { describe, expect, it } from 'vitest';
import { createMockViewer } from './__tests__/mockViewer';
import { LoaderRegistry, ifcLoader, loadModel } from './index';

// node builtins without @types/node
const nodeRequire = (globalThis as any).process?.getBuiltinModule as ((id: string) => any) | undefined;
const fs = nodeRequire?.('node:fs');
const pathMod = nodeRequire?.('node:path');
const proc = (globalThis as any).process;
const DIR = fs && pathMod ? pathMod.resolve(proc.cwd(), 'TestModels') : '';
const FILE = DIR && fs.existsSync(DIR) ? fs.readdirSync(DIR).find((f: string) => f.toLowerCase().endsWith('.ifc')) : undefined;

describe.skipIf(!FILE)('IFC test model', () => {
  it('loads geometry, the spatial tree and properties', async () => {
    const r = new LoaderRegistry();
    r.register(ifcLoader);
    const v = createMockViewer();
    const bytes = new Uint8Array(fs.readFileSync(pathMod.join(DIR, FILE)));
    const t0 = performance.now();
    const m = await loadModel(v, bytes, { registry: r, name: FILE, up: 'z' });
    const ms = performance.now() - t0;
    console.log(FILE, `${ms.toFixed(0)} ms`, m.stats, m.info, m.bounds && Array.from(m.bounds).map((x) => +x.toFixed(2)));
    for (const w of m.warnings) console.log('  warn:', w);
    expect(m.loader).toBe('ifc');
    expect(m.stats.meshes).toBeGreaterThan(0);
    expect(m.stats.triangles).toBeGreaterThan(0);
    const h = m.hierarchy;
    expect(h.roots().length).toBeGreaterThan(0);
    const root = h.roots()[0];
    expect(h.properties(root)?.Class).toBe('IfcProject');
    // an element with geometry carries its attributes and property sets
    const id = m.objectIds()[0];
    const props = h.properties(h.nodeOfObject(id));
    console.log('first object:', h.name(h.nodeOfObject(id)), JSON.stringify(props).slice(0, 400));
    expect(props?.GlobalId).toBeTypeOf('string');
    // geometry is finite and in metres
    for (const b of m.bounds!) expect(Number.isFinite(b)).toBe(true);
  }, 120_000);
});

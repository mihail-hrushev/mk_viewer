/**
 * A complete loader plugin for "blox", a made-up text format (one statement per line):
 *
 *   # blox 1                                       header (used for content sniffing)
 *   material <name> <r> <g> <b> [opacity]
 *   box <name> <x> <y> <z> <sizeX> <sizeY> <sizeZ> <material>     z is up in blox files
 *
 * Copy this file as the starting point for your own format. See src/loaders/README.md.
 */
import { box } from '../src/index'; // in your project: from 'mk-viewer'
import type { LoaderPlugin } from '../src/index';

export const bloxLoader: LoaderPlugin = {
  name: 'blox',
  extensions: ['blox'],
  up: 'z', // the file's native up axis; the viewer converts it, the plugin never does
  canLoad: ({ header }) => new TextDecoder().decode(header.subarray(0, 6)) === '# blox',

  async load(source, ctx) {
    const lines = (await source.text()).split('\n');
    const materials = new Map<string, number>();
    // one geometry (a unit cube from the library's raw generators), placed once per box
    const unitBox = ctx.createGeometry(box([1, 1, 1]));
    const root = ctx.hierarchy.addNode(-1, source.name);
    let boxes = 0;
    for (let i = 0; i < lines.length; i++) {
      const [kind, name, ...v] = lines[i].trim().split(/\s+/);
      const n = v.map(Number);
      if (kind === 'material') {
        materials.set(name, ctx.createMaterial({ color: [n[0], n[1], n[2], n[3] ?? 1] }));
      } else if (kind === 'box') {
        const material = materials.get(v[6]);
        if (material === undefined || n.slice(0, 6).some(Number.isNaN)) {
          ctx.warn(`line ${i + 1}: bad box statement`); // skip bad parts, don't fail the whole file
          continue;
        }
        const objectId = ctx.allocObjectIds(1); // scene-unique id for picking / selection
        ctx.addMesh({
          geometry: unitBox,
          material,
          objectId,
          transform: [n[3], 0, 0, 0, 0, n[4], 0, 0, 0, 0, n[5], 0, n[0], n[1], n[2], 1], // model-local
        });
        ctx.hierarchy.addNode(root, name, objectId); // name shown on pick, part of model.hierarchy
        ctx.setProperties(objectId, { material: v[6], size: n.slice(3, 6) });
        boxes++;
      } else if (kind && !kind.startsWith('#')) {
        ctx.warn(`line ${i + 1}: unknown statement '${kind}'`);
      }
      if (i % 1000 === 0) {
        ctx.progress(i / lines.length, 'parse');
        await ctx.yieldIfNeeded(); // keeps the page responsive; throws if the load was aborted
      }
    }
    return { info: { format: 'blox 1', boxes } };
  },
};

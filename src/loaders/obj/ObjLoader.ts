/**
 * Wavefront OBJ loader — the reference "how to write a loader plugin" example. Copy this file as the
 * starting point for your own format.
 *
 * Supported: `v`, `vn`, `f` (any polygon, fan-triangulated; `v`, `v/vt`, `v//vn`, `v/vt/vn`, negative
 * indices), `o` / `g` (each starts a new object = one objectId + one hierarchy node). Ignored: texture
 * coordinates, materials (`mtllib`/`usemtl`), curves, lines and points.
 */
import type { LoadContext, LoaderPlugin, LoaderSource } from '../types';

/** Plugin-specific options arrive typed as `ctx.options` (from `loadModel(..., { options })`). */
export interface ObjLoaderOptions {
  /** sRGB colour of the single material. Default light grey. */
  color: [number, number, number];
}

// A plugin is a plain object. Keep it stateless: one instance may serve many concurrent loads.
export const objLoader: LoaderPlugin<ObjLoaderOptions> = {
  name: 'obj',
  extensions: ['obj'],
  mimeTypes: ['model/obj', 'text/plain+obj'],
  // OBJ files are conventionally Y-up. Declare it; the context rotates to the scene's up axis.
  up: 'y',
  // Sniffing is only used when the extension/mime type did not decide. Keep it cheap and strict.
  canLoad: ({ header }) => /^(#[^\n]*\n|\s)*(v|o|g|mtllib)\s/.test(new TextDecoder().decode(header)),
  load: loadObj,
};

/** One object's triangles, de-indexed per corner (OBJ indexes positions and normals separately). */
interface Group {
  name: string;
  pos: number[];
  nrm: number[];
  /** True when every corner of every face had a normal. */
  hasNormals: boolean;
}

async function loadObj(source: LoaderSource, ctx: LoadContext<ObjLoaderOptions>) {
  // 1. Read the input through the source, never fetch yourself: the source handles URL/File/buffer,
  //    reports download progress and honours abort.
  const text = await source.text();
  ctx.progress(0.1, 'parse');

  const v: number[] = []; // all positions, xyz
  const vn: number[] = []; // all normals, xyz
  const groups: Group[] = [];
  let cur: Group | null = null;
  const begin = (name: string) => {
    // a new `o`/`g` only starts a new group once the current one has faces
    if (cur && cur.pos.length === 0) cur.name = name;
    else groups.push((cur = { name, pos: [], nrm: [], hasNormals: true }));
  };
  const corner = (g: Group, tok: string) => {
    const [a, , c] = tok.split('/');
    let i = parseInt(a, 10);
    i = i < 0 ? v.length / 3 + i : i - 1; // OBJ is 1-based; negative = relative to the end
    g.pos.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    if (c) {
      let n = parseInt(c, 10);
      n = n < 0 ? vn.length / 3 + n : n - 1;
      g.nrm.push(vn[n * 3], vn[n * 3 + 1], vn[n * 3 + 2]);
    } else g.hasNormals = false;
  };

  // 2. Parse. Long loops must cooperate with the page: `shouldYield()` is a cheap clock check, `yield()`
  //    lets the browser render and handle input, and throws if the load was aborted.
  let start = 0;
  let lineNo = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (++lineNo % 1024 === 0 && ctx.shouldYield()) {
      ctx.progress(0.1 + 0.6 * (start / text.length), 'parse');
      await ctx.yield();
    }
    if (line === '' || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'v': v.push(+parts[1], +parts[2], +parts[3]); break;
      case 'vn': vn.push(+parts[1], +parts[2], +parts[3]); break;
      case 'o': case 'g': begin(parts.slice(1).join(' ') || 'unnamed'); break;
      case 'f': {
        if (!cur) begin(source.name);
        // fan-triangulate the polygon: (0, k, k+1)
        for (let k = 2; k + 1 < parts.length; k++) {
          corner(cur!, parts[1]);
          corner(cur!, parts[k]);
          corner(cur!, parts[k + 1]);
        }
        break;
      }
      default: break; // vt, usemtl, mtllib, s, l, p, … are ignored
    }
  }

  // 3. Build. Always go through ctx.createGeometry / ctx.createMaterial / ctx.addMesh(es): they record
  //    what the model owns (unload, abort cleanup), apply the up/global transform and compute bounds.
  const color = ctx.options.color ?? [0.8, 0.8, 0.8];
  const material = ctx.createMaterial({ color, roughness: 0.8, metalness: 0 });
  const used = groups.filter((g) => g.pos.length >= 9);

  // objectIds must be unique across all models in the scene: allocate them, never invent numbers.
  const firstId = ctx.allocObjectIds(used.length);
  // One root node for the file, one child per object. Metadata is columnar inside the context.
  const root = ctx.hierarchy.addNode(-1, source.name);

  for (let i = 0; i < used.length; i++) {
    const g = used[i];
    const objectId = firstId + i;
    ctx.hierarchy.addNode(root, g.name, objectId);
    // Typed arrays, not number[]: less memory and faster for the viewer to consume.
    const geometry = ctx.createGeometry({
      positions: new Float32Array(g.pos),
      // omit normals when incomplete: the viewer then computes flat normals
      normals: g.hasNormals ? new Float32Array(g.nrm) : undefined,
    });
    // Transforms are model-local and may be float64; here identity (OBJ has no transforms).
    // If the same geometry were placed many times, reuse the GeometryId (or use addMeshes) so the
    // viewer can draw it instanced.
    ctx.addMesh({ geometry, material, objectId });
    ctx.progress(0.7 + 0.3 * ((i + 1) / used.length), 'build');
    await ctx.yieldIfNeeded();
  }

  // 4. Optionally return display info. Everything else (bounds, stats, unload) is handled for you.
  return { info: { format: 'OBJ', vertices: v.length / 3, objects: used.length } };
}

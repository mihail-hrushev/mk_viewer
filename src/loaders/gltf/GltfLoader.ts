/**
 * glTF 2.0 loader plugin (.glb / .gltf).
 *
 * Pipeline:
 *  1. bytes -> JSON + BIN view (GLB) or JSON (+ external / data-URI buffers).
 *  2. Time-sliced depth-first walk of the default scene: float64 world matrices of mesh-bearing nodes
 *     only (a depth-indexed matrix stack, no per-node matrix storage), parent column, objectId owners,
 *     and (matrix, primitive-group) pairs. EXT_mesh_gpu_instancing expands to one matrix per instance.
 *  3. Pairs are bucketed per group (unique geometry x material). Each group creates its geometry once
 *     (cached by accessor tuple, built from zero-copy views where possible) and adds all its placements
 *     with one `addMeshes` call — so a primitive reused by many nodes becomes viewer instancing.
 *  4. Hierarchy (parents, objectIds) is stored columnar; names/properties are read lazily from the
 *     parsed `nodes` array, which is the only part of the JSON kept after loading.
 */
import type { GeometryData, MaterialId } from '../../types';
import { fromTRS, multiply } from '../mat4d';
import { decodeDataUri } from '../source';
import type { LoadContext, LoaderPlugin, LoaderSource } from '../types';
import { AccessorReader } from './accessors';
import { isGlb, looksLikeGltfJson, parseGlb, parseJsonBytes } from './container';
import { gltfMaterialParams } from './materials';
import { TRIANGLE_FAN, TRIANGLE_STRIP, TRIANGLES, type GltfJson, type GltfNode, type GltfPrimitive } from './schema';

/** Decodes a primitive carrying a compression extension (e.g. Draco) into plain geometry. */
export type PrimitiveDecoder = (args: {
  extension: any;
  primitive: GltfPrimitive;
  json: GltfJson;
  /** Bytes of a bufferView (no copy). */
  bufferView(index: number): Uint8Array;
}) => GeometryData | Promise<GeometryData>;

/**
 * Chooses which node owns the objectId of a mesh-bearing node: return a node index from `path`
 * (root ... node, valid only during the call) or the node itself.
 */
export type ObjectGrouping = (node: number, path: ArrayLike<number>, json: GltfJson) => number;

export interface GltfLoaderOptions {
  /** Scene index (default: `scene` of the file, else 0). */
  scene: number;
  /**
   * objectId policy. 'node' (default): one objectId per mesh-bearing node. A number d: meshes share
   * the objectId of their ancestor at depth d (roots are depth 0). Or a callback.
   */
  objectIds: 'node' | number | ObjectGrouping;
  /** Treat baseColorFactor as sRGB instead of linear (for non-conforming exporters). Default false. */
  srgbColors: boolean;
  /** Keep node names (lazy, from the parsed JSON nodes). Default true. */
  keepNames: boolean;
  /** Decoders for compressed primitives, keyed by extension name. */
  primitiveDecoders: Record<string, PrimitiveDecoder>;
}

/** Extensions handled (or harmlessly ignored, e.g. texture-only ones since textures are ignored). */
const BUILTIN_EXTENSIONS = new Set([
  'KHR_mesh_quantization',
  'EXT_mesh_gpu_instancing',
  'KHR_materials_emissive_strength',
  'KHR_materials_unlit',
  'KHR_texture_transform',
  'KHR_texture_basisu',
  'EXT_texture_webp',
  'EXT_texture_avif',
]);

const EXTENSION_HINTS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco mesh compression',
  EXT_meshopt_compression: 'meshoptimizer compression',
  KHR_meshopt_compression: 'meshoptimizer compression',
};

export function createGltfLoader(defaults: Partial<GltfLoaderOptions> = {}): LoaderPlugin<GltfLoaderOptions> {
  return {
    name: 'gltf',
    extensions: ['glb', 'gltf'],
    mimeTypes: ['model/gltf-binary', 'model/gltf+json'],
    up: 'y',
    canLoad: ({ header }) => isGlb(header) || looksLikeGltfJson(header),
    load: (source, ctx) => loadGltf(source, ctx, { ...defaults, ...ctx.options }),
  };
}

/** The built-in glTF plugin with default options. */
export const gltfLoader: LoaderPlugin<GltfLoaderOptions> = createGltfLoader();

// ------------------------------------------------------------------------------------------------

function growI32(g: { a: Int32Array }, need: number): Int32Array {
  if (need <= g.a.length) return g.a;
  const b = new Int32Array(Math.max(need, g.a.length * 2));
  b.set(g.a);
  return (g.a = b);
}
function growF64(g: { a: Float64Array }, need: number): Float64Array {
  if (need <= g.a.length) return g.a;
  const b = new Float64Array(Math.max(need, g.a.length * 2));
  b.set(g.a);
  return (g.a = b);
}

async function loadGltf(source: LoaderSource, ctx: LoadContext<GltfLoaderOptions>, opt: Partial<GltfLoaderOptions>) {
  ctx.progress(0, 'read');
  let json: GltfJson;
  let bin: Uint8Array | undefined;
  {
    const bytes = await source.bytes();
    ctx.throwIfAborted();
    ctx.progress(0.02, 'parse');
    if (isGlb(bytes)) ({ json, bin } = parseGlb(bytes));
    else json = parseJsonBytes(bytes);
  }
  const decoders = opt.primitiveDecoders ?? {};
  checkRequiredExtensions(json, decoders);
  await ctx.yieldIfNeeded();

  const buffers = await loadBuffers(json, bin, source, ctx);
  bin = undefined;
  const reader = new AccessorReader(json, buffers);
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const N = nodes.length;

  // warnings are aggregated: one line per kind
  const counts = { skippedMode: 0, badPrim: 0, textures: 0, skins: 0, morph: 0, revisit: 0 };
  const badDetails: string[] = [];

  // --- primitive groups: unique (geometry key, material) ---------------------------------------
  const geomKeyToSlot = new Map<string, number>();
  const geomSrc: number[] = []; // per geometry slot: mesh index * 65536 + primitive index (first use)
  const groupKeyToId = new Map<string, number>();
  const groupGeom: number[] = [];
  const groupMat: number[] = [];
  const meshGroups: (Int32Array | undefined)[] = new Array(meshes.length);

  const groupsOfMesh = (mi: number): Int32Array => {
    let g = meshGroups[mi];
    if (g) return g;
    const mesh = meshes[mi];
    if (!mesh) throw new Error(`Node references missing mesh ${mi}`);
    g = new Int32Array(mesh.primitives.length);
    mesh.primitives.forEach((p, pi) => {
      const mode = p.mode ?? TRIANGLES;
      if (mode !== TRIANGLES && mode !== TRIANGLE_STRIP && mode !== TRIANGLE_FAN) {
        counts.skippedMode++;
        g![pi] = -1;
        return;
      }
      if (p.targets) counts.morph++;
      const ext = p.extensions && Object.keys(p.extensions).find((k) => decoders[k]);
      const a = p.attributes;
      const gk = ext
        ? `${ext}:${JSON.stringify(p.extensions![ext])}:${mode}`
        : `${a.POSITION},${a.NORMAL ?? -1},${p.indices ?? -1},${mode}`;
      let slot = geomKeyToSlot.get(gk);
      if (slot === undefined) {
        slot = geomSrc.length;
        geomKeyToSlot.set(gk, slot);
        geomSrc.push(mi * 65536 + pi);
      }
      const mat = p.material ?? -1;
      const key = slot * 65536 + (mat + 1);
      let gid = groupKeyToId.get(String(key));
      if (gid === undefined) {
        gid = groupGeom.length;
        groupKeyToId.set(String(key), gid);
        groupGeom.push(slot);
        groupMat.push(mat);
      }
      g![pi] = gid;
    });
    meshGroups[mi] = g;
    return g;
  };

  // --- objectId owner policy -------------------------------------------------------------------
  const policy = opt.objectIds ?? 'node';
  const ownerOf = (n: number, path: Int32Array, d: number): number => {
    if (policy === 'node') return n;
    if (typeof policy === 'number') return path[Math.max(0, Math.min(policy, d))];
    const o = policy(n, path.subarray(0, d + 1), json);
    return o >= 0 && o < N ? o : n;
  };

  // --- walk ------------------------------------------------------------------------------------
  ctx.progress(0.05, 'nodes');
  const parent = new Int32Array(N).fill(-2);
  const ownerOrd = new Int32Array(N).fill(-1);
  const ownerNodes = { a: new Int32Array(256) };
  let ownerCount = 0;
  const mats = { a: new Float64Array(16 * 1024) }; // world matrices of placements
  const matOwner = { a: new Int32Array(1024) };
  let matCount = 0;
  const pairs = { a: new Int32Array(3 * 1024) }; // (matrix start, matrix count, group)
  let pairCount = 0;

  const roots = sceneRoots(json, opt.scene);
  let stackNode = new Int32Array(Math.max(16, roots.length + 16));
  let stackDepth = new Int32Array(stackNode.length);
  let sp = 0;
  for (let i = roots.length - 1; i >= 0; i--) {
    stackNode[sp] = roots[i];
    stackDepth[sp++] = 0;
  }
  let world = new Float64Array(16 * 16);
  let path = new Int32Array(16);
  const local = new Float64Array(16);
  const inst = new Float64Array(16);
  const visited = new Uint8Array(N);
  let walked = 0;

  while (sp > 0) {
    const n = stackNode[--sp];
    const d = stackDepth[sp];
    const node: GltfNode | undefined = nodes[n];
    if (!node) throw new Error(`Scene references missing node ${n}`);
    if (visited[n]) {
      counts.revisit++;
      continue;
    }
    visited[n] = 1;
    if (d >= path.length) {
      const p2 = new Int32Array(path.length * 2);
      p2.set(path);
      path = p2;
      const w2 = new Float64Array(world.length * 2);
      w2.set(world);
      world = w2;
    }
    path[d] = n;
    parent[n] = d > 0 ? path[d - 1] : -1;

    if (node.matrix && node.matrix.length === 16) for (let i = 0; i < 16; i++) local[i] = node.matrix[i];
    else fromTRS(local, 0, node.translation, node.rotation, node.scale);
    if (d === 0) world.set(local, 0);
    else multiply(world, d * 16, world, (d - 1) * 16, local, 0);

    if (node.mesh !== undefined) {
      if ((node as { skin?: number }).skin !== undefined) counts.skins++;
      const groups = groupsOfMesh(node.mesh);
      const owner = ownerOf(n, path, d);
      if (ownerOrd[owner] < 0) {
        growI32(ownerNodes, ownerCount + 1)[ownerCount] = owner;
        ownerOrd[owner] = ownerCount++;
      }
      const ord = ownerOrd[owner];
      const start = matCount;
      const gi = node.extensions?.EXT_mesh_gpu_instancing;
      if (gi && gi.attributes) {
        const at = gi.attributes as Record<string, number>;
        const T = at.TRANSLATION !== undefined ? reader.readFloat(at.TRANSLATION, 3) : undefined;
        const R = at.ROTATION !== undefined ? reader.readFloat(at.ROTATION, 4) : undefined;
        const S = at.SCALE !== undefined ? reader.readFloat(at.SCALE, 3) : undefined;
        const count = (T ? T.length / 3 : R ? R.length / 4 : S ? S.length / 3 : 0) | 0;
        const m = growF64(mats, (matCount + count) * 16);
        const o = growI32(matOwner, matCount + count);
        for (let i = 0; i < count; i++) {
          fromTRS(inst, 0, T, R, S, i * 3, i * 4, i * 3);
          multiply(m, (matCount + i) * 16, world, d * 16, inst, 0);
          o[matCount + i] = ord;
        }
        matCount += count;
      } else {
        const m = growF64(mats, (matCount + 1) * 16);
        for (let i = 0; i < 16; i++) m[matCount * 16 + i] = world[d * 16 + i];
        growI32(matOwner, matCount + 1)[matCount] = ord;
        matCount++;
      }
      const cnt = matCount - start;
      if (cnt > 0) {
        for (let k = 0; k < groups.length; k++) {
          if (groups[k] < 0) continue;
          const p = growI32(pairs, (pairCount + 1) * 3);
          p[pairCount * 3] = start;
          p[pairCount * 3 + 1] = cnt;
          p[pairCount * 3 + 2] = groups[k];
          pairCount++;
        }
      }
    }

    const ch = node.children;
    if (ch && ch.length) {
      if (sp + ch.length > stackNode.length) {
        const cap = Math.max(stackNode.length * 2, sp + ch.length);
        const a = new Int32Array(cap);
        a.set(stackNode.subarray(0, sp));
        stackNode = a;
        const b = new Int32Array(cap);
        b.set(stackDepth.subarray(0, sp));
        stackDepth = b;
      }
      for (let i = ch.length - 1; i >= 0; i--) {
        const c = ch[i];
        if (!(c >= 0 && c < N)) throw new Error(`Node ${n} has invalid child ${c}`);
        stackNode[sp] = c;
        stackDepth[sp++] = d + 1;
      }
    }
    walked++;
    if ((walked & 255) === 0 && ctx.shouldYield()) {
      ctx.progress(0.05 + 0.1 * (walked / Math.max(1, N)), 'nodes');
      await ctx.yield();
    }
  }

  // --- objectIds + hierarchy -------------------------------------------------------------------
  const oidBase = ownerCount > 0 ? ctx.allocObjectIds(ownerCount) : 0;
  const owners = ownerNodes.a;
  {
    const offset = ctx.hierarchy.count;
    const oidCol = new Float64Array(N).fill(NaN);
    for (let k = 0; k < ownerCount; k++) oidCol[owners[k]] = oidBase + k;
    if (offset) for (let i = 0; i < N; i++) if (parent[i] >= 0) parent[i] += offset;
    const keep = opt.keepNames !== false;
    ctx.hierarchy.addNodes(
      parent,
      oidCol,
      keep ? (i) => nodes[i].name : undefined,
      keep ? (i) => nodeProperties(nodes[i].extras) : undefined,
    );
    if (keep) {
      // lazy properties straight from the parsed nodes (the only JSON part retained)
      const ownerTable = owners.slice(0, ownerCount);
      const meshNames = meshes.map((m) => m.name);
      ctx.setPropertyProvider((objectId) => {
        const k = objectId - oidBase;
        if (!(k >= 0 && k < ownerCount)) return undefined;
        const ni = ownerTable[k];
        const nd = nodes[ni];
        const props: Record<string, unknown> = { gltfNode: ni };
        if (nd.mesh !== undefined && meshNames[nd.mesh] !== undefined) props.meshName = meshNames[nd.mesh];
        if (nd.extras !== undefined) props.extras = nd.extras;
        return props;
      });
    }
  }

  // --- bucket pairs by group (counting sort) ---------------------------------------------------
  const G = groupGeom.length;
  const groupInst = new Int32Array(G);
  const groupPairs = new Int32Array(G + 1);
  const P = pairs.a;
  for (let i = 0; i < pairCount; i++) {
    groupInst[P[i * 3 + 2]] += P[i * 3 + 1];
    groupPairs[P[i * 3 + 2] + 1]++;
  }
  for (let g = 0; g < G; g++) groupPairs[g + 1] += groupPairs[g];
  const order = new Int32Array(pairCount);
  {
    const fill = groupPairs.slice(0, G);
    for (let i = 0; i < pairCount; i++) order[fill[P[i * 3 + 2]]++] = i;
  }

  // progress weight: vertices to build
  let totalVerts = 0;
  for (let s = 0; s < geomSrc.length; s++) totalVerts += vertexCountOf(json, geomSrc[s]);
  let doneVerts = 0;

  // --- materials -------------------------------------------------------------------------------
  const materialCache = new Map<number, MaterialId>();
  const materialFor = (mi: number): MaterialId => {
    let id = materialCache.get(mi);
    if (id !== undefined) return id;
    const m = mi >= 0 ? json.materials?.[mi] : undefined;
    if (m) {
      if (m.pbrMetallicRoughness?.baseColorTexture) counts.textures++;
      id = ctx.createMaterial(gltfMaterialParams(m, !!opt.srgbColors));
    } else id = ctx.createMaterial(); // viewer default (glTF's default material is untextured white metal)
    materialCache.set(mi, id);
    return id;
  };

  // --- geometries + meshes, time-sliced --------------------------------------------------------
  ctx.progress(0.15, 'meshes');
  const geomIds = new Int32Array(geomSrc.length).fill(-1); // -1 = not built, -2 = invalid
  let scratchT = new Float64Array(16 * 64);
  let scratchO = new Float64Array(64);
  const M = mats.a;
  const MO = matOwner.a;

  for (let g = 0; g < G; g++) {
    const n = groupInst[g];
    if (n === 0) continue;
    const slot = groupGeom[g];
    if (geomIds[slot] === -1) {
      const src = geomSrc[slot];
      const prim = meshes[(src / 65536) | 0].primitives[src % 65536];
      try {
        const data = await buildGeometry(prim, reader, json, decoders);
        geomIds[slot] = data ? ctx.createGeometry(data) : -2;
        if (!data) {
          counts.badPrim++;
          if (badDetails.length < 5) badDetails.push(`mesh ${(src / 65536) | 0} primitive ${src % 65536}: no triangles`);
        }
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        geomIds[slot] = -2;
        counts.badPrim++;
        if (badDetails.length < 5) badDetails.push(`mesh ${(src / 65536) | 0} primitive ${src % 65536}: ${e instanceof Error ? e.message : String(e)}`);
      }
      doneVerts += vertexCountOf(json, src);
    }
    const geometry = geomIds[slot];
    if (geometry < 0) continue;
    const material = materialFor(groupMat[g]);

    if (scratchT.length < n * 16) {
      scratchT = new Float64Array(n * 16);
      scratchO = new Float64Array(n);
    }
    let k = 0;
    for (let q = groupPairs[g]; q < groupPairs[g + 1]; q++) {
      const pi = order[q];
      const start = P[pi * 3], cnt = P[pi * 3 + 1];
      scratchT.set(M.subarray(start * 16, (start + cnt) * 16), k * 16);
      for (let j = 0; j < cnt; j++) scratchO[k + j] = oidBase + MO[start + j];
      k += cnt;
    }
    if (n === 1) ctx.addMesh({ geometry, material, transform: scratchT.subarray(0, 16), objectId: scratchO[0] });
    else ctx.addMeshes({ geometry, material, transforms: scratchT.subarray(0, n * 16), objectIds: scratchO.subarray(0, n) });

    if (ctx.shouldYield()) {
      ctx.progress(0.15 + 0.85 * (totalVerts ? doneVerts / totalVerts : g / G), 'meshes');
      await ctx.yield();
    }
  }
  ctx.progress(1, 'meshes');

  if (counts.skippedMode) ctx.warn(`Skipped ${counts.skippedMode} point/line primitive(s): only triangles are rendered`);
  if (counts.badPrim) ctx.warn(`Skipped ${counts.badPrim} invalid primitive(s): ${badDetails.join('; ')}`);
  if (counts.textures) ctx.warn(`${counts.textures} material(s) use textures; textures are ignored (base colour factor used)`);
  if (counts.skins) ctx.warn(`${counts.skins} skinned mesh node(s): skinning ignored, bind pose shown`);
  if (counts.morph) ctx.warn(`${counts.morph} primitive(s) with morph targets: base shape shown`);
  if (counts.revisit) ctx.warn(`${counts.revisit} node(s) referenced more than once (invalid glTF); extra references ignored`);

  return {
    info: {
      format: 'glTF',
      generator: json.asset.generator,
      version: json.asset.version,
      copyright: json.asset.copyright,
      extensionsUsed: json.extensionsUsed ?? [],
      scene: json.scenes?.[opt.scene ?? json.scene ?? 0]?.name,
      zeroCopyAccessors: reader.views,
      copiedAccessors: reader.copies,
      copiedBytes: reader.copiedBytes,
    },
  };
}

function sceneRoots(json: GltfJson, scene: number | undefined): number[] {
  const nodes = json.nodes ?? [];
  if (json.scenes && json.scenes.length) {
    const s = json.scenes[scene ?? json.scene ?? 0];
    if (!s) throw new Error(`Scene ${scene ?? json.scene} does not exist`);
    return s.nodes ?? [];
  }
  // no scenes: show every node that is nobody's child
  const isChild = new Uint8Array(nodes.length);
  for (const n of nodes) for (const c of n.children ?? []) isChild[c] = 1;
  const r: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (!isChild[i]) r.push(i);
  return r;
}

function vertexCountOf(json: GltfJson, src: number): number {
  const prim = json.meshes![(src / 65536) | 0].primitives[src % 65536];
  const a = prim.attributes.POSITION;
  return a !== undefined ? json.accessors?.[a]?.count ?? 0 : 0;
}

function checkRequiredExtensions(json: GltfJson, decoders: Record<string, PrimitiveDecoder>): void {
  for (const ext of json.extensionsRequired ?? []) {
    if (BUILTIN_EXTENSIONS.has(ext) || decoders[ext]) continue;
    const what = EXTENSION_HINTS[ext] ? ` (${EXTENSION_HINTS[ext]})` : '';
    throw new Error(
      `required glTF extension "${ext}"${what} is not supported by the built-in glTF loader. ` +
        `It can be provided by another plugin: pass a decoder via createGltfLoader({ primitiveDecoders: { ${ext}: … } }) ` +
        `or register a loader plugin that handles this extension for .glb/.gltf.`,
    );
  }
}

async function loadBuffers(json: GltfJson, bin: Uint8Array | undefined, source: LoaderSource, ctx: LoadContext<GltfLoaderOptions>) {
  const defs = json.buffers ?? [];
  const out: (Uint8Array | undefined)[] = new Array(defs.length);
  for (let i = 0; i < defs.length; i++) {
    const b = defs[i];
    let data: Uint8Array;
    if (b.uri === undefined) {
      if (i !== 0 || !bin) throw new Error(`Buffer ${i} has no uri and there is no GLB binary chunk`);
      data = bin;
    } else if (b.uri.startsWith('data:')) {
      data = decodeDataUri(b.uri).bytes;
    } else {
      ctx.progress(0.03, `buffer ${b.uri}`);
      data = await source.resolve(b.uri).bytes();
      ctx.throwIfAborted();
    }
    if (data.byteLength < b.byteLength) throw new Error(`Buffer ${i} is ${data.byteLength} bytes, ${b.byteLength} declared (truncated?)`);
    out[i] = data;
  }
  return out;
}

async function buildGeometry(
  prim: GltfPrimitive,
  reader: AccessorReader,
  json: GltfJson,
  decoders: Record<string, PrimitiveDecoder>,
): Promise<GeometryData | null> {
  const mode = prim.mode ?? TRIANGLES;
  let positions: Float32Array;
  let normals: Float32Array | undefined;
  let indices: ArrayLike<number> | undefined;
  const ext = prim.extensions && Object.keys(prim.extensions).find((k) => decoders[k]);
  if (ext) {
    const d = await decoders[ext]({
      extension: prim.extensions![ext],
      primitive: prim,
      json,
      bufferView: (i) => reader.bufferView(i),
    });
    positions = d.positions instanceof Float32Array ? d.positions : Float32Array.from(d.positions);
    normals = d.normals ? (d.normals instanceof Float32Array ? d.normals : Float32Array.from(d.normals)) : undefined;
    indices = d.indices;
  } else {
    if (prim.attributes.POSITION === undefined) throw new Error('primitive has no POSITION');
    positions = reader.readFloat(prim.attributes.POSITION, 3);
    if (prim.attributes.NORMAL !== undefined) {
      const nrm = reader.readFloat(prim.attributes.NORMAL, 3);
      if (nrm.length === positions.length) normals = nrm;
    }
    if (prim.indices !== undefined) indices = reader.readIndices(prim.indices);
  }
  const vc = positions.length / 3;
  let idx: ArrayLike<number> | undefined = indices;
  if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) idx = toTriangleList(idx, vc, mode);
  else if (idx) {
    const t = idx.length - (idx.length % 3);
    if (t !== idx.length) idx = sub(idx, t);
  } else if (vc % 3) {
    const t = (vc - (vc % 3)) * 3;
    positions = positions.subarray(0, t);
    normals = normals?.subarray(0, t);
  }
  if (idx) {
    for (let i = 0; i < idx.length; i++) if (idx[i] >= vc) throw new Error(`index ${idx[i]} out of range (${vc} vertices)`);
    if (idx.length === 0) return null;
  } else if (positions.length < 9) return null;
  return { positions, normals, indices: idx };
}

function sub(a: ArrayLike<number>, n: number): ArrayLike<number> {
  const s = (a as Uint32Array).subarray;
  return typeof s === 'function' ? (a as Uint32Array).subarray(0, n) : Array.prototype.slice.call(a, 0, n);
}

/** Strip/fan -> list, dropping degenerate triangles (strip restarts). */
export function toTriangleList(idx: ArrayLike<number> | undefined, vertexCount: number, mode: number): Uint32Array {
  const n = idx ? idx.length : vertexCount;
  const at = idx ? (i: number) => idx[i] : (i: number) => i;
  const out = new Uint32Array(Math.max(0, n - 2) * 3);
  let o = 0;
  for (let i = 0; i + 2 < n; i++) {
    let a: number, b: number, c: number;
    if (mode === TRIANGLE_STRIP) {
      // glTF: p_i = {v_i, v_(i+(1+i%2)), v_(i+(2-i%2))}
      a = at(i);
      b = at(i + 1 + (i % 2));
      c = at(i + 2 - (i % 2));
    } else {
      a = at(i + 1);
      b = at(i + 2);
      c = at(0);
    }
    if (a === b || b === c || a === c) continue;
    out[o++] = a;
    out[o++] = b;
    out[o++] = c;
  }
  return o === out.length ? out : out.slice(0, o);
}

/** glTF `extras` of a node as its properties: only a plain JSON object counts. */
function nodeProperties(extras: unknown): Record<string, unknown> | undefined {
  return extras !== null && typeof extras === 'object' && !Array.isArray(extras) ? (extras as Record<string, unknown>) : undefined;
}

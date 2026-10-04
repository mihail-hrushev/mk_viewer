/**
 * Recording ViewerApi mock for loader tests (node, no GL). Not part of the library.
 */
import type {
  GeometryData,
  MaterialParams,
  MeshBatchParams,
  MeshParams,
  ViewerApi,
  ViewerStats,
} from '../../types';

export interface MockGeometry {
  vertices: number;
  triangles: number;
  indexed: boolean;
  hasNormals: boolean;
  released: boolean;
  /** Copies (only with keepData). */
  positions?: Float64Array;
  indices?: Uint32Array;
  normals?: Float64Array;
  /** Was the input a view on a larger buffer (zero-copy from the loader)? */
  positionsWasView: boolean;
}

export interface MockMesh {
  geometry: number;
  material: number;
  transform: Float64Array;
  objectId: number;
  alive: boolean;
  visible: boolean;
}

export interface MockViewer extends ViewerApi {
  geometries: MockGeometry[];
  materials: MaterialParams[];
  meshes: MockMesh[];
  calls: { createGeometry: number; addMesh: number; addMeshes: number; remove: number; setVisible: number };
  liveMeshes(): number;
  liveGeometries(): number;
}

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function createMockViewer(opts: { keepData?: boolean } = {}): MockViewer {
  const keep = !!opts.keepData;
  const geometries: MockGeometry[] = [];
  const materials: MaterialParams[] = [];
  const meshes: MockMesh[] = [];
  const calls = { createGeometry: 0, addMesh: 0, addMeshes: 0, remove: 0, setVisible: 0 };
  const stats: ViewerStats = {
    fps: 0, frameMs: 0, meshes: 0, triangles: 0, drawItems: 0, drawCalls: 0, trianglesDrawn: 0, progress: 1, gpuMemoryBytes: 0,
  };
  const checkMat = (m: number) => {
    if (!(m >= 0 && m < materials.length)) throw new Error(`mock: invalid material ${m}`);
  };
  const checkGeom = (g: number) => {
    if (!(g >= 0 && g < geometries.length) || geometries[g].released) throw new Error(`mock: invalid geometry ${g}`);
  };
  const forObjects = (ids: number | ArrayLike<number>, fn: (m: MockMesh) => void) => {
    const set = new Set<number>(typeof ids === 'number' ? [ids] : Array.from(ids));
    for (const m of meshes) if (m.alive && set.has(m.objectId)) fn(m);
  };

  const v: MockViewer = {
    canvas: {} as HTMLCanvasElement,
    primitives: {} as ViewerApi['primitives'],
    stats,
    geometries,
    materials,
    meshes,
    calls,
    liveMeshes: () => meshes.filter((m) => m.alive).length,
    liveGeometries: () => geometries.filter((g) => !g.released).length,

    createGeometry(data: GeometryData) {
      calls.createGeometry++;
      const p = data.positions;
      if (p.length % 3) throw new Error('mock: positions length');
      // consume the data like the real viewer does (one pass), validate
      for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) throw new Error('mock: non-finite position');
      const vc = p.length / 3;
      if (data.indices) for (let i = 0; i < data.indices.length; i++) if (data.indices[i] >= vc) throw new Error('mock: index out of range');
      if (data.normals && data.normals.length !== p.length) throw new Error('mock: normals length');
      const g: MockGeometry = {
        vertices: vc,
        triangles: data.indices ? data.indices.length / 3 : vc / 3,
        indexed: !!data.indices,
        hasNormals: !!data.normals,
        released: false,
        positionsWasView: ArrayBuffer.isView(p) && (p as Float32Array).byteLength < (p as Float32Array).buffer.byteLength,
      };
      if (keep) {
        g.positions = Float64Array.from(p);
        if (data.indices) g.indices = Uint32Array.from(data.indices);
        if (data.normals) g.normals = Float64Array.from(data.normals);
      }
      geometries.push(g);
      return geometries.length - 1;
    },
    releaseGeometry(id) {
      if (geometries[id]) geometries[id].released = true;
    },
    createMaterial(params?: MaterialParams) {
      materials.push({ ...(params ?? {}) });
      return materials.length - 1;
    },
    updateMaterial(id, params) {
      Object.assign(materials[id], params);
    },
    addMesh(params: MeshParams) {
      calls.addMesh++;
      checkGeom(params.geometry);
      checkMat(params.material);
      const id = meshes.length;
      meshes.push({
        geometry: params.geometry,
        material: params.material,
        transform: Float64Array.from(params.transform ?? IDENT),
        objectId: params.objectId ?? id,
        alive: true,
        visible: true,
      });
      return id;
    },
    addMeshes(params: MeshBatchParams) {
      calls.addMeshes++;
      checkGeom(params.geometry);
      const n = params.transforms.length / 16;
      const first = meshes.length;
      for (let i = 0; i < n; i++) {
        const mat = typeof params.material === 'number' ? params.material : params.material[i];
        checkMat(mat);
        const t = new Float64Array(16);
        for (let k = 0; k < 16; k++) t[k] = params.transforms[i * 16 + k];
        meshes.push({
          geometry: params.geometry,
          material: mat,
          transform: t,
          objectId: params.objectIds ? params.objectIds[i] : first + i,
          alive: true,
          visible: true,
        });
      }
      return first;
    },
    remove(ids) {
      calls.remove++;
      const list = typeof ids === 'number' ? [ids] : Array.from(ids);
      for (const i of list) if (meshes[i]) meshes[i].alive = false;
    },
    clear() {
      for (const m of meshes) m.alive = false;
    },
    setTransform(id, t) {
      meshes[id].transform = Float64Array.from(t);
    },
    setMaterial(id, m) {
      meshes[id].material = m;
    },
    setVisible(ids, visible) {
      calls.setVisible++;
      forObjects(ids, (m) => (m.visible = visible));
    },
    isolate() {},
    setColor() {},
    select() {},
    getSelection: () => [],
    showAll() {
      for (const m of meshes) m.visible = true;
    },
    getCamera: () => ({ eye: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], fov: 1, orthographic: false }),
    setCamera() {},
    fitToView() {},
    getBounds: () => null,
    pick: async () => null,
    setSectionPlanes() {},
    on: () => () => {},
    resize() {},
    invalidate() {},
    dispose() {},
  };
  return v;
}

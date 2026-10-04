/**
 * mk-viewer: dependency-free WebGL2 viewer for very large scenes.
 *
 *   import { Viewer, box } from 'mk-viewer';
 *   const viewer = new Viewer(canvas);
 *   const geo = viewer.primitives.box([1, 2, 1]);
 *   const mat = viewer.createMaterial({ color: [0.8, 0.3, 0.2] });
 *   viewer.addMesh({ geometry: geo, material: mat });
 *   viewer.fitToView();
 */
export { Viewer } from './Viewer';
export type {
  Vec3,
  Color,
  Mat4,
  GeometryId,
  MaterialId,
  MeshId,
  ViewerOptions,
  GeometryData,
  MaterialParams,
  MeshParams,
  MeshBatchParams,
  PickResult,
  CameraState,
  SectionPlane,
  ViewerStats,
  ViewerEvents,
  Primitives,
  ViewerApi,
} from './types';
/** Raw GeometryData generators (positions/normals/indices) for users who build their own data. */
export { box, sphere, cylinder, cone, plane, torus, extrusion, triangulate } from './primitives';
export type { PrimitiveGeometry, UpAxis } from './primitives';

/**
 * mk-viewer: dependency-free WebGL2 viewer for very large scenes.
 *
 *   import { Viewer, box } from 'mk-viewer';
 *   const viewer = new Viewer(canvas);
 *   const geo = viewer.primitives.box([1, 2, 1]);
 *   const mat = viewer.createMaterial({ color: [0.8, 0.3, 0.2] });
 *   viewer.addMesh({ geometry: geo, material: mat });
 *   viewer.fitToView();
 *
 *   // models (loader plugins are registered explicitly)
 *   import { Viewer, gltfLoader } from 'mk-viewer';
 *   const viewer = new Viewer(canvas, { loaders: [gltfLoader] });
 *   const model = await viewer.load('plant.glb');
 */
export { Viewer } from './Viewer';
export type {
  Vec3,
  Color,
  Mat4,
  GeometryId,
  MaterialId,
  MeshId,
  ObjectIdRange,
  ObjectSelection,
  ViewerOptions,
  ViewerLoadOptions,
  ViewerLoadProgress,
  GeometryData,
  MaterialParams,
  MeshParams,
  MeshBatchParams,
  PickResult,
  SnapKind,
  SnapOptions,
  SnapResult,
  ScreenPoint,
  ViewerTool,
  ToolPointerInfo,
  ToolEndReason,
  ViewInfo,
  ContextMenuContext,
  ContextMenuItem,
  ContextMenuEntry,
  ContextMenuRequest,
  CameraState,
  SectionPlane,
  EnvironmentSource,
  EnvironmentImage,
  EnvironmentOptions,
  EnvironmentInfo,
  EdgeOptions,
  EdgeInfo,
  ViewerStats,
  ViewerEvents,
  Primitives,
  ViewerApi,
} from './types';
/**
 * Model loaders (plugins): registry, loadModel and the built-in glTF / OBJ plugins. Registration is
 * explicit, so unused plugins are tree-shaken: `new Viewer(canvas, { loaders: [gltfLoader] })`,
 * `viewer.registerLoader(plugin)` or `registerDefaultLoaders()`.
 */
export * from './loaders';
/** Optional built-in UI over the canvas: bottom toolbar and model tree panel (`createViewerUi`). */
export * from './ui';
/**
 * Viewer plugins: tools and UI additions installed with `new Viewer(canvas, { plugins: [...] })` or
 * `viewer.use(plugin)` (see docs/PLUGIN_API.md), and the built-in measurement and colour plugins.
 */
export * from './plugins';
/** Raw GeometryData generators (positions/normals/indices) for users who build their own data. */
export { box, sphere, cylinder, cone, plane, torus, extrusion, triangulate } from './primitives';
export type { PrimitiveGeometry, UpAxis } from './primitives';

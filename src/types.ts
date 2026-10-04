/**
 * Public API types of mk-viewer. The Viewer class (src/Viewer.ts) implements `ViewerApi`.
 *
 * Conventions: right-handed coordinates, 4x4 matrices are column-major (gl-matrix / glTF layout),
 * colours are sRGB in 0..1, angles are radians.
 */

export type Vec3 = [number, number, number] | Float32Array;
export type Color = [number, number, number] | [number, number, number, number];
/** Column-major 4x4, 16 numbers. Must be affine. */
export type Mat4 = ArrayLike<number>;

/** Opaque handles. Numeric so bulk APIs can use typed arrays. */
export type GeometryId = number;
export type MaterialId = number;
/** Identifies one placed mesh (a "fragment"). Stable until removed. */
export type MeshId = number;

export interface ViewerOptions {
  /** World up axis. Default 'y'. */
  up?: 'y' | 'z';
  /** Background colour(s): one colour or [top, bottom] gradient. */
  background?: Color | [Color, Color];
  /** CPU/GPU time budget per frame in ms while the camera moves. Default 12. */
  frameBudgetMs?: number;
  /** Objects whose projected size is below this many pixels are skipped while moving. Default 2. */
  cullPixelSize?: number;
  /** Same threshold for the final still image. Default 0.5. */
  cullPixelSizeStill?: number;
  /** Device pixel ratio cap. Default min(devicePixelRatio, 2). */
  pixelRatio?: number;
  /** Install built-in orbit/pan/zoom controls. Default true. */
  controls?: boolean;
  /** Click-to-select and hover highlight handled by the viewer. Default true. */
  autoSelect?: boolean;
}

export interface GeometryData {
  /** xyz triples. */
  positions: ArrayLike<number>;
  /** Triangle list. If omitted, positions are taken as non-indexed triangles. */
  indices?: ArrayLike<number>;
  /** xyz triples. If omitted, normals are computed (flat for non-indexed, smooth for indexed). */
  normals?: ArrayLike<number>;
}

export interface MaterialParams {
  /** sRGB colour; alpha < 1 makes the material transparent. Default [0.8, 0.8, 0.8, 1]. */
  color?: Color;
  metalness?: number;
  roughness?: number;
  /** 0..1, how much the base colour glows independent of lighting. */
  emissive?: number;
}

export interface MeshParams {
  geometry: GeometryId;
  material: MaterialId;
  /** Default identity. */
  transform?: Mat4;
  /**
   * Application-level id reported by picking/selection. Many meshes may share one objectId
   * (e.g. all parts of one door). Default: the MeshId.
   */
  objectId?: number;
}

export interface MeshBatchParams {
  geometry: GeometryId;
  /** One material for all, or one per instance. */
  material: MaterialId | ArrayLike<number>;
  /** 16 * count numbers, column-major matrices back to back. */
  transforms: ArrayLike<number>;
  objectIds?: ArrayLike<number>;
}

export interface PickResult {
  meshId: MeshId;
  objectId: number;
  /** World-space hit position. */
  position: [number, number, number];
  /** Distance from the camera eye. */
  distance: number;
}

export interface CameraState {
  eye: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  /** Vertical field of view (perspective only). */
  fov: number;
  orthographic: boolean;
}

export interface SectionPlane {
  /** Plane normal; geometry on the positive side is cut away. */
  normal: Vec3;
  /** Any point on the plane. */
  point: Vec3;
}

export interface ViewerStats {
  fps: number;
  frameMs: number;
  /** Meshes alive in the scene. */
  meshes: number;
  triangles: number;
  /** Draw items / draw calls / triangles submitted in the last frame. */
  drawItems: number;
  drawCalls: number;
  trianglesDrawn: number;
  /** 0..1, how much of the visible scene the progressive renderer has presented. */
  progress: number;
  gpuMemoryBytes: number;
}

export interface ViewerEvents {
  /** User clicked; `null` when the background was hit. */
  pick: PickResult | null;
  hover: PickResult | null;
  /** Current selection as objectIds. */
  selection: number[];
  camera: CameraState;
  /** Progressive rendering finished: the image is complete. */
  frameComplete: ViewerStats;
}

export interface Primitives {
  box(size?: Vec3): GeometryId;
  sphere(radius?: number, segments?: number): GeometryId;
  cylinder(radius?: number, height?: number, segments?: number): GeometryId;
  cone(radius?: number, height?: number, segments?: number): GeometryId;
  plane(width?: number, depth?: number): GeometryId;
  torus(radius?: number, tube?: number, radialSegments?: number, tubularSegments?: number): GeometryId;
  /** Extrude a closed 2D polygon (xy pairs, counter-clockwise) along +Z (or +Y when up = 'y'). */
  extrusion(outline: ArrayLike<number>, height: number): GeometryId;
}

export interface ViewerApi {
  readonly canvas: HTMLCanvasElement;
  readonly primitives: Primitives;
  readonly stats: ViewerStats;

  // --- scene construction (callable at any time, including every frame) ---
  createGeometry(data: GeometryData): GeometryId;
  /** Frees the geometry once no mesh uses it. */
  releaseGeometry(id: GeometryId): void;
  createMaterial(params?: MaterialParams): MaterialId;
  updateMaterial(id: MaterialId, params: MaterialParams): void;
  addMesh(params: MeshParams): MeshId;
  /** Bulk add; returns the first MeshId, the rest follow consecutively. */
  addMeshes(params: MeshBatchParams): MeshId;
  remove(ids: MeshId | ArrayLike<number>): void;
  clear(): void;
  setTransform(id: MeshId, transform: Mat4): void;
  setMaterial(id: MeshId, material: MaterialId): void;

  // --- per-object state; these take objectIds and affect every mesh carrying that id ---
  setVisible(objectIds: number | ArrayLike<number>, visible: boolean): void;
  /** Show only these objects; everything else is ghosted (or hidden when `hideOthers`). */
  isolate(objectIds: ArrayLike<number> | null, hideOthers?: boolean): void;
  /** Override colour; `null` restores the material colour. */
  setColor(objectIds: number | ArrayLike<number>, color: Color | null): void;
  select(objectIds: ArrayLike<number>): void;
  getSelection(): number[];
  showAll(): void;

  // --- camera ---
  getCamera(): CameraState;
  setCamera(state: Partial<CameraState>, animate?: boolean): void;
  /** Frame the given objects, or the whole scene. */
  fitToView(objectIds?: ArrayLike<number>, animate?: boolean): void;
  /** World-space bounds [minx, miny, minz, maxx, maxy, maxz], or null when empty. */
  getBounds(objectIds?: ArrayLike<number>): Float32Array | null;

  // --- queries and effects ---
  /** GPU pick at canvas CSS-pixel coordinates. */
  pick(x: number, y: number): Promise<PickResult | null>;
  setSectionPlanes(planes: SectionPlane[]): void;

  // --- lifecycle ---
  on<K extends keyof ViewerEvents>(event: K, handler: (payload: ViewerEvents[K]) => void): () => void;
  /** Call after changing canvas CSS size (a ResizeObserver does this automatically). */
  resize(): void;
  /** Force a redraw; normally not needed. */
  invalidate(): void;
  dispose(): void;
}

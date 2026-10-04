/** Minimal glTF 2.0 JSON typings (only what the loader reads). */

export interface GltfJson {
  asset: { version: string; generator?: string; copyright?: string; minVersion?: string };
  scene?: number;
  scenes?: { nodes?: number[]; name?: string }[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { uri?: string; byteLength: number }[];
  materials?: GltfMaterial[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extras?: unknown;
}

export interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extensions?: Record<string, any>;
  extras?: unknown;
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: unknown[];
  extensions?: Record<string, any>;
}

export interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
}

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
}

export interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  extensions?: Record<string, any>;
}

export interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    metallicFactor?: number;
    roughnessFactor?: number;
    baseColorTexture?: unknown;
  };
  emissiveFactor?: number[];
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  doubleSided?: boolean;
  extensions?: Record<string, any>;
}

/** Primitive modes. */
export const TRIANGLES = 4;
export const TRIANGLE_STRIP = 5;
export const TRIANGLE_FAN = 6;

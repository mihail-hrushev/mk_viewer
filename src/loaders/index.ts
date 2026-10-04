/**
 * Model loaders: plugin contract, registry, `loadModel` and the built-in glTF / OBJ plugins.
 *
 * Registration is explicit (tree-shakeable): call `registerDefaultLoaders()` once, or register only
 * the plugins you need: `defaultRegistry.register(gltfLoader)`.
 */
import { gltfLoader } from './gltf/GltfLoader';
import { objLoader } from './obj/ObjLoader';
import { defaultRegistry, type LoaderRegistry } from './registry';

export type {
  HierarchyBuilder,
  LoadContext,
  LoaderInput,
  LoaderPlugin,
  LoaderProbe,
  LoaderSource,
  LoadOptions,
  LoadProgress,
  LoadTask,
  Model,
  ModelHierarchy,
  ModelInfoExtras,
  ModelStats,
  PropertyProvider,
  ResourceResolver,
  UpAxis,
} from './types';
export { LoaderRegistry, defaultRegistry } from './registry';
export { loadModel, LoaderError } from './loadModel';
export { allocObjectIds, setNextObjectId, DEFAULT_OBJECT_ID_BASE } from './objectIds';
export { isAbortError } from './scheduler';
export { createGltfLoader, gltfLoader } from './gltf/GltfLoader';
export type { GltfLoaderOptions, ObjectGrouping, PrimitiveDecoder } from './gltf/GltfLoader';
export { objLoader } from './obj/ObjLoader';
export type { ObjLoaderOptions } from './obj/ObjLoader';

/** Registers the built-in glTF and OBJ plugins into `registry` (default: the shared registry). */
export function registerDefaultLoaders(registry: LoaderRegistry = defaultRegistry): LoaderRegistry {
  registry.register(objLoader);
  registry.register(gltfLoader);
  return registry;
}

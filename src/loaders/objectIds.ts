/**
 * Scene-unique objectId allocation shared by all models loaded into one viewer.
 *
 * Meshes added directly through `ViewerApi` without an objectId report their MeshId (0, 1, 2, …), so
 * loader ids start high (`DEFAULT_OBJECT_ID_BASE` = 2^30) to never collide with those. objectIds are
 * float64 in the viewer, so the space is effectively unbounded; ids of unloaded models are not reused.
 */
import type { ViewerApi } from '../types';

export const DEFAULT_OBJECT_ID_BASE = 0x40000000;

const next = new WeakMap<object, number>();

/** Reserves `count` consecutive objectIds for `viewer`; returns the first. */
export function allocObjectIds(viewer: ViewerApi, count: number): number {
  if (!(count >= 0) || Math.floor(count) !== count) throw new RangeError(`allocObjectIds: invalid count ${count}`);
  const first = next.get(viewer) ?? DEFAULT_OBJECT_ID_BASE;
  next.set(viewer, first + count);
  return first;
}

/** Sets the next objectId handed out for `viewer` (e.g. to restore ids saved by an application). */
export function setNextObjectId(viewer: ViewerApi, id: number): void {
  next.set(viewer, id);
}

/**
 * Scene-unique objectId allocation shared by all models loaded into one viewer.
 *
 * The viewer owns the allocator (`ViewerApi.allocObjectIds`); these helpers delegate to it. For a
 * `ViewerApi` implementation without one (custom wrappers, older code) a per-viewer counter is kept
 * here instead.
 *
 * Meshes added directly through `ViewerApi` without an objectId report their MeshId (0, 1, 2, …), so
 * loader ids start high (`DEFAULT_OBJECT_ID_BASE` = 2^30) to never collide with those. objectIds are
 * float64 in the viewer, so the space is effectively unbounded; ids of unloaded models are not reused.
 */
import type { ViewerApi } from '../types';

export const DEFAULT_OBJECT_ID_BASE = 0x40000000;

const next = new WeakMap<object, number>();

/** Fallback allocator state for a viewer without `allocObjectIds`; returns the first id. */
export function allocObjectIdsFallback(owner: object, count: number): number {
  checkCount(count);
  const first = next.get(owner) ?? DEFAULT_OBJECT_ID_BASE;
  next.set(owner, first + count);
  return first;
}

/** Reserves `count` consecutive objectIds for `viewer`; returns the first. */
export function allocObjectIds(viewer: ViewerApi, count: number): number {
  checkCount(count);
  const own = (viewer as Partial<ViewerApi>).allocObjectIds;
  if (typeof own === 'function') return own.call(viewer, count);
  return allocObjectIdsFallback(viewer, count);
}

/** Sets the next objectId handed out for `viewer` (e.g. to restore ids saved by an application). */
export function setNextObjectId(viewer: ViewerApi, id: number): void {
  const own = (viewer as { setNextObjectId?: (id: number) => void }).setNextObjectId;
  if (typeof own === 'function') own.call(viewer, id);
  else next.set(viewer, id);
}

function checkCount(count: number): void {
  if (!(count >= 0) || Math.floor(count) !== count) throw new RangeError(`allocObjectIds: invalid count ${count}`);
}

/**
 * Standard views (top, front, iso...): the view direction and image up vector of each, for a Y-up
 * or Z-up world. Defined for Z up and mapped to Y up with (x, y, z) -> (x, z, -y), the inverse of
 * the usual Y-up to Z-up conversion, so 'front' looks from -Y with Z up and from +Z with Y up.
 */
import type { StandardView } from '../types';

/** Z up: [direction target -> eye, image up], unnormalized. */
const Z_UP_VIEWS: Record<StandardView, [number[], number[]]> = {
  top: [[0, 0, 1], [0, 1, 0]],
  bottom: [[0, 0, -1], [0, -1, 0]],
  front: [[0, -1, 0], [0, 0, 1]],
  back: [[0, 1, 0], [0, 0, 1]],
  left: [[-1, 0, 0], [0, 0, 1]],
  right: [[1, 0, 0], [0, 0, 1]],
  iso: [[1, -1, 1], [0, 0, 1]],
};

/** The names accepted by `standardView`, in display order. */
export const STANDARD_VIEWS: readonly StandardView[] = ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'];

/**
 * Writes the unit direction from the target to the eye and the image up vector of `view` into
 * `dir` and `up`. TypeError for an unknown view name.
 */
export function standardView(view: StandardView, worldUp: 'y' | 'z', dir: number[] | Float64Array, up: number[] | Float64Array): void {
  const v = Object.prototype.hasOwnProperty.call(Z_UP_VIEWS, view) ? Z_UP_VIEWS[view] : undefined;
  if (!v) throw new TypeError(`mk-viewer: unknown standard view '${String(view)}' (expected one of ${STANDARD_VIEWS.join(', ')})`);
  const [d, u] = v;
  const l = Math.hypot(d[0], d[1], d[2]);
  if (worldUp === 'z') {
    dir[0] = d[0] / l; dir[1] = d[1] / l; dir[2] = d[2] / l;
    up[0] = u[0]; up[1] = u[1]; up[2] = u[2];
  } else {
    dir[0] = d[0] / l; dir[1] = d[2] / l; dir[2] = -d[1] / l;
    up[0] = u[0]; up[1] = u[2]; up[2] = -u[1];
  }
}

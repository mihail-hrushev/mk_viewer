/**
 * Screen-space helpers: projected size estimates (for pixel-size culling), unprojection and rays.
 */
import type { ReadArray, WriteArray } from './common';

/**
 * Pixels per world unit at distance 1 for a perspective camera: viewportHeightPx / (2 tan(fovy/2)).
 * The on-screen size of an object of size s at distance d is then about s * factor / d.
 */
export function perspectivePixelFactor(fovy: number, viewportHeightPx: number): number {
  return viewportHeightPx / (2 * Math.tan(fovy / 2));
}

/** Pixels per world unit for an orthographic camera whose view is `viewHeight` world units tall. */
export function orthographicPixelFactor(viewHeight: number, viewportHeightPx: number): number {
  return viewportHeightPx / viewHeight;
}

/**
 * Approximate on-screen diameter in pixels of a sphere.
 * Perspective: `pixelFactor` from perspectivePixelFactor, distance measured from `eye`;
 * returns Infinity when the eye is inside the sphere.
 * Orthographic: `pixelFactor` from orthographicPixelFactor; `eye` is ignored.
 */
export function projectedSphereSizePx(
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  eye: ReadArray,
  pixelFactor: number,
  orthographic: boolean,
): number {
  if (orthographic) return 2 * radius * pixelFactor;
  const dx = cx - eye[0], dy = cy - eye[1], dz = cz - eye[2];
  const d2 = dx * dx + dy * dy + dz * dz - radius * radius;
  if (d2 <= 0) return Infinity;
  return (2 * radius * pixelFactor) / Math.sqrt(d2);
}

/**
 * Approximate on-screen size in pixels of box [minx..maxz] at `offset` in `box`, via its bounding
 * sphere (conservative: never smaller than the box's true projected extent).
 */
export function projectedAABBSizePx(
  box: ReadArray,
  eye: ReadArray,
  pixelFactor: number,
  orthographic: boolean,
  offset = 0,
): number {
  const minx = box[offset], miny = box[offset + 1], minz = box[offset + 2];
  const sx = box[offset + 3] - minx, sy = box[offset + 4] - miny, sz = box[offset + 5] - minz;
  const r = 0.5 * Math.sqrt(sx * sx + sy * sy + sz * sz);
  return projectedSphereSizePx(minx + sx * 0.5, miny + sy * 0.5, minz + sz * 0.5, r, eye, pixelFactor, orthographic);
}

/** Converts CSS pixel coordinates (origin top-left) to NDC x/y written to out[0], out[1]. */
export function cssToNdc<T extends WriteArray>(out: T, x: number, y: number, width: number, height: number): T {
  out[0] = (x / width) * 2 - 1;
  out[1] = 1 - (y / height) * 2;
  return out;
}

/** Depth-buffer value (0..1, default glDepthRange) to NDC z (-1..1). */
export function depthToNdcZ(depth: number): number {
  return depth * 2 - 1;
}

/** NDC (x, y, z in -1..1) to world space using the inverse view-projection matrix. */
export function unproject<T extends WriteArray>(out: T, invViewProj: ReadArray, ndcX: number, ndcY: number, ndcZ: number): T {
  const m = invViewProj;
  const x = m[0] * ndcX + m[4] * ndcY + m[8] * ndcZ + m[12];
  const y = m[1] * ndcX + m[5] * ndcY + m[9] * ndcZ + m[13];
  const z = m[2] * ndcX + m[6] * ndcY + m[10] * ndcZ + m[14];
  const w = m[3] * ndcX + m[7] * ndcY + m[11] * ndcZ + m[15];
  const iw = w !== 0 ? 1 / w : 1;
  out[0] = x * iw;
  out[1] = y * iw;
  out[2] = z * iw;
  return out;
}

/**
 * World-space ray through NDC (x, y). The origin lies on the near plane; the direction is
 * normalized and points into the scene. Works for perspective and orthographic projections.
 */
export function rayFromNDC(
  outOrigin: WriteArray,
  outDir: WriteArray,
  invViewProj: ReadArray,
  ndcX: number,
  ndcY: number,
): void {
  unproject(outOrigin, invViewProj, ndcX, ndcY, -1);
  // a point halfway into the depth range is well conditioned even for huge far/near ratios
  unproject(outDir, invViewProj, ndcX, ndcY, 0);
  const dx = outDir[0] - outOrigin[0], dy = outDir[1] - outOrigin[1], dz = outDir[2] - outOrigin[2];
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const inv = l > 0 ? 1 / l : 0;
  outDir[0] = dx * inv;
  outDir[1] = dy * inv;
  outDir[2] = dz * inv;
}

/**
 * Distance t along the ray (origin o, direction d) to the plane through `p` with normal `n`,
 * or NaN when parallel.
 */
export function rayPlaneDistance(o: ReadArray, d: ReadArray, p: ReadArray, n: ReadArray): number {
  const denom = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
  if (Math.abs(denom) < 1e-15) return NaN;
  return ((p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2]) / denom;
}

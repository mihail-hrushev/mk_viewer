/** Read-only numeric array input (Float32Array, Float64Array, number[], ...). */
export type ReadArray = ArrayLike<number>;

/** Writable numeric array used for out-parameters (Float32Array, Float64Array, number[]). */
export interface WriteArray {
  [index: number]: number;
  readonly length: number;
}

export const EPSILON = 1e-12;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

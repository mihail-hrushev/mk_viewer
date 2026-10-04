/**
 * MaterialStore: the CPU side of the material data texture (layout.ts MAT_*).
 * `data` is MAT_FLOATS floats per material, capacity a multiple of MAT_RECORDS_PER_ROW, so it can be
 * uploaded as an RGBA32F texture of width MAT_TEX_WIDTH and height `rows`.
 */
import type { Color, MaterialParams } from '../types';
import {
  MAT_COLOR,
  MAT_EMISSIVE,
  MAT_FLOATS,
  MAT_METALNESS,
  MAT_RECORDS_PER_ROW,
  MAT_ROUGHNESS,
} from '../layout';
import { DirtyRows } from './DirtyRows';
import { srgbToLinear } from './coremath';

const DEFAULT_COLOR: Color = [0.8, 0.8, 0.8, 1];

export class MaterialStore {
  /** RGBA32F texture contents, MAT_FLOATS per material. */
  data: Float32Array;
  /** 1 when opacity < 1. */
  transparent: Uint8Array;
  /** Number of materials created (ids are 0..count-1). */
  count = 0;
  readonly dirty: DirtyRows;
  /** Incremented when capacity (texture height) changes. */
  capacityVersion = 0;

  constructor() {
    this.data = new Float32Array(MAT_RECORDS_PER_ROW * MAT_FLOATS);
    this.transparent = new Uint8Array(MAT_RECORDS_PER_ROW);
    this.dirty = new DirtyRows(1);
  }

  /** Texture height in rows (MAT_RECORDS_PER_ROW records per row). */
  get rows(): number {
    return this.transparent.length / MAT_RECORDS_PER_ROW;
  }

  /** Rows that contain at least one material. */
  get usedRows(): number {
    return Math.ceil(this.count / MAT_RECORDS_PER_ROW);
  }

  isValid(id: number): boolean {
    return id >= 0 && id < this.count && (id | 0) === id;
  }

  isTransparent(id: number): boolean {
    return this.transparent[id] === 1;
  }

  create(params: MaterialParams = {}): number {
    const id = this.count;
    if (id >= this.transparent.length) {
      const cap = this.transparent.length * 2;
      const d = new Float32Array(cap * MAT_FLOATS);
      d.set(this.data);
      this.data = d;
      const t = new Uint8Array(cap);
      t.set(this.transparent);
      this.transparent = t;
      this.dirty.resize(cap / MAT_RECORDS_PER_ROW);
      this.capacityVersion++;
    }
    this.count++;
    const o = id * MAT_FLOATS;
    this.data[o + MAT_METALNESS] = 0;
    this.data[o + MAT_ROUGHNESS] = 0.5;
    this.data[o + MAT_EMISSIVE] = 0;
    this.writeColor(id, params.color ?? DEFAULT_COLOR);
    this.update(id, params);
    this.dirty.mark((id / MAT_RECORDS_PER_ROW) | 0);
    return id;
  }

  /**
   * Updates the given fields (omitted ones are kept). A colour with 3 components means opacity 1.
   * Returns true when the transparent flag changed (fragments must move between passes).
   */
  update(id: number, params: MaterialParams): boolean {
    if (!this.isValid(id)) throw new Error(`invalid material id ${id}`);
    const before = this.transparent[id];
    const o = id * MAT_FLOATS;
    if (params.color) this.writeColor(id, params.color);
    if (params.metalness !== undefined) this.data[o + MAT_METALNESS] = clamp01(params.metalness);
    if (params.roughness !== undefined) this.data[o + MAT_ROUGHNESS] = clamp01(params.roughness);
    if (params.emissive !== undefined) this.data[o + MAT_EMISSIVE] = clamp01(params.emissive);
    this.dirty.mark((id / MAT_RECORDS_PER_ROW) | 0);
    return before !== this.transparent[id];
  }

  /** Reports dirty row runs (firstRow, rowCount) and clears them. */
  flushDirty(fn: (firstRow: number, rowCount: number) => void): void {
    this.dirty.flush(fn);
  }

  private writeColor(id: number, c: Color): void {
    const o = id * MAT_FLOATS + MAT_COLOR;
    this.data[o] = srgbToLinear(c[0]);
    this.data[o + 1] = srgbToLinear(c[1]);
    this.data[o + 2] = srgbToLinear(c[2]);
    const a = c.length > 3 ? clamp01((c as number[])[3]) : 1;
    this.data[o + 3] = a;
    this.transparent[id] = a < 1 ? 1 : 0;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

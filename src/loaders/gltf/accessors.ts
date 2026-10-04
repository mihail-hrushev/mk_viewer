/**
 * Accessor decoding. Returns typed-array *views* on the original buffer whenever layout allows
 * (float, tightly packed, 4-byte aligned, no sparse) and copies per accessor otherwise (strided,
 * misaligned, normalized/quantized integers, sparse).
 */
import type { GltfAccessor, GltfJson } from './schema';

const COMPS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

type Getter = (dv: DataView, off: number) => number;

function getter(ct: number, normalized: boolean): Getter {
  switch (ct) {
    case 5126: return (dv, o) => dv.getFloat32(o, true);
    case 5120: return normalized ? (dv, o) => Math.max(dv.getInt8(o) / 127, -1) : (dv, o) => dv.getInt8(o);
    case 5121: return normalized ? (dv, o) => dv.getUint8(o) / 255 : (dv, o) => dv.getUint8(o);
    case 5122: return normalized ? (dv, o) => Math.max(dv.getInt16(o, true) / 32767, -1) : (dv, o) => dv.getInt16(o, true);
    case 5123: return normalized ? (dv, o) => dv.getUint16(o, true) / 65535 : (dv, o) => dv.getUint16(o, true);
    case 5125: return (dv, o) => dv.getUint32(o, true);
    default: throw new Error(`Unsupported accessor componentType ${ct}`);
  }
}

export class AccessorReader {
  /** Number of accessors served as zero-copy views / copied (diagnostics). */
  views = 0;
  copies = 0;
  copiedBytes = 0;

  constructor(
    private readonly json: GltfJson,
    private readonly buffers: (Uint8Array | undefined)[],
  ) {}

  accessor(index: number): GltfAccessor {
    const a = this.json.accessors?.[index];
    if (!a) throw new Error(`Accessor ${index} does not exist`);
    return a;
  }

  /** Bytes of a bufferView (view, no copy). */
  bufferView(index: number): Uint8Array {
    const bv = this.json.bufferViews?.[index];
    if (!bv) throw new Error(`bufferView ${index} does not exist`);
    if (bv.extensions && (bv.extensions.EXT_meshopt_compression || bv.extensions.KHR_meshopt_compression)) {
      throw new Error('bufferView uses meshopt compression, which this loader does not decode');
    }
    const buf = this.buffers[bv.buffer];
    if (!buf) throw new Error(`Buffer ${bv.buffer} is not available`);
    const start = bv.byteOffset ?? 0;
    if (start + bv.byteLength > buf.byteLength) throw new Error(`bufferView ${index} exceeds its buffer`);
    return buf.subarray(start, start + bv.byteLength);
  }

  /** Float components (dequantized when normalized). `comps` checks the accessor type. */
  readFloat(index: number, comps: number): Float32Array {
    const a = this.accessor(index);
    const nc = COMPS[a.type];
    if (nc !== comps) throw new Error(`Accessor ${index}: expected ${comps} components, got ${a.type}`);
    const n = a.count * nc;
    let out: Float32Array | null = null;
    if (a.bufferView !== undefined) {
      const { bytes, stride, elem } = this.layout(a, index);
      const abs = bytes.byteOffset;
      if (a.componentType === 5126 && stride === elem && abs % 4 === 0 && !a.sparse) {
        this.views++;
        return new Float32Array(bytes.buffer, abs, n);
      }
      out = new Float32Array(n);
      this.copies++;
      this.copiedBytes += n * 4;
      if (a.componentType === 5126 && abs % 4 === 0 && stride % 4 === 0) {
        // strided float: read through an aligned float view
        const src = new Float32Array(bytes.buffer, abs, ((a.count - 1) * stride + elem) / 4);
        const s4 = stride / 4;
        for (let i = 0, o = 0; i < a.count; i++) for (let c = 0; c < nc; c++) out[o++] = src[i * s4 + c];
      } else {
        const dv = new DataView(bytes.buffer, abs, bytes.byteLength);
        const get = getter(a.componentType, !!a.normalized);
        const cs = SIZE[a.componentType];
        for (let i = 0, o = 0; i < a.count; i++) for (let c = 0; c < nc; c++) out[o++] = get(dv, i * stride + c * cs);
      }
    } else {
      out = new Float32Array(n);
    }
    if (a.sparse) this.applySparse(a, out, nc, getter(a.componentType, !!a.normalized));
    return out;
  }

  /** Integer scalars for indices: u8/u16/u32 view when possible. */
  readIndices(index: number): Uint8Array | Uint16Array | Uint32Array {
    const a = this.accessor(index);
    if (a.type !== 'SCALAR') throw new Error(`Index accessor ${index} must be SCALAR`);
    const ct = a.componentType;
    if (ct !== 5121 && ct !== 5123 && ct !== 5125) throw new Error(`Index accessor ${index}: invalid componentType ${ct}`);
    const cs = SIZE[ct];
    let out: Uint8Array | Uint16Array | Uint32Array;
    if (a.bufferView === undefined) out = new Uint32Array(a.count);
    else {
      const { bytes, stride } = this.layout(a, index);
      const abs = bytes.byteOffset;
      if (stride === cs && abs % cs === 0 && !a.sparse) {
        this.views++;
        return ct === 5121 ? new Uint8Array(bytes.buffer, abs, a.count)
          : ct === 5123 ? new Uint16Array(bytes.buffer, abs, a.count)
          : new Uint32Array(bytes.buffer, abs, a.count);
      }
      this.copies++;
      this.copiedBytes += a.count * 4;
      out = new Uint32Array(a.count);
      const dv = new DataView(bytes.buffer, abs, bytes.byteLength);
      const get = getter(ct, false);
      for (let i = 0; i < a.count; i++) out[i] = get(dv, i * stride);
    }
    if (a.sparse) {
      if (!(out instanceof Uint32Array)) out = Uint32Array.from(out);
      this.applySparse(a, out, 1, getter(ct, false));
    }
    return out;
  }

  private layout(a: GltfAccessor, index: number): { bytes: Uint8Array; stride: number; elem: number } {
    const bv = this.json.bufferViews![a.bufferView!];
    const view = this.bufferView(a.bufferView!);
    const elem = COMPS[a.type] * (SIZE[a.componentType] ?? 0);
    if (!elem) throw new Error(`Accessor ${index}: invalid type/componentType`);
    const stride = bv.byteStride || elem;
    const off = a.byteOffset ?? 0;
    const need = a.count > 0 ? off + (a.count - 1) * stride + elem : off;
    if (need > view.byteLength) throw new Error(`Accessor ${index} exceeds its bufferView`);
    return { bytes: view.subarray(off, need), stride, elem };
  }

  private applySparse(a: GltfAccessor, out: Float32Array | Uint32Array, nc: number, get: Getter): void {
    const sp = a.sparse!;
    const ib = this.bufferView(sp.indices.bufferView);
    const vb = this.bufferView(sp.values.bufferView);
    const idv = new DataView(ib.buffer, ib.byteOffset + (sp.indices.byteOffset ?? 0));
    const vdv = new DataView(vb.buffer, vb.byteOffset + (sp.values.byteOffset ?? 0));
    const iget = getter(sp.indices.componentType, false);
    const isz = SIZE[sp.indices.componentType];
    const vsz = SIZE[a.componentType];
    for (let k = 0; k < sp.count; k++) {
      const target = iget(idv, k * isz);
      if (target >= a.count) throw new Error('Sparse accessor index out of range');
      for (let c = 0; c < nc; c++) out[target * nc + c] = get(vdv, (k * nc + c) * vsz);
    }
  }
}

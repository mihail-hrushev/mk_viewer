/** Builds small glTF / GLB fixtures in memory for tests. */

type TA = Float32Array | Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array;

const CT = (a: TA): number =>
  a instanceof Float32Array ? 5126 : a instanceof Uint32Array ? 5125 : a instanceof Uint16Array ? 5123
    : a instanceof Int16Array ? 5122 : a instanceof Uint8Array ? 5121 : 5120;

export class GltfBuilder {
  json: any = {
    asset: { version: '2.0', generator: 'test' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
    materials: [],
  };
  private bin = new Uint8Array(1024);
  private len = 0;

  /** Appends raw bytes as a bufferView (aligned to `align`, optionally misaligned by `pad`). */
  view(bytes: Uint8Array, opts: { stride?: number; pad?: number } = {}): number {
    let off = Math.ceil(this.len / 4) * 4 + (opts.pad ?? 0);
    this.ensure(off + bytes.length);
    this.bin.set(bytes, off);
    this.len = off + bytes.length;
    const bv: any = { buffer: 0, byteOffset: off, byteLength: bytes.length };
    if (opts.stride) bv.byteStride = opts.stride;
    this.json.bufferViews.push(bv);
    return this.json.bufferViews.length - 1;
  }

  /** Tightly packed accessor over a new bufferView. */
  accessor(data: TA, type: string, opts: { normalized?: boolean; pad?: number; minmax?: boolean } = {}): number {
    const bv = this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), { pad: opts.pad });
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type]!;
    const acc: any = { bufferView: bv, componentType: CT(data), count: data.length / comps, type };
    if (opts.normalized) acc.normalized = true;
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }

  /** Raw accessor definition (for strided / offset / sparse cases). */
  rawAccessor(acc: any): number {
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }

  mesh(primitives: any[], name?: string): number {
    this.json.meshes.push({ primitives, ...(name ? { name } : {}) });
    return this.json.meshes.length - 1;
  }

  node(n: any, root = false): number {
    this.json.nodes.push(n);
    const i = this.json.nodes.length - 1;
    if (root) this.json.scenes[0].nodes.push(i);
    return i;
  }

  material(m: any): number {
    this.json.materials.push(m);
    return this.json.materials.length - 1;
  }

  binary(): Uint8Array<ArrayBuffer> {
    const n = Math.ceil(this.len / 4) * 4;
    const out = new Uint8Array(n);
    out.set(this.bin.subarray(0, this.len));
    return out;
  }

  glb(): Uint8Array {
    const bin = this.binary();
    const json = structuredClone(this.json);
    json.buffers = [{ byteLength: bin.length }];
    const text = new TextEncoder().encode(JSON.stringify(json));
    const jpad = (4 - (text.length % 4)) % 4;
    const jl = text.length + jpad;
    const total = 12 + 8 + jl + 8 + bin.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jl, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(text, 20);
    out.fill(0x20, 20 + text.length, 20 + jl);
    dv.setUint32(20 + jl, bin.length, true);
    dv.setUint32(24 + jl, 0x004e4942, true);
    out.set(bin, 28 + jl);
    return out;
  }

  /** .gltf JSON with the buffer either embedded as data URI or referenced as `uri`. */
  gltf(bufferUri?: string): string {
    const bin = this.binary();
    const json = structuredClone(this.json);
    let uri = bufferUri;
    if (!uri) {
      let s = '';
      for (let i = 0; i < bin.length; i++) s += String.fromCharCode(bin[i]);
      uri = 'data:application/octet-stream;base64,' + btoa(s);
    }
    json.buffers = [{ byteLength: bin.length, uri }];
    return JSON.stringify(json);
  }

  private ensure(n: number): void {
    if (n <= this.bin.length) return;
    const b = new Uint8Array(Math.max(n, this.bin.length * 2));
    b.set(this.bin);
    this.bin = b;
  }
}

/** Unit right triangle in XY. */
export const TRI = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
export const TRI_N = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);

/** Apply a column-major matrix to a point. */
export function xform(m: ArrayLike<number>, p: [number, number, number]): [number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

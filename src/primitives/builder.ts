import type { GeometryData } from '../types';

/** GeometryData with concrete typed arrays, as produced by every primitive. */
export interface PrimitiveGeometry extends GeometryData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export type UpAxis = 'y' | 'z';

/** Growable vertex/index buffers. Primitives are built in a Z-up local frame. */
export class MeshBuilder {
  readonly p: number[] = [];
  readonly n: number[] = [];
  readonly i: number[] = [];

  get vertexCount(): number {
    return this.p.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    const idx = this.p.length / 3;
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    return idx;
  }

  tri(a: number, b: number, c: number): void {
    this.i.push(a, b, c);
  }

  /**
   * Converts to typed arrays. With up = 'y' the Z-up local frame is rotated -90 degrees about X
   * ((x, y, z) -> (x, z, -y)), a proper rotation, so winding and outward normals are preserved.
   */
  build(up: UpAxis = 'z'): PrimitiveGeometry {
    const positions = new Float32Array(this.p);
    const normals = new Float32Array(this.n);
    if (up === 'y') {
      remapZupToYup(positions);
      remapZupToYup(normals);
    }
    return { positions, normals, indices: new Uint32Array(this.i) };
  }
}

function remapZupToYup(a: Float32Array): void {
  for (let k = 0; k < a.length; k += 3) {
    const y = a[k + 1], z = a[k + 2];
    a[k + 1] = z;
    a[k + 2] = y === 0 ? 0 : -y;
  }
}

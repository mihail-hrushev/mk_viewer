/** glTF material -> mk-viewer MaterialParams (no textures: factors only). */
import type { MaterialParams } from '../../types';
import type { GltfMaterial } from './schema';

export function linearToSrgb(c: number): number {
  c = Math.min(1, Math.max(0, c));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * baseColorFactor is linear in glTF; the viewer takes sRGB. `srgbInput` skips the conversion for
 * exporters that (incorrectly) write sRGB values.
 */
export function gltfMaterialParams(m: GltfMaterial, srgbInput = false): MaterialParams {
  const pbr = m.pbrMetallicRoughness ?? {};
  const f = pbr.baseColorFactor ?? [1, 1, 1, 1];
  const conv = srgbInput ? (c: number) => Math.min(1, Math.max(0, c)) : linearToSrgb;
  const alpha = m.alphaMode === 'BLEND' ? Math.min(1, Math.max(0, f[3] ?? 1)) : 1;
  const e = m.emissiveFactor ?? [0, 0, 0];
  const strength = m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
  const emissive = Math.min(1, Math.max(0, Math.max(e[0] ?? 0, e[1] ?? 0, e[2] ?? 0) * strength));
  const params: MaterialParams = {
    color: [conv(f[0] ?? 1), conv(f[1] ?? 1), conv(f[2] ?? 1), alpha],
    metalness: pbr.metallicFactor ?? 1,
    roughness: pbr.roughnessFactor ?? 1,
  };
  if (emissive > 0) params.emissive = emissive;
  return params;
}

/** GLB container parsing and JSON decoding without copying the binary chunk. */
import type { GltfJson } from './schema';

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export function isGlb(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

/** Heuristic for .gltf JSON: starts with '{' (after BOM/whitespace) and mentions "asset" early. */
export function looksLikeGltfJson(header: Uint8Array): boolean {
  let i = 0;
  if (header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf) i = 3;
  while (i < header.length && (header[i] === 0x20 || header[i] === 0x0a || header[i] === 0x0d || header[i] === 0x09)) i++;
  if (header[i] !== 0x7b) return false;
  const text = new TextDecoder().decode(header.subarray(i, Math.min(header.length, i + 256)));
  return /"(asset|scenes|nodes|accessors|bufferViews|buffers)"\s*:/.test(text);
}

/**
 * Splits a GLB into its parsed JSON and a view of the BIN chunk (no copy). The JSON text exists only
 * inside this function, so string and parsed form are never both retained.
 */
export function parseGlb(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array | undefined } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || dv.getUint32(0, true) !== MAGIC) throw new Error('Not a GLB file (bad magic)');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`Unsupported GLB container version ${version} (only 2 is supported)`);
  const length = Math.min(dv.getUint32(8, true), bytes.length);
  let off = 12;
  let json: GltfJson | undefined;
  let bin: Uint8Array | undefined;
  while (off + 8 <= length) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (start + len > length) throw new Error('GLB chunk exceeds file length (truncated file?)');
    if (type === CHUNK_JSON && !json) json = parseJsonBytes(bytes.subarray(start, start + len));
    else if (type === CHUNK_BIN && !bin) bin = bytes.subarray(start, start + len);
    off = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

export function parseJsonBytes(bytes: Uint8Array): GltfJson {
  const json = JSON.parse(new TextDecoder().decode(bytes)) as GltfJson;
  if (!json || typeof json !== 'object' || !json.asset) throw new Error('Invalid glTF: missing "asset"');
  const major = parseInt(String(json.asset.minVersion ?? json.asset.version), 10);
  if (major !== 2) throw new Error(`Unsupported glTF version "${json.asset.version}" (only 2.x is supported)`);
  return json;
}

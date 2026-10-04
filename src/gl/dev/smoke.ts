/**
 * End-to-end smoke test of src/gl without the other modules. Run `npx vite` in the project root and
 * open http://localhost:5173/src/gl/dev/smoke.html
 *
 * Scene: a merged page (5x5 grid of cubes and spheres, fragments 0..24) and an instanced page
 * (100 small cubes on a ring, fragments 25..124, drawn as two instance chunks). Fragment data and
 * material textures are filled by hand following src/layout.ts.
 *
 * Mouse: drag = orbit, wheel = zoom, hover = highlight + pick readout, click = toggle selection.
 * Keys: L = simulate context loss/restore, S = section plane, H = hide/show fragment 12, G = toggle ghosting of row 3, M = multi-draw on/off,
 *       C = colour override on fragment 3, O = outline on/off.
 */
import {
  FRAG_COLOR,
  FRAG_DEQUANT_OFFSET,
  FRAG_DEQUANT_SCALE,
  FRAG_FLAGS,
  FRAG_FLOATS,
  FRAG_MATERIAL,
  FRAG_RECORDS_PER_ROW,
  FRAG_TEX_WIDTH,
  FragFlags,
  MAT_COLOR,
  MAT_EMISSIVE,
  MAT_FLOATS,
  MAT_METALNESS,
  MAT_RECORDS_PER_ROW,
  MAT_ROUGHNESS,
  MAT_TEX_WIDTH,
  MERGED_VERTEX_STRIDE,
  SHARED_VERTEX_STRIDE,
  VERTEX_FRAGMENT_OFFSET,
  VERTEX_NORMAL_OFFSET,
  VERTEX_POSITION_OFFSET,
} from '../../layout';
import {
  DataTexture,
  DrawSubmitter,
  GeometryVao,
  GlContext,
  GpuTimer,
  MirroredBuffer,
  PixelReader,
  PostPasses,
  RenderTargets,
  UberProgram,
  UBER_FRAG_TEX_UNIT,
  UBER_MAT_TEX_UNIT,
  applyPassState,
  linearizeDepth,
  octEncodeSnorm8,
  planeFromNormalPoint,
  planesToViewSpace,
  srgbToLinear,
  unprojectDepth,
  type UberPass,
} from '../index';

// ---------------------------------------------------------------------------
// tiny column-major mat4 helpers (src/math is off limits for this module)
// ---------------------------------------------------------------------------
function perspective(out: Float32Array, fovy: number, aspect: number, near: number, far: number): void {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
}
function lookAt(out: Float32Array, eye: number[], target: number[], up: number[]): void {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz);
  zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz);
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out.set([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}
function multiply(out: Float32Array, a: Float32Array, b: Float32Array): void {
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
}
function invert(out: Float32Array, m: Float32Array): boolean {
  const a = Array.from(m);
  const inv = new Array<number>(16);
  inv[0] = a[5]*a[10]*a[15]-a[5]*a[11]*a[14]-a[9]*a[6]*a[15]+a[9]*a[7]*a[14]+a[13]*a[6]*a[11]-a[13]*a[7]*a[10];
  inv[4] = -a[4]*a[10]*a[15]+a[4]*a[11]*a[14]+a[8]*a[6]*a[15]-a[8]*a[7]*a[14]-a[12]*a[6]*a[11]+a[12]*a[7]*a[10];
  inv[8] = a[4]*a[9]*a[15]-a[4]*a[11]*a[13]-a[8]*a[5]*a[15]+a[8]*a[7]*a[13]+a[12]*a[5]*a[11]-a[12]*a[7]*a[9];
  inv[12] = -a[4]*a[9]*a[14]+a[4]*a[10]*a[13]+a[8]*a[5]*a[14]-a[8]*a[6]*a[13]-a[12]*a[5]*a[10]+a[12]*a[6]*a[9];
  inv[1] = -a[1]*a[10]*a[15]+a[1]*a[11]*a[14]+a[9]*a[2]*a[15]-a[9]*a[3]*a[14]-a[13]*a[2]*a[11]+a[13]*a[3]*a[10];
  inv[5] = a[0]*a[10]*a[15]-a[0]*a[11]*a[14]-a[8]*a[2]*a[15]+a[8]*a[3]*a[14]+a[12]*a[2]*a[11]-a[12]*a[3]*a[10];
  inv[9] = -a[0]*a[9]*a[15]+a[0]*a[11]*a[13]+a[8]*a[1]*a[15]-a[8]*a[3]*a[13]-a[12]*a[1]*a[11]+a[12]*a[3]*a[9];
  inv[13] = a[0]*a[9]*a[14]-a[0]*a[10]*a[13]-a[8]*a[1]*a[14]+a[8]*a[2]*a[13]+a[12]*a[1]*a[10]-a[12]*a[2]*a[9];
  inv[2] = a[1]*a[6]*a[15]-a[1]*a[7]*a[14]-a[5]*a[2]*a[15]+a[5]*a[3]*a[14]+a[13]*a[2]*a[7]-a[13]*a[3]*a[6];
  inv[6] = -a[0]*a[6]*a[15]+a[0]*a[7]*a[14]+a[4]*a[2]*a[15]-a[4]*a[3]*a[14]-a[12]*a[2]*a[7]+a[12]*a[3]*a[6];
  inv[10] = a[0]*a[5]*a[15]-a[0]*a[7]*a[13]-a[4]*a[1]*a[15]+a[4]*a[3]*a[13]+a[12]*a[1]*a[7]-a[12]*a[3]*a[5];
  inv[14] = -a[0]*a[5]*a[14]+a[0]*a[6]*a[13]+a[4]*a[1]*a[14]-a[4]*a[2]*a[13]-a[12]*a[1]*a[6]+a[12]*a[2]*a[5];
  inv[3] = -a[1]*a[6]*a[11]+a[1]*a[7]*a[10]+a[5]*a[2]*a[11]-a[5]*a[3]*a[10]-a[9]*a[2]*a[7]+a[9]*a[3]*a[6];
  inv[7] = a[0]*a[6]*a[11]-a[0]*a[7]*a[10]-a[4]*a[2]*a[11]+a[4]*a[3]*a[10]+a[8]*a[2]*a[7]-a[8]*a[3]*a[6];
  inv[11] = -a[0]*a[5]*a[11]+a[0]*a[7]*a[9]+a[4]*a[1]*a[11]-a[4]*a[3]*a[9]-a[8]*a[1]*a[7]+a[8]*a[3]*a[5];
  inv[15] = a[0]*a[5]*a[10]-a[0]*a[6]*a[9]-a[4]*a[1]*a[10]+a[4]*a[2]*a[9]+a[8]*a[1]*a[6]-a[8]*a[2]*a[5];
  let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!det) return false;
  det = 1 / det;
  for (let i = 0; i < 16; i++) out[i] = inv[i] * det;
  return true;
}

// ---------------------------------------------------------------------------
// geometry (positions inside the local AABB, normals), then quantization
// ---------------------------------------------------------------------------
interface Geo {
  positions: number[];
  normals: number[];
  indices: number[];
  min: [number, number, number];
  max: [number, number, number];
}

function cube(): Geo {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) positions.push(0.5 * (n[k] + su * u[k] + sv * v[k]));
      normals.push(n[0], n[1], n[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices, min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
}

function sphere(seg = 24, rings = 16): Geo {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const th = (r / rings) * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const ph = (s / seg) * Math.PI * 2;
      const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
      positions.push(0.5 * x, 0.5 * y, 0.5 * z);
      normals.push(x, y, z);
    }
  }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s, b = a + seg + 1;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  return { positions, normals, indices, min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
}

/** Writes quantized vertices of `g` into `bytes` at vertex `firstVertex`; fragment index if merged. */
function writeVertices(g: Geo, bytes: DataView, firstVertex: number, stride: number, fragment: number): void {
  const enc = new Int8Array(2);
  const n = g.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const o = (firstVertex + i) * stride;
    for (let k = 0; k < 3; k++) {
      const t = (g.positions[i * 3 + k] - g.min[k]) / (g.max[k] - g.min[k]);
      bytes.setUint16(o + VERTEX_POSITION_OFFSET + k * 2, Math.round(t * 65535), true);
    }
    octEncodeSnorm8(g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2], enc);
    bytes.setInt8(o + VERTEX_NORMAL_OFFSET, enc[0]);
    bytes.setInt8(o + VERTEX_NORMAL_OFFSET + 1, enc[1]);
    if (stride === MERGED_VERTEX_STRIDE) bytes.setUint32(o + VERTEX_FRAGMENT_OFFSET, fragment, true);
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
const canvas = document.getElementById('c') as HTMLCanvasElement;
const info = document.getElementById('info') as HTMLDivElement;
let fatal = '';
window.addEventListener('error', (e) => {
  fatal = `ERROR: ${e.message}`;
  info.textContent = fatal;
  console.error(e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  fatal = `ERROR (promise): ${String(e.reason)}`;
  info.textContent = fatal;
  console.error(e.reason);
});
const ctx = GlContext.create(canvas);
const gl = ctx.gl;
ctx.on('lost', () => (info.textContent = 'context lost'));
ctx.on('restored', () => console.log('context restored'));

// --- materials ---
const MATERIAL_COUNT = 6;
const matData = new Float32Array(MAT_RECORDS_PER_ROW * MAT_FLOATS); // one row
function writeMaterial(i: number, srgb: number[], opacity: number, metal: number, rough: number, emissive: number): void {
  const o = i * MAT_FLOATS;
  for (let k = 0; k < 3; k++) matData[o + MAT_COLOR + k] = srgbToLinear(srgb[k]);
  matData[o + MAT_COLOR + 3] = opacity;
  matData[o + MAT_METALNESS] = metal;
  matData[o + MAT_ROUGHNESS] = rough;
  matData[o + MAT_EMISSIVE] = emissive;
}
writeMaterial(0, [0.75, 0.75, 0.75], 1, 0, 0.5, 0); // plastic grey
writeMaterial(1, [0.8, 0.2, 0.15], 1, 0, 0.35, 0); // red
writeMaterial(2, [1.0, 0.78, 0.34], 1, 1, 0.3, 0); // gold
writeMaterial(3, [0.4, 0.6, 0.95], 0.35, 0, 0.1, 0); // glass (transparent)
writeMaterial(4, [0.3, 0.9, 0.4], 1, 0, 0.6, 0.8); // emissive green
writeMaterial(5, [0.55, 0.56, 0.6], 1, 0.6, 0.7, 0); // brushed metal
void MATERIAL_COUNT;

// --- fragments ---
const GRID = 5;
const MERGED_COUNT = GRID * GRID;
const INSTANCE_COUNT = 100;
const FRAG_COUNT = MERGED_COUNT + INSTANCE_COUNT;
// capacity: one texture row (512 records), not a multiple of the record count on purpose
const fragData = new Float32Array(FRAG_RECORDS_PER_ROW * FRAG_FLOATS);

function writeFragment(
  i: number,
  rows: number[], // 12 floats, row-major 3x4
  g: Geo,
  material: number,
  flags: number,
): void {
  const o = i * FRAG_FLOATS;
  fragData.set(rows, o);
  for (let k = 0; k < 3; k++) {
    fragData[o + FRAG_DEQUANT_SCALE + k] = g.max[k] - g.min[k];
    fragData[o + FRAG_DEQUANT_OFFSET + k] = g.min[k];
  }
  fragData[o + FRAG_MATERIAL] = material;
  fragData[o + FRAG_FLAGS] = flags;
  fragData.fill(0, o + FRAG_COLOR, o + FRAG_COLOR + 4);
}
function trs(tx: number, ty: number, tz: number, sx: number, sy: number, sz: number, rotY: number): number[] {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return [c * sx, 0, s * sz, tx, 0, sy, 0, ty, -s * sx, 0, c * sz, tz];
}
function getFlags(i: number): number {
  return fragData[i * FRAG_FLOATS + FRAG_FLAGS];
}
function setFlags(i: number, f: number): void {
  fragData[i * FRAG_FLOATS + FRAG_FLAGS] = f;
  dirtyFragMin = Math.min(dirtyFragMin, i);
  dirtyFragMax = Math.max(dirtyFragMax, i + 1);
}
let dirtyFragMin = Infinity;
let dirtyFragMax = 0;

const cubeGeo = cube();
const sphereGeo = sphere();
const V = FragFlags.Visible;

// merged page: grid of cubes / spheres
const mergedGeos: Geo[] = [];
for (let i = 0; i < MERGED_COUNT; i++) {
  const gx = i % GRID, gz = Math.floor(i / GRID);
  const g = (gx + gz) % 2 === 0 ? cubeGeo : sphereGeo;
  mergedGeos.push(g);
  const rows =
    i === 6
      ? trs((gx - 2) * 1.6, 0.9, (gz - 2) * 1.6, 0.5, 1.8, 0.5, 0.4) // non-uniform scale
      : i === 8
        ? trs((gx - 2) * 1.6, 0.6, (gz - 2) * 1.6, -1.0, 1.0, 1.0, 0) // mirrored
        : trs((gx - 2) * 1.6, 0.6, (gz - 2) * 1.6, 1.1, 1.1, 1.1, i * 0.3);
  let flags = V;
  if (i === 20) flags |= FragFlags.NotPickable;
  writeFragment(i, rows, g, i % 6, flags);
}
// instanced ring of small cubes (fragments 25..124)
for (let k = 0; k < INSTANCE_COUNT; k++) {
  const a = (k / INSTANCE_COUNT) * Math.PI * 2;
  const r = 6.5;
  const h = 0.3 + 0.25 * Math.sin(a * 5);
  writeFragment(MERGED_COUNT + k, trs(Math.cos(a) * r, h / 2, Math.sin(a) * r, 0.3, h, 0.3, -a), cubeGeo, k % 3 === 0 ? 2 : 5, V);
}

// --- merged page buffers ---
let mergedVertexCount = 0;
let mergedIndexCount = 0;
for (const g of mergedGeos) {
  mergedVertexCount += g.positions.length / 3;
  mergedIndexCount += g.indices.length;
}
const mergedVertexBytes = new Uint8Array(mergedVertexCount * MERGED_VERTEX_STRIDE);
const mergedIndices = new Uint32Array(mergedIndexCount);
const itemFirst: number[] = [];
const itemCount: number[] = [];
{
  const dv = new DataView(mergedVertexBytes.buffer);
  let v = 0;
  let ix = 0;
  mergedGeos.forEach((g, frag) => {
    writeVertices(g, dv, v, MERGED_VERTEX_STRIDE, frag);
    itemFirst.push(ix);
    itemCount.push(g.indices.length);
    for (const idx of g.indices) mergedIndices[ix++] = idx + v;
    v += g.positions.length / 3;
  });
}

// --- instanced page buffers ---
const sharedVertexBytes = new Uint8Array((cubeGeo.positions.length / 3) * SHARED_VERTEX_STRIDE);
writeVertices(cubeGeo, new DataView(sharedVertexBytes.buffer), 0, SHARED_VERTEX_STRIDE, 0);
const sharedIndices = Uint32Array.from(cubeGeo.indices);
const instanceIds = new Uint32Array(INSTANCE_COUNT);
for (let k = 0; k < INSTANCE_COUNT; k++) instanceIds[k] = MERGED_COUNT + k;

// --- GPU resources ---
const fragTex = new DataTexture(ctx, FRAG_TEX_WIDTH, 'fragments');
fragTex.setSource(fragData);
const matTex = new DataTexture(ctx, MAT_TEX_WIDTH, 'materials');
matTex.setSource(matData);

const mergedVB = new MirroredBuffer(ctx, 'vertex', { label: 'merged vertices' });
const mergedIB = new MirroredBuffer(ctx, 'index', { label: 'merged indices' });
mergedVB.setSource(mergedVertexBytes);
mergedIB.setSource(mergedIndices);
const mergedVao = GeometryVao.merged(ctx, mergedVB, mergedIB);

const sharedVB = new MirroredBuffer(ctx, 'vertex');
const sharedIB = new MirroredBuffer(ctx, 'index');
const instBuf = new MirroredBuffer(ctx, 'instance');
sharedVB.setSource(sharedVertexBytes);
sharedIB.setSource(sharedIndices);
instBuf.setSource(instanceIds);
const instVao = GeometryVao.instanced(ctx, sharedVB, sharedIB, instBuf);

const uber = new UberProgram(ctx);
const uberSection = new UberProgram(ctx, { sectionPlanes: true });
const targets = new RenderTargets(ctx);
const post = new PostPasses(ctx);
const reader = new PixelReader(ctx);
const timer = new GpuTimer(ctx);
const submitter = new DrawSubmitter(ctx);

// instance chunks: two halves, exercising setInstanceStart
const chunkFirst = [0, 0];
const chunkCount = [sharedIndices.length, sharedIndices.length];
const chunkInstStart = [0, INSTANCE_COUNT / 2];
const chunkInstCount = [INSTANCE_COUNT / 2, INSTANCE_COUNT / 2];

// ---------------------------------------------------------------------------
// camera + interaction
// ---------------------------------------------------------------------------
let yaw = 0.7;
let pitch = 0.5;
let dist = 16;
const target = [0, 0.5, 0];
const view = new Float32Array(16);
const proj = new Float32Array(16);
const viewProj = new Float32Array(16);
const invViewProj = new Float32Array(16);
const near = 0.1;
const far = 200;
let sectionOn = false;
let outlineOn = true;
let hoverId = -1;
let hoverPending = false;
let mouseX = -1;
let mouseY = -1;
let pickText = 'move the mouse over the scene';
let dragging = false;
let dragMoved = false;
const sectionWorld = new Float32Array(4);
const sectionView = new Float32Array(4);
planeFromNormalPoint(1, 0, 0.3, 0.5, 0, 0, sectionWorld);

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragMoved = false;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', async (e) => {
  dragging = false;
  if (dragMoved) return;
  const s = await pickAt(e.offsetX, e.offsetY);
  if (s && s.id >= 0) setFlags(s.id, getFlags(s.id) ^ FragFlags.Selected);
});
canvas.addEventListener('pointermove', (e) => {
  mouseX = e.offsetX;
  mouseY = e.offsetY;
  if (dragging && (e.movementX || e.movementY)) {
    dragMoved = true;
    yaw += e.movementX * 0.008;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + e.movementY * 0.008));
  }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  dist = Math.max(2, Math.min(80, dist * Math.exp(e.deltaY * 0.001)));
}, { passive: false });
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 's') sectionOn = !sectionOn;
  if (k === 'o') outlineOn = !outlineOn;
  if (k === 'm') submitter.useMultiDraw = !submitter.useMultiDraw;
  if (k === 'l') {
    // simulate context loss + restore after 500 ms (tests GlResource.restore paths)
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) {
      ext.loseContext();
      setTimeout(() => ext.restoreContext(), 500);
    }
  }
  if (k === 'h') setFlags(12, getFlags(12) ^ FragFlags.Visible);
  if (k === 'g') for (let i = 15; i < 20; i++) setFlags(i, getFlags(i) ^ FragFlags.Ghosted);
  if (k === 'c') {
    const o = 3 * FRAG_FLOATS + FRAG_COLOR;
    const on = fragData[o + 3] === 0;
    fragData.set(on ? [1.0, 0.35, 0.0, 0.8] : [0, 0, 0, 0], o);
    setFlags(3, getFlags(3));
  }
});
// start with row 3 ghosted so the ghost pass is visible
for (let i = 15; i < 20; i++) setFlags(i, getFlags(i) | FragFlags.Ghosted);

async function pickAt(cssX: number, cssY: number) {
  const dpr = canvas.width / canvas.clientWidth;
  const x = Math.floor(cssX * dpr);
  const y = targets.height - 1 - Math.floor(cssY * dpr);
  const s = await reader.readPixel(targets, x, y);
  if (!s) return null;
  if (s.id < 0) {
    pickText = `pick (${x},${y}): background  depth=${s.depth.toFixed(6)}`;
  } else {
    const w = [0, 0, 0];
    unprojectDepth(x + 0.5, y + 0.5, targets.width, targets.height, s.depth, invViewProj, w);
    const lin = linearizeDepth(s.depth, near, far, false);
    pickText =
      `pick (${x},${y}): fragment ${s.id}  depth=${s.depth.toFixed(6)}  viewZ=${lin.toFixed(3)}\n` +
      `world = (${w.map((v) => v.toFixed(3)).join(', ')})`;
  }
  return s;
}

function hover(): void {
  if (hoverPending || mouseX < 0 || dragging) return;
  hoverPending = true;
  pickAt(mouseX, mouseY).then((s) => {
    hoverPending = false;
    const id = s ? s.id : -1;
    if (id === hoverId) return;
    if (hoverId >= 0) setFlags(hoverId, getFlags(hoverId) & ~FragFlags.Highlighted);
    hoverId = id;
    if (id >= 0) setFlags(id, getFlags(id) | FragFlags.Highlighted);
  });
}

// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------
const BG_TOP = [0.32, 0.36, 0.42];
const BG_BOTTOM = [0.1, 0.1, 0.12];
const OUTLINE = [1.0, 0.62, 0.1, 1.0];
let frames = 0;
let lastFpsT = performance.now();
let fps = 0;

function drawScene(prog: UberProgram, pass: UberPass): void {
  applyPassState(ctx, targets, pass);
  prog.setPass(pass); // material filter on: this demo does not pre-split items by transparency
  // merged page: all items except fragment 10's range, so multi-draw sees several ranges
  mergedVao.bind();
  for (let i = 0; i < itemFirst.length; i++) if (i !== 10) submitter.push(itemFirst[i], itemCount[i]);
  submitter.flush();
  submitter.drawInstancedRanges(instVao, chunkFirst, chunkCount, chunkInstStart, chunkInstCount, 0, 2);
}

// ?pick=fx,fy (fractions of the canvas): select the fragment there after a few frames (headless checks)
const autoPick = new URLSearchParams(location.search).get('pick');
// ?keys=sc : simulate key presses at startup (headless checks)
const autoKeys = new URLSearchParams(location.search).get('keys');
let frameNo = 0;

function frame(): void {
  // headless screenshots barely tick rAF; drive frames with timers when auto-picking
  if (autoPick) setTimeout(frame, 30);
  else requestAnimationFrame(frame);
  if (ctx.isLost || fatal) return;
  if (frameNo === 2 && autoKeys) {
    for (const key of autoKeys) window.dispatchEvent(new KeyboardEvent('keydown', { key }));
  }
  if (++frameNo === 5 && autoPick) {
    const [fx, fy] = autoPick.split(',').map(Number);
    pickAt(fx * canvas.clientWidth, fy * canvas.clientHeight).then((s) => {
      if (s && s.id >= 0) setFlags(s.id, getFlags(s.id) | FragFlags.Selected);
      console.log(`autopick: ${pickText.split('\n').join(' | ')}`);
    });
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  targets.resize(gl.drawingBufferWidth, gl.drawingBufferHeight);

  // upload changed fragment records (flags / colour)
  if (dirtyFragMax > dirtyFragMin) {
    fragTex.uploadRecords(dirtyFragMin, dirtyFragMax, FRAG_FLOATS);
    dirtyFragMin = Infinity;
    dirtyFragMax = 0;
  }

  const eye = [
    target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
    target[1] + dist * Math.sin(pitch),
    target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
  ];
  lookAt(view, eye, target, [0, 1, 0]);
  perspective(proj, Math.PI / 4, targets.width / targets.height, near, far);
  multiply(viewProj, proj, view);
  invert(invViewProj, viewProj);

  timer.begin();
  submitter.resetStats();

  // 1. new image: clear id + depth, background gradient into colour
  targets.clearIdAndDepth();
  ctx.state.setDepthTest(false);
  ctx.state.setDepthMask(false);
  ctx.state.setBlend(false);
  targets.setDrawBuffers('color');
  post.drawBackground(BG_TOP, BG_BOTTOM);

  // 2. scene passes
  const prog = sectionOn ? uberSection : uber;
  fragTex.bind(UBER_FRAG_TEX_UNIT);
  matTex.bind(UBER_MAT_TEX_UNIT);
  prog.setCamera(view, proj, false);
  prog.setUpView(view[4], view[5], view[6]); // mat3(view) * (0,1,0) = second column
  if (sectionOn) {
    planesToViewSpace(sectionWorld, 1, view, sectionView);
    prog.setSectionPlanes(sectionView, 1);
  }
  drawScene(prog, 'opaque');
  drawScene(prog, 'transparent');
  drawScene(prog, 'ghost');
  drawScene(prog, 'transparentId'); // ids + depth of glass, so transparent objects are pickable

  // 3. present + outline to the canvas
  const s = ctx.state;
  s.bindFramebuffer(null);
  s.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  s.setDepthTest(false);
  s.setBlend(false);
  post.drawPresent(targets.colorTex!);
  if (outlineOn) {
    s.setBlend(true);
    s.setBlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    post.drawOutline(targets.idTex!, fragTex.texture, OUTLINE, 2);
    s.setBlend(false);
  }
  timer.end();

  // 4. async work
  hover();
  reader.poll();
  timer.poll();

  frames++;
  const now = performance.now();
  if (now - lastFpsT > 500) {
    fps = (frames * 1000) / (now - lastFpsT);
    frames = 0;
    lastFpsT = now;
  }
  const caps = ctx.caps;
  info.textContent =
    `${targets.width}x${targets.height}  ${fps.toFixed(0)} fps  gpu ${Number.isNaN(timer.averageMs) ? 'n/a' : timer.averageMs.toFixed(2) + ' ms'}\n` +
    `draw calls ${submitter.drawCalls}  triangles ${submitter.trianglesDrawn}  fragments ${FRAG_COUNT}\n` +
    `multiDraw ${caps.multiDraw ? (submitter.useMultiDraw ? 'on' : 'off (M)') : 'unavailable'}  ` +
    `timer ${caps.timerQuery ? 'yes' : 'no'}  float RT ${caps.colorBufferFloat ? 'yes' : 'no'}  ` +
    `drawBuffersIndexed ${caps.drawBuffersIndexed ? 'yes' : 'no'}  provoking ${caps.provokingVertex ? 'yes' : 'no'}  ` +
    `maxTex ${caps.maxTextureSize}\n` +
    `depth ${targets.depthFormat === gl.DEPTH_COMPONENT32F ? '32F' : '24'}  gpu mem ${(ctx.gpuMemoryBytes / 1048576).toFixed(1)} MB\n` +
    `section ${sectionOn ? 'on' : 'off'} (S)  outline ${outlineOn ? 'on' : 'off'} (O)  H hide #12  G ghost row  C colour #3\n` +
    pickText;
}

requestAnimationFrame(frame);

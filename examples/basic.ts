/**
 * Minimal verification page for the Viewer (the real examples come later).
 *
 *   npx vite  ->  http://localhost:5173/examples/basic.html
 *
 * URL parameters
 *   scene=basic|big     basic: primitives, merged + instanced paths, transparency (default)
 *                       big: n1 instanced boxes + n2 unique meshes (defaults 1,000,000 / 100,000)
 *   offset=<number>     translate the whole scene by (offset, offset/2, -offset), e.g. 1e7
 *   up=y|z              world up axis
 *   n1=, n2=            sizes of the big scene
 *   glass=0             basic scene without the transparent box
 *
 * Everything is reachable from the console / a test driver through `window.mk`.
 */
import { Viewer } from '../src/index';
import type { ViewerStats } from '../src/index';

const params = new URLSearchParams(location.search);
const sceneName = params.get('scene') ?? 'basic';
const OFF = Number(params.get('offset') ?? 0);
const up = (params.get('up') === 'z' ? 'z' : 'y') as 'y' | 'z';
const canvas = document.getElementById('c') as HTMLCanvasElement;
const info = document.getElementById('info') as HTMLDivElement;

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

const viewer = new Viewer(canvas, { up });

/** Column-major T * Ry * S, with the scene offset added. */
function T(x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rotY = 0): number[] {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  // up = 'z': swap the meaning of y/z for placement
  const [px, py, pz] = up === 'z' ? [x, -z, y] : [x, y, z];
  const m = [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, px + OFF, py + OFF / 2, pz - OFF, 1];
  if (up === 'z') {
    // rotation about z instead of y; sy (height) goes along z, sz (depth) along y
    return [c * sx, s * sx, 0, 0, -s * sz, c * sz, 0, 0, 0, 0, sy, 0, px + OFF, py + OFF / 2, pz - OFF, 1];
  }
  return m;
}

const log: string[] = [];
let loadMs = 0;

function buildBasic(): void {
  const grey = viewer.createMaterial({ color: [0.75, 0.75, 0.75] });
  const red = viewer.createMaterial({ color: [0.85, 0.2, 0.15], roughness: 0.35 });
  const gold = viewer.createMaterial({ color: [1.0, 0.78, 0.34], metalness: 1, roughness: 0.3 });
  const glass = viewer.createMaterial({ color: [0.4, 0.6, 0.95, 0.35], roughness: 0.1 });
  const green = viewer.createMaterial({ color: [0.3, 0.8, 0.4] });
  const blue = viewer.createMaterial({ color: [0.25, 0.4, 0.85] });

  const P = viewer.primitives;
  const ground = P.plane(20, 20);
  viewer.addMesh({ geometry: ground, material: grey, transform: T(0, 0, 0), objectId: 1 });

  const bx = P.box([1, 1, 1]);
  const sp = P.sphere(0.5, 32);
  for (let i = 0; i < 5; i++) {
    viewer.addMesh({ geometry: bx, material: red, transform: T(-4 + i * 2, 0.5, -3, 1, 1 + i * 0.3, 1, i * 0.3), objectId: 100 + i });
    viewer.addMesh({ geometry: sp, material: i % 2 ? gold : blue, transform: T(-4 + i * 2, 0.5, 0), objectId: 200 + i });
  }
  // extrusions: an L shape and a star
  const L = P.extrusion([0, 0, 2, 0, 2, 0.6, 0.6, 0.6, 0.6, 2, 0, 2], 1.2);
  const star: number[] = [];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    const r = k % 2 ? 0.45 : 1;
    star.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  const S = P.extrusion(star, 0.8);
  viewer.addMesh({ geometry: L, material: green, transform: T(-5, 0, 3), objectId: 300 });
  viewer.addMesh({ geometry: S, material: gold, transform: T(0, 0, 3.5), objectId: 301 });
  viewer.addMesh({ geometry: P.torus(0.8, 0.25), material: blue, transform: T(4, 0.8, 3.5, 1, 1, 1), objectId: 302 });
  viewer.addMesh({ geometry: P.cylinder(0.5, 2), material: grey, transform: T(6.5, 0, -3), objectId: 303 });
  viewer.addMesh({ geometry: P.cone(0.6, 1.5), material: red, transform: T(6.5, 0, 0), objectId: 304 });

  // instanced: 64 small boxes on a ring (same geometry used >= 16 times -> instanced path)
  const small = P.box([0.3, 0.3, 0.3]);
  const n = 64;
  const tr = new Float64Array(n * 16);
  const ids = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const h = 0.3 + 0.25 * Math.sin(a * 5);
    tr.set(T(Math.cos(a) * 8.5, h / 2, Math.sin(a) * 8.5, 1, h / 0.3, 1, -a), k * 16);
    ids[k] = 1000 + k;
  }
  viewer.addMeshes({ geometry: small, material: gold, transforms: tr, objectIds: ids });

  // transparent box over sphere 202 (glass=0 leaves it out, to exercise the opaque append path)
  if (params.get('glass') !== '0') {
    viewer.addMesh({ geometry: bx, material: glass, transform: T(0, 1, 0, 2.2, 2, 2.2), objectId: 500 });
  }
}

function buildBig(): void {
  const n1 = Number(params.get('n1') ?? 1_000_000);
  const n2 = Number(params.get('n2') ?? 100_000);
  const t0 = performance.now();
  const mats = [
    viewer.createMaterial({ color: [0.75, 0.75, 0.75] }),
    viewer.createMaterial({ color: [0.85, 0.3, 0.2] }),
    viewer.createMaterial({ color: [0.3, 0.5, 0.85] }),
    viewer.createMaterial({ color: [0.4, 0.75, 0.4] }),
  ];
  let seed = 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // n1 instanced small boxes on a grid
  const side = Math.ceil(Math.sqrt(n1));
  const spacing = 2;
  const box = viewer.primitives.box([1, 1, 1]);
  const tr = new Float32Array(n1 * 16);
  const matIds = new Uint8Array(n1);
  for (let i = 0; i < n1; i++) {
    const gx = i % side, gz = (i / side) | 0;
    const h = 0.3 + rnd() * 1.5;
    tr.set(T((gx - side / 2) * spacing, h / 2, (gz - side / 2) * spacing, 0.8, h, 0.8), i * 16);
    matIds[i] = mats[i & 3];
  }
  const t1 = performance.now();
  viewer.addMeshes({ geometry: box, material: matIds, transforms: tr });
  const t2 = performance.now();
  // n2 unique meshes (distinct geometry each, merged path)
  const extent = side * spacing;
  for (let i = 0; i < n2; i++) {
    const g = viewer.createGeometry(boxGeometry(1 + rnd() * 4, 2 + rnd() * 20, 1 + rnd() * 4));
    viewer.addMesh({
      geometry: g,
      material: mats[i & 3],
      transform: T((rnd() - 0.5) * extent, 0, (rnd() - 0.5) * extent, 1, 1, 1, rnd() * Math.PI),
    });
  }
  const t3 = performance.now();
  log.push(
    `big: prep ${(t1 - t0).toFixed(0)} ms, addMeshes(${n1}) ${(t2 - t1).toFixed(0)} ms, ` +
      `${n2} unique createGeometry+addMesh ${(t3 - t2).toFixed(0)} ms`,
  );
}

/** Box standing on y = 0 (unique sizes -> unique geometry). */
function boxGeometry(sx: number, sy: number, sz: number) {
  const x = sx / 2, z = sz / 2;
  const p = [
    -x, 0, -z, x, 0, -z, x, sy, -z, -x, sy, -z,
    -x, 0, z, x, 0, z, x, sy, z, -x, sy, z,
  ];
  // non-indexed triangles -> flat normals computed by the viewer
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [3, 7, 6, 2], [0, 1, 5, 4],
  ];
  const pos: number[] = [];
  for (const [a, b, c, d] of quads) {
    for (const k of [a, b, c, a, c, d]) pos.push(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]);
  }
  if (up === 'z') {
    for (let i = 0; i < pos.length; i += 3) {
      const y = pos[i + 1];
      pos[i + 1] = -pos[i + 2];
      pos[i + 2] = y;
    }
  }
  return { positions: pos };
}

const tStart = performance.now();
if (sceneName === 'big') buildBig();
else buildBasic();
viewer.fitToView();
if (sceneName === 'basic') {
  // a pleasant default view
  const c = viewer.getCamera();
  viewer.setCamera({ eye: [c.target[0] + 9, c.target[1] + 8, c.target[2] + 13] });
}

let completes = 0;
let firstCompleteMs = 0;
let lastComplete: ViewerStats | null = null;
viewer.on('frameComplete', (s) => {
  completes++;
  lastComplete = { ...s };
  if (!firstCompleteMs) {
    firstCompleteMs = performance.now() - tStart;
    loadMs = firstCompleteMs;
  }
});
const events: string[] = [];
viewer.on('pick', (p) => events.push(`pick ${p ? p.objectId : 'null'}`));
viewer.on('selection', (s) => events.push(`selection [${s.join(',')}]`));

// --- camera orbit animation (for budget tests) ------------------------------------------------
let orbitRaf = 0;
const frameLog: { dt: number; units: number; drawCalls: number; tris: number; items: number; mode: string; cpu: number }[] = [];
function startOrbit(radPerSec = 0.5): void {
  stopOrbit();
  let last = performance.now();
  const step = (t: number) => {
    const dt = t - last;
    last = t;
    const c = viewer.getCamera();
    const dx = c.eye[0] - c.target[0], dz = c.eye[2] - c.target[2];
    const a = (radPerSec * dt) / 1000;
    const ca = Math.cos(a), sa = Math.sin(a);
    viewer.setCamera({ eye: [c.target[0] + dx * ca - dz * sa, c.eye[1], c.target[2] + dx * sa + dz * ca] });
    const s = viewer.stats;
    frameLog.push({
      dt,
      units: Math.round(viewer.renderer.budget.units),
      drawCalls: s.drawCalls,
      tris: s.trianglesDrawn,
      items: s.drawItems,
      mode: viewer.renderer.lastMode,
      cpu: +s.frameMs.toFixed(2),
    });
    orbitRaf = requestAnimationFrame(step);
  };
  orbitRaf = requestAnimationFrame(step);
}
function stopOrbit(): void {
  if (orbitRaf) cancelAnimationFrame(orbitRaf);
  orbitRaf = 0;
}

function waitIdle(timeoutMs = 600000): Promise<boolean> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const check = () => {
      const r = viewer.renderer;
      if (r.idle && r.pendingPicks === 0) resolve(true);
      else if (performance.now() - t0 > timeoutMs) resolve(false);
      else setTimeout(check, 30);
    };
    check();
  });
}

const mk = {
  viewer,
  errors,
  events,
  log,
  frameLog,
  startOrbit,
  stopOrbit,
  waitIdle,
  get completes() {
    return completes;
  },
  get loadMs() {
    return loadMs;
  },
  get lastComplete() {
    return lastComplete;
  },
};
(window as unknown as { mk: typeof mk }).mk = mk;

setInterval(() => {
  const s = viewer.stats;
  const r = viewer.renderer;
  info.textContent =
    `${sceneName}${OFF ? ` offset ${OFF}` : ''}  ${canvas.width}x${canvas.height}\n` +
    `meshes ${s.meshes}  triangles ${s.triangles}\n` +
    `fps ${s.fps.toFixed(1)}  cpu ${s.frameMs.toFixed(1)} ms  progress ${(s.progress * 100).toFixed(0)}%\n` +
    `items ${s.drawItems}  calls ${s.drawCalls}  tris drawn ${s.trianglesDrawn}\n` +
    `budget ${(r.budget.units / 1e6).toFixed(2)}M units  refresh ${r.budget.refreshMs.toFixed(1)} ms  ${r.lastMode}\n` +
    `gpu mem ${(s.gpuMemoryBytes / 1048576).toFixed(0)} MB  completes ${completes}` +
    (errors.length ? `\nERRORS: ${errors.join(' | ')}` : '');
}, 250);

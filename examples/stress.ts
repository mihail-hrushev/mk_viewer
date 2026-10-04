/**
 * Stress test and benchmark.
 *
 * URL parameters (the form at the top writes them):
 *   n=1000000   instanced meshes (one box geometry placed n times, one bulk addMeshes call)
 *   m=100000    unique meshes (each its own geometry, merged into shared batches)
 *   glass=0.1   fraction of the unique meshes with a transparent material (default 0)
 *   secs=8      length of the scripted camera path of the benchmark
 *   dpr=1       pixel ratio cap (default: min(devicePixelRatio, 2))
 *   bench=1     run the benchmark as soon as the first image is complete
 *
 * The benchmark result is shown on screen and stored as `window.benchmark` (JSON-compatible).
 */
import { Viewer } from '../src/index';
import { $, captureErrors, expose, gpuName, jsHeapMB, showStats } from './shared';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
const N = num('n', 1_000_000);
const M = num('m', 100_000);
const GLASS = num('glass', 0);
const SECS = num('secs', 8);
const DPR = params.has('dpr') ? num('dpr', 1) : undefined;

const canvas = $<HTMLCanvasElement>('c');
const errors = captureErrors($('errors'));
const viewer = new Viewer(canvas, { pixelRatio: DPR });

// --- form -------------------------------------------------------------------------------------------
$<HTMLInputElement>('n').value = String(N);
$<HTMLInputElement>('m').value = String(M);
$<HTMLInputElement>('glass').value = String(GLASS);
$('build').onclick = () => {
  const q = new URLSearchParams(location.search);
  for (const k of ['n', 'm', 'glass']) q.set(k, $<HTMLInputElement>(k).value);
  q.delete('bench');
  location.search = q.toString();
};

// --- scene -------------------------------------------------------------------------------------------
let seed = 1;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

/** Box standing on y = 0 as 12 non-indexed triangles (flat normals are computed by the viewer). */
function boxGeometry(sx: number, sy: number, sz: number) {
  const x = sx / 2, z = sz / 2;
  const p = [-x, 0, -z, x, 0, -z, x, sy, -z, -x, sy, -z, -x, 0, z, x, 0, z, x, sy, z, -x, sy, z];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [3, 7, 6, 2], [0, 1, 5, 4]];
  const positions = new Float32Array(36 * 3);
  let o = 0;
  for (const [a, b, c, d] of quads) {
    for (const k of [a, b, c, a, c, d]) {
      positions[o++] = p[k * 3];
      positions[o++] = p[k * 3 + 1];
      positions[o++] = p[k * 3 + 2];
    }
  }
  return { positions };
}

const tStart = performance.now();
const colours: [number, number, number][] = [[0.75, 0.75, 0.75], [0.85, 0.3, 0.2], [0.3, 0.5, 0.85], [0.4, 0.75, 0.4]];
const mats = colours.map((color) => viewer.createMaterial({ color }));
const glassMat = viewer.createMaterial({ color: [0.5, 0.7, 1, 0.35] });

// N instances of one geometry: one transform array, one call
const side = Math.ceil(Math.sqrt(Math.max(N, 1)));
const spacing = 2;
const transforms = new Float32Array(N * 16);
const materials = new Uint16Array(N);
for (let i = 0; i < N; i++) {
  const gx = i % side, gz = (i / side) | 0, h = 0.3 + rnd() * 1.5, o = i * 16;
  transforms[o] = 0.8;
  transforms[o + 5] = h;
  transforms[o + 10] = 0.8;
  transforms[o + 12] = (gx - side / 2) * spacing;
  transforms[o + 13] = h / 2;
  transforms[o + 14] = (gz - side / 2) * spacing;
  transforms[o + 15] = 1;
  materials[i] = mats[i & 3];
}
if (N > 0) viewer.addMeshes({ geometry: viewer.primitives.box([1, 1, 1]), material: materials, transforms });

// M unique meshes
const extent = side * spacing;
const m4 = new Float64Array(16);
for (let i = 0; i < M; i++) {
  const geometry = viewer.createGeometry(boxGeometry(1 + rnd() * 4, 2 + rnd() * 20, 1 + rnd() * 4));
  const a = rnd() * Math.PI, c = Math.cos(a), s = Math.sin(a);
  m4.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, (rnd() - 0.5) * extent, 0, (rnd() - 0.5) * extent, 1]);
  const material = rnd() < GLASS ? glassMat : mats[i & 3];
  viewer.addMesh({ geometry, material, transform: m4 });
}
const buildMs = performance.now() - tStart;
viewer.fitToView();

// --- load timings: first pixels and first complete image ----------------------------------------
let firstPixelsMs = NaN;
let firstCompleteMs = NaN;
const firstPixels = () => {
  if (viewer.stats.trianglesDrawn > 0) firstPixelsMs = performance.now() - tStart;
  else requestAnimationFrame(firstPixels);
};
requestAnimationFrame(firstPixels);
const firstComplete = new Promise<void>((resolve) => {
  const off = viewer.on('frameComplete', () => {
    firstCompleteMs = performance.now() - tStart;
    off();
    resolve();
  });
});

// --- benchmark ---------------------------------------------------------------------------------------
function percentiles(values: number[]) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { min: +v[0].toFixed(2), median: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +v[v.length - 1].toFixed(2) };
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

async function benchmark() {
  $('result').textContent = 'benchmark running…';
  ($('result').parentElement as HTMLDetailsElement).open = true;
  await firstComplete;
  const b = viewer.getBounds()!;
  const c = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
  const R = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
  const interval: number[] = [], cpu: number[] = [], gpu: number[] = [];
  const items: number[] = [], calls: number[] = [], tris: number[] = [];
  let prev = await nextFrame();
  const t0 = prev;
  for (;;) {
    const now = await nextFrame();
    const u = (now - t0) / (SECS * 1000);
    if (u > 1) break;
    // one orbit around the scene, zooming in to 30 % of the distance half-way
    const ang = u * Math.PI * 2, d = R * (1.2 - 0.85 * Math.sin(u * Math.PI));
    viewer.setCamera({ target: c as [number, number, number], eye: [c[0] + Math.cos(ang) * d, c[1] + d * 0.45, c[2] + Math.sin(ang) * d] });
    if (now - t0 > 500) {
      // skip the first half second (warm-up of the frame budget)
      const s = viewer.stats;
      interval.push(now - prev);
      cpu.push(s.frameMs);
      gpu.push(s.gpuMs);
      items.push(s.drawItems);
      calls.push(s.drawCalls);
      tris.push(s.trianglesDrawn);
    }
    prev = now;
  }
  // camera stopped: time until the still image is complete
  const tStill = performance.now();
  await new Promise<void>((resolve) => {
    const off = viewer.on('frameComplete', () => {
      off();
      resolve();
    });
  });
  const stillCompleteMs = performance.now() - tStill;
  const s = viewer.stats;
  const result = {
    renderer: gpuName(),
    userAgent: navigator.userAgent,
    canvas: `${canvas.width}x${canvas.height}`,
    devicePixelRatio,
    scene: { instanced: N, unique: M, glassFraction: GLASS, meshes: s.meshes, triangles: s.triangles },
    buildMs: Math.round(buildMs),
    firstPixelsMs: Math.round(firstPixelsMs),
    firstCompleteMs: Math.round(firstCompleteMs),
    moving: {
      seconds: SECS,
      frames: interval.length,
      frameIntervalMs: percentiles(interval),
      cpuMs: percentiles(cpu),
      gpuMs: percentiles(gpu),
      drawItems: percentiles(items),
      drawCalls: percentiles(calls),
      trianglesDrawn: percentiles(tris),
    },
    stillCompleteMs: Math.round(stillCompleteMs),
    still: { drawItems: s.drawItems, drawCalls: s.drawCalls, trianglesDrawn: s.trianglesDrawn },
    gpuMemoryMB: Math.round(s.gpuMemoryBytes / 1048576),
    jsHeapMB: Math.round(jsHeapMB()),
    errors: errors.slice(),
  };
  (window as unknown as { benchmark: unknown }).benchmark = result;
  $('result').textContent = JSON.stringify(result, null, 1);
  return result;
}

$('bench').onclick = () => void benchmark();
if (params.get('bench') === '1') void benchmark();

showStats(viewer, $('stats'), () =>
  `build ${buildMs.toFixed(0)} ms  first pixels ${firstPixelsMs.toFixed(0)} ms  complete ${firstCompleteMs.toFixed(0)} ms\n` +
  `canvas ${canvas.width}x${canvas.height}  js heap ${jsHeapMB().toFixed(0)} MB`);
expose({ viewer, errors, benchmark });

/**
 * Geometry on the fly: every animation frame this page
 *   - creates new geometry (a random extruded block) and adds it to a growing spiral tower,
 *   - removes the oldest blocks and releases their geometry once the tower is full (so the tower is
 *     continuously rebuilt from the bottom with new shapes and drifting colours),
 *   - moves 160 instanced links of a rotating machine with one bulk `setTransforms` call,
 *   - moves 16 pistons with individual `setTransform` calls,
 *   - recolours a band of tower blocks with `setColor` (a scan line running up the tower).
 * The panel shows how many API calls were made per frame and how long they took.
 */
import { Viewer } from '../src/index';
import { $, captureErrors, expose, showStats } from './shared';

const viewer = new Viewer($<HTMLCanvasElement>('c'));
const errors = captureErrors($('errors'));

const steel = viewer.createMaterial({ color: [0.62, 0.66, 0.7], metalness: 0.8, roughness: 0.35 });
const yellow = viewer.createMaterial({ color: [0.95, 0.75, 0.15], roughness: 0.4 });
const blockMat = viewer.createMaterial({ color: [0.8, 0.8, 0.8] });
viewer.addMesh({ geometry: viewer.primitives.plane(40, 40), material: viewer.createMaterial({ color: [0.45, 0.48, 0.5] }) });

/** Column-major matrix: scale, then rotation about +Y by `a`, then translation. */
function trs(out: Float64Array, o: number, x: number, y: number, z: number, a: number, sx: number, sy: number, sz: number): void {
  const c = Math.cos(a), s = Math.sin(a);
  out.set([c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1], o);
}

// --- machine: 4 arms x 40 links, one geometry placed 160 times (drawn instanced) ---------------
const ARMS = 4, LINKS = 30;
const MX = 8; // machine centre x (the tower stands at x = -7)
const links = new Float64Array(ARMS * LINKS * 16);
function computeLinks(t: number): void {
  for (let a = 0; a < ARMS; a++) {
    for (let i = 0; i < LINKS; i++) {
      const ang = t * 0.6 + (a * Math.PI) / 2 + Math.sin(t * 1.3 + i * 0.15) * 0.25;
      const r = 1 + i * 0.2;
      const y = 0.4 + 0.35 * Math.sin(t * 2 + i * 0.25 + a);
      trs(links, (a * LINKS + i) * 16, MX + Math.cos(ang) * r, y, Math.sin(ang) * r, -ang, 0.3, 0.3, 0.3);
    }
  }
}
computeLinks(0);
const firstLink = viewer.addMeshes({ geometry: viewer.primitives.box([1, 1, 1]), material: steel, transforms: links });
function moveMachine(t: number): void {
  computeLinks(t);
  viewer.setTransforms(firstLink, links); // one call moves all 160 meshes (MeshIds firstLink..)
}

// --- pistons: 16 meshes moved one by one ---------------------------------------------------------
const cylinder = viewer.primitives.cylinder(0.25, 1, 24); // base at 0, height 1 along +Y
const pistons: number[] = [];
const m = new Float64Array(16);
for (let k = 0; k < 16; k++) pistons.push(viewer.addMesh({ geometry: cylinder, material: yellow }));
function movePistons(t: number): void {
  for (let k = 0; k < pistons.length; k++) {
    const a = (k / pistons.length) * Math.PI * 2;
    trs(m, 0, MX + Math.cos(a) * 8, 0, Math.sin(a) * 8, 0, 1, 1 + 1.5 * (0.5 + 0.5 * Math.sin(t * 3 + k * 0.8)), 1);
    viewer.setTransform(pistons[k], m);
  }
}

// --- growing tower: new geometry every frame, oldest removed ------------------------------------
interface Block { mesh: number; geometry: number; objectId: number; hue: [number, number, number] }
const tower: Block[] = [];
let built = 0;
const MAX_BLOCKS = 1200;

function hsl(h: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return 0.55 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function addBlock(): void {
  // a random convex polygon -> unique geometry for each block
  const n = 3 + (built % 5), outline: number[] = [];
  const size = 0.35 + Math.random() * 0.3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    outline.push(Math.cos(a) * size, Math.sin(a) * size);
  }
  const geometry = viewer.primitives.extrusion(outline, 0.25);
  const k = built++;
  const slot = k % MAX_BLOCKS; // the block replaces the oldest one, removed in the same frame
  const ang = slot * 0.31;
  const r = 3.5 + Math.sin(slot * 0.02) * 1;
  trs(m, 0, -7 + Math.cos(ang) * r, slot * 0.012, Math.sin(ang) * r, -ang, 1, 1, 1);
  const objectId = 1_000_000 + k;
  const mesh = viewer.addMesh({ geometry, material: blockMat, transform: m, objectId });
  const hue = hsl((k % 3000) / 3000); // colours drift as the tower is rebuilt
  viewer.setColor(objectId, hue);
  tower.push({ mesh, geometry, objectId, hue });
}

function removeOldest(): void {
  const b = tower.shift()!;
  viewer.remove(b.mesh);
  viewer.releaseGeometry(b.geometry); // freed now that no mesh uses it
}

// scan band: 24 consecutive blocks highlighted, moving up the tower
let band = 0;
function scan(): number {
  const W = 24;
  let calls = 0;
  for (let i = 0; i < W && band + i < tower.length; i++) {
    viewer.setColor(tower[band + i].objectId, tower[band + i].hue); // restore the previous band
    calls++;
  }
  band = (band + 2) % Math.max(1, tower.length - W);
  for (let i = 0; i < W && band + i < tower.length; i++) {
    viewer.setColor(tower[band + i].objectId, [1, 1, 1, 0.7]); // 70 % white over the block colour
    calls++;
  }
  return calls;
}

// --- the frame loop ------------------------------------------------------------------------------
let running = true;
let perFrame = 3;
let t = 0;
let last = performance.now();
let apiMs = 0;
let counts = '';

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (running) {
    t += dt;
    const t0 = performance.now();
    let removed = 0;
    for (let i = 0; i < perFrame; i++) addBlock();
    while (tower.length > MAX_BLOCKS) {
      removeOldest();
      removed++;
    }
    moveMachine(t);
    movePistons(t);
    const colours = scan() + perFrame;
    apiMs = apiMs * 0.9 + (performance.now() - t0) * 0.1;
    counts =
      `per frame: ${perFrame} createGeometry+addMesh, ${removed} remove+releaseGeometry,\n` +
      `  1 setTransforms (${ARMS * LINKS} meshes), ${pistons.length} setTransform, ${colours} setColor\n` +
      `  time in API calls ${apiMs.toFixed(2)} ms  (tower ${tower.length} blocks, ${built} built)`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

viewer.setCamera({ eye: [8, 20, 32], target: [0, 4, 0] });

// --- UI --------------------------------------------------------------------------------------------
const playBtn = $<HTMLButtonElement>('play');
playBtn.onclick = () => {
  running = !running;
  playBtn.textContent = running ? 'Pause' : 'Play';
};
const rate = $<HTMLInputElement>('rate');
rate.oninput = () => {
  perFrame = Number(rate.value);
  $('rateLabel').textContent = `${perFrame} new blocks / frame`;
};
$('fit').onclick = () => viewer.fitToView(undefined, true);
showStats(viewer, $('stats'), () => counts);
expose({ viewer, errors, tower });

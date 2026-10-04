/**
 * Interaction: picking and selection events, isolate (ghost or hide the rest), colour overrides,
 * section planes and fit to selection, on a small procedurally built building.
 *
 * Every table is 5 meshes (top + 4 legs) sharing one objectId, so it picks, highlights, hides and
 * recolours as one object. Click / tap selects, ctrl/shift-click toggles, a click on the background
 * clears the selection.
 */
import { Viewer } from '../src/index';
import type { Color } from '../src/index';
import { $, captureErrors, expose, translation } from './shared';

const viewer = new Viewer($<HTMLCanvasElement>('c'));
const errors = captureErrors($('errors'));
const names = new Map<number, string>(); // application data keyed by objectId
let nextId = 1;
const P = viewer.primitives;

const concrete = viewer.createMaterial({ color: [0.72, 0.72, 0.7], roughness: 0.9 });
const steel = viewer.createMaterial({ color: [0.35, 0.45, 0.6], metalness: 0.7, roughness: 0.4 });
const wood = viewer.createMaterial({ color: [0.6, 0.42, 0.25], roughness: 0.7 });
const glass = viewer.createMaterial({ color: [0.55, 0.75, 0.95, 0.3], roughness: 0.05 });

const unit = P.box([1, 1, 1]);
const column = P.cylinder(0.25, 1, 24);
const FLOORS = 4, H = 3.5, W = 20, D = 14;

/** One object made of several meshes that share its objectId. */
function object(name: string, parts: { material: number; transform: number[]; geometry?: number }[]): number {
  const objectId = nextId++;
  names.set(objectId, name);
  for (const p of parts) viewer.addMesh({ geometry: p.geometry ?? unit, material: p.material, transform: p.transform, objectId });
  return objectId;
}

const floorIds: number[] = [];
for (let f = 0; f < FLOORS; f++) {
  const y = f * H;
  floorIds.push(object(`slab ${f}`, [{ material: concrete, transform: translation(0, y - 0.15, 0, W, 0.3, D) }]));
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 4; j++) {
      object(`column ${f}.${i}.${j}`, [{ geometry: column, material: steel, transform: translation(-8 + i * 4, y, -6 + j * 4, 1, H - 0.3, 1) }]);
    }
  }
  for (let t = 0; t < 6; t++) {
    const x = -7 + (t % 3) * 7, z = t < 3 ? -3 : 3;
    const legs = [[-0.8, -0.4], [0.8, -0.4], [-0.8, 0.4], [0.8, 0.4]].map(([dx, dz]) => ({
      material: wood,
      transform: translation(x + dx, y + 0.375, z + dz, 0.08, 0.75, 0.08),
    }));
    object(`table ${f}.${t}`, [{ material: wood, transform: translation(x, y + 0.78, z, 1.9, 0.06, 1), }, ...legs]);
  }
  for (const side of [-1, 1]) {
    object(`facade ${f} ${side < 0 ? 'north' : 'south'}`, [{ material: glass, transform: translation(0, y + H / 2 - 0.15, side * (D / 2 - 0.05), W - 0.2, H - 0.3, 0.05) }]);
  }
}
object('roof', [{ material: concrete, transform: translation(0, FLOORS * H - 0.15, 0, W, 0.3, D) }]);
viewer.setCamera({ eye: [24, 20, 26], target: [0, 6, 0] });

// --- events ------------------------------------------------------------------------------------------
const log: string[] = [];
function note(line: string): void {
  log.unshift(line);
  log.length = Math.min(log.length, 6);
  $('log').textContent = log.join('\n');
}
viewer.on('pick', (hit) => note(hit ? `pick: ${names.get(hit.objectId)} at ${hit.position.map((v) => v.toFixed(2)).join(', ')}` : 'pick: background'));
viewer.on('hover', (hit) => ($('hover').textContent = hit ? `hover: ${names.get(hit.objectId)}` : ''));
viewer.on('selection', (ids) => {
  const list = ids.slice(0, 6).map((id) => names.get(id)).join(', ') + (ids.length > 6 ? ', …' : '');
  $('selection').textContent = ids.length ? `selected (${ids.length}): ${list}` : 'nothing selected';
});

// --- actions on the selection -------------------------------------------------------------------
const palette: Color[] = [[0.9, 0.2, 0.2], [0.2, 0.75, 0.3], [0.95, 0.7, 0.1], [0.6, 0.3, 0.85]];
let paint = 0;
const coloured = new Set<number>();
const hidden = new Set<number>();
const sel = () => viewer.getSelection();
const actions: Record<string, () => void> = {
  'isolate-ghost': () => viewer.isolate(sel()),
  'isolate-hide': () => viewer.isolate(sel(), true),
  hide: () => {
    for (const id of sel()) hidden.add(id);
    viewer.setVisible(sel(), false);
    viewer.select([]);
  },
  'show-all': () => {
    viewer.showAll(); // ends isolation and shows hidden objects
    hidden.clear();
  },
  colour: () => {
    viewer.setColor(sel(), palette[paint++ % palette.length]);
    for (const id of sel()) coloured.add(id);
  },
  'reset-colour': () => {
    viewer.setColor(Array.from(coloured), null);
    coloured.clear();
  },
  'fit-sel': () => viewer.fitToView(sel().length ? sel() : undefined, true),
  'select-tables': () => viewer.select(Array.from(names).filter(([, n]) => n.startsWith('table')).map(([id]) => id)),
  'select-floor': () => viewer.select([floorIds[1]]),
};
for (const [id, fn] of Object.entries(actions)) $(id).onclick = fn;

// --- section plane -----------------------------------------------------------------------------------
const bounds = viewer.getBounds()!;
const axis = $<HTMLSelectElement>('axis');
const slider = $<HTMLInputElement>('cut');
const flip = $<HTMLInputElement>('flip');
function updateSection(): void {
  if (axis.value === 'off') {
    viewer.setSectionPlanes([]);
    return;
  }
  const a = axis.value === 'x' ? 0 : axis.value === 'y' ? 1 : 2;
  const t = Number(slider.value) / 1000;
  const point: [number, number, number] = [0, 0, 0];
  point[a] = bounds[a] + (bounds[a + 3] - bounds[a]) * t;
  const normal: [number, number, number] = [0, 0, 0];
  normal[a] = flip.checked ? -1 : 1; // geometry on the positive side is cut away
  viewer.setSectionPlanes([{ normal, point }]);
}
axis.onchange = updateSection;
slider.oninput = updateSection;
flip.onchange = updateSection;
updateSection();

expose({ viewer, errors, names, updateSection });

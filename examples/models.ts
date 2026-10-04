/**
 * Loading models and federation: open several glTF / GLB / OBJ files (file picker, drag and drop,
 * or ?url=a.glb,b.glb), then show / hide / isolate / fit / unload each model. Clicking an object
 * selects it and shows its name and model (ctrl/shift-click toggles objects in the selection).
 *
 *   npm run dev  ->  http://localhost:5173/examples/models.html?url=/path/to/model.glb
 *
 * URL parameters: url=<comma-separated URLs>, offset=<x shift between URL models, default 0>,
 * up=y|z (scene up axis, default z).
 */
import { Viewer, createViewerUi, gltfLoader, objLoader } from '../src/index';
import type { LoadTask } from '../src/index';
import { $, button, captureErrors, expose, showStats } from './shared';

const params = new URLSearchParams(location.search);
const viewer = new Viewer($<HTMLCanvasElement>('c'), {
  up: params.get('up') === 'y' ? 'y' : 'z',
  loaders: [gltfLoader, objLoader], // plugins are registered explicitly; only these are bundled
});
// built-in toolbar at the bottom centre: model tree (with name search), fit, show all
const ui = createViewerUi(viewer);
const errors = captureErrors($('errors'));

// --- loading -------------------------------------------------------------------------------------
const loads = new Map<LoadTask, { name: string; text: string }>();

function load(input: string | File, files?: File[], x = 0): LoadTask {
  const task = viewer.load(input, {
    // a multi-file .gltf dropped together with its .bin files: resolve them by name
    resolve: files ? (uri) => files.find((f) => f.name === uri.split('/').pop()) : undefined,
    // placement: column-major matrix, here a shift by x along the x axis
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1],
  });
  task.catch((e) => {
    if (e?.name !== 'AbortError') errors.push(`${typeof input === 'string' ? input : input.name}: ${e?.message ?? e}`);
  });
  return task;
}

function loadFiles(list: FileList | File[]): void {
  const files = Array.from(list);
  for (const f of files) if (!/\.bin$/i.test(f.name)) load(f, files);
}

viewer.on('loadProgress', (p) => {
  if (p.stage === 'done' || p.stage === 'failed' || p.stage === 'aborted') loads.delete(p.task);
  else loads.set(p.task, { name: p.name, text: `${p.stage} ${(p.fraction * 100).toFixed(0)}%` });
  renderLoads();
});
viewer.on('modelLoaded', renderModels);
viewer.on('modelUnloaded', renderModels);

$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files) loadFiles(input.files);
  input.value = '';
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('drag');
});
window.addEventListener('dragleave', () => document.body.classList.remove('drag'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drag');
  if (e.dataTransfer?.files.length) loadFiles(e.dataTransfer.files);
});
// ?url=a.glb,b.glb loads both at once; &offset=160 places each further model 160 units along x
const offset = Number(params.get('offset') ?? 0);
(params.get('url') ?? '').split(',').filter(Boolean).forEach((url, k) => load(url, undefined, k * offset));

// --- UI ------------------------------------------------------------------------------------------
function renderLoads(): void {
  const box = $('loads');
  box.replaceChildren();
  for (const [task, l] of loads) {
    const row = document.createElement('div');
    row.className = 'row';
    const bar = document.createElement('progress');
    bar.max = 1;
    bar.value = task.progress;
    row.append(`${l.name} ${l.text}`, bar, button('cancel', () => task.abort()));
    box.append(row);
  }
}

function renderModels(): void {
  const box = $('models');
  box.replaceChildren();
  for (const m of viewer.models) {
    const row = document.createElement('div');
    row.className = 'row';
    const vis = document.createElement('input');
    vis.type = 'checkbox';
    vis.checked = m.visible;
    vis.title = 'show / hide';
    vis.onchange = () => m.setVisible(vis.checked);
    const name = document.createElement('span');
    name.textContent = `${m.name}: ${m.stats.meshes.toLocaleString()} meshes, ${(m.stats.triangles / 1e6).toFixed(2)}M triangles`;
    row.append(
      vis,
      name,
      button('fit', () => m.fitToView(true)),
      button('isolate', () => m.isolate()),
      button('unload', () => m.unload()),
    );
    box.append(row);
  }
  if (viewer.models.length > 0) box.append(button('show all', () => viewer.showAll()), ' ', button('fit all', () => viewer.fitToView(undefined, true)));
}

/** Node name with up to 3 parents (exporters often name the meaningful node above the mesh). */
function objectName(objectId: number): string {
  const h = viewer.getModelOf(objectId)?.hierarchy;
  const names: string[] = [];
  for (let n = h ? h.nodeOfObject(objectId) : -1; h && n >= 0 && names.length < 4; n = h.parent(n)) {
    const s = h.name(n);
    if (s) names.unshift(s);
  }
  return names.join(' / ') || `object ${objectId}`;
}

viewer.on('pick', (hit) => {
  $('picked').textContent = hit ? `${objectName(hit.objectId)}\nmodel: ${hit.model?.name ?? '-'}` : '';
});
viewer.on('selection', (ids) => {
  const parts: string[] = [];
  for (const [model, list] of viewer.groupByModel(ids)) parts.push(`${list.length} in ${model?.name ?? 'scene'}`);
  $('selection').replaceChildren(
    ids.length ? `selected: ${parts.join(', ')} ` : '',
    ...(ids.length
      ? [button('fit', () => viewer.fitToView(ids, true)), ' ', button('isolate', () => viewer.isolate(ids)), ' ', button('clear', () => viewer.select([]))]
      : []),
  );
});

showStats(viewer, $('stats'));
expose({ viewer, ui, errors, load });

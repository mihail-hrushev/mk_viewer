/**
 * Minimal federation page: load several models (file picker, drag and drop, or ?url=a.glb,b.glb),
 * list them with visibility / fit / unload, show load progress, stats and the picked object.
 *
 *   npx vite  ->  http://localhost:5173/examples/models.html?url=/TestModels/FactoryDemo.glb
 *
 * URL parameters: url=<comma-separated URLs>, up=y|z (default z).
 * Everything is reachable from the console / a test driver through `window.mk`.
 */
import { Viewer, gltfLoader, objLoader } from '../src/index';
import type { LoadTask, Model } from '../src/index';

const params = new URLSearchParams(location.search);
const up = params.get('up') === 'y' ? 'y' : 'z';
const canvas = document.getElementById('c') as HTMLCanvasElement;
const $ = (id: string) => document.getElementById(id) as HTMLElement;

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

// plugins are registered explicitly (only these two are bundled)
const viewer = new Viewer(canvas, { up, loaders: [gltfLoader, objLoader] });

// --- loading -----------------------------------------------------------------------------------
const progress = new Map<LoadTask, string>();
viewer.on('loadProgress', (p) => {
  if (p.stage === 'done' || p.stage === 'failed' || p.stage === 'aborted') progress.delete(p.task);
  else progress.set(p.task, `${p.name}: ${p.stage} ${(p.fraction * 100).toFixed(0)}%`);
  renderLoads();
});
viewer.on('modelLoaded', renderModels);
viewer.on('modelUnloaded', renderModels);

function load(input: string | File, files?: File[]): LoadTask {
  const task = viewer.load(input, {
    // multi-file glTF dropped together: resolve sibling .bin files by name
    resolve: files ? (uri) => files.find((f) => f.name === uri.split('/').pop()) : undefined,
  });
  task.catch((e) => {
    if (e?.name !== 'AbortError') errors.push(String(e?.message ?? e));
  });
  return task;
}

function loadFiles(list: FileList | File[]): void {
  const files = Array.from(list);
  for (const f of files) if (!/\.bin$/i.test(f.name)) load(f, files);
}

($('file') as HTMLInputElement).addEventListener('change', (e) => {
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
for (const url of (params.get('url') ?? '').split(',').filter(Boolean)) load(url);

// --- UI ----------------------------------------------------------------------------------------
function renderLoads(): void {
  $('loads').textContent = Array.from(progress.values()).join('\n');
}

function button(label: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = fn;
  return b;
}

function renderModels(): void {
  const box = $('models');
  box.replaceChildren();
  for (const m of viewer.models) {
    const row = document.createElement('div');
    const vis = document.createElement('input');
    vis.type = 'checkbox';
    vis.checked = m.visible;
    vis.onchange = () => m.setVisible(vis.checked);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${m.name} (${m.stats.meshes} meshes)`;
    name.title = m.name;
    row.append(vis, name, button('fit', () => m.fitToView(true)), button('isolate', () => m.isolate()), button('unload', () => m.unload()));
    box.append(row);
  }
  if (viewer.models.length > 1) box.append(button('show all', () => viewer.showAll()));
}

viewer.on('pick', (p) => {
  if (!p) {
    $('picked').textContent = '';
    return;
  }
  // node name with its parents (exporters often give leaves ids and the meaning sits higher up)
  const names: string[] = [];
  const h = p.model?.hierarchy;
  for (let n = h ? h.nodeOfObject(p.objectId) : -1; h && n >= 0 && names.length < 4; n = h.parent(n)) {
    const s = h.name(n);
    if (s) names.unshift(s);
  }
  $('picked').textContent = `picked: ${names.join(' / ') || `object ${p.objectId}`}\nmodel: ${p.model?.name ?? '-'}`;
});

setInterval(() => {
  const s = viewer.stats;
  $('stats').textContent =
    `meshes ${s.meshes}  triangles ${(s.triangles / 1e6).toFixed(2)}M\n` +
    `fps ${s.fps.toFixed(0)}  cpu ${s.frameMs.toFixed(1)} ms  progress ${(s.progress * 100).toFixed(0)}%\n` +
    `items ${s.drawItems}  calls ${s.drawCalls}  drawn ${(s.trianglesDrawn / 1e6).toFixed(2)}M  gpu ${(s.gpuMemoryBytes / 1048576).toFixed(0)} MB` +
    (errors.length ? `\nERRORS: ${errors.join(' | ')}` : '');
}, 250);

// --- test driver hooks -------------------------------------------------------------------------
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

const mk = { viewer, errors, load, waitIdle, models: (): readonly Model[] => viewer.models };
(window as unknown as { mk: typeof mk }).mk = mk;

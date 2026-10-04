/**
 * Loading models and federation with the built-in UI: the Models panel opens glTF / GLB / OBJ files
 * (file picker, drag and drop, or ?url=a.glb,b.glb) and shows / hides / isolates / fits / unloads
 * each model; the Tree panel shows their node structure. Clicking an object selects it and shows
 * its name and model (ctrl/shift-click toggles objects in the selection).
 *
 *   npm run dev  ->  http://localhost:5173/examples/models.html?url=/path/to/model.glb
 *
 * URL parameters: url=<comma-separated URLs>, offset=<x shift between URL models, default 0>,
 * up=y|z (scene up axis, default z), env=studio|<URL of a Radiance .hdr> (image-based lighting; a
 * .hdr file can also be opened or dropped like a model).
 */
import { Viewer, createViewerUi, gltfLoader, objLoader } from '../src/index';
import { expose, showStats } from './shared';

const params = new URLSearchParams(location.search);
const viewer = new Viewer(document.getElementById('c') as HTMLCanvasElement, {
  up: params.get('up') === 'y' ? 'y' : 'z',
  loaders: [gltfLoader, objLoader], // plugins are registered explicitly; only these are bundled
});
// built-in UI: bottom toolbar, movable Tree and Models panels, right-click menu
const ui = createViewerUi(viewer);
ui.models.open();

// ?url=a.glb,b.glb loads both at once; &offset=160 places each further model 160 units along x
const offset = Number(params.get('offset') ?? 0);
(params.get('url') ?? '').split(',').filter(Boolean).forEach((url, k) => {
  viewer
    // placement: column-major matrix, here a shift by k * offset along the x axis
    .load(url, { transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, k * offset, 0, 0, 1] })
    .catch((e) => {
      if (e?.name !== 'AbortError') ui.models.showError(`${url}: ${e?.message ?? e}`);
    });
});

// ?env=studio (built-in preset) or ?env=/path/to/sky.hdr: light the scene with an HDR environment
const env = params.get('env');
if (env) viewer.setEnvironment(env).catch((e) => ui.models.showError(`${env}: ${e?.message ?? e}`));

// --- the page's own content goes in the Models panel footer ----------------------------------------
const picked = document.createElement('div');
picked.className = 'picked';
const stats = document.createElement('div');
stats.className = 'stats';
ui.models.footer.append(picked, stats);

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
  picked.textContent = hit ? `${objectName(hit.objectId)}\nmodel: ${hit.model?.name ?? '-'}` : '';
});

showStats(viewer, stats);
expose({ viewer, ui });

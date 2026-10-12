/**
 * Loading models and federation with the built-in UI: the Models panel opens glTF / GLB / OBJ files
 * (file picker, drag and drop, or ?url=a.glb,b.glb) and shows / hides / isolates / fits / unloads
 * each model; the Tree panel shows their node structure. Clicking an object selects it and shows
 * its name and model (ctrl/shift-click toggles objects in the selection).
 *
 * It is also the reference for registering viewer plugins at startup: the built-in measurement
 * tool (`measurePlugin`, toolbar button "Measure"), the colour plugin (`colorPlugin`, right-click
 * menu entries "Change colour" and "Reset colour"), the status plugin (`statusPlugin`, toolbar button "Status":
 * a legend of pasted Tag / Status / State / Colour rows), the sets plugin (`setsPlugin`, toolbar
 * button "Sets": saved property searches), the selection plugin (`selectionPlugin`, toolbar button
 * "Selection": the selection level and Parent / Child / Sibling) and a small third-party plugin written
 * against the public API only (./section-plugin.ts, toolbar button "Cut").
 *
 *   npm run dev  ->  http://localhost:5173/examples/models.html?url=/path/to/model.glb
 *
 * URL parameters: url=<comma-separated URLs>, offset=<x shift between URL models, default 0>,
 * up=y|z (scene up axis, default z), env=studio|<URL of a Radiance .hdr> (image-based lighting; a
 * .hdr file can also be opened or dropped like a model), edges=1 (edge display on), xray=1
 * (selection x-ray on) and ghost=1 (hidden objects shown faintly); all three are switches of the
 * Settings panel.
 */
import { Viewer, colorPlugin, createViewerUi, gltfLoader, measurePlugin, objLoader, selectionPlugin, setsPlugin, statusPlugin, type MeasurePlugin } from '../src/index';
import { sectionPlugin } from './section-plugin';
import { expose, showStats } from './shared';

const params = new URLSearchParams(location.search);
const viewer = new Viewer(document.getElementById('c') as HTMLCanvasElement, {
  up: params.get('up') === 'y' ? 'y' : 'z',
  loaders: [gltfLoader, objLoader], // loader plugins (file formats) are registered explicitly
  // viewer plugins (tools, UI): installed in this order; their toolbar buttons appear with the UI
  // colorPlugin adds "Change colour" (a submenu of named colours) and "Reset colour" to the right-click menu
  // statusPlugin adds the "Status" button: a legend of pasted Tag / Status / State / Colour rows
  // setsPlugin adds the "Sets" button: saved property searches (a key and pasted values)
  // selectionPlugin adds the "Selection" button: the selection level (what a click selects; the
  // Spool and Iso levels use the properties of the PCF-derived spool models) and Parent / Child / Sibling
  plugins: [
    measurePlugin({ decimals: 3 }),
    sectionPlugin(),
    colorPlugin(),
    statusPlugin(),
    setsPlugin(),
    selectionPlugin({
      levels: [{ label: 'Object' }, { label: 'Parent', up: 1 }, { label: 'Spool', key: 'Spool' }, { label: 'Iso', key: 'Spools' }, { label: 'Top', up: Infinity }],
    }),
  ],
});
// built-in UI: bottom toolbar, movable panels (Tree, Models, Properties, Search, Settings), right-click menu
const ui = createViewerUi(viewer);
// "display edges": dark lines along creases, silhouettes and mesh boundaries (not triangle diagonals)
if (params.get('edges') === '1') viewer.setEdges(true);
// selection x-ray: the edges of the selected objects on top of everything
if (params.get('xray') === '1') viewer.setSelectionXray(true);
// ghost hidden: objects hidden with setVisible / isolate(ids, true) drawn faintly instead of not at all
if (params.get('ghost') === '1') viewer.setGhostHidden(true);
const measure = viewer.getPlugin<MeasurePlugin>('measure')!; // the plugin's own API
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
expose({ viewer, ui, measure });

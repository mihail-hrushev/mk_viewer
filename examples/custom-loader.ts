/**
 * A custom loader plugin end to end: `bloxLoader` (./blox-loader.ts) is registered on this viewer
 * only, then a .blox file is loaded from a URL (the plugin is chosen by file extension). Edit the
 * text and press "Load text" to load it again from memory (detected by content sniffing, since a
 * Blob has no file name). Click an object to see the name and properties the plugin stored.
 */
import { Viewer } from '../src/index';
import type { Model } from '../src/index';
import { bloxLoader } from './blox-loader';
import { $, captureErrors, expose } from './shared';

const viewer = new Viewer($<HTMLCanvasElement>('c'), { up: 'z' });
const errors = captureErrors($('errors'));
viewer.registerLoader(bloxLoader);

let current: Model | null = null;
async function show(input: string | Blob): Promise<void> {
  try {
    const model = await viewer.load(input, { fitToView: true });
    current?.unload();
    current = model;
    $('info').textContent =
      `loaded "${model.name}" with the '${model.loader}' plugin: ${model.stats.meshes} meshes, ` +
      `${model.stats.objects} objects, ${model.stats.loadMs.toFixed(0)} ms\n` +
      (model.warnings.length ? `warnings:\n  ${model.warnings.join('\n  ')}` : 'no warnings');
  } catch (e) {
    $('info').textContent = `load failed: ${(e as Error).message}`;
  }
}

viewer.on('pick', (hit) => {
  const props = hit?.model?.getProperties(hit.objectId);
  $('picked').textContent = props ? JSON.stringify(props) : '';
});

const text = $<HTMLTextAreaElement>('text');
const url = new URL('./assets/house.blox', location.href).href;
fetch(url).then(async (r) => (text.value = await r.text()));
void show(url);
$('load').onclick = () => void show(new Blob([text.value]));

expose({ viewer, errors, show });

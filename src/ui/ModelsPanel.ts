/**
 * Models panel: open model files (file picker, or drop them on the canvas), follow running loads,
 * and show / hide / fit / isolate / unload each loaded model. It lists every load of the viewer,
 * whoever started it. `footer` is free space for the host page (status text, statistics).
 * A Radiance `.hdr` file among the opened / dropped files becomes the environment lighting
 * (`viewer.setEnvironment`); the active environment is shown with a button to clear it.
 */
import type { ViewerApi } from '../types';
import type { LoadTask } from '../loaders/types';
import { Panel } from './Panel';

interface RunningLoad {
  name: string;
  text: string;
}

export class ModelsPanel {
  /** Empty container at the bottom of the panel for the host page's own content. */
  readonly footer: HTMLElement;

  private readonly viewer: ViewerApi;
  private readonly panel: Panel;
  private readonly loadsBox: HTMLElement;
  private readonly modelsBox: HTMLElement;
  private readonly errorsBox: HTMLElement;
  private readonly envBox: HTMLElement;
  private readonly loads = new Map<LoadTask, RunningLoad>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(viewer: ViewerApi, parent: HTMLElement, onToggle?: (open: boolean) => void) {
    this.viewer = viewer;
    const doc = parent.ownerDocument;
    this.panel = new Panel(parent, { title: 'Models', dock: 'left', height: 'auto', onToggle });
    const body = this.panel.body;
    body.classList.add('mkv-pad');

    const input = doc.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.onchange = () => {
      if (input.files) this.loadFiles(input.files);
      input.value = '';
    };
    const open = this.button('Open files…', () => input.click());
    open.title =
      'Open model files (several at once to federate them) or a .hdr environment image; files can also be dropped on the viewer';
    const top = this.row(open, input);
    this.envBox = doc.createElement('div');

    this.loadsBox = doc.createElement('div');
    this.modelsBox = doc.createElement('div');
    this.errorsBox = doc.createElement('div');
    this.errorsBox.className = 'mkv-errors';
    this.footer = doc.createElement('div');
    this.footer.className = 'mkv-footer';
    body.append(top, this.envBox, this.loadsBox, this.modelsBox, this.errorsBox, this.footer);

    const canvas = viewer.canvas;
    canvas.addEventListener('dragover', this.onDragOver);
    canvas.addEventListener('drop', this.onDrop);

    this.unsubscribe.push(
      viewer.on('loadProgress', (p) => {
        if (p.stage === 'done' || p.stage === 'failed' || p.stage === 'aborted') this.loads.delete(p.task);
        else this.loads.set(p.task, { name: p.name, text: `${p.stage} ${(p.fraction * 100).toFixed(0)}%` });
        this.drawLoads();
      }),
      viewer.on('modelLoaded', () => this.drawModels()),
      viewer.on('modelUnloaded', () => this.drawModels()),
      viewer.on('environment', () => this.drawEnvironment()),
    );
    this.drawModels();
    this.drawEnvironment();
  }

  get element(): HTMLElement {
    return this.panel.element;
  }

  get isOpen(): boolean {
    return this.panel.isOpen;
  }

  open(): void {
    this.panel.open();
  }

  close(): void {
    this.panel.close();
  }

  toggle(): void {
    this.panel.toggle();
  }

  /**
   * Loads the given files as models; `.bin` companions of a multi-file glTF are resolved by name. A
   * `.hdr` file is set as the environment lighting instead.
   */
  loadFiles(list: FileList | File[]): void {
    const files = Array.from(list);
    for (const f of files) {
      if (/\.bin$/i.test(f.name)) continue;
      if (/\.hdr$/i.test(f.name)) {
        // the error message already names the file
        this.viewer.setEnvironment(f).catch((e: { message?: string }) => this.showError(`${e?.message ?? e}`));
        continue;
      }
      const task = this.viewer.load(f, { resolve: (uri: string) => files.find((x) => x.name === uri.split('/').pop()) });
      task.catch((e: { name?: string; message?: string }) => {
        if (e?.name !== 'AbortError') this.showError(`${f.name}: ${e?.message ?? e}`);
      });
    }
  }

  showError(message: string): void {
    const line = this.element.ownerDocument.createElement('div');
    line.textContent = message;
    this.errorsBox.append(line);
    this.open();
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    const canvas = this.viewer.canvas;
    canvas.removeEventListener('dragover', this.onDragOver);
    canvas.removeEventListener('drop', this.onDrop);
    this.panel.dispose();
  }

  // ---------------------------------------------------------------------------------------------

  private readonly onDragOver = (e: DragEvent): void => {
    e.preventDefault();
  };

  private readonly onDrop = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer?.files.length) this.loadFiles(e.dataTransfer.files);
  };

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const b = this.panel.element.ownerDocument.createElement('button');
    b.className = 'mkv-btn mkv-outline';
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  private row(...children: (Node | string)[]): HTMLElement {
    const r = this.panel.element.ownerDocument.createElement('div');
    r.className = 'mkv-line';
    r.append(...children);
    return r;
  }

  private drawLoads(): void {
    const doc = this.element.ownerDocument;
    const rows: HTMLElement[] = [];
    for (const [task, l] of this.loads) {
      const label = doc.createElement('span');
      label.className = 'mkv-grow';
      label.textContent = `${l.name} ${l.text}`;
      const bar = doc.createElement('progress');
      bar.max = 1;
      bar.value = task.progress;
      rows.push(this.row(label, bar, this.button('Cancel', () => task.abort())));
    }
    this.loadsBox.replaceChildren(...rows);
  }

  private drawEnvironment(): void {
    const env = this.viewer.getEnvironment();
    if (!env) {
      this.envBox.replaceChildren();
      return;
    }
    const label = this.element.ownerDocument.createElement('span');
    label.className = 'mkv-grow';
    label.textContent = `Lighting: ${env.name}`;
    label.title = 'Image-based lighting (environment)';
    this.envBox.replaceChildren(this.row(label, this.button('Clear', () => void this.viewer.setEnvironment(null))));
  }

  private drawModels(): void {
    const doc = this.element.ownerDocument;
    const viewer = this.viewer;
    const rows: HTMLElement[] = [];
    for (const m of viewer.models) {
      const vis = doc.createElement('input');
      vis.type = 'checkbox';
      vis.checked = m.visible;
      vis.title = 'Show / hide';
      vis.onchange = () => m.setVisible(vis.checked);
      const name = doc.createElement('span');
      name.className = 'mkv-grow';
      name.textContent = m.name;
      name.title = `${m.stats.meshes.toLocaleString()} meshes, ${(m.stats.triangles / 1e6).toFixed(2)}M triangles`;
      const info = doc.createElement('div');
      info.className = 'mkv-dim';
      info.textContent = name.title;
      const item = doc.createElement('div');
      item.className = 'mkv-model-item';
      item.append(
        this.row(vis, name),
        info,
        this.row(
          this.button('Fit', () => m.fitToView(true)),
          this.button('Isolate', () => m.isolate()),
          this.button('Unload', () => m.unload()),
        ),
      );
      rows.push(item);
    }
    if (viewer.models.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'mkv-dim';
      empty.textContent = 'No models loaded. Open files or drop them on the viewer.';
      rows.push(empty);
    }
    this.modelsBox.replaceChildren(...rows);
  }
}

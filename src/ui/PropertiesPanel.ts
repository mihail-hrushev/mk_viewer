/**
 * Properties panel: the properties of the selected object, inherited from the nodes above it (as
 * `hierarchy.properties(node, true)` merges them), since exports such as Navisworks or PCF keep the
 * data on the isometric and spool groups. With several objects selected it shows the first.
 * Searching by property is the `SearchPanel`.
 */
import type { ViewerApi } from '../types';
import { Panel } from './Panel';

export class PropertiesPanel {
  private readonly viewer: ViewerApi;
  private readonly panel: Panel;
  private readonly selInfo: HTMLElement;
  private readonly selTable: HTMLTableElement;
  private readonly unsubscribe: (() => void)[] = [];
  /** The selection changed while the panel was closed: redraw it on open. */
  private selectionDirty = true;
  /** The viewer's selection as of its last `selection` event. */
  private selection: readonly number[];

  constructor(viewer: ViewerApi, parent: HTMLElement, onToggle?: (open: boolean) => void) {
    this.viewer = viewer;
    this.selection = viewer.getSelection();
    const doc = parent.ownerDocument;
    this.panel = new Panel(parent, {
      title: 'Properties',
      dock: 'right',
      height: 'auto',
      onToggle: (open) => {
        if (open && this.selectionDirty) this.drawSelection();
        onToggle?.(open);
      },
    });
    const body = this.panel.body;
    body.classList.add('mkv-pad', 'mkv-propbody');

    this.selInfo = doc.createElement('div');
    this.selInfo.className = 'mkv-dim';
    this.selTable = doc.createElement('table');
    this.selTable.className = 'mkv-props';
    body.append(this.selInfo, this.selTable);

    this.unsubscribe.push(
      viewer.on('selection', (ids) => {
        this.selection = ids;
        this.onSelection();
      }),
      // a new model may own the selection's ids; an unloaded one takes its properties with it
      viewer.on('modelLoaded', () => this.onSelection()),
      viewer.on('modelUnloaded', () => this.onSelection()),
    );
    this.drawSelection();
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

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.panel.dispose();
  }

  // ---------------------------------------------------------------------------------------------

  private onSelection(): void {
    if (this.isOpen) this.drawSelection();
    else this.selectionDirty = true;
  }

  private drawSelection(): void {
    this.selectionDirty = false;
    const doc = this.element.ownerDocument;
    const sel = this.selection;
    const rows: HTMLElement[] = [];
    if (sel.length === 0) {
      this.selInfo.textContent = 'Select an object to see its properties.';
      this.selTable.replaceChildren();
      return;
    }
    const id = sel[0];
    const model = this.viewer.getModelOf(id);
    const h = model?.hierarchy;
    const node = h ? h.nodeOfObject(id) : -1;
    this.selInfo.textContent = sel.length > 1 ? `${sel.length.toLocaleString()} objects selected, showing the first` : '';
    const add = (key: string, value: string, cls?: string): void => {
      const tr = doc.createElement('tr');
      if (cls) tr.className = cls;
      const k = doc.createElement('td');
      k.textContent = key;
      const v = doc.createElement('td');
      v.textContent = value;
      tr.append(k, v);
      rows.push(tr);
    };
    add('Model', model ? model.name : '-', 'mkv-props-meta');
    add('Node', (h && node >= 0 ? h.name(node) : undefined) ?? `object ${id}`, 'mkv-props-meta');
    const props = h && node >= 0 ? h.properties(node, true) : undefined;
    let n = 0;
    if (props) {
      for (const key in props) {
        add(key, formatValue(props[key]));
        n++;
      }
    }
    if (n === 0) {
      const tr = doc.createElement('tr');
      const td = doc.createElement('td');
      td.colSpan = 2;
      td.className = 'mkv-dim';
      td.textContent = 'No properties';
      tr.append(td);
      rows.push(tr);
    }
    this.selTable.replaceChildren(...rows);
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

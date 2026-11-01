/**
 * Properties panel: the properties of the selected object, inherited from the nodes above it (as
 * `hierarchy.properties(node, true)` merges them), since exports such as Navisworks or PCF keep the
 * data on the isometric and spool groups. With several objects selected it shows the first.
 * Nested objects (categories, property sets) are shown as collapsible groups (`propertyRows`).
 * Searching by property is the `SearchPanel`.
 */
import type { ViewerApi } from '../types';
import { Panel } from './Panel';
import { propertyRows } from './propertyRows';

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
  /** Collapsed property groups (categories) by name; kept across selections. */
  private readonly collapsed = new Set<string>();

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
    const groupRows = new Map<string, HTMLElement[]>();
    let n = 0;
    for (const r of propertyRows(props)) {
      if (r.kind === 'group') {
        rows.push(this.groupHeader(doc, r.key, groupRows));
        continue;
      }
      add(r.key, r.value);
      n++;
      if (r.group !== undefined) {
        const tr = rows[rows.length - 1];
        tr.hidden = this.collapsed.has(r.group);
        let list = groupRows.get(r.group);
        if (!list) groupRows.set(r.group, (list = []));
        list.push(tr);
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

  /** A category header row; a click collapses or expands the rows listed under it in `groupRows`. */
  private groupHeader(doc: Document, name: string, groupRows: Map<string, HTMLElement[]>): HTMLElement {
    const tr = doc.createElement('tr');
    tr.className = 'mkv-props-group';
    const td = doc.createElement('td');
    td.colSpan = 2;
    td.textContent = name;
    tr.append(td);
    tr.classList.toggle('mkv-collapsed', this.collapsed.has(name));
    tr.addEventListener('click', () => {
      const collapse = !this.collapsed.has(name);
      if (collapse) this.collapsed.add(name);
      else this.collapsed.delete(name);
      tr.classList.toggle('mkv-collapsed', collapse);
      for (const row of groupRows.get(name) ?? []) row.hidden = collapse;
    });
    return tr;
  }
}

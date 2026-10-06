/**
 * Properties panel: the properties of the selected object (inherited from the nodes above it, as
 * `hierarchy.properties(node, true)` merges them) and a search over the property index of every
 * loaded model (`viewer.findObjects`): one value, a pasted list of thousands of values (with the
 * values that were not found, ready to copy), a prefix or a numeric range. The result's objectIds
 * can be selected, isolated, framed or coloured; they stay the `Float64Array` the index returns.
 */
import type { PropertySearch, ViewerApi } from '../types';
import type { PropertyQuery } from '../loaders/types';
import { Panel } from './Panel';

type Mode = 'equals' | 'in' | 'startsWith' | 'range';

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'equals', label: 'equals' },
  { mode: 'in', label: 'list' },
  { mode: 'startsWith', label: 'starts with' },
  { mode: 'range', label: 'range' },
];

const NO_IDS = new Float64Array(0);

export class PropertiesPanel {
  private readonly viewer: ViewerApi;
  private readonly panel: Panel;
  private readonly selInfo: HTMLElement;
  private readonly selTable: HTMLTableElement;
  private readonly keySelect: HTMLSelectElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly valueInput: HTMLInputElement;
  private readonly listInput: HTMLTextAreaElement;
  private readonly rangeLine: HTMLElement;
  private readonly minInput: HTMLInputElement;
  private readonly maxInput: HTMLInputElement;
  private readonly resultLine: HTMLElement;
  private readonly missingBox: HTMLDetailsElement;
  private readonly missingSummary: HTMLElement;
  private readonly missingList: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly colorInput: HTMLInputElement;
  private readonly unsubscribe: (() => void)[] = [];
  /** objectIds of the last search (never converted to a JS array). */
  private result: Float64Array = NO_IDS;
  /** Values of the last list search that matched nothing, one per line. */
  private missingText = '';
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

    // --- properties of the selection ---
    this.selInfo = doc.createElement('div');
    this.selInfo.className = 'mkv-dim';
    this.selTable = doc.createElement('table');
    this.selTable.className = 'mkv-props';

    // --- search ---
    const searchHead = doc.createElement('div');
    searchHead.className = 'mkv-subhead';
    searchHead.textContent = 'Find by property';

    this.keySelect = doc.createElement('select');
    this.keySelect.className = 'mkv-field mkv-grow';
    this.keySelect.title = 'Property key';
    this.modeSelect = doc.createElement('select');
    this.modeSelect.className = 'mkv-field';
    this.modeSelect.title = 'How values are matched';
    for (const m of MODES) {
      const o = doc.createElement('option');
      o.value = m.mode;
      o.textContent = m.label;
      this.modeSelect.append(o);
    }
    this.modeSelect.onchange = () => this.showMode();

    const onEnter = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.find();
      }
    };
    this.valueInput = doc.createElement('input');
    this.valueInput.type = 'text';
    this.valueInput.className = 'mkv-field mkv-grow';
    this.valueInput.spellcheck = false;
    this.valueInput.addEventListener('keydown', onEnter);

    this.listInput = doc.createElement('textarea');
    this.listInput.className = 'mkv-field';
    this.listInput.rows = 5;
    this.listInput.spellcheck = false;
    this.listInput.placeholder = 'One value per line (paste a spreadsheet column); Ctrl+Enter finds';
    this.listInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.find();
      }
    });

    this.minInput = doc.createElement('input');
    this.minInput.type = 'number';
    this.minInput.className = 'mkv-field mkv-grow';
    this.minInput.placeholder = 'min';
    this.minInput.addEventListener('keydown', onEnter);
    this.maxInput = doc.createElement('input');
    this.maxInput.type = 'number';
    this.maxInput.className = 'mkv-field mkv-grow';
    this.maxInput.placeholder = 'max';
    this.maxInput.addEventListener('keydown', onEnter);
    this.rangeLine = this.row(this.minInput, this.maxInput);

    const findButton = this.button('Find', () => this.find());
    findButton.title = 'Search every loaded model';

    this.resultLine = doc.createElement('div');
    this.resultLine.className = 'mkv-dim';

    this.missingBox = doc.createElement('details');
    this.missingBox.className = 'mkv-missing';
    this.missingSummary = doc.createElement('summary');
    this.missingList = doc.createElement('pre');
    const copy = this.button('Copy missing', () => this.copyMissing());
    copy.title = 'Copy the values that were not found, one per line';
    this.missingBox.append(this.missingSummary, this.missingList, this.row(copy));

    this.colorInput = doc.createElement('input');
    this.colorInput.type = 'color';
    this.colorInput.value = '#ff5722';
    this.colorInput.title = 'Colour for "Colour"';
    this.actions = this.row(
      this.button('Select', () => this.viewer.select(this.result)),
      this.button('Isolate', () => this.viewer.isolate(this.result)),
      this.button('Fit', () => this.viewer.fitToView(this.result, true)),
      this.button('Colour', () => this.viewer.setColor(this.result, this.pickedColor())),
      this.colorInput,
      this.button('Clear colour', () => this.viewer.setColor(this.result, null)),
    );

    body.append(
      this.selInfo,
      this.selTable,
      searchHead,
      this.row(this.keySelect, this.modeSelect),
      this.row(this.valueInput),
      this.listInput,
      this.rangeLine,
      this.row(findButton),
      this.resultLine,
      this.missingBox,
      this.actions,
    );

    this.unsubscribe.push(
      viewer.on('selection', (ids) => {
        this.selection = ids;
        this.onSelection();
      }),
      viewer.on('modelLoaded', () => this.onModelsChanged()),
      viewer.on('modelUnloaded', () => this.onModelsChanged()),
    );
    this.showMode();
    this.fillKeys();
    this.clearResult();
    this.drawSelection();
  }

  get element(): HTMLElement {
    return this.panel.element;
  }

  get isOpen(): boolean {
    return this.panel.isOpen;
  }

  /** objectIds of the last search, ascending (empty before the first one). */
  get resultIds(): Float64Array {
    return this.result;
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

  /** Runs a search as if typed into the panel and returns its result. */
  search(query: PropertyQuery): PropertySearch {
    const res = this.viewer.findObjects(query);
    this.showResult(res, query.in ? query.in.length : -1, query.in);
    return res;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.result = NO_IDS;
    this.panel.dispose();
  }

  // ---------------------------------------------------------------------------------------------

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

  private onSelection(): void {
    if (this.isOpen) this.drawSelection();
    else this.selectionDirty = true;
  }

  private onModelsChanged(): void {
    this.fillKeys();
    // ids of an unloaded model are gone; a new model may own the selection's ids
    this.clearResult();
    this.onSelection();
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

  private fillKeys(): void {
    const doc = this.element.ownerDocument;
    const prev = this.keySelect.value;
    const keys = this.viewer.propertyKeys();
    const options: HTMLOptionElement[] = [];
    let hasName = false;
    for (const k of keys) {
      if (k.key === 'name') hasName = true;
      const o = doc.createElement('option');
      o.value = o.textContent = k.key;
      o.title = `${k.count.toLocaleString()} nodes, ${k.distinct.toLocaleString()} distinct values${k.numeric ? ', numeric' : ''}`;
      options.push(o);
    }
    if (!hasName) {
      const o = doc.createElement('option');
      o.value = o.textContent = 'name';
      options.unshift(o);
    }
    this.keySelect.replaceChildren(...options);
    if (prev && options.some((o) => o.value === prev)) this.keySelect.value = prev;
    else this.keySelect.value = 'name';
  }

  private showMode(): void {
    const mode = this.modeSelect.value as Mode;
    (this.valueInput.parentElement as HTMLElement).hidden = mode !== 'equals' && mode !== 'startsWith';
    this.listInput.hidden = mode !== 'in';
    this.rangeLine.hidden = mode !== 'range';
    this.valueInput.placeholder = mode === 'startsWith' ? 'Prefix; Enter finds' : 'Value; Enter finds';
  }

  private find(): void {
    const key = this.keySelect.value;
    if (!key) return;
    const mode = this.modeSelect.value as Mode;
    const query: PropertyQuery = { key };
    if (mode === 'equals' || mode === 'startsWith') {
      const v = this.valueInput.value.trim();
      if (!v) return this.clearResult('Enter a value.');
      if (mode === 'equals') query.equals = v;
      else query.startsWith = v;
    } else if (mode === 'in') {
      const values = parseList(this.listInput.value);
      if (values.length === 0) return this.clearResult('Paste one value per line.');
      query.in = values;
    } else {
      const min = this.minInput.value.trim() === '' ? NaN : Number(this.minInput.value);
      const max = this.maxInput.value.trim() === '' ? NaN : Number(this.maxInput.value);
      if (Number.isNaN(min) && Number.isNaN(max)) return this.clearResult('Enter a minimum, a maximum or both.');
      if (!Number.isNaN(min)) query.min = min;
      if (!Number.isNaN(max)) query.max = max;
    }
    try {
      this.search(query);
    } catch (e) {
      this.clearResult(`Search failed: ${(e as { message?: string })?.message ?? e}`);
    }
  }

  private showResult(res: PropertySearch, inputCount: number, inputs?: ArrayLike<string | number>): void {
    this.result = res.objectIds;
    const objects = res.objectIds.length.toLocaleString();
    this.missingText = '';
    this.resultLine.hidden = false;
    if (res.hits && inputs) {
      let found = 0;
      const missing: string[] = [];
      for (let i = 0; i < res.hits.length; i++) {
        if (res.hits[i] > 0) found++;
        else missing.push(String(inputs[i]));
      }
      this.resultLine.textContent = `${found.toLocaleString()} of ${inputCount.toLocaleString()} values found, ${objects} objects`;
      this.missingText = missing.join('\n');
      this.missingSummary.textContent = `${missing.length.toLocaleString()} not found`;
      this.missingList.textContent = this.missingText;
      this.missingBox.hidden = missing.length === 0;
    } else {
      let nodes = 0;
      for (const m of res.matches) nodes += m.match.nodes.length;
      this.resultLine.textContent = `${objects} objects in ${nodes.toLocaleString()} nodes`;
      this.missingBox.hidden = true;
    }
    this.missingBox.open = false;
    this.actions.hidden = res.objectIds.length === 0;
  }

  private clearResult(message = ''): void {
    this.result = NO_IDS;
    this.missingText = '';
    this.resultLine.textContent = message;
    this.resultLine.hidden = message === '';
    this.missingBox.hidden = true;
    this.actions.hidden = true;
  }

  private copyMissing(): void {
    const clip = this.element.ownerDocument.defaultView?.navigator.clipboard;
    if (!this.missingText || !clip) return;
    clip.writeText(this.missingText).catch(() => {
      // clipboard refused (no permission, insecure context): select the text for a manual copy
      const range = this.element.ownerDocument.createRange();
      range.selectNodeContents(this.missingList);
      const s = this.element.ownerDocument.getSelection();
      s?.removeAllRanges();
      s?.addRange(range);
    });
  }

  /** The colour input as sRGB 0..1. */
  private pickedColor(): [number, number, number] {
    const hex = this.colorInput.value;
    const v = parseInt(hex.slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
}

/** One value per line, trimmed; empty lines dropped. */
function parseList(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const v = line.trim();
    if (v) out.push(v);
  }
  return out;
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

/**
 * Sets plugin: a list of saved property searches ("sets"), each a property key and a list of
 * values (one typed, or a pasted spreadsheet column), matched against every loaded model with
 * `viewer.findObjects`. The panel lists the sets with their object counts; a click selects the
 * objects, icons select, isolate or remove a set, and the values that were not found are listed
 * under it.
 *
 *   const viewer = new Viewer(canvas, { plugins: [setsPlugin()] });
 *   createViewerUi(viewer);                               // toolbar button "Sets" opens the panel
 *   const sets = viewer.getPlugin<SetsPlugin>('sets')!;
 *   const batch = sets.add('Batch', '140');               // or ['140', '141'] or a pasted text
 *   await sets.resolve();                                 // matched against every loaded model
 *   sets.select(batch.id);
 *
 * A set stores its query, not its result: matching runs asynchronously, one set per task, so the
 * list shows at once with pending counts, and runs again when a model is loaded or unloaded.
 * Unlike the status plugin there are no colours; the viewer's scene is untouched until the user
 * selects or isolates.
 */
import type { ViewerApi } from '../../types';
import type { ViewerUi } from '../../ui/ViewerUi';
import { Panel } from '../../ui/Panel';
import { sortedUnion } from '../../metadata/sortedSets';
import type { PluginContext, PluginInstance, ViewerPlugin } from '../types';

export interface SetsPluginOptions {
  /** Plugin name (`viewer.getPlugin(name)`). Default 'sets'. */
  name?: string;
  /** Add the toolbar button and panel to the built-in UI. Default true. */
  ui?: boolean;
  /** Label of the toolbar button and title of the panel. Default 'Sets'. */
  label?: string;
}

/** A saved search: a property key and the values looked up under it. */
export interface PropertySet {
  /** Unique within the plugin, never reused. */
  readonly id: number;
  /** `Batch = 140`, or `Batch in 12 values`. */
  readonly label: string;
  /** The property key the values are matched against (`name` for the hierarchy node names). */
  readonly key: string;
  /** The values, in input order, without (case-insensitive) duplicates. */
  readonly values: readonly string[];
  /** objectIds of the matching nodes and everything below them (sorted, unique); empty until `resolved`. */
  readonly objectIds: Float64Array;
  /** Per value, the number of matching nodes over all models (0 = not found); null until `resolved`. */
  readonly hits: Int32Array | null;
  /** True once the values were matched against the loaded models. */
  readonly resolved: boolean;
}

export interface SetsEvents {
  /** The list changed: a set added, removed or resolved. */
  changed: void;
}

/** The installed plugin's API (`viewer.getPlugin<SetsPlugin>('sets')`). */
export interface SetsPlugin extends PluginInstance {
  /** The sets, in input order. A snapshot: the arrays are copies, the objects are live. */
  readonly sets: readonly PropertySet[];
  /**
   * Adds a set of the values found under `key`: a text (`parseSetValues`: one value per line, or
   * tab / semicolon / comma separated, so a spreadsheet column or row pastes as it is) or a list.
   * Returns the new set, or null when there is no value. Nothing is matched synchronously:
   * `await resolve()` for the counts.
   */
  add(key: string, values: string | readonly (string | number)[]): PropertySet | null;
  /** Removes a set. False when there is none with this id. */
  remove(id: number): boolean;
  /** Removes every set. */
  clear(): void;
  /**
   * Matches every unresolved set against the loaded models (one set per task) and resolves when
   * all are done. `force` re-matches the resolved ones too. Called by `add` and when models
   * change; calling it again while it runs returns the running promise.
   */
  resolve(force?: boolean): Promise<void>;
  /** The objects of a set (sorted, unique; empty for an unknown or unresolved set). */
  objectIdsOf(id: number): Float64Array;
  /** The values of a set that no loaded model has (empty until resolved). */
  missingValuesOf(id: number): string[];
  /**
   * Selects the objects of a set; with `add` they are added to the current selection instead of
   * replacing it (the panel: Shift + click).
   */
  select(id: number, add?: boolean): void;
  /**
   * Shows only the objects of these sets (default: all sets); everything else is hidden
   * (`hideOthers`, default true) or ghosted. `viewer.showAll()` undoes it.
   */
  isolate(ids?: readonly number[], hideOthers?: boolean): void;
  on<K extends keyof SetsEvents>(event: K, handler: (payload: SetsEvents[K]) => void): () => void;
}

const NO_IDS = new Float64Array(0);

/**
 * Splits a pasted text into values: one per line, or tab, semicolon or comma separated (a
 * spreadsheet column or row). Values are trimmed, empty ones dropped, and duplicates (ignoring
 * case) removed, keeping the first spelling.
 */
export function parseSetValues(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\r\n\t;,]+/)) {
    const v = raw.trim();
    if (!v) continue;
    const low = v.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(v);
  }
  return out;
}

/** The label of a set: `Batch = 140`, or `Batch in 12 values`. */
export function setLabel(key: string, values: readonly string[]): string {
  return values.length === 1 ? `${key} = ${values[0]}` : `${key} in ${values.length} values`;
}

interface SetData {
  id: number;
  label: string;
  key: string;
  values: string[];
  objectIds: Float64Array;
  hits: Int32Array | null;
  resolved: boolean;
}

class SetsPluginImpl implements SetsPlugin {
  private readonly viewer: ViewerApi;
  private readonly opts: SetsPluginOptions;
  private readonly data = new Map<number, SetData>();
  private readonly handlers = new Set<() => void>();
  private readonly offModels: () => void;
  private nextId = 1;
  private running: Promise<void> | null = null;
  /** Set while `running`: the loop restarts over every set (models changed). */
  private restart = false;
  private disposed = false;
  private uiCleanup: (() => void) | null = null;

  constructor(context: PluginContext, opts: SetsPluginOptions) {
    this.viewer = context.viewer;
    this.opts = opts;
    const onModels = (): void => {
      for (const s of this.data.values()) this.invalidate(s);
      this.emit();
      void this.resolve();
    };
    const off1 = this.viewer.on('modelLoaded', onModels);
    const off2 = this.viewer.on('modelUnloaded', onModels);
    this.offModels = () => {
      off1();
      off2();
    };
  }

  // --- public API -------------------------------------------------------------------------------

  get sets(): readonly PropertySet[] {
    const out: PropertySet[] = [];
    for (const s of this.data.values()) out.push(this.snapshot(s));
    return out;
  }

  add(key: string, values: string | readonly (string | number)[]): PropertySet | null {
    if (this.disposed) return null;
    key = String(key ?? '').trim();
    const list = typeof values === 'string' ? parseSetValues(values) : parseSetValues(values.map((v) => String(v)).join('\n'));
    if (!key || list.length === 0) return null;
    const set: SetData = { id: this.nextId++, label: setLabel(key, list), key, values: list, objectIds: NO_IDS, hits: null, resolved: false };
    this.data.set(set.id, set);
    this.emit();
    void this.resolve();
    return this.snapshot(set);
  }

  remove(id: number): boolean {
    if (!this.data.delete(id)) return false;
    this.emit();
    return true;
  }

  clear(): void {
    if (this.data.size === 0) return;
    this.data.clear();
    this.emit();
  }

  resolve(force = false): Promise<void> {
    if (force) for (const s of this.data.values()) this.invalidate(s);
    if (this.running) {
      this.restart = true;
      return this.running;
    }
    this.running = this.run();
    return this.running;
  }

  objectIdsOf(id: number): Float64Array {
    return this.data.get(id)?.objectIds ?? NO_IDS;
  }

  missingValuesOf(id: number): string[] {
    const s = this.data.get(id);
    const out: string[] = [];
    if (!s || !s.hits) return out;
    for (let i = 0; i < s.values.length; i++) if (s.hits[i] === 0) out.push(s.values[i]);
    return out;
  }

  select(id: number, add = false): void {
    let ids = this.objectIdsOf(id);
    if (add) {
      const current = Float64Array.from(this.viewer.getSelection()).sort();
      if (current.length > 0) ids = ids.length === 0 ? current : sortedUnion(current, ids);
    }
    this.viewer.select(ids);
  }

  isolate(ids?: readonly number[], hideOthers = true): void {
    let all: Float64Array = NO_IDS;
    const sets = ids ? ids.map((id) => this.data.get(id)).filter((s): s is SetData => !!s) : Array.from(this.data.values());
    for (const s of sets) all = all.length === 0 ? s.objectIds : sortedUnion(all, s.objectIds);
    this.viewer.isolate(all, hideOthers);
  }

  on<K extends keyof SetsEvents>(_event: K, handler: (payload: SetsEvents[K]) => void): () => void {
    const h = handler as () => void;
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }

  // --- plugin hooks -----------------------------------------------------------------------------

  ui(ui: ViewerUi): () => void {
    if (this.opts.ui === false) return () => {};
    const cleanup = createSetsPanel(this, this.viewer, ui, this.opts.label ?? 'Sets');
    const wrapped = (): void => {
      cleanup();
      if (this.uiCleanup === wrapped) this.uiCleanup = null;
    };
    this.uiCleanup = wrapped;
    return wrapped;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.restart = false;
    this.offModels();
    this.uiCleanup?.();
    this.data.clear();
    this.handlers.clear();
  }

  // --- internals --------------------------------------------------------------------------------

  private snapshot(s: SetData): PropertySet {
    return { id: s.id, label: s.label, key: s.key, values: s.values.slice(), objectIds: s.objectIds, hits: s.hits, resolved: s.resolved };
  }

  private invalidate(s: SetData): void {
    s.resolved = false;
    s.objectIds = NO_IDS;
    s.hits = null;
  }

  private emit(): void {
    for (const h of this.handlers) {
      try {
        h();
      } catch (e) {
        console.error('mk-viewer: sets plugin handler failed', e);
      }
    }
  }

  private nextUnresolved(): SetData | null {
    for (const s of this.data.values()) if (!s.resolved) return s;
    return null;
  }

  /** One set per task: the list repaints between sets and a model load is not starved. */
  private async run(): Promise<void> {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    try {
      // always yield first: the list paints before any matching, and the run never finishes
      // synchronously (resolve() assigns `running` after this call returns)
      await tick();
      for (;;) {
        this.restart = false;
        let set = this.nextUnresolved();
        while (set && !this.disposed) {
          if (!set.resolved) {
            // the set may have been removed meanwhile: resolving it anyway is harmless
            const r = this.viewer.findObjects({ key: set.key, in: set.values });
            set.objectIds = r.objectIds;
            set.hits = r.hits;
            set.resolved = true;
            this.emit();
          }
          await tick();
          if (this.restart || this.disposed) break;
          set = this.nextUnresolved();
        }
        if (!this.restart || this.disposed) return;
      }
    } finally {
      this.running = null;
    }
  }
}

// --- the panel -------------------------------------------------------------------------------------

const STYLE_ID = 'mkv-sets-style';
const CSS = `
.mkv-sets-list{display:flex;flex-direction:column;gap:2px}
.mkv-sets-row{display:flex;align-items:center;gap:6px;min-height:28px;padding:0 0 0 4px;cursor:pointer;border-radius:4px;user-select:none;-webkit-user-select:none}
.mkv-sets-row:hover{background:#2d3035}
.mkv-sets-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.mkv-sets-icon{min-width:28px;min-height:28px;padding:0 6px}
.mkv-sets-missing{margin:0 0 4px 22px}
`;

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  doc.head.append(st);
}

const SVG_OPEN = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">';
const TRASH_SVG = SVG_OPEN + '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.5h6.4L12 4M6.5 7v4M9.5 7v4"/></svg>';
const SELECT_SVG = SVG_OPEN + '<path d="M3.5 2.5l9.5 5.5-4.3 1.1-2.2 4.2z"/></svg>';
const ISOLATE_SVG = SVG_OPEN + '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';

function createSetsPanel(plugin: SetsPlugin, viewer: ViewerApi, ui: ViewerUi, label: string): () => void {
  const doc = ui.element.ownerDocument;
  ensureStyles(doc);
  const toggle = ui.addToggle({
    label,
    title: 'Sets: find the objects whose property has one of the given values, and keep the result in a list',
    onClick: () => panel.toggle(),
  });
  const panel = new Panel(ui.element, {
    title: label,
    dock: 'right',
    height: 'auto',
    onToggle: (open) => {
      toggle.on = open;
    },
  });
  const body = panel.body;
  body.classList.add('mkv-pad', 'mkv-propbody');

  // the property key: every key of the loaded models, `name` first
  const keySelect = doc.createElement('select');
  keySelect.className = 'mkv-field mkv-grow';
  keySelect.title = 'Property key the values are looked up under';
  const fillKeys = (): void => {
    const prev = keySelect.value;
    const options: HTMLOptionElement[] = [];
    let hasName = false;
    for (const k of viewer.propertyKeys()) {
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
    keySelect.replaceChildren(...options);
    if (prev && options.some((o) => o.value === prev)) keySelect.value = prev;
    else keySelect.value = 'name';
  };

  const input = doc.createElement('textarea');
  input.className = 'mkv-field';
  input.rows = 4;
  input.spellcheck = false;
  input.placeholder = 'Values: one per line (paste a spreadsheet column), or comma / semicolon separated; Ctrl+Enter adds';
  input.title = 'The values to find under the chosen key; a value that matches a group node matches its whole subtree';

  const message = doc.createElement('div');
  message.className = 'mkv-dim';

  const addSet = (): void => {
    const set = plugin.add(keySelect.value, input.value);
    if (!set) {
      message.textContent = 'Type or paste at least one value';
      return;
    }
    message.textContent = '';
    input.value = '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      addSet();
    }
  });

  const button = (text: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.className = 'mkv-btn mkv-outline';
    b.textContent = text;
    b.title = title;
    b.onclick = onClick;
    return b;
  };
  const actions = doc.createElement('div');
  actions.className = 'mkv-line';
  actions.append(
    button('Add', 'Find the values under the key and add the result as a set', addSet),
    button('Fit', 'Frame the selected objects (click a set to select its objects)', () => {
      const sel = viewer.getSelection();
      if (sel.length === 0) message.textContent = 'Nothing selected: click a set first';
      else {
        message.textContent = '';
        viewer.fitToView(sel, true);
      }
    }),
    button('Clear', 'Remove every set', () => plugin.clear()),
  );

  const list = doc.createElement('div');
  list.className = 'mkv-sets-list';
  const render = (): void => {
    list.replaceChildren();
    const sets = plugin.sets;
    if (sets.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'mkv-dim';
      empty.textContent = 'No sets yet: choose a key, paste values and click Add';
      list.append(empty);
      return;
    }
    const icon = (svg: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement => {
      const b = doc.createElement('button');
      b.className = 'mkv-btn mkv-outline mkv-sets-icon';
      b.innerHTML = svg;
      b.title = title;
      b.onclick = (e) => {
        e.stopPropagation(); // not also the row's select
        onClick(e);
      };
      return b;
    };
    for (const set of sets) {
      const row = doc.createElement('div');
      row.className = 'mkv-sets-row';
      const shown = set.values.slice(0, 20).join(', ') + (set.values.length > 20 ? ', …' : '');
      row.title = `${set.key}: ${shown}\nClick to select the matched objects, Shift + click to add them to the selection`;
      const text = doc.createElement('span');
      text.className = 'mkv-sets-label';
      text.textContent = set.label;
      const count = doc.createElement('span');
      count.className = 'mkv-dim';
      count.textContent = set.resolved ? String(set.objectIds.length) : '…';
      count.title = 'Objects matched by the values of this set';
      const select = icon(SELECT_SVG, 'Select the objects of this set (Shift + click: add them to the selection)', (e) => plugin.select(set.id, e.shiftKey));
      const isolate = icon(ISOLATE_SVG, 'Show only the objects of this set; hide the rest ("Show all" undoes it)', () => plugin.isolate([set.id]));
      const trash = icon(TRASH_SVG, 'Remove this set', () => plugin.remove(set.id));
      row.append(text, count, select, isolate, trash);
      row.onclick = (e) => plugin.select(set.id, e.shiftKey);
      list.append(row);

      const missing = plugin.missingValuesOf(set.id);
      if (missing.length > 0) {
        const box = doc.createElement('details');
        box.className = 'mkv-missing mkv-sets-missing';
        const summary = doc.createElement('summary');
        summary.textContent = `${missing.length} of ${set.values.length} value${set.values.length === 1 ? '' : 's'} not found`;
        const pre = doc.createElement('pre');
        pre.textContent = missing.join('\n');
        box.append(summary, pre);
        list.append(box);
      }
    }
  };

  // in a row, like the Search panel: a bare select would stretch to fill the column
  const keyLine = doc.createElement('div');
  keyLine.className = 'mkv-line';
  keyLine.append(keySelect);
  body.append(keyLine, input, actions, message, list);
  fillKeys();
  render();
  const offs = [plugin.on('changed', render), viewer.on('modelLoaded', fillKeys), viewer.on('modelUnloaded', fillKeys)];
  return () => {
    for (const off of offs) off();
    toggle.remove();
    panel.dispose();
  };
}

/** Creates the sets plugin. */
export function setsPlugin(options: SetsPluginOptions = {}): ViewerPlugin<SetsPlugin> {
  return {
    name: options.name ?? 'sets',
    install(context) {
      return new SetsPluginImpl(context, options);
    },
  };
}

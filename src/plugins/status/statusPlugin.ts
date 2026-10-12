/**
 * Status plugin: a legend of statuses and states built from pasted rows, matched against model
 * item names, with selection and colouring per state.
 *
 *   const viewer = new Viewer(canvas, { plugins: [statusPlugin()] });
 *   createViewerUi(viewer);                               // toolbar button "Status" opens the panel
 *   const status = viewer.getPlugin<StatusPlugin>('status')!;
 *   status.add('304-SP001\tErection\tFab\tyellow\n440-SP003\tErection\tErected\t#00ff00');
 *   await status.resolve();                               // matched against every loaded model
 *   status.select('Erection', 'Fab');
 *   status.applyColors(['Erection']);
 *
 * Input rows are `Tag  Status  State  Colour` (tab, semicolon or comma separated; only the tag is
 * mandatory, see `parseStatusRows`), pasted into the panel or read from `.csv` / `.tsv` / `.txt`
 * files dropped on the viewer or the panel (`addFile`; rows without a status column go under a
 * status named after the file). Tags are matched against hierarchy node names (`viewer.findObjects`
 * with the key `name`, case-insensitive); a tag that matches a group node matches its whole
 * subtree. Rows added later merge into the legend: a new status or state is created, a known one
 * receives the tags (and the last colour given wins). A tag listed under two states belongs to
 * both; when both are coloured, the later one applied wins.
 *
 * Matching runs asynchronously, one state per task, so the legend shows up at once with pending
 * counts; it runs again when a model is loaded or unloaded. Colours are `viewer.setColor`
 * overrides; removing a status (or the plugin) removes the overrides of its objects.
 */
import type { Color, ViewerApi } from '../../types';
import type { ViewerUi } from '../../ui/ViewerUi';
import { Panel } from '../../ui/Panel';
import { sortedUnion } from '../../metadata/sortedSets';
import type { PluginContext, PluginInstance, ViewerPlugin } from '../types';
import {
  DEFAULT_COLOR_NAME,
  STATUS_FILE_EXTENSIONS,
  colorToHex,
  isStatusFile,
  parseColor,
  parseStatusRows,
  statusNameOfFile,
  type ParseStatusOptions,
  type StatusRow,
} from './parse';

export type { ParseStatusOptions, StatusRow } from './parse';
export { STATUS_FILE_EXTENSIONS, isStatusFile } from './parse';

export interface StatusPluginOptions {
  /** Plugin name (`viewer.getPlugin(name)`). Default 'status'. */
  name?: string;
  /** Property key the tags are matched against. Default 'name' (the hierarchy node names). */
  key?: string;
  /** Add the toolbar button and panel to the built-in UI. Default true. */
  ui?: boolean;
  /** Label of the toolbar button and title of the panel. Default 'Status'. */
  label?: string;
}

/** One state of a status: a colour, the tags listed under it and the objects they matched. */
export interface StatusState {
  readonly name: string;
  /** sRGB 0..1. */
  readonly color: Color;
  /** The colour as written in the input (or the default). */
  readonly colorText: string;
  /** The tags listed under this state, in input order, without duplicates. */
  readonly tags: readonly string[];
  /** objectIds matched by the tags (sorted, unique); empty until `resolved`. */
  readonly objectIds: Float64Array;
  /** Per tag, the number of matching nodes (0 = not found); null until `resolved`. */
  readonly hits: Int32Array | null;
  /** True once the tags were matched against the loaded models. */
  readonly resolved: boolean;
}

export interface Status {
  readonly name: string;
  /** Checked in the legend: `applyColors()` without arguments colours the checked statuses. */
  readonly checked: boolean;
  readonly states: readonly StatusState[];
}

/** What `add` reports. */
export interface StatusAddResult {
  /** Rows taken into the legend. */
  rows: number;
  /** Colour texts that could not be parsed; their states got the default colour. */
  invalidColors: string[];
}

export interface StatusEvents {
  /** The legend changed: rows added, a status removed or checked, a state resolved. */
  changed: void;
}

/** The installed plugin's API (`viewer.getPlugin<StatusPlugin>('status')`). */
export interface StatusPlugin extends PluginInstance {
  /** The legend, in input order. A snapshot: the arrays are copies, the objects are live. */
  readonly statuses: readonly Status[];
  /**
   * Adds rows (pasted text or parsed rows) to the legend and schedules the matching. Nothing is
   * matched synchronously: `await resolve()` for the counts. `options.defaultStatus` names the
   * status of text rows without a status column (default `Default`).
   */
  add(input: string | readonly StatusRow[], options?: ParseStatusOptions): StatusAddResult;
  /**
   * Reads a row file (`.csv`, `.tsv` or `.txt`: tab, semicolon or comma separated, an optional
   * `Tag  Status  State  Colour` header) and adds its rows like `add`; rows without a status go
   * under a status named after the file (`Erection.csv` → `Erection`). The panel calls this for
   * files dropped on the viewer or the panel and for the "Open…" button.
   */
  addFile(file: File): Promise<StatusAddResult>;
  /** Removes a status, removing the colour overrides of its objects. False when there is none. */
  remove(status: string): boolean;
  /** Removes every status (and the colour overrides of their objects). */
  clear(): void;
  setChecked(status: string, checked: boolean): void;
  /**
   * Matches every unresolved state against the loaded models (one state per task) and resolves
   * when all are done. `force` re-matches the resolved ones too. Called by `add` and when models
   * change; calling it again while it runs returns the running promise.
   */
  resolve(force?: boolean): Promise<void>;
  /** The objects of one state, or of all states of a status (sorted, unique). */
  objectIdsOf(status: string, state?: string): Float64Array;
  /**
   * Selects the objects of a state or a whole status; with `add` they are added to the current
   * selection instead of replacing it (the panel: Shift + click on a state).
   */
  select(status: string, state?: string, add?: boolean): void;
  /** Colours the objects of every state of these statuses (default: the checked ones). */
  applyColors(statuses?: readonly string[]): void;
  /**
   * Shows only the objects of these statuses (default: the checked ones, i.e. the same objects
   * `applyColors()` colours); everything else is hidden (`hideOthers`, default true) or ghosted.
   * `viewer.showAll()` undoes it.
   */
  isolate(statuses?: readonly string[], hideOthers?: boolean): void;
  /** Removes the colour overrides of these statuses' objects (default: all statuses). */
  resetColors(statuses?: readonly string[]): void;
  on<K extends keyof StatusEvents>(event: K, handler: (payload: StatusEvents[K]) => void): () => void;
}

const NO_IDS = new Float64Array(0);
const STYLE_ID = 'mkv-status-style';
const CSS = `
.mkv-status-legend{display:flex;flex-direction:column;gap:2px}
.mkv-status-head{display:flex;align-items:center;gap:6px;min-height:28px;cursor:pointer;user-select:none;-webkit-user-select:none}
.mkv-status-head:hover{background:#2d3035;border-radius:4px}
.mkv-status-head input{margin:0 0 0 2px}
.mkv-status-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.mkv-status-icon{min-width:28px;min-height:28px;padding:0 6px}
.mkv-status-states{display:flex;flex-direction:column;padding:0 0 4px 22px}
.mkv-status-state{display:flex;align-items:center;gap:8px;min-height:26px;padding:0 6px;cursor:pointer;border-radius:4px;user-select:none;-webkit-user-select:none}
.mkv-status-state:hover{background:#2d3035}
.mkv-status-swatch{flex:0 0 14px;width:14px;height:14px;border-radius:3px;border:1px solid rgba(255,255,255,.35)}
.mkv-status-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

interface StateData {
  name: string;
  color: Color;
  colorText: string;
  tags: string[];
  tagSet: Set<string>;
  objectIds: Float64Array;
  hits: Int32Array | null;
  resolved: boolean;
}

interface StatusData {
  name: string;
  checked: boolean;
  states: Map<string, StateData>;
}

class StatusPluginImpl implements StatusPlugin {
  private readonly viewer: ViewerApi;
  private readonly opts: StatusPluginOptions;
  private readonly data = new Map<string, StatusData>();
  private readonly handlers = new Set<() => void>();
  private readonly offModels: () => void;
  private running: Promise<void> | null = null;
  /** Set while `running`: the loop restarts over every state (models changed). */
  private restart = false;
  private disposed = false;
  private uiCleanup: (() => void) | null = null;

  constructor(context: PluginContext, opts: StatusPluginOptions) {
    this.viewer = context.viewer;
    this.opts = opts;
    const onModels = (): void => {
      for (const s of this.data.values()) for (const st of s.states.values()) this.invalidate(st);
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

  get statuses(): readonly Status[] {
    const out: Status[] = [];
    for (const s of this.data.values()) {
      const states: StatusState[] = [];
      for (const st of s.states.values()) states.push({ ...st, color: st.color.slice() as Color, tags: st.tags.slice() });
      out.push({ name: s.name, checked: s.checked, states });
    }
    return out;
  }

  async addFile(file: File): Promise<StatusAddResult> {
    const text = await file.text();
    if (this.disposed) return { rows: 0, invalidColors: [] };
    return this.add(text, { defaultStatus: statusNameOfFile(file.name) });
  }

  add(input: string | readonly StatusRow[], options?: ParseStatusOptions): StatusAddResult {
    const rows = typeof input === 'string' ? parseStatusRows(input, options) : input;
    const invalidColors: string[] = [];
    let n = 0;
    for (const row of rows) {
      if (!row.tag) continue;
      n++;
      let status = this.data.get(row.status);
      if (!status) {
        status = { name: row.status, checked: false, states: new Map() };
        this.data.set(row.status, status);
      }
      let colorText = row.color || DEFAULT_COLOR_NAME;
      let rgb = row.rgb ?? parseColor(colorText);
      if (!rgb) {
        invalidColors.push(colorText);
        colorText = DEFAULT_COLOR_NAME;
        rgb = parseColor(DEFAULT_COLOR_NAME)!;
      }
      let state = status.states.get(row.state);
      if (!state) {
        state = { name: row.state, color: rgb, colorText, tags: [], tagSet: new Set(), objectIds: NO_IDS, hits: null, resolved: false };
        status.states.set(row.state, state);
      } else if (colorText.toLowerCase() !== DEFAULT_COLOR_NAME.toLowerCase()) {
        // a later row with a colour recolours a known state (an empty colour column does not)
        state.color = rgb;
        state.colorText = colorText;
      }
      const key = row.tag.trim().toLowerCase();
      if (!state.tagSet.has(key)) {
        state.tagSet.add(key);
        state.tags.push(row.tag.trim());
        this.invalidate(state);
      }
    }
    if (n > 0) {
      this.emit();
      void this.resolve();
    }
    return { rows: n, invalidColors };
  }

  remove(name: string): boolean {
    const status = this.data.get(name);
    if (!status) return false;
    this.resetStatus(status);
    this.data.delete(name);
    this.emit();
    return true;
  }

  clear(): void {
    if (this.data.size === 0) return;
    for (const s of this.data.values()) this.resetStatus(s);
    this.data.clear();
    this.emit();
  }

  setChecked(name: string, checked: boolean): void {
    const status = this.data.get(name);
    if (!status || status.checked === checked) return;
    status.checked = checked;
    this.emit();
  }

  resolve(force = false): Promise<void> {
    if (force) for (const s of this.data.values()) for (const st of s.states.values()) this.invalidate(st);
    if (this.running) {
      this.restart = true;
      return this.running;
    }
    this.running = this.run();
    return this.running;
  }

  objectIdsOf(name: string, state?: string): Float64Array {
    const status = this.data.get(name);
    if (!status) return NO_IDS;
    if (state !== undefined) return status.states.get(state)?.objectIds ?? NO_IDS;
    let ids: Float64Array = NO_IDS;
    for (const st of status.states.values()) ids = ids.length === 0 ? st.objectIds : sortedUnion(ids, st.objectIds);
    return ids;
  }

  select(name: string, state?: string, add = false): void {
    let ids = this.objectIdsOf(name, state);
    if (add) {
      const current = Float64Array.from(this.viewer.getSelection()).sort();
      if (current.length > 0) ids = ids.length === 0 ? current : sortedUnion(current, ids);
    }
    this.viewer.select(ids);
  }

  applyColors(names?: readonly string[]): void {
    for (const status of this.pick(names, true)) {
      for (const st of status.states.values()) if (st.objectIds.length > 0) this.viewer.setColor(st.objectIds, st.color);
    }
  }

  isolate(names?: readonly string[], hideOthers = true): void {
    let ids: Float64Array = NO_IDS;
    for (const status of this.pick(names, true)) {
      for (const st of status.states.values()) ids = ids.length === 0 ? st.objectIds : sortedUnion(ids, st.objectIds);
    }
    this.viewer.isolate(ids, hideOthers);
  }

  resetColors(names?: readonly string[]): void {
    for (const status of this.pick(names, false)) this.resetStatus(status);
  }

  on<K extends keyof StatusEvents>(_event: K, handler: (payload: StatusEvents[K]) => void): () => void {
    const h = handler as () => void;
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }

  // --- plugin hooks -----------------------------------------------------------------------------

  ui(ui: ViewerUi): () => void {
    if (this.opts.ui === false) return () => {};
    const cleanup = createStatusPanel(this, this.viewer, ui, this.opts.label ?? 'Status');
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
    for (const s of this.data.values()) this.resetStatus(s);
    this.data.clear();
    this.handlers.clear();
  }

  // --- internals --------------------------------------------------------------------------------

  private pick(names: readonly string[] | undefined, checkedOnly: boolean): StatusData[] {
    const out: StatusData[] = [];
    if (names) {
      for (const n of names) {
        const s = this.data.get(n);
        if (s) out.push(s);
      }
    } else {
      for (const s of this.data.values()) if (!checkedOnly || s.checked) out.push(s);
    }
    return out;
  }

  private resetStatus(status: StatusData): void {
    for (const st of status.states.values()) if (st.objectIds.length > 0) this.viewer.setColor(st.objectIds, null);
  }

  private invalidate(state: StateData): void {
    state.resolved = false;
    state.objectIds = NO_IDS;
    state.hits = null;
  }

  private emit(): void {
    for (const h of this.handlers) {
      try {
        h();
      } catch (e) {
        console.error('mk-viewer: status plugin handler failed', e);
      }
    }
  }

  private nextUnresolved(): StateData | null {
    for (const s of this.data.values()) for (const st of s.states.values()) if (!st.resolved) return st;
    return null;
  }

  /** One state per task: the legend repaints between states and a model load is not starved. */
  private async run(): Promise<void> {
    const key = this.opts.key ?? 'name';
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    try {
      // always yield first: the legend paints before any matching, and the run never finishes
      // synchronously (resolve() assigns  after this call returns)
      await tick();
      for (;;) {
        this.restart = false;
        let state = this.nextUnresolved();
        while (state && !this.disposed) {
          if (!state.resolved) {
            // the state may have been removed meanwhile: resolving it anyway is harmless
            const r = this.viewer.findObjects({ key, in: state.tags });
            state.objectIds = r.objectIds;
            state.hits = r.hits;
            state.resolved = true;
            this.emit();
          }
          await tick();
          if (this.restart || this.disposed) break;
          state = this.nextUnresolved();
        }
        if (!this.restart || this.disposed) return;
      }
    } finally {
      this.running = null;
    }
  }
}

// --- the panel -------------------------------------------------------------------------------------

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  doc.head.append(st);
}

const SVG_OPEN = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">';
const TRASH_SVG = SVG_OPEN + '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.5h6.4L12 4M6.5 7v4M9.5 7v4"/></svg>';
/** A pointer arrow: select the objects of the status. */
const SELECT_SVG = SVG_OPEN + '<path d="M3.5 2.5l9.5 5.5-4.3 1.1-2.2 4.2z"/></svg>';
/** An eye: show only the objects of the status. */
const ISOLATE_SVG = SVG_OPEN + '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';

function createStatusPanel(plugin: StatusPlugin, viewer: ViewerApi, ui: ViewerUi, label: string): () => void {
  const doc = ui.element.ownerDocument;
  ensureStyles(doc);
  const toggle = ui.addToggle({
    label,
    title: 'Status legend: paste rows "Tag, Status, State, Colour" or drop .csv files, match them to the model, select and colour',
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

  const input = doc.createElement('textarea');
  input.className = 'mkv-field';
  input.rows = 5;
  input.placeholder =
    'One row per line, tab separated:\nTag\tStatus\tState\tColour\n304-SP001\tErection\tFab\tyellow\n\nor drop a .csv / .tsv / .txt file here';
  input.title = 'Tag (item name) is mandatory. Status defaults to "Default", State to the tag, Colour to #DDDDDD';

  const message = doc.createElement('div');
  message.className = 'mkv-dim';

  // row files: the "Open…" button, files dropped on the panel, and files dropped on the viewer
  // (claimed from the models panel so they are not loaded as models)
  const fileExts = STATUS_FILE_EXTENSIONS.map((e) => `.${e}`).join(', ');
  const addFiles = (files: Iterable<File>): void => {
    for (const f of files) {
      plugin.addFile(f).then(
        (r) => {
          const bad = r.invalidColors.length > 0 ? `; unknown colour: ${[...new Set(r.invalidColors)].join(', ')} (default used)` : '';
          message.textContent = `${f.name}: ${r.rows} row${r.rows === 1 ? '' : 's'} added${bad}`;
          panel.open();
        },
        (e: { message?: string }) => {
          message.textContent = `${f.name}: ${e?.message ?? e}`;
          panel.open();
        },
      );
    }
  };
  const picker = doc.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.accept = fileExts;
  picker.hidden = true;
  picker.onchange = () => {
    if (picker.files) addFiles(Array.from(picker.files));
    picker.value = '';
  };
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault();
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer?.files.length) return;
    const files = Array.from(e.dataTransfer.files);
    const rows = files.filter((f) => isStatusFile(f.name));
    const other = files.filter((f) => !isStatusFile(f.name));
    if (rows.length > 0) addFiles(rows);
    if (other.length > 0) message.textContent = `Not a row file (${fileExts}): ${other.map((f) => f.name).join(', ')}`;
  };
  body.addEventListener('dragover', onDragOver);
  body.addEventListener('drop', onDrop);
  const offFiles = ui.models.addFileHandler((f) => {
    if (!isStatusFile(f.name)) return false;
    addFiles([f]);
    return true;
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
    button('Add', 'Add the rows above to the legend', () => {
      const r = plugin.add(input.value);
      if (r.rows === 0) message.textContent = 'No rows: the first column (the tag) is mandatory';
      else if (r.invalidColors.length > 0) message.textContent = `Unknown colour: ${[...new Set(r.invalidColors)].join(', ')} (default used)`;
      else message.textContent = '';
      if (r.rows > 0) input.value = '';
    }),
    button('Open…', `Add the rows of ${fileExts} files (also: drop them on the viewer or this panel)`, () => picker.click()),
    button('Colour', 'Colour the objects of every checked status by state', () => {
      if (!plugin.statuses.some((s) => s.checked)) message.textContent = 'Check the statuses to colour first';
      else {
        message.textContent = '';
        plugin.applyColors();
      }
    }),
    button('Isolate', 'Show only the objects of every checked status (the ones "Colour" colours); hide the rest', () => {
      if (!plugin.statuses.some((s) => s.checked)) message.textContent = 'Check the statuses to isolate first';
      else {
        message.textContent = '';
        plugin.isolate();
      }
    }),
    button('Reset', 'Remove the colours of every status', () => plugin.resetColors()),
    button('Fit', 'Frame the selected objects (click a state to select its objects)', () => {
      const sel = viewer.getSelection();
      if (sel.length === 0) message.textContent = 'Nothing selected: click a state first';
      else {
        message.textContent = '';
        viewer.fitToView(sel, true);
      }
    }),
    button('Clear', 'Remove every status', () => plugin.clear()),
  );

  const legend = doc.createElement('div');
  legend.className = 'mkv-status-legend';
  const expanded = new Set<string>();

  const render = (): void => {
    legend.replaceChildren();
    const statuses = plugin.statuses;
    if (statuses.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'mkv-dim';
      empty.textContent = 'No statuses yet';
      legend.append(empty);
      return;
    }
    for (const status of statuses) {
      const open = expanded.has(status.name);
      const head = doc.createElement('div');
      head.className = 'mkv-status-head';
      const check = doc.createElement('input');
      check.type = 'checkbox';
      check.checked = status.checked;
      check.title = 'Include in "Colour"';
      check.onclick = (e) => {
        e.stopPropagation();
        plugin.setChecked(status.name, check.checked);
      };
      const caret = doc.createElement('span');
      caret.className = 'mkv-caret';
      caret.textContent = open ? '▼' : '▶';
      const name = doc.createElement('span');
      name.className = 'mkv-status-name';
      name.textContent = status.name;
      const pending = status.states.some((st) => !st.resolved);
      const count = doc.createElement('span');
      count.className = 'mkv-dim';
      count.textContent = pending ? '…' : String(plugin.objectIdsOf(status.name).length);
      count.title = 'Objects matched by the states of this status';
      // icon buttons; their clicks must not fold / unfold the row
      const icon = (svg: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement => {
        const b = doc.createElement('button');
        b.className = 'mkv-btn mkv-outline mkv-status-icon';
        b.innerHTML = svg;
        b.title = title;
        b.onclick = (e) => {
          e.stopPropagation();
          onClick(e);
        };
        return b;
      };
      const select = icon(SELECT_SVG, 'Select the objects of every state of this status (Shift + click: add them to the selection)', (e) =>
        plugin.select(status.name, undefined, e.shiftKey),
      );
      const isolate = icon(ISOLATE_SVG, 'Show only the objects of every state of this status; hide the rest ("Show all" undoes it)', () =>
        plugin.isolate([status.name]),
      );
      const trash = icon(TRASH_SVG, 'Remove this status (and its colours)', () => plugin.remove(status.name));
      head.append(check, caret, name, count, select, isolate, trash);
      head.onclick = () => {
        if (expanded.has(status.name)) expanded.delete(status.name);
        else expanded.add(status.name);
        render();
      };
      legend.append(head);
      if (!open) continue;

      const states = doc.createElement('div');
      states.className = 'mkv-status-states';
      for (const st of status.states) {
        const row = doc.createElement('div');
        row.className = 'mkv-status-state';
        row.title = `${st.tags.length} tag${st.tags.length === 1 ? '' : 's'}, colour ${st.colorText}. Click to select the matched objects, Shift + click to add them to the selection`;
        const swatch = doc.createElement('span');
        swatch.className = 'mkv-status-swatch';
        swatch.style.background = colorToHex(st.color);
        const text = doc.createElement('span');
        text.className = 'mkv-status-label';
        text.textContent = `${st.name}: ${st.resolved ? st.objectIds.length : '…'}`;
        row.append(swatch, text);
        row.onclick = (e) => plugin.select(status.name, st.name, e.shiftKey);
        states.append(row);
      }
      legend.append(states);
    }
  };

  body.append(input, picker, actions, message, legend);
  render();
  const off = plugin.on('changed', render);
  return () => {
    off();
    offFiles();
    body.removeEventListener('dragover', onDragOver);
    body.removeEventListener('drop', onDrop);
    toggle.remove();
    panel.dispose();
  };
}

/** Creates the status plugin. */
export function statusPlugin(options: StatusPluginOptions = {}): ViewerPlugin<StatusPlugin> {
  return {
    name: options.name ?? 'status',
    install(context) {
      return new StatusPluginImpl(context, options);
    },
  };
}

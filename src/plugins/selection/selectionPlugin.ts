/**
 * Selection plugin: a small panel that manages the selection through the model hierarchy.
 *
 * - **Selection level**: what a click selects. `Object` is the clicked object; other levels are
 *   an ancestor of it: a fixed number of steps up (`up: 1` the parent, `up: Infinity` the node
 *   just below the model root) or the nearest ancestor carrying a property (`key: 'Spool'`),
 *   and the click selects everything under that ancestor. Installed as the viewer's selection
 *   resolver (`viewer.setSelectionResolver`), so Ctrl / Shift + click adds or removes at the same
 *   level and the context menu acts at it too.
 * - **Parent / Child / Leaf / Sibling**: move the current selection through the tree. The selection is
 *   read as its *selected nodes*, which follow where it came from: a click selects its level node
 *   (the spool, at spool level), a tree click the clicked rows, anything else (`viewer.select`,
 *   Search, Sets) the topmost nodes whose subtree is entirely selected (`PropertyIndex.nodesOf`).
 *   Parent selects their parents, Child their children (one level down, a leaf stays),
 *   Leaf the objects under them (their own leaf nodes, from any depth), Sibling all children of
 *   their parents; the nodes an action produced stay the selected nodes until the selection is
 *   changed from elsewhere. The tree is abstract: isos, spools and idents are one example.
 *
 *   const viewer = new Viewer(canvas, {
 *     plugins: [selectionPlugin({ levels: [{ label: 'Object' }, { label: 'Spool', key: 'Spool' }, { label: 'Iso', key: 'Spools' }] })],
 *   });
 *   const sel = viewer.getPlugin<SelectionPlugin>('selection')!;
 *   sel.setLevel(1);          // clicks now select whole spools
 *   sel.parent();             // the selection grows to the parents of its selected nodes
 */
import type { PickResult, ViewerApi } from '../../types';
import type { Model } from '../../loaders/types';
import type { ViewerUi } from '../../ui/ViewerUi';
import { Panel } from '../../ui/Panel';
import type { PluginContext, PluginInstance, ViewerPlugin } from '../types';

/** A selection level: what a click on an object selects. */
export interface SelectionLevel {
  /** Button label. */
  label: string;
  /**
   * Steps up the hierarchy from the clicked object's node: 0 the object itself (default), 1 its
   * parent, `Infinity` the top node (just below the model root). Stops at the top node.
   */
  up?: number;
  /**
   * The nearest ancestor (the node itself included) with an own property of this key; when none
   * has it, the object itself. Wins over `up`.
   */
  key?: string;
}

/** A node of the hierarchy of one model. */
export interface SelectedNode {
  readonly model: Model;
  readonly node: number;
}

export interface SelectionPluginOptions {
  /** Plugin name (`viewer.getPlugin(name)`). Default 'selection'. */
  name?: string;
  /** Add the toolbar button and panel to the built-in UI. Default true. */
  ui?: boolean;
  /** Label of the toolbar button and title of the panel. Default 'Selection'. */
  label?: string;
  /** The selection levels, in button order. Default `DEFAULT_LEVELS` (Object, Parent, Top). */
  levels?: SelectionLevel[];
  /** Index of the initial level. Default 0. */
  level?: number;
}

export interface SelectionEvents {
  /** The level or the selected nodes changed. */
  changed: void;
}

/** The installed plugin's API (`viewer.getPlugin<SelectionPlugin>('selection')`). */
export interface SelectionPlugin extends PluginInstance {
  /** The levels, in button order (copies). */
  readonly levels: readonly SelectionLevel[];
  /** Index of the current level. */
  readonly level: number;
  /** Makes clicks select at this level (an index into `levels`; out of range is ignored). */
  setLevel(index: number): void;
  /** What a click on this object selects at the current level: the objects under its level node. */
  resolve(objectId: number): Float64Array;
  /**
   * The selected nodes: what the selection came from. A click: the clicked object's level node,
   * added to (Ctrl / Shift) or replacing the previous nodes, which stay as long as their objects
   * stay selected; a tree click: the clicked rows; an action: the nodes it produced; anything
   * else (`viewer.select`, Search, Sets, a model change): the topmost nodes whose subtree is
   * entirely selected. Objects under none of these are listed as their own nodes. Objects without
   * a hierarchy node are not listed.
   */
  readonly nodes: readonly SelectedNode[];
  /** Selects the parents of the selected nodes (a top node stays). */
  parent(): void;
  /** Selects the children of the selected nodes, one level down each (a leaf stays). */
  child(): void;
  /** Selects the objects under the selected nodes as their own (leaf) nodes, from any depth. */
  leaf(): void;
  /** Selects all children of the selected nodes' parents (the siblings and the nodes themselves). */
  sibling(): void;
  on<K extends keyof SelectionEvents>(event: K, handler: (payload: SelectionEvents[K]) => void): () => void;
}

export const DEFAULT_LEVELS: readonly SelectionLevel[] = Object.freeze([
  Object.freeze({ label: 'Object', up: 0 }),
  Object.freeze({ label: 'Parent', up: 1 }),
  Object.freeze({ label: 'Top', up: Infinity }),
]);

const NO_IDS = new Float64Array(0);

/** The node of `level` above `node` in `model`'s hierarchy (see `SelectionLevel`). */
export function levelNode(model: Model, node: number, level: SelectionLevel): number {
  const h = model.hierarchy;
  if (level.key !== undefined) {
    for (let n = node; n >= 0; n = h.parent(n)) {
      const props = h.properties(n);
      if (props && Object.prototype.hasOwnProperty.call(props, level.key)) return n;
    }
    return node;
  }
  let n = node;
  for (let steps = level.up ?? 0; steps > 0; steps--) {
    const p = h.parent(n);
    if (p < 0 || h.parent(p) < 0) break; // the top node: just below the root
    n = p;
  }
  return n;
}

class SelectionPluginImpl implements SelectionPlugin {
  private readonly viewer: ViewerApi;
  private readonly opts: SelectionPluginOptions;
  private readonly levelList: readonly SelectionLevel[];
  private levelIndex: number;
  private selectedNodes: SelectedNode[] = [];
  private readonly handlers = new Set<() => void>();
  private readonly offs: (() => void)[];
  /** True while the plugin itself selects: the selection event then keeps its nodes. */
  private selecting = false;
  /** Set by the click resolver until the click's `selection` event (same task): read as a click. */
  private clickPending = false;
  /** The level node the last click resolved to. */
  private lastClick: SelectedNode | null = null;
  private disposed = false;
  private uiCleanup: (() => void) | null = null;

  constructor(context: PluginContext, opts: SelectionPluginOptions) {
    this.viewer = context.viewer;
    this.opts = opts;
    const levels = (opts.levels ?? DEFAULT_LEVELS).map((l, i) => {
      if (!l || typeof l.label !== 'string') throw new TypeError(`selection plugin: levels[${i}] needs a string label`);
      return Object.freeze({ ...l });
    });
    if (levels.length === 0) throw new RangeError('selection plugin: `levels` is empty');
    this.levelList = Object.freeze(levels);
    this.levelIndex = opts.level !== undefined && opts.level >= 0 && opts.level < levels.length ? Math.floor(opts.level) : 0;
    this.viewer.setSelectionResolver((hit: PickResult) => {
      // the click's selection event follows synchronously; a resolve without one (the context
      // menu's target) must not colour the next selection
      const target = this.levelNodeOf(hit.objectId);
      this.lastClick = target;
      this.clickPending = true;
      queueMicrotask(() => {
        if (!this.clickPending || this.disposed) return;
        // no selection event followed: the click resolved to the selection as it was (the viewer
        // skips an identical re-select). Still read it as the click meant
        this.clickPending = false;
        if (this.viewer.getSelection().length === 0) return;
        this.selectedNodes = this.readClick(this.viewer.getSelection());
        this.emit();
      });
      return target ? target.model.properties.objectsUnder(target.node) : Float64Array.of(hit.objectId);
    });
    const onSelection = (ids: number[]): void => {
      if (this.selecting) return;
      this.selectedNodes = this.clickPending ? this.readClick(ids) : this.nodesCovered(ids);
      this.clickPending = false;
      this.emit();
    };
    const onModels = (): void => {
      this.selectedNodes = this.nodesCovered(this.viewer.getSelection());
      this.emit();
    };
    this.offs = [this.viewer.on('selection', onSelection), this.viewer.on('modelLoaded', onModels), this.viewer.on('modelUnloaded', onModels)];
    this.selectedNodes = this.nodesCovered(this.viewer.getSelection());
  }

  // --- public API -------------------------------------------------------------------------------

  get levels(): readonly SelectionLevel[] {
    return this.levelList.map((l) => ({ ...l }));
  }

  get level(): number {
    return this.levelIndex;
  }

  setLevel(index: number): void {
    if (!(index >= 0 && index < this.levelList.length) || index === this.levelIndex) return;
    this.levelIndex = Math.floor(index); // the next click; the selected nodes stay what they are
    this.emit();
  }

  resolve(objectId: number): Float64Array {
    const target = this.levelNodeOf(objectId);
    return target ? target.model.properties.objectsUnder(target.node) : Float64Array.of(objectId);
  }

  get nodes(): readonly SelectedNode[] {
    return this.selectedNodes.slice();
  }

  parent(): void {
    this.applyNodes(
      this.selectedNodes.map(({ model, node }) => {
        const p = model.hierarchy.parent(node);
        return { model, node: p >= 0 ? p : node };
      }),
    );
  }

  child(): void {
    const out: SelectedNode[] = [];
    for (const { model, node } of this.selectedNodes) {
      const ch = model.hierarchy.children(node);
      if (ch.length === 0) out.push({ model, node });
      else for (let i = 0; i < ch.length; i++) out.push({ model, node: ch[i] });
    }
    this.applyNodes(out);
  }

  leaf(): void {
    const out: SelectedNode[] = [];
    for (const { model, node } of this.selectedNodes) {
      const h = model.hierarchy;
      const ids = model.properties.objectsUnder(node);
      if (ids.length === 0) continue; // a group without objects: nothing to select
      for (let i = 0; i < ids.length; i++) {
        const n = h.nodeOfObject(ids[i]);
        if (n >= 0) out.push({ model, node: n });
      }
    }
    this.applyNodes(out);
  }

  sibling(): void {
    const out: SelectedNode[] = [];
    for (const { model, node } of this.selectedNodes) {
      const p = model.hierarchy.parent(node);
      const all = p >= 0 ? model.hierarchy.children(p) : model.hierarchy.roots();
      for (let i = 0; i < all.length; i++) out.push({ model, node: all[i] });
    }
    this.applyNodes(out);
  }

  on<K extends keyof SelectionEvents>(_event: K, handler: (payload: SelectionEvents[K]) => void): () => void {
    const h = handler as () => void;
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }

  // --- plugin hooks -----------------------------------------------------------------------------

  ui(ui: ViewerUi): () => void {
    // the model tree highlights the selected nodes of this plugin (the nodes at the level, or what
    // Parent / Child / Leaf / Sibling produced) instead of its own topmost-covered-node reading, so the
    // parts of a spool selected one by one or with Sibling show as parts, and a spool click as the spool
    ui.hierarchy.setSelectedNodesProvider(() => this.selectedNodes);
    const offChanged = this.on('changed', () => ui.hierarchy.updateSelection());
    // a click in the tree says which rows the user meant
    const offTree = ui.hierarchy.onNodeSelection((nodes) => {
      this.selectedNodes = nodes.map(({ model, node }) => ({ model, node }));
      this.emit();
    });
    const cleanup = this.opts.ui === false ? (): void => {} : createSelectionPanel(this, this.viewer, ui, this.opts.label ?? 'Selection');
    const wrapped = (): void => {
      offChanged();
      offTree();
      ui.hierarchy.setSelectedNodesProvider(null);
      cleanup();
      if (this.uiCleanup === wrapped) this.uiCleanup = null;
    };
    this.uiCleanup = wrapped;
    return wrapped;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    this.viewer.setSelectionResolver(null);
    this.uiCleanup?.();
    this.selectedNodes = [];
    this.handlers.clear();
  }

  // --- internals --------------------------------------------------------------------------------

  /** Selects the objects under these nodes (duplicates dropped) and makes them the selected nodes. */
  private applyNodes(nodes: SelectedNode[]): void {
    if (this.disposed) return;
    const unique: SelectedNode[] = [];
    const seen = new Map<Model, Set<number>>();
    for (const n of nodes) {
      let set = seen.get(n.model);
      if (!set) seen.set(n.model, (set = new Set()));
      if (set.has(n.node)) continue;
      set.add(n.node);
      unique.push(n);
    }
    const parts: Float64Array[] = [];
    let total = 0;
    for (const { model, node } of unique) {
      const ids = model.properties.objectsUnder(node);
      if (ids.length === 0) continue;
      parts.push(ids);
      total += ids.length;
    }
    let ids: Float64Array = NO_IDS;
    if (parts.length === 1) ids = parts[0];
    else if (parts.length > 1) {
      ids = new Float64Array(total);
      let k = 0;
      for (const p of parts) {
        ids.set(p, k);
        k += p.length;
      }
      ids.sort();
      let w = 0;
      for (let i = 0; i < ids.length; i++) if (i === 0 || ids[i] !== ids[i - 1]) ids[w++] = ids[i];
      ids = ids.subarray(0, w);
    }
    this.selectedNodes = unique;
    this.selecting = true;
    try {
      this.viewer.select(ids);
    } finally {
      this.selecting = false;
    }
    this.emit();
  }

  /** The topmost nodes whose subtree is entirely in `ids`, per model (`PropertyIndex.nodesOf`). */
  private nodesCovered(ids: ArrayLike<number>): SelectedNode[] {
    const out: SelectedNode[] = [];
    if (ids.length === 0) return out;
    for (const model of this.viewer.models) {
      const nodes = model.properties.nodesOf(ids);
      for (let i = 0; i < nodes.length; i++) out.push({ model, node: nodes[i] });
    }
    return out;
  }

  /** The current level's node of an object, or null when the object has no hierarchy node. */
  private levelNodeOf(objectId: number): SelectedNode | null {
    const model = this.viewer.getModelOf(objectId);
    const node = model ? model.hierarchy.nodeOfObject(objectId) : -1;
    if (!model || node < 0) return null;
    return { model, node: levelNode(model, node, this.levelList[this.levelIndex]) };
  }

  /**
   * The selected nodes after a click whose selection is `ids`: the previous nodes whose objects
   * are all still selected (but not those under the clicked node, which takes their place), plus
   * the clicked level node when its objects are selected (a Ctrl click that removed them drops
   * it), plus the own nodes of any selected object under none of these.
   */
  private readClick(ids: ArrayLike<number>): SelectedNode[] {
    const selected = new Set<number>();
    for (let i = 0; i < ids.length; i++) selected.add(ids[i]);
    const allSelected = (n: SelectedNode): boolean => {
      const o = n.model.properties.objectsUnder(n.node);
      if (o.length === 0) return false;
      for (let i = 0; i < o.length; i++) if (!selected.has(o[i])) return false;
      return true;
    };
    const click = this.lastClick;
    const under = (n: SelectedNode): boolean => {
      if (!click || n.model !== click.model) return false;
      for (let a = n.node; a >= 0; a = n.model.hierarchy.parent(a)) if (a === click.node) return true;
      return false;
    };
    const out = this.selectedNodes.filter((n) => !under(n) && allSelected(n));
    if (click && allSelected(click) && !out.some((n) => n.model === click.model && n.node === click.node)) out.push(click);
    // selected objects under none of the nodes: their own nodes
    const covered = new Set<number>();
    for (const n of out) for (const id of n.model.properties.objectsUnder(n.node)) covered.add(id);
    if (covered.size < selected.size) {
      const have = new Map<Model, Set<number>>();
      for (const n of out) {
        let set = have.get(n.model);
        if (!set) have.set(n.model, (set = new Set()));
        set.add(n.node);
      }
      for (const id of selected) {
        if (covered.has(id)) continue;
        const model = this.viewer.getModelOf(id);
        const node = model ? model.hierarchy.nodeOfObject(id) : -1;
        if (!model || node < 0) continue;
        let set = have.get(model);
        if (!set) have.set(model, (set = new Set()));
        if (set.has(node)) continue;
        set.add(node);
        out.push({ model, node });
      }
    }
    return out;
  }

  private emit(): void {
    for (const h of this.handlers) {
      try {
        h();
      } catch (e) {
        console.error('mk-viewer: selection plugin handler failed', e);
      }
    }
  }
}

// --- the panel -------------------------------------------------------------------------------------

function createSelectionPanel(plugin: SelectionPlugin, viewer: ViewerApi, ui: ViewerUi, label: string): () => void {
  const doc = ui.element.ownerDocument;
  const toggle = ui.addToggle({
    label,
    title: 'Selection: what a click selects (object, parent, ...) and moving the selection through the tree',
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

  const heading = (text: string): HTMLElement => {
    const el = doc.createElement('div');
    el.className = 'mkv-dim';
    el.textContent = text;
    return el;
  };
  const row = (): HTMLElement => {
    const el = doc.createElement('div');
    el.className = 'mkv-line';
    return el;
  };
  const button = (text: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.className = 'mkv-btn mkv-outline';
    b.textContent = text;
    b.title = title;
    b.onclick = onClick;
    return b;
  };

  // the level: one toggle button per level, the current one lit
  const levelRow = row();
  const levelButtons = plugin.levels.map((l, i) => {
    const what = l.key !== undefined ? `the nearest node above it with a "${l.key}" property` : l.up === 0 || l.up === undefined ? 'the object itself' : l.up === Infinity ? 'its top node (just below the model root)' : `the node ${l.up} level${l.up === 1 ? '' : 's'} above it`;
    const b = button(l.label, `A click on an object selects ${what}`, () => plugin.setLevel(i));
    b.setAttribute('aria-pressed', 'false');
    levelRow.append(b);
    return b;
  });

  // the selected nodes; the arrows tell the actions apart from the level buttons above
  const readout = doc.createElement('div');
  readout.className = 'mkv-dim';
  readout.style.whiteSpace = 'pre-wrap';
  const actions = row();
  const parentButton = button('Parent ↑', 'Select the parents of the selected nodes', () => plugin.parent());
  const childButton = button('Child ↓', 'Select the children of the selected nodes: one level down (the spools of an iso)', () => plugin.child());
  const leafButton = button('Leaf ⇊', 'Select the objects under the selected nodes, as their own nodes (the idents of a spool or an iso)', () => plugin.leaf());
  const siblingButton = button('Sibling ↔', 'Select all children of the selected nodes’ parents (the siblings)', () => plugin.sibling());
  actions.append(parentButton, childButton, leafButton, siblingButton);

  const render = (): void => {
    levelButtons.forEach((b, i) => {
      const on = i === plugin.level;
      b.classList.toggle('mkv-on', on);
      b.classList.toggle('mkv-outline', !on); // the outline background would hide the lit state
      b.setAttribute('aria-pressed', String(on));
    });
    const nodes = plugin.nodes;
    const count = viewer.getSelection().length;
    if (count === 0) readout.textContent = 'Nothing selected';
    else {
      const names = nodes.slice(0, 5).map(({ model, node }) => model.hierarchy.name(node) || `node ${node}`);
      const more = nodes.length > 5 ? `, … (${nodes.length - 5} more)` : '';
      readout.textContent = `${count.toLocaleString()} object${count === 1 ? '' : 's'} in ${nodes.length} node${nodes.length === 1 ? '' : 's'}: ${names.join(', ')}${more}`;
    }
    const none = nodes.length === 0;
    parentButton.disabled = none;
    childButton.disabled = none;
    leafButton.disabled = none;
    siblingButton.disabled = none;
  };

  body.append(heading('Click selects'), levelRow, heading('Selected nodes'), readout, heading('Select'), actions);
  render();
  const offs = [plugin.on('changed', render), viewer.on('selection', render)];
  return () => {
    for (const off of offs) off();
    toggle.remove();
    panel.dispose();
  };
}

/** Creates the selection plugin. */
export function selectionPlugin(options: SelectionPluginOptions = {}): ViewerPlugin<SelectionPlugin> {
  return {
    name: options.name ?? 'selection',
    install(context) {
      return new SelectionPluginImpl(context, options);
    },
  };
}

/**
 * Model tree panel: the original node structure of every loaded model, with a name filter.
 * Clicking a node selects its objects (the node and everything below it) and zooms the camera to
 * them; shift / ctrl + click adds further nodes to the selection (or removes them); selecting
 * objects on the canvas highlights and reveals their nodes. Rows are virtualised, so trees with
 * hundreds of thousands of nodes stay responsive.
 */
import type { ViewerApi } from '../types';
import type { Model } from '../loaders/types';
import { Panel } from './Panel';
import { TreeModel, type TreeSource } from './TreeModel';

const ROW_HEIGHT = 26;
const INDENT = 14;
const FILTER_DELAY_MS = 150;
/** Rows drawn above and below the visible window. */
const OVERSCAN = 6;
const KEY_BASE = 2 ** 32;

function nodeKey(model: number, node: number): number {
  return model * KEY_BASE + node;
}

/** A node of one model's hierarchy. */
export interface HierarchyNodeRef {
  readonly model: Model;
  readonly node: number;
}

/**
 * Decides which nodes the tree highlights for a selection (`HierarchyPanel.setSelectedNodesProvider`).
 * Called with the selected objectIds; returns nodes of any loaded models.
 */
export type SelectedNodesProvider = (objectIds: number[]) => readonly HierarchyNodeRef[];

export class HierarchyPanel {
  readonly tree = new TreeModel();

  private readonly viewer: ViewerApi;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly sources = new Map<Model, TreeSource>();
  private readonly unsubscribe: (() => void)[] = [];
  /** Highlighted nodes, as nodeKey(model index, node). */
  private readonly active = new Set<number>();
  /** When set, what a selection highlights (the selection plugin: the nodes at its level). */
  private nodeProvider: SelectedNodesProvider | null = null;
  /** True while a selection made from the tree is being applied (do not reveal it again). */
  private selecting = false;
  private filterTimer = 0;
  private drawQueued = false;
  private readonly panel: Panel;
  private readonly resizeObserver: ResizeObserver;

  constructor(viewer: ViewerApi, parent: HTMLElement, onToggle?: (open: boolean) => void) {
    this.viewer = viewer;
    const doc = parent.ownerDocument;
    this.panel = new Panel(parent, { title: 'Model tree', dock: 'right', onToggle });

    const search = doc.createElement('div');
    search.className = 'mkv-search';
    this.input = doc.createElement('input');
    this.input.type = 'search';
    this.input.placeholder = 'Filter by node name';
    this.input.spellcheck = false;
    this.input.oninput = () => {
      clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => this.applyFilter(), FILTER_DELAY_MS) as unknown as number;
    };
    this.count = doc.createElement('span');
    this.count.className = 'mkv-count';
    search.append(this.input, this.count);

    this.scroller = doc.createElement('div');
    this.scroller.className = 'mkv-tree';
    this.spacer = doc.createElement('div');
    this.spacer.className = 'mkv-tree-spacer';
    this.scroller.append(this.spacer);
    this.scroller.addEventListener('scroll', () => this.queueDraw(), { passive: true });
    this.scroller.addEventListener('click', (e) => this.onClick(e));

    this.panel.body.append(search, this.scroller);
    // redraw the visible rows whenever the list area changes size (panel opened, canvas resized)
    this.resizeObserver = new ResizeObserver(() => this.queueDraw());
    this.resizeObserver.observe(this.scroller);

    this.unsubscribe.push(
      viewer.on('modelLoaded', () => this.syncModels()),
      viewer.on('modelUnloaded', () => this.syncModels()),
      viewer.on('selection', (ids) => this.onSelection(ids)),
    );
    this.syncModels();
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
   * Lets a plugin decide which nodes a selection highlights: by default the topmost nodes whose
   * subtree is entirely selected (`PropertyIndex.nodesOf`); the selection plugin provides the
   * nodes at its level instead, so a spool selected at spool level and the same parts selected
   * one by one look different. Null restores the default. The current selection is re-read at
   * once; call `updateSelection()` when the provider's answer changes without a selection change.
   */
  setSelectedNodesProvider(provider: SelectedNodesProvider | null): void {
    this.nodeProvider = provider;
    this.updateSelection();
  }

  /** Re-reads the current selection (its highlighted nodes and the revealed row). */
  updateSelection(): void {
    this.onSelection(this.viewer.getSelection());
  }

  dispose(): void {
    clearTimeout(this.filterTimer);
    for (const off of this.unsubscribe) off();
    this.resizeObserver.disconnect();
    this.panel.dispose();
  }

  // ---------------------------------------------------------------------------------------------

  private syncModels(): void {
    const list: TreeSource[] = [];
    for (const m of this.viewer.models) {
      let s = this.sources.get(m);
      if (!s) this.sources.set(m, (s = { name: m.name, hierarchy: m.hierarchy }));
      list.push(s);
    }
    for (const m of this.sources.keys()) if (!this.viewer.models.includes(m)) this.sources.delete(m);
    this.active.clear(); // model indices shift
    this.tree.setSources(list);
    this.updateCount();
    this.queueDraw();
  }

  private applyFilter(): void {
    this.tree.setFilter(this.input.value);
    this.scroller.scrollTop = 0;
    this.updateCount();
    this.draw();
  }

  private updateCount(): void {
    this.count.textContent = this.tree.filterText ? `${this.tree.matchCount.toLocaleString()} found` : '';
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const rowEl = target.closest<HTMLElement>('.mkv-row');
    if (!rowEl) return;
    const row = Number(rowEl.dataset.row);
    const tree = this.tree;
    if (!(row >= 0 && row < tree.rowCount)) return;
    if (target.classList.contains('mkv-caret') || tree.isModelRow(row)) {
      if (tree.hasChildren(row)) {
        tree.toggle(row);
        this.draw();
      }
      if (!tree.isModelRow(row)) return;
    }
    if (tree.isModelRow(row)) {
      // a whole model is framed but not selected: selecting every object would only tint it all
      this.active.clear();
      this.applySelection([]);
      const all = tree.collectObjectIds(row);
      if (all.length > 0) this.viewer.zoomToObjects(all, true);
      this.draw();
      return;
    }
    // shift / ctrl / cmd + click adds the node to the selection, or removes it when already in
    const key = nodeKey(tree.rowModel[row], tree.rowNode[row]);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (!this.active.delete(key)) this.active.add(key);
    } else {
      this.active.clear();
      this.active.add(key);
    }
    // objects of every highlighted node (a node and one of its parents may both be in)
    const ids = new Set<number>();
    for (const k of this.active) {
      for (const id of tree.collectNodeObjectIds(Math.floor(k / KEY_BASE), k % KEY_BASE)) ids.add(id);
    }
    const list = Array.from(ids);
    this.applySelection(list);
    if (list.length > 0) this.viewer.zoomToObjects(list, true);
    this.draw();
  }

  private applySelection(ids: number[]): void {
    this.selecting = true;
    try {
      this.viewer.select(ids);
    } finally {
      this.selecting = false;
    }
  }

  /**
   * Canvas selection: highlight its selected nodes (the provider's, else a group once all its
   * objects are selected and otherwise the objects' own nodes; `PropertyIndex.nodesOf`) and show
   * the one holding the first selected object.
   */
  private onSelection(ids: number[]): void {
    if (this.selecting) return;
    this.active.clear();
    const sources = this.tree.sources;
    const firstModel = ids.length > 0 ? this.viewer.getModelOf(ids[0]) : undefined;
    let revealSource: TreeSource | undefined;
    let revealNode = -1;
    let provided: readonly HierarchyNodeRef[] | null = null;
    if (this.nodeProvider && ids.length > 0) {
      try {
        provided = this.nodeProvider(ids);
      } catch (e) {
        console.error('mk-viewer: error in the selected nodes provider of the model tree', e);
      }
    }
    for (const [model, source] of this.sources) {
      if (ids.length === 0) break;
      let nodes: ArrayLike<number>;
      if (provided) {
        const own: number[] = [];
        for (const r of provided) if (r.model === model) own.push(r.node);
        nodes = own;
      } else nodes = model.properties.nodesOf(ids);
      if (nodes.length === 0) continue;
      const m = sources.indexOf(source);
      for (let i = 0; i < nodes.length; i++) this.active.add(nodeKey(m, nodes[i]));
      if (model === firstModel) {
        // the selected node above (or at) the first object's node
        const h = model.hierarchy;
        const set = new Set(Array.from(nodes));
        for (let n = h.nodeOfObject(ids[0]); n >= 0; n = h.parent(n)) {
          if (set.has(n)) {
            revealSource = source;
            revealNode = n;
            break;
          }
        }
      }
    }
    if (!this.isOpen) return;
    const row = revealSource ? this.tree.revealNode(revealSource, revealNode) : -1;
    if (row < 0) {
      this.draw();
      return;
    }
    const top = row * ROW_HEIGHT;
    const view = this.scroller;
    // revealing added rows: grow the scroll range before scrolling into it
    this.spacer.style.height = `${this.tree.rowCount * ROW_HEIGHT}px`;
    if (top < view.scrollTop || top + ROW_HEIGHT > view.scrollTop + view.clientHeight) {
      view.scrollTop = Math.max(0, top - view.clientHeight / 2);
    }
    this.draw();
  }

  private queueDraw(): void {
    if (this.drawQueued || !this.isOpen) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  private draw(): void {
    if (!this.isOpen) return;
    const tree = this.tree;
    const doc = this.element.ownerDocument;
    const spacer = this.spacer;
    spacer.style.height = `${tree.rowCount * ROW_HEIGHT}px`;
    if (tree.rowCount === 0) {
      const empty = doc.createElement('div');
      empty.className = 'mkv-empty';
      empty.textContent = 'No models loaded';
      spacer.replaceChildren(empty);
      return;
    }
    const first = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(tree.rowCount, Math.ceil((this.scroller.scrollTop + this.scroller.clientHeight) / ROW_HEIGHT) + OVERSCAN);
    const rows: HTMLElement[] = [];
    for (let r = first; r < last; r++) {
      const row = doc.createElement('div');
      let cls = 'mkv-row';
      if (tree.isModelRow(r)) cls += ' mkv-model';
      if (tree.isMatch(r)) cls += ' mkv-match';
      if (!tree.isModelRow(r) && this.active.has(nodeKey(tree.rowModel[r], tree.rowNode[r]))) cls += ' mkv-active';
      row.className = cls;
      row.dataset.row = String(r);
      row.style.top = `${r * ROW_HEIGHT}px`;
      row.style.height = `${ROW_HEIGHT}px`;
      row.style.paddingLeft = `${tree.rowDepth[r] * INDENT}px`;
      const caret = doc.createElement('span');
      caret.className = 'mkv-caret';
      caret.textContent = tree.hasChildren(r) ? (tree.isExpanded(r) ? '▼' : '▶') : '';
      const label = doc.createElement('span');
      label.className = 'mkv-label';
      label.textContent = label.title = tree.label(r);
      row.append(caret, label);
      rows.push(row);
    }
    spacer.replaceChildren(...rows);
  }
}

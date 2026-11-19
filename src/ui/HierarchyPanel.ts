/**
 * Model tree panel: the original node structure of every loaded model, with a name filter.
 * Clicking a node selects its objects (the node and everything below it) and zooms the camera to
 * them; shift / ctrl + click adds further nodes to the selection (or removes them); selecting
 * objects on the canvas highlights and reveals their nodes. Rows are virtualised, so trees with
 * hundreds of thousands of nodes stay responsive.
 *
 * The host can add groups of virtual nodes that belong to no model (`addGroup`), e.g. objects it
 * draws itself; the tree shows and filters them and reports clicks, and the host decides what a
 * click does and which of its nodes are highlighted (`setGroupSelection`).
 *
 * Every top-level row with a show / hide state has an eye button: a model row shows / hides the
 * model (`model.setVisible`) and follows `model.visible` on the viewer's `visibility` event; a group
 * row has one when the group provides `visible` and `setVisible`. Hidden rows are dimmed.
 */
import type { ViewerApi } from '../types';
import type { Model } from '../loaders/types';
import { Panel } from './Panel';
import { TreeModel, type TreeSource, type VirtualTreeClick, type VirtualTreeGroup } from './TreeModel';

const ROW_HEIGHT = 26;
const INDENT = 14;
const FILTER_DELAY_MS = 150;
/** Eye of a shown / hidden row (stroke icons, 16 x 16). */
const EYE_OPEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const EYE_SHUT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 13.5l11-11"/></svg>';
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
  /** Highlighted virtual nodes per group id (set by the host). */
  private readonly groupActive = new Map<string, Set<string>>();
  /** `onChanged` unsubscribers per group id. */
  private readonly groupOffs = new Map<string, () => void>();
  /** When set, what a selection highlights (the selection plugin: the nodes at its level). */
  private nodeProvider: SelectedNodesProvider | null = null;
  /** Told which rows a tree click selected (`onNodeSelection`). */
  private readonly nodeHandlers = new Set<(nodes: readonly HierarchyNodeRef[]) => void>();
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
    this.scroller.addEventListener('dblclick', (e) => this.onDoubleClick(e));

    this.panel.body.append(search, this.scroller);
    // redraw the visible rows whenever the list area changes size (panel opened, canvas resized)
    this.resizeObserver = new ResizeObserver(() => this.queueDraw());
    this.resizeObserver.observe(this.scroller);

    this.unsubscribe.push(
      viewer.on('modelLoaded', () => this.syncModels()),
      viewer.on('modelUnloaded', () => this.syncModels()),
      viewer.on('selection', (ids) => this.onSelection(ids)),
      viewer.on('visibility', () => this.updateVisibility()),
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

  /**
   * Calls `handler` with the rows a click in the tree selected (all highlighted rows after a
   * Shift / Ctrl + click; empty when a model row cleared the selection), right after the viewer's
   * `selection` event. The selection plugin takes them as its selected nodes. Returns the remover.
   */
  onNodeSelection(handler: (nodes: readonly HierarchyNodeRef[]) => void): () => void {
    this.nodeHandlers.add(handler);
    return () => {
      this.nodeHandlers.delete(handler);
    };
  }

  /**
   * Adds a top-level group of host-provided virtual nodes (not part of any model), e.g. objects the
   * host draws itself. It is shown after the loaded models (before them with a negative `order`),
   * also when no model is loaded, and the name filter covers its nodes. A click on a node calls
   * `group.onClick` and leaves the viewer's selection alone. A group with the same id is replaced
   * (keeping its expansion state). Returns a function that removes the group.
   */
  addGroup(group: VirtualTreeGroup): () => void {
    this.groupOffs.get(group.id)?.();
    this.groupOffs.delete(group.id);
    this.tree.addGroup(group);
    if (group.onChanged) {
      try {
        const off = group.onChanged(() => {
          if (this.tree.groupList.includes(group)) this.refreshGroups(group.id);
        });
        if (typeof off === 'function') this.groupOffs.set(group.id, off);
      } catch (e) {
        console.error(`mk-viewer: error in onChanged() of model tree group '${group.id}'`, e);
      }
    }
    this.afterGroupChange();
    return () => {
      // only if this very group is still registered (not replaced by one with the same id)
      if (this.tree.groupList.includes(group)) this.removeGroup(group.id);
    };
  }

  /** Removes the group with this id (and its highlighted nodes); false when there is none. */
  removeGroup(id: string): boolean {
    if (!this.tree.removeGroup(id)) return false;
    this.groupOffs.get(id)?.();
    this.groupOffs.delete(id);
    this.groupActive.delete(id);
    this.afterGroupChange();
    return true;
  }

  /**
   * Re-reads `children()` of the group with this id, or of every group; expansion and highlight
   * state are kept by node id. Groups with `onChanged` refresh themselves.
   */
  refreshGroups(id?: string): void {
    this.tree.refreshGroup(id);
    this.afterGroupChange();
  }

  /**
   * Highlights these nodes of a group (replacing its highlighted nodes; [] clears them), the way
   * the tree highlights the nodes of a canvas selection. With `reveal` (default true) the first
   * node is shown in the open tree: its ancestors are expanded and it is scrolled into view. The
   * viewer's selection and the highlighted model nodes are not touched.
   */
  setGroupSelection(groupId: string, nodeIds: readonly string[], options?: { reveal?: boolean }): void {
    if (nodeIds.length === 0) this.groupActive.delete(groupId);
    else this.groupActive.set(groupId, new Set(nodeIds));
    if (nodeIds.length > 0 && options?.reveal !== false && this.isOpen) {
      const row = this.tree.revealGroupNode(groupId, nodeIds[0]);
      if (row >= 0) {
        this.scrollToRow(row);
        return;
      }
    }
    this.draw();
  }

  /** The highlighted nodes of a group (`setGroupSelection`). */
  getGroupSelection(groupId: string): string[] {
    return Array.from(this.groupActive.get(groupId) ?? []);
  }

  /**
   * Expands the ancestors of a group node and scrolls it into view when the tree is open. False
   * when the node is unknown or hidden by the filter.
   */
  revealGroupNode(groupId: string, nodeId: string): boolean {
    const row = this.tree.revealGroupNode(groupId, nodeId);
    if (row < 0) return false;
    this.scrollToRow(row);
    return true;
  }

  /**
   * Re-reads the show / hide state of every model and group row (their eyes). Runs on the viewer's
   * `visibility` event; groups whose `visible()` changed for another reason signal it through
   * `onChanged` or `refreshGroups`.
   */
  updateVisibility(): void {
    if (this.tree.readVisibility()) this.queueDraw();
  }

  dispose(): void {
    clearTimeout(this.filterTimer);
    for (const off of this.groupOffs.values()) off();
    this.groupOffs.clear();
    for (const off of this.unsubscribe) off();
    this.resizeObserver.disconnect();
    this.panel.dispose();
  }

  // ---------------------------------------------------------------------------------------------

  private syncModels(): void {
    const list: TreeSource[] = [];
    for (const m of this.viewer.models) {
      let s = this.sources.get(m);
      if (!s) {
        s = { name: m.name, hierarchy: m.hierarchy, visible: () => m.visible, setVisible: (on: boolean) => m.setVisible(on) };
        this.sources.set(m, s);
      }
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

  private afterGroupChange(): void {
    this.updateCount();
    this.queueDraw();
  }

  /** Row index of the clicked row element, or -1. */
  private rowOf(e: MouseEvent): number {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.mkv-row');
    const row = rowEl ? Number(rowEl.dataset.row) : -1;
    return row >= 0 && row < this.tree.rowCount ? row : -1;
  }

  /** Runs a host callback of a virtual group, logging what it throws. */
  private callGroup(group: VirtualTreeGroup, what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`mk-viewer: error in ${what} of model tree group '${group.id}'`, err);
    }
  }

  /** Virtual group rows: the caret and the header expand / collapse, the rest goes to the host. */
  private onGroupClick(e: MouseEvent, row: number): void {
    const tree = this.tree;
    const group = tree.groupOf(row);
    if (!group) return;
    const click: VirtualTreeClick = { additive: e.shiftKey || e.ctrlKey || e.metaKey, event: e };
    const header = tree.isModelRow(row);
    if ((e.target as HTMLElement).classList.contains('mkv-caret') || header) {
      if (tree.hasChildren(row)) {
        tree.toggle(row);
        this.draw();
      }
      if (header && group.onHeaderClick) this.callGroup(group, 'onHeaderClick', () => group.onHeaderClick?.(click));
      return;
    }
    const node = tree.groupNode(row);
    if (node && group.onClick) this.callGroup(group, 'onClick', () => group.onClick?.(node, click));
  }

  /** Eye button of a header: show / hide its model or group; nothing else happens. */
  private onEyeClick(e: MouseEvent, row: number): void {
    e.stopPropagation();
    if (this.tree.toggleVisibility(row)) this.draw();
  }

  private isEye(e: MouseEvent): boolean {
    return !!(e.target as HTMLElement).closest('.mkv-eye');
  }

  private onDoubleClick(e: MouseEvent): void {
    const row = this.rowOf(e);
    if (row < 0 || this.isEye(e) || (e.target as HTMLElement).classList.contains('mkv-caret')) return;
    const group = this.tree.groupOf(row);
    const node = this.tree.groupNode(row);
    if (!group || !node || !group.onDoubleClick) return;
    const click: VirtualTreeClick = { additive: e.shiftKey || e.ctrlKey || e.metaKey, event: e };
    this.callGroup(group, 'onDoubleClick', () => group.onDoubleClick?.(node, click));
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const row = this.rowOf(e);
    if (row < 0) return;
    if (this.isEye(e)) {
      this.onEyeClick(e, row);
      return;
    }
    const tree = this.tree;
    if (tree.isGroupRow(row)) {
      this.onGroupClick(e, row);
      return;
    }
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
      if (this.nodeHandlers.size > 0) {
        // the highlighted rows as nodes of their models
        const sources = this.tree.sources;
        const nodes: HierarchyNodeRef[] = [];
        for (const k of this.active) {
          const source = sources[Math.floor(k / KEY_BASE)];
          for (const [model, s] of this.sources) if (s === source) nodes.push({ model, node: k % KEY_BASE });
        }
        for (const h of this.nodeHandlers) {
          try {
            h(nodes);
          } catch (e) {
            console.error('mk-viewer: error in a node selection handler of the model tree', e);
          }
        }
      }
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
    this.scrollToRow(row);
  }

  /** Scrolls `row` into view (centred when it was outside) and draws. */
  private scrollToRow(row: number): void {
    if (!this.isOpen) return;
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
    // rows are redrawn from scratch: keep the keyboard focus on an eye button (Enter / Space)
    const focused = doc.activeElement as HTMLElement | null;
    const focusRow = focused?.classList.contains('mkv-eye') && spacer.contains(focused) ? (focused.closest<HTMLElement>('.mkv-row')?.dataset.row ?? '') : '';
    const rows: HTMLElement[] = [];
    for (let r = first; r < last; r++) {
      const row = doc.createElement('div');
      const group = tree.groupOf(r);
      const vnode = tree.groupNode(r);
      let cls = 'mkv-row';
      if (tree.isModelRow(r)) cls += group ? ' mkv-model mkv-group' : ' mkv-model';
      if (tree.isMatch(r)) cls += ' mkv-match';
      if (!tree.isShown(r)) cls += ' mkv-hidden';
      if (group) {
        if (vnode && this.groupActive.get(group.id)?.has(vnode.id)) cls += ' mkv-active';
      } else if (!tree.isModelRow(r) && this.active.has(nodeKey(tree.rowModel[r], tree.rowNode[r]))) cls += ' mkv-active';
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
      row.append(caret);
      if (group && !vnode && group.icon) {
        const icon = doc.createElement('span');
        icon.className = 'mkv-icon';
        icon.textContent = group.icon;
        row.append(icon);
      }
      row.append(label);
      if (vnode?.badge) {
        const badge = doc.createElement('span');
        badge.className = 'mkv-badge';
        badge.style.background = vnode.badge.color;
        if (vnode.badge.title) badge.title = vnode.badge.title;
        row.append(badge);
      }
      if (tree.hasVisibility(r)) {
        const shown = tree.isShown(r);
        const eye = doc.createElement('button');
        eye.type = 'button';
        eye.className = 'mkv-eye';
        eye.title = shown ? 'Hide' : 'Show';
        eye.setAttribute('aria-label', `${shown ? 'Hide' : 'Show'} ${tree.label(r)}`);
        eye.setAttribute('aria-pressed', String(shown));
        eye.innerHTML = shown ? EYE_OPEN : EYE_SHUT;
        row.append(eye);
      }
      rows.push(row);
    }
    spacer.replaceChildren(...rows);
    if (focusRow) spacer.querySelector<HTMLElement>(`.mkv-row[data-row="${focusRow}"] .mkv-eye`)?.focus({ preventScroll: true });
  }
}

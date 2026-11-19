/**
 * Row model of the hierarchy panel: turns the node trees of the loaded models, plus the host's
 * virtual groups, into the flat list of rows currently visible (expansion state + name filter). No
 * DOM, so it is unit-testable and the panel only has to draw the rows in view.
 *
 * Row r is either a header (`rowNode[r] === MODEL_ROW`) or node `rowNode[r]` below it. For a model
 * `rowModel[r]` is the model's index (>= 0); for a virtual group it is `-1 - groupIndex` and the
 * node is an index into the group's flattened nodes. Model trees can have hundreds of thousands of
 * nodes, so per-node state lives in typed arrays and rows are rebuilt only for what is expanded.
 */
import type { ModelHierarchy } from '../loaders/types';

export const MODEL_ROW = -1;

/**
 * Show / hide state of a top-level row (a model or a virtual group). With both functions the row's
 * header gets an eye button: a click calls `setVisible(!visible())` and re-reads `visible()`.
 */
export interface TreeVisibility {
  /** True while the row's content is shown; read on every refresh and after a click on the eye. */
  visible?(): boolean;
  /** Shows (true) or hides (false) the row's content. */
  setVisible?(on: boolean): void;
}

export interface TreeSource extends TreeVisibility {
  readonly name: string;
  readonly hierarchy: ModelHierarchy;
}

/** A small coloured dot drawn after a virtual node's label (e.g. a red / green status). */
export interface TreeBadge {
  /** Any CSS colour. */
  readonly color: string;
  /** Tooltip of the dot. */
  readonly title?: string;
}

/** A node of a host-provided tree group (`HierarchyPanel.addGroup`); not part of any model. */
export interface VirtualTreeNode {
  /** Unique within its group; expansion and highlight state are kept by id across refreshes. */
  readonly id: string;
  readonly label: string;
  readonly badge?: TreeBadge;
  readonly children?: readonly VirtualTreeNode[];
}

/** How a virtual node or group header was clicked. */
export interface VirtualTreeClick {
  /** Shift / ctrl / cmd was held: add to (or remove from) the host's selection instead of replacing it. */
  readonly additive: boolean;
  readonly event: MouseEvent;
}

/**
 * A top-level group of host-provided nodes in the model tree (`ui.hierarchy.addGroup`), e.g.
 * objects the host draws itself. The tree only shows the nodes and reports clicks; selecting,
 * framing and highlighting (`ui.hierarchy.setGroupSelection`) are up to the host.
 */
export interface VirtualTreeGroup extends TreeVisibility {
  /** Unique among the groups of the tree. */
  readonly id: string;
  /** Header text. */
  readonly label: string;
  /** Short text (e.g. one character or emoji) drawn before the header label. */
  readonly icon?: string;
  /**
   * Position among the groups, ascending (default 0; equal orders keep the order of `addGroup`).
   * Groups with a negative order come before the loaded models, all others after them.
   */
  readonly order?: number;
  /** Header starts collapsed (default false: expanded). */
  readonly collapsed?: boolean;
  /** The group's top-level nodes; read on `addGroup` and on every refresh of the group. */
  children(): readonly VirtualTreeNode[];
  /**
   * Click on a node (not on its caret, which only expands it). The viewer's selection is not
   * changed; select, frame and highlight here as you see fit.
   */
  onClick?(node: VirtualTreeNode, click: VirtualTreeClick): void;
  /** Double click on a node (its two clicks are reported to `onClick` first). */
  onDoubleClick?(node: VirtualTreeNode, click: VirtualTreeClick): void;
  /** Click on the group header, after it has been expanded / collapsed. */
  onHeaderClick?(click: VirtualTreeClick): void;
  /**
   * Subscribes the tree to changes of the host's data: call `listener` whenever `children()` (or
   * `visible()`) would return something else and the group is re-read. Return the unsubscribe
   * function.
   */
  onChanged?(listener: () => void): () => void;
}

function hasToggle(v: TreeVisibility): boolean {
  return typeof v.visible === 'function' && typeof v.setVisible === 'function';
}

/** `visible()` of a row owner: true without a toggle or when it throws (logged). */
function readShown(v: TreeVisibility, id: string): boolean {
  if (!hasToggle(v)) return true;
  try {
    return v.visible?.() !== false;
  } catch (e) {
    console.error(`mk-viewer: error in visible() of model tree row '${id}'`, e);
    return true;
  }
}

/** Per-node filter flags. */
const MATCH = 1; // the node's own name matches
const DESC = 2; // some descendant matches

interface Entry {
  source: TreeSource;
  /** Model header expanded. */
  open: boolean;
  expanded: Uint8Array;
  /** MATCH | DESC per node while a filter is active. */
  flags: Uint8Array | null;
  /** Lower-cased names, built on the first search. */
  lower: string[] | null;
  /** Last read `visible()` (true without one). */
  shown: boolean;
}

/** A virtual group with its nodes flattened to indices (depth first). */
interface GroupEntry {
  group: VirtualTreeGroup;
  /** Insertion sequence (breaks ties of `order`). */
  seq: number;
  /** Header expanded. */
  open: boolean;
  /** Ids of the nodes opened by hand; kept across refreshes. */
  expanded: Set<string>;
  nodes: VirtualTreeNode[];
  parent: Int32Array;
  kids: number[][];
  roots: number[];
  /** Node id -> index (the first node with that id). */
  index: Map<string, number>;
  lower: string[];
  flags: Uint8Array | null;
  /** Last read `visible()` (true without one). */
  shown: boolean;
}

export class TreeModel {
  rowCount = 0;
  rowModel = new Int32Array(256);
  rowNode = new Int32Array(256);
  rowDepth = new Uint16Array(256);
  /** Number of nodes whose name matches the current filter (0 without a filter). */
  matchCount = 0;

  private entries: Entry[] = [];
  private groups: GroupEntry[] = [];
  private groupSeq = 0;
  private filter = '';

  get sources(): readonly TreeSource[] {
    return this.entries.map((e) => e.source);
  }

  /** The virtual groups, in display order. */
  get groupList(): readonly VirtualTreeGroup[] {
    return this.groups.map((g) => g.group);
  }

  get filterText(): string {
    return this.filter;
  }

  /** Replaces the model list, keeping expansion state of models that stay. */
  setSources(sources: readonly TreeSource[]): void {
    const old = this.entries;
    this.entries = sources.map((source) => {
      const kept = old.find((e) => e.source === source);
      if (kept) return kept;
      return { source, open: sources.length === 1, expanded: new Uint8Array(source.hierarchy.nodeCount), flags: null, lower: null, shown: true };
    });
    for (const e of this.entries) e.shown = readShown(e.source, e.source.name);
    this.applyFilter();
  }

  setFilter(text: string): void {
    const f = text.trim().toLowerCase();
    if (f === this.filter) return;
    this.filter = f;
    this.applyFilter();
  }

  /**
   * Adds a virtual group (reading its `children()`), or replaces the group with the same id,
   * keeping its place and expansion state.
   */
  addGroup(group: VirtualTreeGroup): void {
    const i = this.groups.findIndex((g) => g.group.id === group.id);
    const old = i >= 0 ? this.groups[i] : undefined;
    const g: GroupEntry = {
      group,
      seq: old ? old.seq : this.groupSeq++,
      open: old ? old.open : !group.collapsed,
      expanded: old ? old.expanded : new Set(),
      nodes: [],
      parent: new Int32Array(0),
      kids: [],
      roots: [],
      index: new Map(),
      lower: [],
      flags: null,
      shown: true,
    };
    if (i >= 0) this.groups.splice(i, 1);
    this.groups.push(g);
    this.groups.sort((a, b) => (a.group.order ?? 0) - (b.group.order ?? 0) || a.seq - b.seq);
    this.readGroup(g);
    this.applyFilter();
  }

  /** Removes the group with this id; false when there is none. */
  removeGroup(id: string): boolean {
    const i = this.groups.findIndex((g) => g.group.id === id);
    if (i < 0) return false;
    this.groups.splice(i, 1);
    this.applyFilter();
    return true;
  }

  /** Re-reads `children()` of one group, or of every group when no id is given. */
  refreshGroup(id?: string): void {
    for (const g of this.groups) if (id === undefined || g.group.id === id) this.readGroup(g);
    this.applyFilter();
  }

  /**
   * Re-reads `visible()` of every model and group; true when any of them changed. Call it when the
   * visibility changed outside the tree (the panel does on the viewer's `visibility` event).
   */
  readVisibility(): boolean {
    let changed = false;
    for (const e of this.entries) {
      const v = readShown(e.source, e.source.name);
      if (v !== e.shown) changed = true;
      e.shown = v;
    }
    for (const g of this.groups) {
      const v = readShown(g.group, g.group.id);
      if (v !== g.shown) changed = true;
      g.shown = v;
    }
    return changed;
  }

  /** True when the row is a header whose model / group has `visible` and `setVisible` (it gets an eye). */
  hasVisibility(row: number): boolean {
    if (this.rowNode[row] !== MODEL_ROW) return false;
    const owner = this.ownerOf(row);
    return !!owner && hasToggle(owner);
  }

  /**
   * False when the row's model or group is hidden (as last read), for its header and every node
   * row below it; true for rows without visibility.
   */
  isShown(row: number): boolean {
    const m = this.rowModel[row];
    const e = m < 0 ? this.groups[-1 - m] : this.entries[m];
    return e ? e.shown : true;
  }

  /**
   * Eye of a header row: calls `setVisible(!visible())` of its model / group and re-reads it.
   * False (nothing done) for other rows. Errors of the callbacks are logged.
   */
  toggleVisibility(row: number): boolean {
    if (!this.hasVisibility(row)) return false;
    const m = this.rowModel[row];
    const e = m < 0 ? this.groups[-1 - m] : this.entries[m];
    const owner = this.ownerOf(row) as TreeVisibility;
    const id = m < 0 ? (owner as VirtualTreeGroup).id : (owner as TreeSource).name;
    const now = readShown(owner, id);
    try {
      owner.setVisible?.(!now);
    } catch (err) {
      console.error(`mk-viewer: error in setVisible() of model tree row '${id}'`, err);
    }
    e.shown = readShown(owner, id);
    return true;
  }

  /** True for a model header and a virtual group header. */
  isModelRow(row: number): boolean {
    return this.rowNode[row] === MODEL_ROW;
  }

  /** True for the header and the node rows of a virtual group. */
  isGroupRow(row: number): boolean {
    return this.rowModel[row] < 0;
  }

  /** The virtual group of a group row (undefined for model rows). */
  groupOf(row: number): VirtualTreeGroup | undefined {
    const m = this.rowModel[row];
    return m < 0 ? this.groups[-1 - m]?.group : undefined;
  }

  /** The virtual node of a group node row (undefined for headers and model rows). */
  groupNode(row: number): VirtualTreeNode | undefined {
    const m = this.rowModel[row];
    const n = this.rowNode[row];
    return m < 0 && n !== MODEL_ROW ? this.groups[-1 - m]?.nodes[n] : undefined;
  }

  label(row: number): string {
    const m = this.rowModel[row];
    const n = this.rowNode[row];
    if (m < 0) {
      const g = this.groups[-1 - m];
      return n === MODEL_ROW ? g.group.label : g.nodes[n].label;
    }
    const e = this.entries[m];
    return n === MODEL_ROW ? e.source.name : this.nodeName(e, n);
  }

  hasChildren(row: number): boolean {
    const m = this.rowModel[row];
    const n = this.rowNode[row];
    if (m < 0) {
      const g = this.groups[-1 - m];
      return n === MODEL_ROW ? g.roots.length > 0 : g.kids[n].length > 0;
    }
    const e = this.entries[m];
    return n === MODEL_ROW ? e.source.hierarchy.nodeCount > 0 : e.source.hierarchy.children(n).length > 0;
  }

  isExpanded(row: number): boolean {
    const m = this.rowModel[row];
    const n = this.rowNode[row];
    if (m < 0) {
      const g = this.groups[-1 - m];
      if (n === MODEL_ROW) return g.open || this.filter !== '';
      return g.expanded.has(g.nodes[n].id) || (g.flags !== null && (g.flags[n] & DESC) !== 0);
    }
    const e = this.entries[m];
    if (n === MODEL_ROW) return e.open || this.filter !== '';
    return e.expanded[n] === 1 || (e.flags !== null && (e.flags[n] & DESC) !== 0);
  }

  /** True when the node's own name matches the filter. */
  isMatch(row: number): boolean {
    const m = this.rowModel[row];
    const n = this.rowNode[row];
    const flags = m < 0 ? this.groups[-1 - m].flags : this.entries[m].flags;
    return n !== MODEL_ROW && flags !== null && (flags[n] & MATCH) !== 0;
  }

  toggle(row: number): void {
    const m = this.rowModel[row];
    const n = this.rowNode[row];
    if (m < 0) {
      const g = this.groups[-1 - m];
      if (n === MODEL_ROW) g.open = !g.open;
      else {
        const id = g.nodes[n].id;
        if (!g.expanded.delete(id)) g.expanded.add(id);
      }
    } else {
      const e = this.entries[m];
      if (n === MODEL_ROW) e.open = !e.open;
      else e.expanded[n] = e.expanded[n] ? 0 : 1;
    }
    this.rebuild();
  }

  /** objectIds of the row's node and all nodes below it (a model row gives every object, a group row none). */
  collectObjectIds(row: number): number[] {
    return this.collectNodeObjectIds(this.rowModel[row], this.rowNode[row]);
  }

  /** Same by model index and node (MODEL_ROW for the whole model); the node need not be visible. */
  collectNodeObjectIds(model: number, n: number): number[] {
    const e = model >= 0 ? this.entries[model] : undefined;
    if (!e) return [];
    const h = e.source.hierarchy;
    const out: number[] = [];
    const stack: number[] = n === MODEL_ROW ? Array.from(h.roots()) : [n];
    while (stack.length > 0) {
      const node = stack.pop() as number;
      const id = h.objectId(node);
      if (id === id) out.push(id); // not NaN
      const kids = h.children(node);
      for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    return out;
  }

  /**
   * Expands the ancestors of the node carrying `objectId` in `source` and returns its row, or -1
   * when the node is unknown or hidden by the filter.
   */
  reveal(source: TreeSource, objectId: number): number {
    const node = source.hierarchy.nodeOfObject(objectId);
    return node < 0 ? -1 : this.revealNode(source, node);
  }

  /** Expands the ancestors of `node` in `source` and returns its row, or -1 when unknown or filtered out. */
  revealNode(source: TreeSource, node: number): number {
    const m = this.entries.findIndex((e) => e.source === source);
    if (m < 0) return -1;
    const e = this.entries[m];
    const h = e.source.hierarchy;
    if (!(node >= 0 && node < h.nodeCount)) return -1;
    e.open = true;
    for (let p = h.parent(node); p >= 0; p = h.parent(p)) e.expanded[p] = 1;
    this.rebuild();
    return this.findRow(m, node);
  }

  /**
   * Expands the group header and the ancestors of node `nodeId` of group `groupId` and returns its
   * row, or -1 when the group or node is unknown or hidden by the filter.
   */
  revealGroupNode(groupId: string, nodeId: string): number {
    const gi = this.groups.findIndex((g) => g.group.id === groupId);
    if (gi < 0) return -1;
    const g = this.groups[gi];
    const node = g.index.get(nodeId);
    if (node === undefined) return -1;
    g.open = true;
    for (let p = g.parent[node]; p >= 0; p = g.parent[p]) g.expanded.add(g.nodes[p].id);
    this.rebuild();
    return this.findRow(-1 - gi, node);
  }

  // ---------------------------------------------------------------------------------------------

  /** The model source or virtual group of a row. */
  private ownerOf(row: number): TreeVisibility | undefined {
    const m = this.rowModel[row];
    return m < 0 ? this.groups[-1 - m]?.group : this.entries[m]?.source;
  }

  private findRow(model: number, node: number): number {
    for (let r = 0; r < this.rowCount; r++) if (this.rowModel[r] === model && this.rowNode[r] === node) return r;
    return -1;
  }

  private nodeName(e: Entry, n: number): string {
    return e.source.hierarchy.name(n) || `node ${n}`;
  }

  /** Flattens the group's `children()` depth first; a throwing provider leaves the group empty. */
  private readGroup(g: GroupEntry): void {
    let top: readonly VirtualTreeNode[] = [];
    try {
      top = g.group.children() ?? [];
    } catch (e) {
      console.error(`mk-viewer: error in children() of model tree group '${g.group.id}'`, e);
    }
    const nodes: VirtualTreeNode[] = [];
    const parents: number[] = [];
    const kids: number[][] = [];
    const roots: number[] = [];
    const index = new Map<string, number>();
    // explicit stack of (node, parent index) so deep trees cannot overflow the call stack
    const stack: { node: VirtualTreeNode; parent: number }[] = [];
    for (let i = top.length - 1; i >= 0; i--) stack.push({ node: top[i], parent: -1 });
    while (stack.length > 0) {
      const { node, parent } = stack.pop() as { node: VirtualTreeNode; parent: number };
      const n = nodes.length;
      nodes.push(node);
      parents.push(parent);
      kids.push([]);
      if (parent < 0) roots.push(n);
      else kids[parent].push(n);
      if (!index.has(node.id)) index.set(node.id, n);
      const c = node.children ?? [];
      for (let i = c.length - 1; i >= 0; i--) stack.push({ node: c[i], parent: n });
    }
    g.nodes = nodes;
    g.parent = Int32Array.from(parents);
    g.kids = kids;
    g.roots = roots;
    g.index = index;
    g.lower = nodes.map((x) => String(x.label ?? '').toLowerCase());
    g.flags = null;
    g.shown = readShown(g.group, g.group.id);
  }

  private applyFilter(): void {
    const f = this.filter;
    this.matchCount = 0;
    for (const e of this.entries) {
      if (f === '') {
        e.flags = null;
        continue;
      }
      const h = e.source.hierarchy;
      const count = h.nodeCount;
      if (!e.lower) {
        e.lower = new Array<string>(count);
        for (let n = 0; n < count; n++) e.lower[n] = this.nodeName(e, n).toLowerCase();
      }
      const flags = (e.flags = new Uint8Array(count));
      for (let n = 0; n < count; n++) {
        if (!e.lower[n].includes(f)) continue;
        flags[n] |= MATCH;
        this.matchCount++;
        // mark ancestors; stop at the first one already marked
        for (let p = h.parent(n); p >= 0 && (flags[p] & DESC) === 0; p = h.parent(p)) flags[p] |= DESC;
      }
    }
    for (const g of this.groups) {
      if (f === '') {
        g.flags = null;
        continue;
      }
      const flags = (g.flags = new Uint8Array(g.nodes.length));
      for (let n = 0; n < g.nodes.length; n++) {
        if (!g.lower[n].includes(f)) continue;
        flags[n] |= MATCH;
        this.matchCount++;
        for (let p = g.parent[n]; p >= 0 && (flags[p] & DESC) === 0; p = g.parent[p]) flags[p] |= DESC;
      }
    }
    this.rebuild();
  }

  private push(model: number, node: number, depth: number): void {
    if (this.rowCount === this.rowNode.length) {
      const cap = this.rowCount * 2;
      const grow = <T extends Int32Array | Uint16Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(cap);
        b.set(a);
        return b;
      };
      this.rowModel = grow(this.rowModel);
      this.rowNode = grow(this.rowNode);
      this.rowDepth = grow(this.rowDepth);
    }
    this.rowModel[this.rowCount] = model;
    this.rowNode[this.rowCount] = node;
    this.rowDepth[this.rowCount] = depth;
    this.rowCount++;
  }

  private rebuild(): void {
    this.rowCount = 0;
    // groups with a negative order, then the models, then the other groups (this.groups is sorted)
    let gi = 0;
    while (gi < this.groups.length && (this.groups[gi].group.order ?? 0) < 0) this.pushGroup(gi++);
    this.pushModels();
    while (gi < this.groups.length) this.pushGroup(gi++);
  }

  private pushGroup(gi: number): void {
    const g = this.groups[gi];
    const m = -1 - gi;
    const flags = g.flags;
    this.push(m, MODEL_ROW, 0);
    if (!g.open && flags === null) return;
    // the same walk as pushModels
    const stack: number[] = [];
    for (let i = g.roots.length - 1; i >= 0; i--) stack.push(g.roots[i], 1, 0);
    while (stack.length > 0) {
      const forced = stack.pop() as number;
      const depth = stack.pop() as number;
      const n = stack.pop() as number;
      if (flags && flags[n] === 0 && forced === 0) continue;
      this.push(m, n, depth);
      const manual = g.expanded.has(g.nodes[n].id);
      if (!manual && !(flags !== null && (flags[n] & DESC) !== 0)) continue;
      const kids = g.kids[n];
      const force = manual && flags !== null ? 1 : 0;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i], depth + 1, force);
    }
  }

  private pushModels(): void {
    const filtering = this.filter !== '';
    // explicit stack (node, depth, forced) so deep trees cannot overflow the call stack
    const stack: number[] = [];
    for (let m = 0; m < this.entries.length; m++) {
      const e = this.entries[m];
      const h = e.source.hierarchy;
      const flags = e.flags;
      this.push(m, MODEL_ROW, 0);
      if (!e.open && !filtering) continue;
      const roots = h.roots();
      for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i], 1, 0);
      while (stack.length > 0) {
        const forced = stack.pop() as number;
        const depth = stack.pop() as number;
        const n = stack.pop() as number;
        // with a filter only matches and the paths to them are shown, plus whatever the user
        // opened by hand below them
        if (flags && flags[n] === 0 && forced === 0) continue;
        this.push(m, n, depth);
        const manual = e.expanded[n] === 1;
        if (!manual && !(flags !== null && (flags[n] & DESC) !== 0)) continue;
        const kids = h.children(n);
        const force = manual && flags !== null ? 1 : 0;
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i], depth + 1, force);
      }
    }
  }
}

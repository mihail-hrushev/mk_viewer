/**
 * Row model of the hierarchy panel: turns the node trees of the loaded models into the flat list of
 * rows currently visible (expansion state + name filter). No DOM, so it is unit-testable and the
 * panel only has to draw the rows in view.
 *
 * Row r is either a model header (`rowNode[r] === MODEL_ROW`) or node `rowNode[r]` of model
 * `rowModel[r]`. Trees can have hundreds of thousands of nodes, so per-node state lives in typed
 * arrays and rows are rebuilt only for what is expanded.
 */
import type { ModelHierarchy } from '../loaders/types';

export const MODEL_ROW = -1;

export interface TreeSource {
  readonly name: string;
  readonly hierarchy: ModelHierarchy;
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
}

export class TreeModel {
  rowCount = 0;
  rowModel = new Int32Array(256);
  rowNode = new Int32Array(256);
  rowDepth = new Uint16Array(256);
  /** Number of nodes whose name matches the current filter (0 without a filter). */
  matchCount = 0;

  private entries: Entry[] = [];
  private filter = '';

  get sources(): readonly TreeSource[] {
    return this.entries.map((e) => e.source);
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
      return { source, open: sources.length === 1, expanded: new Uint8Array(source.hierarchy.nodeCount), flags: null, lower: null };
    });
    this.applyFilter();
  }

  setFilter(text: string): void {
    const f = text.trim().toLowerCase();
    if (f === this.filter) return;
    this.filter = f;
    this.applyFilter();
  }

  isModelRow(row: number): boolean {
    return this.rowNode[row] === MODEL_ROW;
  }

  label(row: number): string {
    const e = this.entries[this.rowModel[row]];
    const n = this.rowNode[row];
    return n === MODEL_ROW ? e.source.name : this.nodeName(e, n);
  }

  hasChildren(row: number): boolean {
    const e = this.entries[this.rowModel[row]];
    const n = this.rowNode[row];
    return n === MODEL_ROW ? e.source.hierarchy.nodeCount > 0 : e.source.hierarchy.children(n).length > 0;
  }

  isExpanded(row: number): boolean {
    const e = this.entries[this.rowModel[row]];
    const n = this.rowNode[row];
    if (n === MODEL_ROW) return e.open || this.filter !== '';
    return e.expanded[n] === 1 || (e.flags !== null && (e.flags[n] & DESC) !== 0);
  }

  /** True when the node's own name matches the filter. */
  isMatch(row: number): boolean {
    const e = this.entries[this.rowModel[row]];
    const n = this.rowNode[row];
    return n !== MODEL_ROW && e.flags !== null && (e.flags[n] & MATCH) !== 0;
  }

  toggle(row: number): void {
    const e = this.entries[this.rowModel[row]];
    const n = this.rowNode[row];
    if (n === MODEL_ROW) e.open = !e.open;
    else e.expanded[n] = e.expanded[n] ? 0 : 1;
    this.rebuild();
  }

  /** objectIds of the row's node and all nodes below it (a model row gives every object). */
  collectObjectIds(row: number): number[] {
    return this.collectNodeObjectIds(this.rowModel[row], this.rowNode[row]);
  }

  /** Same by model index and node (MODEL_ROW for the whole model); the node need not be visible. */
  collectNodeObjectIds(model: number, n: number): number[] {
    const e = this.entries[model];
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
    const m = this.entries.findIndex((e) => e.source === source);
    if (m < 0) return -1;
    const e = this.entries[m];
    const h = e.source.hierarchy;
    const node = h.nodeOfObject(objectId);
    if (node < 0) return -1;
    e.open = true;
    for (let p = h.parent(node); p >= 0; p = h.parent(p)) e.expanded[p] = 1;
    this.rebuild();
    for (let r = 0; r < this.rowCount; r++) if (this.rowModel[r] === m && this.rowNode[r] === node) return r;
    return -1;
  }

  // ---------------------------------------------------------------------------------------------

  private nodeName(e: Entry, n: number): string {
    return e.source.hierarchy.name(n) || `node ${n}`;
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

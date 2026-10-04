/**
 * Model tree panel: the original node structure of every loaded model, with a name filter.
 * Clicking a node selects its objects (the node and everything below it) and zooms the camera to
 * them; selecting an object on the canvas reveals its node. Rows are virtualised, so trees with
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

export class HierarchyPanel {
  readonly tree = new TreeModel();

  private readonly viewer: ViewerApi;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly sources = new Map<Model, TreeSource>();
  private readonly unsubscribe: (() => void)[] = [];
  private activeModel = -1;
  private activeNode = -1;
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
    this.activeModel = this.activeNode = -1;
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
    this.activeModel = tree.rowModel[row];
    this.activeNode = tree.rowNode[row];
    const ids = tree.collectObjectIds(row);
    if (ids.length > 0) {
      this.selecting = true;
      try {
        // a whole model is framed but not selected: selecting every object would only tint it all
        this.viewer.select(tree.isModelRow(row) ? [] : ids);
      } finally {
        this.selecting = false;
      }
      this.viewer.zoomToObjects(ids, true);
    }
    this.draw();
  }

  /** Canvas selection: show the node of the (first) selected object. */
  private onSelection(ids: number[]): void {
    if (this.selecting || !this.isOpen || ids.length === 0) return;
    const model = this.viewer.getModelOf(ids[0]);
    const source = model && this.sources.get(model);
    if (!source) return;
    const row = this.tree.reveal(source, ids[0]);
    if (row < 0) return;
    this.activeModel = this.tree.rowModel[row];
    this.activeNode = this.tree.rowNode[row];
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
      if (tree.rowModel[r] === this.activeModel && tree.rowNode[r] === this.activeNode) cls += ' mkv-active';
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

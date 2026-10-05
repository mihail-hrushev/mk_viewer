/**
 * The built-in context menu: draws the viewer's context menu requests (`contextMenu` event) over
 * the canvas. The viewer decides when a menu is wanted (a right click that was not a pan, a long
 * press on touch, `openContextMenu`), selects what was right-clicked and collects the items
 * (`viewer.addContextMenuItem`, `PluginContext.addContextMenuItem`); this class only shows them.
 * It closes on a press outside it, Escape, wheel, page scroll, camera movement and canvas resize.
 * A `contextMenu` handler that calls `preventDefault()` keeps it from showing (to draw your own).
 */
import type { ContextMenuRequest, ViewerApi } from '../types';

/**
 * A menu entry in the selection-only form of `ViewerUi.addMenuItem`. For the pointer position and
 * the object under the pointer use `viewer.addContextMenuItem` (`ContextMenuItem`) instead.
 */
export interface MenuItem {
  label: string;
  /** Receives the selection (objectIds) the menu was opened for. */
  onClick: (selection: number[]) => void;
  /** Whether the item is available for this selection. Default: always. */
  enabled?: (selection: number[]) => boolean;
  /** Tooltip. */
  title?: string;
  /** See `ContextMenuItem.order`. Default 0. */
  order?: number;
}

export class ContextMenu {
  readonly element: HTMLElement;
  private readonly viewer: ViewerApi;
  /** Removers of the items added through `addItem` (removed again on dispose). */
  private readonly owned = new Set<() => void>();
  private readonly offs: (() => void)[];
  private disposed = false;

  constructor(viewer: ViewerApi, parent: HTMLElement) {
    this.viewer = viewer;
    const el = (this.element = parent.ownerDocument.createElement('div'));
    el.className = 'mkv-menu';
    el.hidden = true;
    el.setAttribute('role', 'menu');
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    parent.append(el);

    this.offs = [
      viewer.on('contextMenu', (req) => {
        // after all handlers ran, so one registered later can still preventDefault()
        queueMicrotask(() => {
          if (!this.disposed && !req.defaultPrevented && req.items.length > 0) this.show(req);
        });
      }),
      // the camera moved or the canvas was resized: the menu no longer points at its object
      viewer.on('view', this.close),
    ];
    viewer.canvas.addEventListener('wheel', this.close, { passive: true });
    const doc = viewer.canvas.ownerDocument;
    doc.addEventListener('pointerdown', this.onDocPointerDown, true);
    doc.addEventListener('keydown', this.onKeyDown);
    doc.defaultView?.addEventListener('scroll', this.onScroll, true);
    doc.defaultView?.addEventListener('blur', this.close);
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** Adds an item (`viewer.addContextMenuItem` in selection-only form); returns its remover. */
  addItem(item: MenuItem): () => void {
    const enabled = item.enabled;
    const off = this.viewer.addContextMenuItem({
      label: item.label,
      title: item.title,
      order: item.order,
      enabled: enabled ? (c) => enabled(c.selection.slice()) : undefined,
      onClick: (c) => item.onClick(c.selection.slice()),
    });
    const remove = (): void => {
      this.owned.delete(remove);
      off();
    };
    this.owned.add(remove);
    return remove;
  }

  readonly close = (): void => {
    this.element.hidden = true;
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    for (const remove of Array.from(this.owned)) remove();
    this.viewer.canvas.removeEventListener('wheel', this.close);
    const doc = this.viewer.canvas.ownerDocument;
    doc.removeEventListener('pointerdown', this.onDocPointerDown, true);
    doc.removeEventListener('keydown', this.onKeyDown);
    doc.defaultView?.removeEventListener('scroll', this.onScroll, true);
    doc.defaultView?.removeEventListener('blur', this.close);
    this.element.remove();
  }

  // ---------------------------------------------------------------------------------------------

  /** Any press outside the menu closes it (capture phase, so the canvas controls still get it). */
  private readonly onDocPointerDown = (e: PointerEvent): void => {
    if (this.isOpen && !this.element.contains(e.target as Node)) this.close();
  };

  /** Scrolling the page (not the menu itself) moves the canvas away from the menu. */
  private readonly onScroll = (e: Event): void => {
    if (this.isOpen && !this.element.contains(e.target as Node)) this.close();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) {
      this.close();
      e.preventDefault(); // consumed: an active tool does not also see this Escape
    }
  };

  private show(req: ContextMenuRequest): void {
    const el = this.element;
    const doc = el.ownerDocument;
    const rows: HTMLElement[] = [];
    let lastOrder = req.items[0].order;
    for (const entry of req.items) {
      if (entry.order !== lastOrder) {
        const sep = doc.createElement('div');
        sep.className = 'mkv-menu-sep';
        sep.setAttribute('role', 'separator');
        rows.push(sep);
        lastOrder = entry.order;
      }
      const b = doc.createElement('button');
      b.className = 'mkv-menu-item';
      b.setAttribute('role', 'menuitem');
      b.textContent = entry.label;
      if (entry.title) b.title = entry.title;
      b.disabled = !entry.enabled;
      b.onclick = () => {
        this.close();
        entry.run();
      };
      rows.push(b);
    }
    el.replaceChildren(...rows);
    el.hidden = false;
    // keep the menu inside the canvas
    const canvas = this.viewer.canvas;
    el.style.left = `${Math.max(0, Math.min(req.x, canvas.clientWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(0, Math.min(req.y, canvas.clientHeight - el.offsetHeight - 4))}px`;
  }
}

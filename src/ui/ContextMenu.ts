/**
 * Right-click (or long-press) menu on the viewer canvas. A right click that was not a drag opens
 * it; if the object under the cursor is not part of the selection it becomes the selection first,
 * so the menu always acts on what the user pointed at.
 */
import type { ViewerApi } from '../types';

export interface MenuItem {
  label: string;
  /** Receives the selection (objectIds) the menu was opened for. */
  onClick: (selection: number[]) => void;
  /** Whether the item is available for this selection. Default: always. */
  enabled?: (selection: number[]) => boolean;
}

/** A right-button press that moved further than this (CSS px) was a pan, not a menu request. */
const DRAG_SLOP = 5;

export class ContextMenu {
  readonly element: HTMLElement;
  private readonly viewer: ViewerApi;
  private readonly items: MenuItem[] = [];
  private downX = 0;
  private downY = 0;
  private moved = false;
  /** Guards against a slow pick resolving after a newer request or a close. */
  private request = 0;

  constructor(viewer: ViewerApi, parent: HTMLElement) {
    this.viewer = viewer;
    const el = (this.element = parent.ownerDocument.createElement('div'));
    el.className = 'mkv-menu';
    el.hidden = true;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    parent.append(el);

    const canvas = viewer.canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('wheel', this.close, { passive: true });
    const doc = canvas.ownerDocument;
    doc.addEventListener('pointerdown', this.onDocPointerDown, true);
    doc.addEventListener('keydown', this.onKeyDown);
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** Adds an item; returns a function that removes it again. */
  addItem(item: MenuItem): () => void {
    this.items.push(item);
    return () => {
      const i = this.items.indexOf(item);
      if (i >= 0) this.items.splice(i, 1);
    };
  }

  readonly close = (): void => {
    this.request++;
    this.element.hidden = true;
  };

  dispose(): void {
    const canvas = this.viewer.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    canvas.removeEventListener('wheel', this.close);
    const doc = canvas.ownerDocument;
    doc.removeEventListener('pointerdown', this.onDocPointerDown, true);
    doc.removeEventListener('keydown', this.onKeyDown);
    this.element.remove();
  }

  // ---------------------------------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.downX = e.offsetX;
    this.downY = e.offsetY;
    this.moved = false;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.buttons !== 0 && Math.hypot(e.offsetX - this.downX, e.offsetY - this.downY) > DRAG_SLOP) this.moved = true;
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (this.moved) return; // end of a right-button pan
    const x = e.offsetX, y = e.offsetY;
    const request = ++this.request;
    this.viewer.pick(x, y).then(
      (hit) => {
        if (request !== this.request) return;
        let selection = this.viewer.getSelection();
        // while a tool is active, clicks never select (the menu acts on the current selection)
        if (hit && !selection.includes(hit.objectId) && !this.viewer.getTool()) {
          selection = [hit.objectId];
          this.viewer.select(selection);
        }
        this.show(x, y, selection);
      },
      () => undefined,
    );
  };

  /** Any press outside the menu closes it (capture phase, so the canvas controls still get it). */
  private readonly onDocPointerDown = (e: PointerEvent): void => {
    if (this.isOpen && !this.element.contains(e.target as Node)) this.close();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) {
      this.close();
      e.preventDefault(); // consumed: an active tool does not also see this Escape
    }
  };

  private show(x: number, y: number, selection: number[]): void {
    const el = this.element;
    const doc = el.ownerDocument;
    const rows: HTMLElement[] = [];
    for (const item of this.items) {
      const b = doc.createElement('button');
      b.className = 'mkv-menu-item';
      b.textContent = item.label;
      b.disabled = item.enabled ? !item.enabled(selection) : false;
      b.onclick = () => {
        this.close();
        item.onClick(selection);
      };
      rows.push(b);
    }
    el.replaceChildren(...rows);
    el.hidden = false;
    // keep the menu inside the canvas
    const canvas = this.viewer.canvas;
    el.style.left = `${Math.max(0, Math.min(x, canvas.clientWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(0, Math.min(y, canvas.clientHeight - el.offsetHeight - 4))}px`;
  }
}

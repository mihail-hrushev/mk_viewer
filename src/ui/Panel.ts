/**
 * Floating window of the built-in UI (`.mkv-panel`): a header with title and close button, and a
 * body for content. It is moved by dragging the header and always stays inside the canvas overlay.
 */
export interface PanelOptions {
  title: string;
  /** Where the panel sits until the user moves it. Default 'right'. */
  dock?: 'left' | 'right';
  /**
   * 'fill' (default) spans the overlay height; 'auto' is as tall as its content (scrolling when it
   * would not fit).
   */
  height?: 'fill' | 'auto';
  onToggle?: (open: boolean) => void;
}

export class Panel {
  readonly element: HTMLElement;
  /** Content container below the header. */
  readonly body: HTMLElement;

  private readonly autoHeight: boolean;
  private readonly onToggle: ((open: boolean) => void) | undefined;
  private readonly resizeObserver: ResizeObserver;
  /** Pointer dragging the header, or -1. */
  private dragPointer = -1;
  /** Pointer position inside the panel when the drag started. */
  private grabX = 0;
  private grabY = 0;
  /** True once the user has moved the panel (it is then positioned by left/top). */
  private moved = false;

  constructor(parent: HTMLElement, options: PanelOptions) {
    const doc = parent.ownerDocument;
    this.autoHeight = options.height === 'auto';
    this.onToggle = options.onToggle;

    const el = (this.element = doc.createElement('div'));
    el.className = `mkv-panel mkv-dock-${options.dock ?? 'right'}${this.autoHeight ? ' mkv-auto' : ''}`;
    el.hidden = true;

    const head = doc.createElement('div');
    head.className = 'mkv-panel-head';
    head.title = 'Drag to move';
    const title = doc.createElement('span');
    title.textContent = options.title;
    const close = doc.createElement('button');
    close.className = 'mkv-btn';
    close.textContent = '✕';
    close.title = 'Close';
    close.onclick = () => this.close();
    head.append(title, close);
    head.addEventListener('pointerdown', (e) => this.startDrag(e, head));
    head.addEventListener('pointermove', (e) => this.drag(e));
    head.addEventListener('pointerup', (e) => this.endDrag(e, head));
    head.addEventListener('pointercancel', (e) => this.endDrag(e, head));

    this.body = doc.createElement('div');
    this.body.className = 'mkv-panel-body';
    el.append(head, this.body);
    parent.append(el);

    // a moved panel must stay reachable when the canvas shrinks
    this.resizeObserver = new ResizeObserver(() => this.clampPosition());
    this.resizeObserver.observe(parent);
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  open(): void {
    if (this.isOpen) return;
    this.element.hidden = false;
    this.clampPosition();
    this.onToggle?.(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.element.hidden = true;
    this.onToggle?.(false);
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.element.remove();
  }

  // --- moving the panel by its header ------------------------------------------------------------

  private startDrag(e: PointerEvent, head: HTMLElement): void {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const parent = this.element.parentElement;
    if (!parent) return;
    const p = parent.getBoundingClientRect();
    const r = this.element.getBoundingClientRect();
    if (!this.moved) {
      // switch from the default docking to an explicit position
      const s = this.element.style;
      s.left = `${r.left - p.left}px`;
      s.top = `${r.top - p.top}px`;
      if (!this.autoHeight) s.height = `${r.height}px`;
      s.right = s.bottom = 'auto';
      this.moved = true;
    }
    this.dragPointer = e.pointerId;
    this.grabX = e.clientX - r.left;
    this.grabY = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private drag(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointer) return;
    const parent = this.element.parentElement;
    if (!parent) return;
    const p = parent.getBoundingClientRect();
    this.place(e.clientX - this.grabX - p.left, e.clientY - this.grabY - p.top);
  }

  private endDrag(e: PointerEvent, head: HTMLElement): void {
    if (e.pointerId !== this.dragPointer) return;
    this.dragPointer = -1;
    if (head.hasPointerCapture(e.pointerId)) head.releasePointerCapture(e.pointerId);
  }

  /** Positions the panel at (left, top) inside its parent, keeping it fully inside. */
  private place(left: number, top: number): void {
    const parent = this.element.parentElement;
    if (!parent) return;
    const el = this.element;
    const maxLeft = Math.max(0, parent.clientWidth - el.offsetWidth);
    const maxTop = Math.max(0, parent.clientHeight - el.offsetHeight);
    el.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    el.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
  }

  private clampPosition(): void {
    if (!this.moved || !this.isOpen) return;
    const parent = this.element.parentElement;
    if (!parent) return;
    const el = this.element;
    // never taller than the canvas
    if (!this.autoHeight && el.offsetHeight > parent.clientHeight) el.style.height = `${parent.clientHeight}px`;
    this.place(el.offsetLeft, el.offsetTop);
  }
}

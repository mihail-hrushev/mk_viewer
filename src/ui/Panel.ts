/**
 * Floating window of the built-in UI (`.mkv-panel`): a header with title and close button, a body
 * for content and a footer strip whose corner grip resizes the panel. It is moved by dragging the
 * header and always stays inside the canvas overlay.
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
  /** Draw the footer with the resize grip (default true). */
  resizable?: boolean;
  onToggle?: (open: boolean) => void;
}

/** Smallest size the grip can drag a panel to, in CSS pixels. */
const MIN_WIDTH = 180;
const MIN_HEIGHT = 120;

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
  /** Pointer dragging the resize grip, or -1. */
  private sizePointer = -1;
  /** Pointer position and panel size when the resize started. */
  private sizeX = 0;
  private sizeY = 0;
  private sizeW = 0;
  private sizeH = 0;
  /** True once the user has resized the panel (it then has an explicit width and height). */
  private sized = false;

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
    if (options.resizable !== false) {
      const foot = doc.createElement('div');
      foot.className = 'mkv-panel-foot';
      const grip = doc.createElement('div');
      grip.className = 'mkv-panel-grip';
      grip.title = 'Drag to resize';
      grip.addEventListener('pointerdown', (e) => this.startResize(e, grip));
      grip.addEventListener('pointermove', (e) => this.resize(e));
      grip.addEventListener('pointerup', (e) => this.endResize(e, grip));
      grip.addEventListener('pointercancel', (e) => this.endResize(e, grip));
      foot.append(grip);
      el.append(foot);
    }
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
    const r = this.detach(parent);
    this.dragPointer = e.pointerId;
    this.grabX = e.clientX - r.left;
    this.grabY = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  /**
   * Switches the panel from the default docking to an explicit left/top position (the first time
   * it is moved or resized) and returns its rectangle.
   */
  private detach(parent: HTMLElement): DOMRect {
    const r = this.element.getBoundingClientRect();
    if (!this.moved) {
      const p = parent.getBoundingClientRect();
      const s = this.element.style;
      s.left = `${r.left - p.left}px`;
      s.top = `${r.top - p.top}px`;
      if (!this.autoHeight) s.height = `${r.height}px`;
      s.right = s.bottom = 'auto';
      this.moved = true;
    }
    return r;
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
    // never larger than the canvas
    if ((this.sized || !this.autoHeight) && el.offsetHeight > parent.clientHeight) el.style.height = `${parent.clientHeight}px`;
    if (this.sized && el.offsetWidth > parent.clientWidth) el.style.width = `${parent.clientWidth}px`;
    this.place(el.offsetLeft, el.offsetTop);
  }

  // --- resizing the panel by the grip in its footer ----------------------------------------------

  private startResize(e: PointerEvent, grip: HTMLElement): void {
    if (e.button !== 0) return;
    const parent = this.element.parentElement;
    if (!parent) return;
    const r = this.detach(parent);
    const s = this.element.style;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    s.maxHeight = 'none';
    this.sized = true;
    this.sizePointer = e.pointerId;
    this.sizeX = e.clientX;
    this.sizeY = e.clientY;
    this.sizeW = r.width;
    this.sizeH = r.height;
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private resize(e: PointerEvent): void {
    if (e.pointerId !== this.sizePointer) return;
    const parent = this.element.parentElement;
    if (!parent) return;
    const el = this.element;
    const maxW = Math.max(MIN_WIDTH, parent.clientWidth - el.offsetLeft);
    const maxH = Math.max(MIN_HEIGHT, parent.clientHeight - el.offsetTop);
    const w = Math.min(Math.max(MIN_WIDTH, this.sizeW + e.clientX - this.sizeX), maxW);
    const h = Math.min(Math.max(MIN_HEIGHT, this.sizeH + e.clientY - this.sizeY), maxH);
    el.style.width = `${Math.round(w)}px`;
    el.style.height = `${Math.round(h)}px`;
  }

  private endResize(e: PointerEvent, grip: HTMLElement): void {
    if (e.pointerId !== this.sizePointer) return;
    this.sizePointer = -1;
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
  }
}

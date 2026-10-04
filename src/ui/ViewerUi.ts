/**
 * Optional built-in UI drawn over the viewer canvas: a toolbar at the bottom centre and the model
 * tree panel it opens. Plain DOM, no dependencies; the viewer itself works without it.
 *
 *   const ui = createViewerUi(viewer);
 *   ui.addButton({ label: 'Section', title: 'Toggle section plane', onClick: () => ... });
 */
import type { ViewerApi } from '../types';
import { HierarchyPanel } from './HierarchyPanel';
import { ensureStyles } from './styles';

export interface ToolbarButton {
  label: string;
  title?: string;
  /** Called on click; return a boolean to show the button as on / off. */
  onClick: () => boolean | void;
}

export interface ViewerUi {
  /** Overlay covering the canvas (pointer-transparent except for its controls). */
  readonly element: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly hierarchy: HierarchyPanel;
  /** Appends a button to the toolbar and returns it. */
  addButton(button: ToolbarButton): HTMLButtonElement;
  dispose(): void;
}

export function createViewerUi(viewer: ViewerApi): ViewerUi {
  const canvas = viewer.canvas;
  const doc = canvas.ownerDocument;
  ensureStyles(doc);

  const overlay = doc.createElement('div');
  overlay.className = 'mkv-overlay';
  (canvas.parentElement ?? doc.body).append(overlay);

  // the overlay follows the canvas rectangle wherever the page puts it
  const place = (): void => {
    const r = canvas.getBoundingClientRect();
    const s = overlay.style;
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
  };
  place();
  const observer = new ResizeObserver(place);
  observer.observe(canvas);
  const win = doc.defaultView;
  win?.addEventListener('resize', place);
  win?.addEventListener('scroll', place, true);

  const toolbar = doc.createElement('div');
  toolbar.className = 'mkv-toolbar';
  overlay.append(toolbar);

  const addButton = (b: ToolbarButton): HTMLButtonElement => {
    const el = doc.createElement('button');
    el.className = 'mkv-btn';
    el.textContent = b.label;
    if (b.title) el.title = b.title;
    el.onclick = () => {
      const on = b.onClick();
      if (typeof on === 'boolean') el.classList.toggle('mkv-on', on);
    };
    toolbar.append(el);
    return el;
  };

  let treeButton: HTMLButtonElement | null = null;
  const hierarchy = new HierarchyPanel(viewer, overlay, (open) => treeButton?.classList.toggle('mkv-on', open));
  treeButton = addButton({
    label: 'Tree',
    title: 'Model tree: node structure with search',
    onClick: () => {
      hierarchy.toggle();
      return hierarchy.isOpen;
    },
  });
  addButton({ label: 'Fit', title: 'Fit everything in view', onClick: () => viewer.fitToView(undefined, true) });
  addButton({
    label: 'Show all',
    title: 'Clear selection, hiding and isolation',
    onClick: () => {
      viewer.select([]);
      viewer.showAll();
    },
  });

  return {
    element: overlay,
    toolbar,
    hierarchy,
    addButton,
    dispose() {
      observer.disconnect();
      win?.removeEventListener('resize', place);
      win?.removeEventListener('scroll', place, true);
      hierarchy.dispose();
      overlay.remove();
    },
  };
}

/**
 * Optional built-in UI drawn over the viewer canvas: a toolbar at the bottom centre, the movable
 * panels it opens (model tree, models), and a right-click menu. Plain DOM, no dependencies; the viewer itself works without it.
 *
 *   const ui = createViewerUi(viewer);
 *   ui.addButton({ label: 'Section', title: 'Toggle section plane', onClick: () => ... });
 *
 * Viewer plugins contribute through their `ui(ui)` hook (src/plugins/types.ts), which is called here
 * for plugins installed before and after the UI is created.
 */
import type { ViewerApi } from '../types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { HierarchyPanel } from './HierarchyPanel';
import { ModelsPanel } from './ModelsPanel';
import { ensureStyles } from './styles';

export interface ToolbarButton {
  label: string;
  title?: string;
  /** Called on click; return a boolean to show the button as on / off. */
  onClick: () => boolean | void;
}

/** A toolbar button whose on / off look its owner controls (`ViewerUi.addToggle`). */
export interface ToolbarToggle {
  readonly element: HTMLButtonElement;
  /** Shown as on (highlighted). */
  on: boolean;
  /** Removes the button from the toolbar. */
  remove(): void;
}

export interface ViewerUi {
  /** Overlay covering the canvas (pointer-transparent except for its controls). */
  readonly element: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly hierarchy: HierarchyPanel;
  /** Models panel: open files, running loads, per-model show / hide / fit / isolate / unload. */
  readonly models: ModelsPanel;
  /** Right-click menu of the canvas (Hide selected, Hide unselected, Show all). */
  readonly menu: ContextMenu;
  /** Appends a button to the toolbar and returns it. */
  addButton(button: ToolbarButton): HTMLButtonElement;
  /**
   * Appends an on / off button (e.g. a tool) to the toolbar. `onClick` only reports the click; set
   * `toggle.on` to show the state, so it stays right when the state changes elsewhere (Escape, API).
   */
  addToggle(button: { label: string; title?: string; onClick: () => void }): ToolbarToggle;
  /** Appends an item to the right-click menu; returns a function that removes it. */
  addMenuItem(item: MenuItem): () => void;
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
  let modelsButton: HTMLButtonElement | null = null;
  const models = new ModelsPanel(viewer, overlay, (open) => modelsButton?.classList.toggle('mkv-on', open));
  modelsButton = addButton({
    label: 'Models',
    title: 'Open, show / hide and unload models',
    onClick: () => {
      models.toggle();
      return models.isOpen;
    },
  });
  addButton({ label: 'Fit', title: 'Fit everything in view', onClick: () => viewer.fitToView(undefined, true) });
  const addToggle = (b: { label: string; title?: string; onClick: () => void }): ToolbarToggle => {
    const el = addButton({ label: b.label, title: b.title, onClick: () => b.onClick() });
    el.setAttribute('aria-pressed', 'false');
    return {
      element: el,
      get on() {
        return el.classList.contains('mkv-on');
      },
      set on(v: boolean) {
        el.classList.toggle('mkv-on', v);
        el.setAttribute('aria-pressed', String(v));
      },
      remove: () => el.remove(),
    };
  };
  addButton({
    label: 'Show all',
    title: 'Clear selection, hiding and isolation',
    onClick: () => {
      viewer.select([]);
      viewer.showAll();
    },
  });

  const menu = new ContextMenu(viewer, overlay);
  const hasSelection = (sel: number[]): boolean => sel.length > 0;
  menu.addItem({
    label: 'Hide selected',
    enabled: hasSelection,
    onClick: (sel) => {
      viewer.setVisible(sel, false);
      viewer.select([]);
    },
  });
  // hides everything else and keeps the selection, so it can be refined further
  menu.addItem({ label: 'Hide unselected', enabled: hasSelection, onClick: (sel) => viewer.isolate(sel, true) });
  menu.addItem({ label: 'Show all', onClick: () => viewer.showAll() });

  // viewer plugins: those installed already, and any installed later
  const pluginCleanups: (() => void)[] = [];
  const attach = (name: string): void => {
    const inst = viewer.getPlugin(name);
    if (!inst || typeof inst.ui !== 'function') return;
    try {
      const cleanup = inst.ui(ui);
      if (typeof cleanup === 'function') pluginCleanups.push(cleanup);
    } catch (e) {
      console.error(`mk-viewer: error in the ui() hook of viewer plugin '${name}'`, e);
    }
  };
  let offPlugins: (() => void) | null = null;

  const ui: ViewerUi = {
    element: overlay,
    toolbar,
    hierarchy,
    models,
    menu,
    addButton,
    addToggle,
    addMenuItem: (item) => menu.addItem(item),
    dispose() {
      offPlugins?.();
      for (let i = pluginCleanups.length - 1; i >= 0; i--) {
        try {
          pluginCleanups[i]();
        } catch (e) {
          console.error('mk-viewer: error removing a viewer plugin UI', e);
        }
      }
      pluginCleanups.length = 0;
      observer.disconnect();
      win?.removeEventListener('resize', place);
      win?.removeEventListener('scroll', place, true);
      menu.dispose();
      models.dispose();
      hierarchy.dispose();
      overlay.remove();
    },
  };
  for (const name of viewer.plugins) attach(name);
  offPlugins = viewer.on('pluginInstalled', (p) => attach(p.name));
  return ui;
}

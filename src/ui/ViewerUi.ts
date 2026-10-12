/**
 * Optional built-in UI drawn over the viewer canvas: a toolbar at the bottom centre, the movable
 * panels it opens (model tree, models, properties, search, settings), and a right-click menu. Plain DOM, no dependencies; the viewer itself works without it.
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
import { PropertiesPanel } from './PropertiesPanel';
import { SearchPanel } from './SearchPanel';
import { SettingsPanel } from './SettingsPanel';
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
  /** Properties panel: the (inherited) properties of the first selected object. */
  readonly properties: PropertiesPanel;
  /**
   * Search panel: a search over the property index (`viewer.findObjects`) whose result can be
   * selected, isolated, framed or coloured; `ui.search.find(query)` runs one from code.
   */
  readonly search: SearchPanel;
  /**
   * Settings panel: switches for viewer settings (Show edges, Selected x-ray, Ghost hidden);
   * `ui.settings.addToggle(...)` adds rows for your own.
   */
  readonly settings: SettingsPanel;
  /**
   * Draws the canvas context menu (`contextMenu` requests of the viewer) and adds its own entries
   * Hide selected, Hide unselected and Show all (order -100) and Properties (order -90).
   */
  readonly menu: ContextMenu;
  /** Appends a button to the toolbar and returns it. */
  addButton(button: ToolbarButton): HTMLButtonElement;
  /**
   * Appends an on / off button (e.g. a tool) to the toolbar. `onClick` only reports the click; set
   * `toggle.on` to show the state, so it stays right when the state changes elsewhere (Escape, API).
   */
  addToggle(button: { label: string; title?: string; onClick: () => void }): ToolbarToggle;
  /**
   * Adds an item to the context menu that only needs the selection; returns a function that removes
   * it (also removed by `dispose()`). Plugins should prefer `PluginContext.addContextMenuItem`,
   * which works without the built-in UI and gets the pointer position and the object under it.
   */
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
  let propsButton: HTMLButtonElement | null = null;
  const properties = new PropertiesPanel(viewer, overlay, (open) => propsButton?.classList.toggle('mkv-on', open));
  propsButton = addButton({
    label: 'Properties',
    title: 'Properties of the selected object',
    onClick: () => {
      properties.toggle();
      return properties.isOpen;
    },
  });
  let searchButton: HTMLButtonElement | null = null;
  const search = new SearchPanel(viewer, overlay, (open) => searchButton?.classList.toggle('mkv-on', open));
  searchButton = addButton({
    label: 'Search',
    title: 'Find objects by property value',
    onClick: () => {
      search.toggle();
      return search.isOpen;
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
  let settingsButton: HTMLButtonElement | null = null;
  const settings = new SettingsPanel(viewer, overlay, (open) => settingsButton?.classList.toggle('mkv-on', open));
  settingsButton = addButton({
    label: 'Settings',
    title: 'Viewer settings: edges, selected x-ray, ghost hidden',
    onClick: () => {
      settings.toggle();
      return settings.isOpen;
    },
  });

  const menu = new ContextMenu(viewer, overlay);
  const hasSelection = (sel: number[]): boolean => sel.length > 0;
  // built-in entries come first (order -100); plugin entries default to order 0
  menu.addItem({
    label: 'Hide selected',
    order: -100,
    enabled: hasSelection,
    onClick: (sel) => {
      viewer.setVisible(sel, false);
      viewer.select([]);
    },
  });
  // hides everything else and keeps the selection, so it can be refined further
  menu.addItem({ label: 'Hide unselected', order: -100, enabled: hasSelection, onClick: (sel) => viewer.isolate(sel, true) });
  menu.addItem({ label: 'Show all', order: -100, onClick: () => viewer.showAll() });
  // own group (order -90): opens the properties panel for the right-clicked / selected object
  menu.addItem({
    label: 'Properties',
    title: 'Properties of the selected object',
    order: -90,
    enabled: hasSelection,
    onClick: () => properties.open(),
  });

  // viewer plugins: those installed already, and any installed later; a removed plugin's cleanup
  // runs at once
  const pluginCleanups: { name: string; cleanup: () => void }[] = [];
  const runCleanup = (name: string, cleanup: () => void): void => {
    try {
      cleanup();
    } catch (e) {
      console.error(`mk-viewer: error removing the UI of viewer plugin '${name}'`, e);
    }
  };
  const attach = (name: string): void => {
    const inst = viewer.getPlugin(name);
    if (!inst || typeof inst.ui !== 'function') return;
    try {
      const cleanup = inst.ui(ui);
      if (typeof cleanup === 'function') pluginCleanups.push({ name, cleanup });
    } catch (e) {
      console.error(`mk-viewer: error in the ui() hook of viewer plugin '${name}'`, e);
    }
  };
  const detach = (name: string): void => {
    for (let i = pluginCleanups.length - 1; i >= 0; i--) {
      const p = pluginCleanups[i];
      if (p.name !== name) continue;
      pluginCleanups.splice(i, 1);
      runCleanup(name, p.cleanup);
    }
  };
  let offPlugins: (() => void)[] = [];

  const ui: ViewerUi = {
    element: overlay,
    toolbar,
    hierarchy,
    models,
    properties,
    search,
    settings,
    menu,
    addButton,
    addToggle,
    addMenuItem: (item) => menu.addItem(item),
    dispose() {
      for (const off of offPlugins) off();
      offPlugins = [];
      for (const p of pluginCleanups.splice(0).reverse()) runCleanup(p.name, p.cleanup);
      observer.disconnect();
      win?.removeEventListener('resize', place);
      win?.removeEventListener('scroll', place, true);
      menu.dispose();
      settings.dispose();
      search.dispose();
      properties.dispose();
      models.dispose();
      hierarchy.dispose();
      overlay.remove();
    },
  };
  for (const name of viewer.plugins) attach(name);
  offPlugins = [viewer.on('pluginInstalled', (p) => attach(p.name)), viewer.on('pluginRemoved', (p) => detach(p.name))];
  return ui;
}

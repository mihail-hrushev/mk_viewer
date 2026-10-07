/**
 * Settings panel: on / off switches for viewer settings. Built in: "Show edges" (`viewer.setEdges`)
 * and "Selected x-ray" (`viewer.setSelectionXray`); a switch turned off and on again keeps the
 * options the setting had. `addToggle` adds a row for a setting of your own (viewer plugins: in
 * their `ui(ui)` hook). Every row re-reads its state when the panel opens and after any switch is
 * used, so settings changed from code show right; `refresh()` does it on demand.
 */
import type { EdgeOptions, SelectionXrayOptions, ViewerApi } from '../types';
import { Panel } from './Panel';

/** A row of the settings panel: a label and a switch bound to a boolean setting. */
export interface SettingsToggle {
  label: string;
  /** Tooltip of the row. */
  title?: string;
  /** The current state of the setting. */
  get: () => boolean;
  /** Switches the setting. */
  set: (on: boolean) => void;
}

interface Row {
  toggle: SettingsToggle;
  element: HTMLElement;
  input: HTMLInputElement;
}

export class SettingsPanel {
  private readonly panel: Panel;
  private readonly list: HTMLElement;
  private readonly rows: Row[] = [];

  constructor(viewer: ViewerApi, parent: HTMLElement, onToggle?: (open: boolean) => void) {
    const doc = parent.ownerDocument;
    this.panel = new Panel(parent, {
      title: 'Settings',
      dock: 'right',
      height: 'auto',
      resizable: false,
      onToggle: (open) => {
        if (open) this.refresh();
        onToggle?.(open);
      },
    });
    this.list = doc.createElement('div');
    this.list.className = 'mkv-settings';
    this.panel.body.classList.add('mkv-pad');
    this.panel.body.append(this.list);

    // the options a setting had when it was switched off come back when it is switched on
    let edges: EdgeOptions = {};
    this.addToggle({
      label: 'Show edges',
      title: 'Dark lines along creases, silhouettes and mesh boundaries',
      get: () => viewer.getEdges() !== null,
      set: (on) => {
        if (!on) edges = viewer.getEdges() ?? edges;
        viewer.setEdges(on, edges);
      },
    });
    let xray: SelectionXrayOptions = {};
    this.addToggle({
      label: 'Selected x-ray',
      title: 'Draw the borders of the selected objects on top of everything, through what is in front of them',
      get: () => viewer.getSelectionXray() !== null,
      set: (on) => {
        if (!on) xray = viewer.getSelectionXray() ?? xray;
        viewer.setSelectionXray(on, xray);
      },
    });
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

  /** Adds a switch row; returns a function that removes it. */
  addToggle(toggle: SettingsToggle): () => void {
    const doc = this.list.ownerDocument;
    const element = doc.createElement('label');
    element.className = 'mkv-switch';
    if (toggle.title) element.title = toggle.title;
    const text = doc.createElement('span');
    text.className = 'mkv-grow';
    text.textContent = toggle.label;
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.checked = toggle.get();
    input.onchange = () => {
      try {
        toggle.set(input.checked);
      } finally {
        this.refresh(); // one setting may change another, and a rejected change shows its real state
      }
    };
    element.append(text, input);
    this.list.append(element);
    const row: Row = { toggle, element, input };
    this.rows.push(row);
    return () => {
      const i = this.rows.indexOf(row);
      if (i < 0) return;
      this.rows.splice(i, 1);
      element.remove();
    };
  }

  /** Re-reads the state of every row. */
  refresh(): void {
    for (const r of this.rows) {
      const on = r.toggle.get();
      r.input.checked = on;
      r.input.setAttribute('aria-checked', String(on));
    }
  }

  dispose(): void {
    this.rows.length = 0;
    this.panel.dispose();
  }
}

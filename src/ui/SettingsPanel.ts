/**
 * Settings panel: rows of viewer settings. Built in: the switches "Show edges" (`viewer.setEdges`),
 * "Selected x-ray" (`viewer.setSelectionXray`) and "Ghost hidden" (`viewer.setGhostHidden`), and
 * the "X-ray colour" swatches (Default plus the default colour set) that pick the colour of the
 * selection x-ray lines; a switch turned off and on again keeps the options the setting had,
 * including the chosen colour. `addToggle` adds a switch row and `addColors` a row of colour
 * swatches for a setting of your own (viewer plugins: in their `ui(ui)` hook). Every row re-reads
 * its state when the panel opens and after any switch or swatch is used, so settings changed from
 * code show right; `refresh()` does it on demand.
 */
import type { Color, EdgeOptions, SelectionXrayOptions, ViewerApi } from '../types';
import { DEFAULT_COLORS, type NamedColor } from '../colors';
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

/** A row of the settings panel: a label and colour swatches bound to a colour setting. */
export interface SettingsColors {
  label: string;
  /** Tooltip of the row. */
  title?: string;
  /** The swatches, in this order. */
  colors: readonly NamedColor[];
  /** The current colour, or null when none is marked. */
  get: () => Color | null;
  /** Picks a colour. */
  set: (color: Color) => void;
}

interface Row {
  /** The row's elements in the list, removed together. */
  elements: HTMLElement[];
  /** Re-reads the state of the setting into the row. */
  refresh: () => void;
}

const sameRgb = (a: Color | null, b: Color): boolean =>
  a !== null && Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3;

const cssRgb = (c: Color): string => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;

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
    // the x-ray's default colour first, so the user can get back to it; shares `xray` with the switch
    this.addColors({
      label: 'X-ray colour',
      title: 'Colour of the selected x-ray lines',
      colors: [{ label: 'Default', color: [1, 0.62, 0.1] }, ...DEFAULT_COLORS],
      get: () => viewer.getSelectionXray()?.color ?? null,
      set: (color) => {
        const cur = viewer.getSelectionXray() ?? xray;
        xray = { ...cur, color };
        viewer.setSelectionXray(true, xray);
      },
    });
    this.addToggle({
      label: 'Ghost hidden',
      title: 'Show hidden objects faintly, like ghosted ones, instead of not at all',
      get: () => viewer.getGhostHidden(),
      set: (on) => viewer.setGhostHidden(on),
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
    return this.addRow({
      elements: [element],
      refresh: () => {
        const on = toggle.get();
        input.checked = on;
        input.setAttribute('aria-checked', String(on));
      },
    });
  }

  /** Adds a row of colour swatches (the one equal to `get()` is marked); returns a function that removes it. */
  addColors(row: SettingsColors): () => void {
    const doc = this.list.ownerDocument;
    const element = doc.createElement('div');
    element.className = 'mkv-switch mkv-colors-label';
    if (row.title) element.title = row.title;
    const text = doc.createElement('span');
    text.className = 'mkv-grow';
    text.textContent = row.label;
    element.append(text);
    const swatches = doc.createElement('div');
    swatches.className = 'mkv-colors';
    const buttons: { button: HTMLButtonElement; color: Color }[] = [];
    for (const c of row.colors) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'mkv-color';
      button.title = c.label;
      button.setAttribute('aria-label', c.label);
      button.style.background = cssRgb(c.color);
      button.onclick = () => {
        try {
          row.set(c.color);
        } finally {
          this.refresh(); // one setting may change another, and a rejected change shows its real state
        }
      };
      swatches.append(button);
      buttons.push({ button, color: c.color });
    }
    this.list.append(element, swatches);
    const refresh = (): void => {
      const current = row.get();
      for (const b of buttons) {
        const on = sameRgb(current, b.color);
        b.button.classList.toggle('mkv-on', on);
        b.button.setAttribute('aria-pressed', String(on));
      }
    };
    refresh();
    return this.addRow({ elements: [element, swatches], refresh });
  }

  private addRow(row: Row): () => void {
    this.rows.push(row);
    return () => {
      const i = this.rows.indexOf(row);
      if (i < 0) return;
      this.rows.splice(i, 1);
      for (const e of row.elements) e.remove();
    };
  }

  /** Re-reads the state of every row. */
  refresh(): void {
    for (const r of this.rows) r.refresh();
  }

  dispose(): void {
    this.rows.length = 0;
    this.panel.dispose();
  }
}

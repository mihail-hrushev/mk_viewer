/**
 * Screenshot plugin: a panel with a width and a height in pixels and a "Screenshot" button that
 * renders the current view at that size (`viewer.getScreenshot`) and opens the image in a new
 * browser tab. The smallest panel plugin: two inputs, one button, one API call.
 *
 *   const viewer = new Viewer(canvas, { plugins: [screenshotPlugin()] });
 *   createViewerUi(viewer);                                   // toolbar button "Screenshot" opens the panel
 *   const shot = viewer.getPlugin<ScreenshotPlugin>('screenshot')!;
 *   const blob = await shot.capture(1920, 1080);              // the encoded image, no tab
 *   await shot.open();                                        // the panel's size, in a new tab
 *
 * The tab is opened synchronously on the click (before the render) so that popup blockers let it
 * through; when it is blocked anyway, the panel shows an "Open screenshot" link instead.
 */
import type { ViewerApi } from '../../types';
import type { ViewerUi } from '../../ui/ViewerUi';
import { Panel } from '../../ui/Panel';
import type { PluginContext, PluginInstance, ViewerPlugin } from '../types';

export interface ScreenshotPluginOptions {
  /** Plugin name (`viewer.getPlugin(name)`). Default 'screenshot'. */
  name?: string;
  /** Label of the toolbar button and title of the panel. Default 'Screenshot'. */
  label?: string;
  /** Initial image width in pixels (a positive integer). Default 4000. */
  width?: number;
  /** Initial image height in pixels (a positive integer). Default 3000. */
  height?: number;
  /** Image MIME type passed to `getScreenshot`: 'image/png' (default), 'image/jpeg' or 'image/webp'. */
  type?: string;
  /** Encoder quality in 0..1 for lossy types (jpeg, webp). Browser default when absent. */
  quality?: number;
  /** Add the toolbar button and panel to the built-in UI. Default true. */
  ui?: boolean;
}

/** The installed plugin's API (`viewer.getPlugin<ScreenshotPlugin>('screenshot')`). */
export interface ScreenshotPlugin extends PluginInstance {
  /** The current image width in pixels; the panel's input follows it. */
  width: number;
  /** The current image height in pixels; the panel's input follows it. */
  height: number;
  /**
   * `viewer.getScreenshot(width, height)` with the plugin's `type` and `quality`; the plugin's
   * current size when a side is omitted. Rejects as `getScreenshot` does (RangeError beyond the
   * GPU limit).
   */
  capture(width?: number, height?: number): Promise<Blob>;
  /**
   * Captures and shows the image in a new browser tab; resolves with the blob. The tab is opened
   * before the render so a popup blocker lets it through on a click. Rejects without a window
   * (headless) and when the capture fails (the tab is closed again).
   */
  open(width?: number, height?: number): Promise<Blob>;
}

/** How long an opened image's object URL stays valid (the tab has loaded it long before). */
const REVOKE_MS = 60_000;

function checkSide(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`mk-viewer: screenshot plugin: ${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/** `1.2 MB`, `640 kB`, `512 B`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${Math.round(bytes / 1000)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

class ScreenshotPluginImpl implements ScreenshotPlugin {
  private readonly viewer: ViewerApi;
  private readonly opts: ScreenshotPluginOptions;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly sizeHandlers = new Set<() => void>();
  private sizeW: number;
  private sizeH: number;
  private disposed = false;
  private uiCleanup: (() => void) | null = null;

  constructor(context: PluginContext, opts: ScreenshotPluginOptions) {
    this.viewer = context.viewer;
    this.opts = opts;
    this.sizeW = opts.width ?? 4000;
    this.sizeH = opts.height ?? 3000;
  }

  // --- public API -------------------------------------------------------------------------------

  get width(): number {
    return this.sizeW;
  }
  set width(value: number) {
    this.sizeW = checkSide('width', value);
    this.emitSize();
  }

  get height(): number {
    return this.sizeH;
  }
  set height(value: number) {
    this.sizeH = checkSide('height', value);
    this.emitSize();
  }

  capture(width = this.sizeW, height = this.sizeH): Promise<Blob> {
    if (this.disposed) return Promise.reject(new Error('mk-viewer: screenshot plugin is disposed'));
    const options = this.opts.quality === undefined ? { type: this.opts.type ?? 'image/png' } : { type: this.opts.type ?? 'image/png', quality: this.opts.quality };
    return this.viewer.getScreenshot(width, height, options);
  }

  open(width = this.sizeW, height = this.sizeH): Promise<Blob> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return Promise.reject(new Error('mk-viewer: screenshot plugin: open() needs a browser window; use capture() for the image'));
    }
    return this.openIn(width, height, null);
  }

  // --- plugin hooks -----------------------------------------------------------------------------

  ui(ui: ViewerUi): () => void {
    if (this.opts.ui === false) return () => {};
    const cleanup = createScreenshotPanel(this, ui, this.opts.label ?? 'Screenshot');
    const wrapped = (): void => {
      cleanup();
      if (this.uiCleanup === wrapped) this.uiCleanup = null;
    };
    this.uiCleanup = wrapped;
    return wrapped;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.uiCleanup?.();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.sizeHandlers.clear();
  }

  // --- internals (the panel) --------------------------------------------------------------------

  /** The panel follows `width` / `height` set through the API. */
  onSize(handler: () => void): () => void {
    this.sizeHandlers.add(handler);
    return () => {
      this.sizeHandlers.delete(handler);
    };
  }

  /**
   * Captures and navigates a new tab to the image. `onBlocked(url)` is called instead when the
   * browser refused the tab (popup blocker); without it the promise still resolves with the blob.
   */
  async openIn(width: number, height: number, onBlocked: ((url: string) => void) | null): Promise<Blob> {
    // the tab must be opened synchronously in the click's task, before any await, or popup
    // blockers refuse it; it navigates to the image once that is ready
    const win = window.open('', '_blank');
    let blob: Blob;
    try {
      blob = await this.capture(width, height);
    } catch (e) {
      win?.close();
      throw e;
    }
    const url = URL.createObjectURL(blob);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      URL.revokeObjectURL(url);
    }, REVOKE_MS);
    this.timers.add(timer);
    if (win && !win.closed) win.location.href = url;
    else onBlocked?.(url);
    return blob;
  }

  private emitSize(): void {
    for (const h of this.sizeHandlers) h();
  }
}

// --- the panel -------------------------------------------------------------------------------------

function createScreenshotPanel(plugin: ScreenshotPluginImpl, ui: ViewerUi, label: string): () => void {
  const doc = ui.element.ownerDocument;
  const toggle = ui.addToggle({
    label,
    title: 'Screenshot: render the view at a chosen size in pixels and open the image in a new tab',
    onClick: () => panel.toggle(),
  });
  const panel = new Panel(ui.element, {
    title: label,
    dock: 'right',
    height: 'auto',
    onToggle: (open) => {
      toggle.on = open;
    },
  });
  const body = panel.body;
  body.classList.add('mkv-pad');

  const sideInput = (title: string, value: number): HTMLInputElement => {
    const i = doc.createElement('input');
    i.className = 'mkv-field mkv-grow';
    i.type = 'number';
    i.min = '1';
    i.step = '1';
    i.title = title;
    i.value = String(value);
    return i;
  };
  const widthInput = sideInput('Width in pixels', plugin.width);
  const heightInput = sideInput('Height in pixels', plugin.height);
  const times = doc.createElement('span');
  times.className = 'mkv-dim';
  times.textContent = 'x';
  const sizeLine = doc.createElement('div');
  sizeLine.className = 'mkv-line';
  sizeLine.append(widthInput, times, heightInput);

  const message = doc.createElement('div');
  message.className = 'mkv-dim';

  const button = doc.createElement('button');
  button.className = 'mkv-btn mkv-outline';
  button.type = 'button';
  button.textContent = 'Screenshot';
  button.title = 'Render the view at this size and open it in a new tab';
  const actions = doc.createElement('div');
  actions.className = 'mkv-line';
  actions.append(button);

  const readSide = (input: HTMLInputElement, name: string): number | null => {
    const v = Number(input.value);
    if (input.value.trim() === '' || !Number.isInteger(v) || v < 1) {
      message.textContent = `${name} must be a whole number of pixels, 1 or more`;
      return null;
    }
    return v;
  };
  let busy = false;
  const shoot = async (): Promise<void> => {
    if (busy) return;
    const w = readSide(widthInput, 'Width');
    if (w === null) return;
    const h = readSide(heightInput, 'Height');
    if (h === null) return;
    plugin.width = w;
    plugin.height = h;
    busy = true;
    button.disabled = true;
    message.textContent = `Rendering ${w} x ${h}...`;
    const t0 = performance.now();
    try {
      const blob = await plugin.openIn(w, h, (url) => {
        // the tab was blocked: the user opens it from here instead
        message.textContent = '';
        const a = doc.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Open screenshot';
        a.title = 'The browser blocked the new tab: click to open the image';
        message.append(a);
      });
      const seconds = ((performance.now() - t0) / 1000).toFixed(1);
      const info = `${w} x ${h}, ${formatBytes(blob.size)}, ${seconds} s`;
      if (message.firstElementChild) message.append(` (${info})`);
      else message.textContent = info;
    } catch (e) {
      message.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      button.disabled = false;
    }
  };
  button.onclick = () => void shoot();
  const onEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void shoot();
    }
  };
  widthInput.addEventListener('keydown', onEnter);
  heightInput.addEventListener('keydown', onEnter);

  body.append(sizeLine, actions, message);
  const offSize = plugin.onSize(() => {
    widthInput.value = String(plugin.width);
    heightInput.value = String(plugin.height);
  });
  return () => {
    offSize();
    toggle.remove();
    panel.dispose();
  };
}

/** Creates the screenshot plugin. */
export function screenshotPlugin(options: ScreenshotPluginOptions = {}): ViewerPlugin<ScreenshotPlugin> {
  if (options.width !== undefined) checkSide('width', options.width);
  if (options.height !== undefined) checkSide('height', options.height);
  return {
    name: options.name ?? 'screenshot',
    install(context) {
      return new ScreenshotPluginImpl(context, options);
    },
  };
}

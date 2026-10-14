/**
 * Camera plugin: a panel for the camera settings of the viewer API. Projection (perspective or
 * orthographic, `viewer.setProjection`), field of view (`viewer.setFieldOfView`, which keeps the
 * framing), the standard views and Fit (`viewer.setStandardView`, `viewer.fitToView`), the
 * navigation speeds and animation time (`viewer.setNavigation`), and Reset, which restores what the
 * viewer had when the plugin was installed.
 *
 *   const viewer = new Viewer(canvas, { plugins: [cameraPlugin()] });
 *   createViewerUi(viewer);                               // toolbar button "Camera" opens the panel
 *   const camera = viewer.getPlugin<CameraPlugin>('camera')!;
 *   camera.projection = 'orthographic';
 *   camera.fovDegrees = 60;
 *
 * Everything the panel does is plain viewer API, so settings changed from code show in the panel:
 * projection and field of view follow the `camera` event, the navigation rows are re-read when the
 * panel opens.
 */
import type { NavigationSettings, Projection, StandardView, ViewerApi } from '../../types';
import type { ViewerUi } from '../../ui/ViewerUi';
import { Panel } from '../../ui/Panel';
import type { PluginContext, PluginInstance, ViewerPlugin } from '../types';

export interface CameraPluginOptions {
  /** Plugin name (`viewer.getPlugin(name)`). Default 'camera'. */
  name?: string;
  /** Label of the toolbar button and title of the panel. Default 'Camera'. */
  label?: string;
  /** Smallest field of view the panel's slider offers, in degrees. Default 10. */
  minFov?: number;
  /** Largest field of view the panel's slider offers, in degrees. Default 120. */
  maxFov?: number;
  /** Add the toolbar button and panel to the built-in UI. Default true. */
  ui?: boolean;
}

/** What `reset()` restores: the viewer's settings when the plugin was installed. */
export interface CameraDefaults {
  /** Vertical field of view in radians. */
  fov: number;
  projection: Projection;
  navigation: NavigationSettings;
}

/** The installed plugin's API (`viewer.getPlugin<CameraPlugin>('camera')`). */
export interface CameraPlugin extends PluginInstance {
  /** `viewer.getProjection()` / `viewer.setProjection()`. */
  projection: Projection;
  /** The vertical field of view in degrees; setting it calls `viewer.setFieldOfView` (framing kept). */
  fovDegrees: number;
  /** The settings `reset()` restores. */
  readonly defaults: Readonly<CameraDefaults>;
  /** Restores the field of view, projection and navigation settings in `defaults`. */
  reset(animate?: boolean): void;
}

const DEG = Math.PI / 180;

/** Panel rows of the standard views, in display order. */
const VIEW_BUTTONS: { view: StandardView; label: string }[] = [
  { view: 'top', label: 'Top' },
  { view: 'front', label: 'Front' },
  { view: 'left', label: 'Left' },
  { view: 'iso', label: 'Iso' },
  { view: 'bottom', label: 'Bottom' },
  { view: 'back', label: 'Back' },
  { view: 'right', label: 'Right' },
];

class CameraPluginImpl implements CameraPlugin {
  readonly defaults: Readonly<CameraDefaults>;
  private readonly viewer: ViewerApi;
  private readonly opts: CameraPluginOptions;
  private disposed = false;
  private uiCleanup: (() => void) | null = null;

  constructor(context: PluginContext, opts: CameraPluginOptions) {
    this.viewer = context.viewer;
    this.opts = opts;
    this.defaults = Object.freeze({
      fov: this.viewer.getCamera().fov,
      projection: this.viewer.getProjection(),
      navigation: Object.freeze(this.viewer.getNavigation()),
    });
  }

  // --- public API -------------------------------------------------------------------------------

  get projection(): Projection {
    return this.viewer.getProjection();
  }
  set projection(value: Projection) {
    this.viewer.setProjection(value);
  }

  get fovDegrees(): number {
    return this.viewer.getCamera().fov / DEG;
  }
  set fovDegrees(value: number) {
    this.viewer.setFieldOfView(value * DEG);
  }

  reset(animate = true): void {
    const d = this.defaults;
    this.viewer.setNavigation(d.navigation);
    this.viewer.setProjection(d.projection);
    this.viewer.setFieldOfView(d.fov, animate);
  }

  // --- plugin hooks -----------------------------------------------------------------------------

  ui(ui: ViewerUi): () => void {
    if (this.opts.ui === false || this.disposed) return () => {};
    const cleanup = createCameraPanel(this, this.viewer, ui, this.opts);
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
  }
}

// --- the panel -------------------------------------------------------------------------------------

interface Slider {
  row: HTMLElement;
  input: HTMLInputElement;
  output: HTMLOutputElement;
}

/** `1x`, `0.5x`, `off`. */
function formatSpeed(v: number): string {
  return v === 0 ? 'off' : `${Number(v.toPrecision(2))}x`;
}

function createCameraPanel(plugin: CameraPluginImpl, viewer: ViewerApi, ui: ViewerUi, opts: CameraPluginOptions): () => void {
  const doc = ui.element.ownerDocument;
  const label = opts.label ?? 'Camera';
  const minFov = opts.minFov ?? 10;
  const maxFov = opts.maxFov ?? 120;

  const toggle = ui.addToggle({
    label,
    title: 'Camera: projection, field of view, standard views and navigation speeds',
    onClick: () => panel.toggle(),
  });
  const panel = new Panel(ui.element, {
    title: label,
    dock: 'right',
    height: 'auto',
    resizable: false,
    onToggle: (open) => {
      toggle.on = open;
      if (open) refresh();
    },
  });
  const body = panel.body;
  body.classList.add('mkv-pad');

  const button = (text: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.className = 'mkv-btn mkv-outline';
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.onclick = onClick;
    return b;
  };
  const subhead = (text: string): HTMLElement => {
    const h = doc.createElement('div');
    h.className = 'mkv-subhead';
    h.textContent = text;
    return h;
  };
  const slider = (text: string, title: string, min: number, max: number, step: number, onInput: (v: number) => void): Slider => {
    const row = doc.createElement('label');
    row.className = 'mkv-slider';
    row.title = title;
    const name = doc.createElement('span');
    name.textContent = text;
    const input = doc.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.addEventListener('input', () => onInput(Number(input.value)));
    const output = doc.createElement('output');
    row.append(name, input, output);
    return { row, input, output };
  };

  // projection
  const perspective = button('Perspective', 'Perspective projection: distant things look smaller', () => {
    plugin.projection = 'perspective';
    syncCamera();
  });
  const orthographic = button('Orthographic', 'Orthographic projection: no foreshortening, parallel lines stay parallel', () => {
    plugin.projection = 'orthographic';
    syncCamera();
  });
  const projection = doc.createElement('div');
  projection.className = 'mkv-seg';
  projection.append(perspective, orthographic);

  // field of view (the slider moves in whole degrees; the output shows the exact value)
  const fov = slider('Field of view', 'Vertical field of view; the view at the orbit centre keeps its size', minFov, maxFov, 1, (v) => {
    plugin.fovDegrees = v;
    syncCamera();
  });

  // standard views and fit
  const views = doc.createElement('div');
  views.className = 'mkv-views';
  for (const { view, label: text } of VIEW_BUTTONS) {
    views.append(button(text, `Look at the scene from the ${view === 'iso' ? 'front right top corner' : view} and frame it`, () => viewer.setStandardView(view)));
  }
  views.append(button('Fit', 'Frame the whole scene from the current direction', () => viewer.fitToView(undefined, true)));

  // navigation: speeds on a log2 scale from 1/4 to 4 times the default
  const speedRow = (text: string, title: string, key: Exclude<keyof NavigationSettings, 'animationMs'>): Slider =>
    slider(text, title, -2, 2, 0.25, (v) => {
      viewer.setNavigation({ [key]: 2 ** v });
      refreshNavigation();
    });
  const speeds: [Slider, Exclude<keyof NavigationSettings, 'animationMs'>][] = [
    [speedRow('Orbit speed', 'How fast a left drag turns the camera', 'rotateSpeed'), 'rotateSpeed'],
    [speedRow('Pan speed', 'How fast a right or middle drag moves the camera sideways', 'panSpeed'), 'panSpeed'],
    [speedRow('Zoom speed', 'How fast the wheel and pinch zoom', 'zoomSpeed'), 'zoomSpeed'],
    [speedRow('Walk speed', 'How fast the W / A / S / D / E / C keys move the camera', 'moveSpeed'), 'moveSpeed'],
  ];
  const animation = slider('Animation', 'Duration of animated camera moves (fit, zoom to object, standard views); 0 jumps', 0, 1500, 50, (v) => {
    viewer.setNavigation({ animationMs: v });
    refreshNavigation();
  });

  const reset = button('Reset', 'Restore the projection, field of view and navigation settings the viewer started with', () => {
    plugin.reset();
    refresh();
  });
  const actions = doc.createElement('div');
  actions.className = 'mkv-line';
  actions.append(reset);

  body.append(projection, fov.row, subhead('Views'), views, subhead('Navigation'));
  for (const [s] of speeds) body.append(s.row);
  body.append(animation.row, actions);

  // --- state -> panel
  let lastFov = NaN;
  let lastOrtho: boolean | null = null;
  const refreshCamera = (fovRad: number, ortho: boolean): void => {
    if (fovRad !== lastFov) {
      lastFov = fovRad;
      const deg = fovRad / DEG;
      // keep the thumb where the user drags it (input sets whole degrees, so this is a no-op then)
      if (Math.round(deg) !== Number(fov.input.value)) fov.input.value = String(Math.round(deg));
      fov.output.value = `${Number(deg.toFixed(1))}°`;
    }
    if (ortho !== lastOrtho) {
      lastOrtho = ortho;
      perspective.classList.toggle('mkv-on', !ortho);
      orthographic.classList.toggle('mkv-on', ortho);
      perspective.setAttribute('aria-pressed', String(!ortho));
      orthographic.setAttribute('aria-pressed', String(ortho));
      fov.input.disabled = ortho;
      fov.row.title = ortho
        ? 'The field of view applies to the perspective projection'
        : 'Vertical field of view; the view at the orbit centre keeps its size';
    }
  };
  const refreshNavigation = (): void => {
    const n = viewer.getNavigation();
    for (const [s, key] of speeds) {
      const v = n[key];
      s.input.value = String(Math.log2(Math.min(4, Math.max(0.25, v))));
      s.output.value = formatSpeed(v);
    }
    animation.input.value = String(n.animationMs);
    animation.output.value = n.animationMs === 0 ? 'off' : `${n.animationMs} ms`;
  };
  // the panel's own changes show at once, not with the next frame's camera event
  function syncCamera(): void {
    const c = viewer.getCamera();
    refreshCamera(c.fov, c.orthographic);
  }
  function refresh(): void {
    syncCamera();
    refreshNavigation();
  }
  refresh();

  const offCamera = viewer.on('camera', (c) => {
    if (panel.isOpen) refreshCamera(c.fov, c.orthographic);
  });
  return () => {
    offCamera();
    toggle.remove();
    panel.dispose();
  };
}

/** Creates the camera plugin. */
export function cameraPlugin(options: CameraPluginOptions = {}): ViewerPlugin<CameraPlugin> {
  const min = options.minFov ?? 10;
  const max = options.maxFov ?? 120;
  if (!(min > 0 && max < 180 && min < max)) {
    throw new RangeError(`mk-viewer: camera plugin: need 0 < minFov < maxFov < 180 degrees, got ${String(min)} and ${String(max)}`);
  }
  return {
    name: options.name ?? 'camera',
    install(context) {
      return new CameraPluginImpl(context, options);
    },
  };
}

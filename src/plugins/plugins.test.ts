/**
 * Viewer plugin system, the active-tool mechanism, worldToScreen and the measurement plugin's
 * headless API, on the real Viewer (headless, no DOM / GL).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from '../__tests__/headlessViewer';
import type { ContextMenuEntry, ToolEndReason, ViewerTool } from '../types';
import type { ViewerUi } from '../ui/ViewerUi';
import type { ViewerPlugin } from './types';
import { measurePlugin, type MeasurePlugin, type Measurement } from './measure/measurePlugin';
import { clipSegment2D, depthCutT, formatDistance, labelOffset } from './measure/geometry';
import { colorPlugin, DEFAULT_COLORS, type ColorPlugin } from './color/colorPlugin';
import { formatBytes, screenshotPlugin, type ScreenshotPlugin } from './screenshot/screenshotPlugin';

let hv: HeadlessViewer | null = null;
afterEach(() => {
  hv?.dispose();
  hv = null;
});

function logPlugin(name: string, log: string[], api: Record<string, unknown> = {}): ViewerPlugin<any> {
  return {
    name,
    install(ctx) {
      log.push(`install ${name}`);
      expect(ctx.viewer).toBeDefined();
      return { ...api, dispose: () => log.push(`dispose ${name}`) };
    },
  };
}

describe('viewer plugins', () => {
  it('installs at construction in order, use() later, getPlugin, names, reverse dispose', () => {
    const log: string[] = [];
    hv = createHeadlessViewer({ plugins: [logPlugin('a', log, { hello: () => 'a' }), logPlugin('b', log)] });
    const v = hv.viewer;
    expect(log).toEqual(['install a', 'install b']);
    expect(v.plugins).toEqual(['a', 'b']);
    expect(v.getPlugin<{ hello(): string }>('a')!.hello()).toBe('a');
    expect(v.getPlugin('nope')).toBeUndefined();
    const installed: string[] = [];
    v.on('pluginInstalled', (p) => installed.push(p.name));
    const c = v.use(logPlugin('c', log, { x: 1 }));
    expect((c as { x: number }).x).toBe(1);
    expect(v.getPlugin('c')).toBe(c);
    expect(installed).toEqual(['c']);
    expect(v.plugins).toEqual(['a', 'b', 'c']);
    // a plugin returning nothing still counts as installed
    v.use({ name: 'void', install: () => undefined });
    expect(v.getPlugin('void')).toEqual({});
    hv.dispose();
    hv = null;
    expect(log.slice(3)).toEqual(['dispose c', 'dispose b', 'dispose a']);
  });

  it('duplicate names and malformed plugins are clear errors', () => {
    hv = createHeadlessViewer({ plugins: [{ name: 'p', install: () => ({}) }] });
    expect(() => hv!.viewer.use({ name: 'p', install: () => ({}) })).toThrow(/plugin named 'p' is already installed/);
    expect(() => hv!.viewer.use({ name: '', install: () => ({}) } as ViewerPlugin)).toThrow(/non-empty string `name`/);
    expect(() => hv!.viewer.use({ name: 'x' } as unknown as ViewerPlugin)).toThrow(/install\(context\)/);
  });

  it('a throwing install: use() leaves the viewer usable; in the constructor the viewer is disposed', () => {
    hv = createHeadlessViewer();
    const bad: ViewerPlugin = {
      name: 'bad',
      install() {
        throw new Error('boom');
      },
    };
    let err: Error | null = null;
    try {
      hv.viewer.use(bad);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe("mk-viewer: viewer plugin 'bad' failed to install: boom");
    expect((err as { cause?: Error }).cause?.message).toBe('boom');
    expect(hv.viewer.plugins).toEqual([]);
    hv.viewer.use({ name: 'ok', install: () => ({}) }); // still usable
    hv.dispose();
    hv = null;

    const log: string[] = [];
    const dispose = vi.fn();
    expect(() => createHeadlessViewer({ plugins: [logPlugin('first', log), bad, logPlugin('never', log)] })).toThrow(
      /viewer plugin 'bad' failed to install: boom/,
    );
    expect(log).toEqual(['install first', 'dispose first']);
    expect(dispose).not.toHaveBeenCalled();
  });
});

describe('tools', () => {
  const tool = (name: string, log: string[]): ViewerTool => ({
    name,
    onDeactivate: (r: ToolEndReason) => log.push(`${name} off ${r}`),
  });

  it('one active tool at a time; replacing, clearing and dispose notify', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const log: string[] = [];
    const a = tool('a', log), b = tool('b', log);
    expect(v.getTool()).toBeNull();
    v.setTool(a);
    expect(v.getTool()).toBe(a);
    v.setTool(a); // no-op
    v.setTool(b);
    expect(log).toEqual(['a off replaced']);
    expect(v.getTool()).toBe(b);
    v.setTool(null);
    expect(log).toEqual(['a off replaced', 'b off api']);
    v.setTool(a);
    hv.dispose();
    hv = null;
    expect(log[2]).toBe('a off dispose');
  });

  it('cursor while active and restored afterwards', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    (v.canvas as unknown as { style: Record<string, string> }).style = { cursor: 'grab' };
    v.setTool({ name: 't' });
    expect(v.canvas.style.cursor).toBe('crosshair');
    v.setTool({ name: 'u', cursor: 'cell' });
    expect(v.canvas.style.cursor).toBe('cell');
    v.setTool(null);
    expect(v.canvas.style.cursor).toBe('grab');
  });
});

describe('worldToScreen', () => {
  it('projects to canvas CSS pixels; behind the eye is not in front; large coordinates', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const X = 1e7, Z = -2e7;
    v.addMesh({ geometry: v.primitives.box([2, 2, 2]), material: v.createMaterial(), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, X, 0, Z, 1] });
    v.camera.setViewport(800, 600);
    v.setCamera({ eye: [X, 0, Z + 10], target: [X, 0, Z], fov: Math.PI / 2 });
    const c = v.worldToScreen([X, 0, Z]);
    expect(c.x).toBeCloseTo(400, 6);
    expect(c.y).toBeCloseTo(300, 6);
    expect(c.depth).toBeCloseTo(10, 9);
    expect(c.inFront && c.inView).toBe(true);
    // fov 90: at depth 10 the half height is 10 units = 300 px; +y is up on screen
    const up = v.worldToScreen([X + 1, 1, Z]);
    expect(up.x).toBeCloseTo(430, 6);
    expect(up.y).toBeCloseTo(270, 6);
    const behind = v.worldToScreen([X, 0, Z + 20]);
    expect(behind.inFront).toBe(false);
    expect(behind.inView).toBe(false);
    const out = { x: 0, y: 0, depth: 0, inFront: false, inView: false };
    expect(v.worldToScreen([X + 100, 0, Z], out)).toBe(out);
    expect(out.inFront).toBe(true);
    expect(out.inView).toBe(false);
  });
});

describe('measure plugin (headless)', () => {
  it('add / remove / clear with events and a read-only list', () => {
    hv = createHeadlessViewer({ plugins: [measurePlugin({ unit: 'm', decimals: 2 })] });
    const m = hv.viewer.getPlugin<MeasurePlugin>('measure')!;
    const created: Measurement[] = [];
    const removed: number[] = [];
    m.on('created', (x) => created.push(x));
    m.on('removed', (x) => removed.push(x.id));
    const a = m.add([1e7, 0, 0], [1e7 + 3, 4, 0]);
    expect(a.distance).toBe(5);
    expect(a.delta).toEqual([3, 4, 0]);
    expect(a.start.kind).toBeNull();
    const b = m.add([0, 0, 0], [0, 0, 2]);
    expect(created.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(m.measurements.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(Object.isFrozen(m.measurements)).toBe(true);
    expect(Object.isFrozen(a)).toBe(true);
    expect(m.remove(a.id)).toBe(true);
    expect(m.remove(a.id)).toBe(false);
    expect(m.measurements.map((x) => x.id)).toEqual([b.id]);
    m.clear();
    expect(m.measurements).toEqual([]);
    expect(removed).toEqual([a.id, b.id]);
    expect(m.format(1.23456)).toBe('1.23 m');
    expect(() => m.add([0, 0, NaN], [0, 0, 0])).toThrow(/start must be 3 finite numbers/);
  });

  it('activate makes it the active tool; another tool or Escape-less API calls deactivate it', () => {
    hv = createHeadlessViewer({ plugins: [measurePlugin()] });
    const v = hv.viewer;
    const m = v.getPlugin<MeasurePlugin>('measure')!;
    const states: boolean[] = [];
    m.on('active', (s) => states.push(s));
    m.activate();
    expect(m.active).toBe(true);
    expect(v.getTool()?.name).toBe('measure');
    v.setTool({ name: 'other' }); // replaces the measuring tool
    expect(m.active).toBe(false);
    expect(m.toggle()).toBe(true);
    expect(m.toggle()).toBe(false);
    expect(v.getTool()).toBeNull();
    expect(states).toEqual([true, false, true, false]);
    // the tool hands a right click / Escape back when nothing is started
    m.activate();
    const t = v.getTool()!;
    expect(t.onEscape!()).toBe(false);
    expect(t.onContextMenu!(0, 0)).toBe(false);
  });

  it('ui hook adds a toggle and removes it again; the menu entry belongs to the plugin', () => {
    hv = createHeadlessViewer({ plugins: [measurePlugin()] });
    const v = hv.viewer;
    const m = v.getPlugin<MeasurePlugin>('measure')!;
    const toggle = { element: {} as HTMLButtonElement, on: false, removed: false, remove() { this.removed = true; } };
    let onClick: (() => void) | null = null;
    const fakeUi = {
      addToggle: (b: { onClick: () => void }) => {
        onClick = b.onClick;
        return toggle;
      },
    } as unknown as ViewerUi;
    const cleanup = m.ui!(fakeUi) as () => void;
    const clearEntry = () => v.contextMenuAt(0, 0, 'mouse', null).items.find((e) => e.label === 'Clear measurements')!;
    expect(clearEntry().enabled).toBe(false);
    m.add([0, 0, 0], [1, 0, 0]);
    expect(clearEntry().enabled).toBe(true);
    onClick!();
    expect(m.active).toBe(true);
    expect(toggle.on).toBe(true);
    m.deactivate();
    expect(toggle.on).toBe(false);
    clearEntry().run();
    expect(m.measurements.length).toBe(0);
    cleanup();
    expect(toggle.removed).toBe(true);
    expect(v.removePlugin('measure')).toBe(true);
    expect(v.contextMenuAt(0, 0, 'mouse', null).items).toEqual([]);
  });

  it('custom format, deltas option and name', () => {
    hv = createHeadlessViewer({ plugins: [measurePlugin({ name: 'ruler', format: (d) => `${(d * 1000).toFixed(0)} mm` })] });
    const m = hv.viewer.getPlugin<MeasurePlugin>('ruler')!;
    expect(m.format(1.2345)).toBe('1235 mm');
    expect(formatDistance(2, 3, '')).toBe('2.000');
    expect(formatDistance(2.5, 1, 'ft')).toBe('2.5 ft');
  });
});

describe('removePlugin', () => {
  it('disposes the plugin, removes its context registrations and emits pluginRemoved', () => {
    const log: string[] = [];
    hv = createHeadlessViewer({ plugins: [logPlugin('a', log), logPlugin('b', log)] });
    const v = hv.viewer;
    const removed: string[] = [];
    v.on('pluginRemoved', (p) => removed.push(p.name));
    expect(v.removePlugin('nope')).toBe(false);
    expect(v.removePlugin('a')).toBe(true);
    expect(log).toEqual(['install a', 'install b', 'dispose a']);
    expect(removed).toEqual(['a']);
    expect(v.plugins).toEqual(['b']);
    expect(v.getPlugin('a')).toBeUndefined();
    v.use(logPlugin('a', log)); // the name is free again
    expect(v.plugins).toEqual(['b', 'a']);
    hv.dispose();
    hv = null;
    expect(log.slice(-2)).toEqual(['dispose a', 'dispose b']);
    expect(removed).toEqual(['a']); // viewer.dispose() does not emit pluginRemoved
  });

  it('context menu items of a plugin go away with it, on a failed install and on early removal', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const labels = () => v.contextMenuAt(0, 0, 'mouse', null).items.map((e) => e.label);
    let removeB: (() => void) | null = null;
    v.use({
      name: 'p',
      install(ctx) {
        expect(ctx.name).toBe('p');
        ctx.addContextMenuItem({ label: 'A', onClick: () => {} });
        removeB = ctx.addContextMenuItem({ label: 'B', onClick: () => {} });
      },
    });
    v.addContextMenuItem({ label: 'host', order: -1, onClick: () => {} });
    expect(labels()).toEqual(['host', 'A', 'B']);
    removeB!();
    removeB!(); // idempotent
    expect(labels()).toEqual(['host', 'A']);
    v.removePlugin('p');
    expect(labels()).toEqual(['host']);
    expect(() =>
      v.use({
        name: 'bad',
        install(ctx) {
          ctx.addContextMenuItem({ label: 'X', onClick: () => {} });
          throw new Error('nope');
        },
      }),
    ).toThrow(/failed to install/);
    expect(labels()).toEqual(['host']);
  });
});

describe('context menu', () => {
  function scene(options = {}) {
    hv = createHeadlessViewer(options);
    const v = hv.viewer;
    const geo = v.primitives.box();
    const mat = v.createMaterial();
    v.addMesh({ geometry: geo, material: mat, objectId: 7 });
    v.addMesh({ geometry: geo, material: mat, objectId: 8 });
    const hit = (objectId: number) => ({ meshId: 0, objectId, position: [0, 0, 0] as [number, number, number], distance: 1 });
    return { v, hit };
  }

  it('acts on the selection, or on the hit object when nothing is selected; never selects', () => {
    const { v, hit } = scene({ autoSelect: true });
    const sel: number[][] = [];
    v.on('selection', (s) => sel.push(s));
    // nothing selected: the object under the pointer, without selecting it
    let r = v.contextMenuAt(10, 20, 'mouse', hit(7));
    expect(r.selection).toEqual([7]);
    expect(v.getSelection()).toEqual([]);
    // a selection: the selection, also when right-clicking another object
    v.select([8]);
    r = v.contextMenuAt(10, 20, 'mouse', hit(7));
    expect(r.selection).toEqual([8]);
    expect(r.hit!.objectId).toBe(7);
    expect(v.getSelection()).toEqual([8]);
    r = v.contextMenuAt(10, 20, 'mouse', null);
    expect(r.selection).toEqual([8]);
    expect(r.hit).toBeNull();
    expect([r.x, r.y, r.pointerType]).toEqual([10, 20, 'mouse']);
    // background with nothing selected: empty
    v.select([]);
    expect(v.contextMenuAt(0, 0, 'mouse', null).selection).toEqual([]);
    expect(sel).toEqual([[8], []]); // only the explicit select() calls
    // the same with a tool active and without autoSelect
    v.setTool({ name: 't' });
    expect(v.contextMenuAt(0, 0, 'mouse', hit(7)).selection).toEqual([7]);
    expect(v.getSelection()).toEqual([]);
  });

  it('without autoSelect: the same', () => {
    const { v, hit } = scene();
    expect(v.contextMenuAt(0, 0, 'mouse', hit(7)).selection).toEqual([7]);
    expect(v.getSelection()).toEqual([]);
  });

  it('visible / enabled / order / run, errors are contained, the event can be prevented', () => {
    const { v, hit } = scene({ autoSelect: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clicked: string[] = [];
    v.addContextMenuItem({ label: 'late', order: 5, onClick: () => clicked.push('late') });
    v.addContextMenuItem({
      label: 'objects only',
      visible: (c) => c.hit !== null,
      enabled: (c) => c.selection.length === 1,
      onClick: (c) => clicked.push(`obj ${c.hit!.objectId}`),
    });
    v.addContextMenuItem({ label: 'first', order: -3, title: 'tip', onClick: () => clicked.push('first') });
    v.addContextMenuItem({ label: 'broken', visible: () => { throw new Error('x'); }, onClick: () => {} });
    v.addContextMenuItem({ label: 'throws', onClick: () => { throw new Error('y'); } });
    const events: string[] = [];
    v.on('contextMenu', (req) => {
      events.push(req.items.map((e) => e.label).join(','));
      req.preventDefault();
    });
    const bg = v.contextMenuAt(0, 0, 'mouse', null);
    expect(bg.items.map((e) => e.label)).toEqual(['first', 'throws', 'late']);
    expect(bg.items[0].title).toBe('tip');
    expect(bg.items[0].order).toBe(-3);
    expect(bg.defaultPrevented).toBe(true);
    const on = v.contextMenuAt(0, 0, 'touch', hit(8));
    expect(on.items.map((e) => [e.label, e.enabled])).toEqual([
      ['first', true],
      ['objects only', true],
      ['throws', true],
      ['late', true],
    ]);
    on.items[1].run();
    on.items[2].run(); // logged, not thrown
    v.select([7, 8]);
    const two = v.contextMenuAt(0, 0, 'mouse', hit(8));
    expect(two.items[1].enabled).toBe(false);
    two.items[1].run(); // disabled: no-op
    expect(clicked).toEqual(['obj 8']);
    expect(events.length).toBe(3);
    expect(err).toHaveBeenCalled();
    expect(() => v.addContextMenuItem({ label: 'x' } as never)).toThrow(/onClick/);
    err.mockRestore();
  });

  it('submenus: items evaluated with the same context, sorted, swatch copied, empty submenu disabled', () => {
    const { v, hit } = scene({ autoSelect: true });
    const clicked: string[] = [];
    v.addContextMenuItem({
      label: 'Colour',
      enabled: (c) => c.selection.length > 0,
      items: [
        { label: 'b', order: 1, color: [0, 0, 1], onClick: (c) => clicked.push(`b ${c.selection.join('+')}`) },
        { label: 'a', color: [1, 0, 0, 0.5], onClick: () => clicked.push('a') },
        { label: 'objects only', visible: (c) => c.hit !== null, items: [{ label: 'deep', onClick: () => clicked.push('deep') }] },
      ],
    });
    v.addContextMenuItem({ label: 'Empty', items: [{ label: 'never', visible: () => false, onClick: () => {} }] });
    expect(() => v.addContextMenuItem({ label: 'x', items: [{ label: 'y' }] } as never)).toThrow(/onClick/);
    expect(() => v.addContextMenuItem({ label: 'x', items: 'y' } as never)).toThrow(/onClick/);

    const bg = v.contextMenuAt(0, 0, 'mouse', null);
    expect(bg.items.map((e) => [e.label, e.enabled, e.items?.length])).toEqual([
      ['Colour', false, 2],
      ['Empty', false, 0],
    ]);
    bg.items[0].run(); // a submenu entry runs nothing
    const on = v.contextMenuAt(0, 0, 'mouse', hit(8)); // acts on 8 (nothing selected)
    const colour = on.items[0];
    expect(colour.enabled).toBe(true);
    expect(colour.items!.map((e) => [e.label, e.order, e.color])).toEqual([
      ['a', 0, [1, 0, 0, 0.5]],
      ['objects only', 0, undefined],
      ['b', 1, [0, 0, 1]],
    ]);
    expect(colour.items![1].items!.map((e) => e.label)).toEqual(['deep']);
    expect(Object.isFrozen(colour.items)).toBe(true);
    colour.items![2].run();
    colour.items![1].run(); // submenu: no-op
    colour.items![1].items![0].run();
    expect(clicked).toEqual(['b 8', 'deep']);
  });
});

describe('colour overrides', () => {
  it('getColor returns the override (sRGB + strength) of an object, null without one', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const geo = v.primitives.box();
    const mat = v.createMaterial({ color: [0.2, 0.4, 0.6] });
    v.addMeshes({ geometry: geo, material: mat, transforms: new Float64Array(32).map((_, i) => (i % 5 === 0 ? 1 : 0)), objectIds: [5, 5] });
    const plain = v.addMesh({ geometry: geo, material: mat });
    expect(v.getColor(5)).toBeNull();
    v.setColor(5, [1, 0.5, 0]);
    const c = v.getColor(5)!;
    expect(c[0]).toBeCloseTo(1, 5);
    expect(c[1]).toBeCloseTo(0.5, 5);
    expect(c[2]).toBeCloseTo(0, 5);
    expect(c[3]).toBe(1);
    v.setColor({ first: plain, count: 1 }, [0, 0, 1, 0.5]);
    expect(v.getColor(plain)![3]).toBe(0.5);
    v.setColor([5, plain], null);
    expect(v.getColor(5)).toBeNull();
    expect(v.getColor(plain)).toBeNull();
    expect(v.getColor(12345)).toBeNull();
  });

  it('getColoredObjects lists every override in first-coloured order; clearColors removes them', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const geo = v.primitives.box();
    const mat = v.createMaterial();
    const mesh = (objectId: number) => v.addMesh({ geometry: geo, material: mat, objectId });
    mesh(1);
    mesh(2);
    mesh(3);
    const m4 = mesh(4);
    expect(v.getColoredObjects()).toEqual([]);
    v.setColor([3, 1], [1, 0, 0]);
    v.setColor(2, [0, 1, 0, 0.5]);
    v.setColor(3, [0, 0, 1]); // re-colouring keeps the first-coloured position
    expect(v.getColoredObjects()).toEqual([3, 1, 2]);
    v.setColor(1, null); // null forgets the id
    expect(v.getColoredObjects()).toEqual([3, 2]);
    v.setColor(1, [1, 1, 0]);
    expect(v.getColoredObjects()).toEqual([3, 2, 1]);
    v.setColor(2, [0, 1, 0, 0]); // strength 0 is no override
    expect(v.getColor(2)).toBeNull();
    expect(v.getColoredObjects()).toEqual([3, 1]);
    v.setColor(999, [1, 0, 0]); // an id without meshes is not remembered
    expect(v.getColoredObjects()).toEqual([3, 1]);
    // the result is a new array
    v.getColoredObjects().length = 0;
    expect(v.getColoredObjects()).toEqual([3, 1]);

    // removed meshes drop out, also when a mesh with the same objectId is added again
    v.setColor(4, [1, 0, 0]);
    expect(v.getColoredObjects()).toEqual([3, 1, 4]);
    v.remove(m4);
    expect(v.getColoredObjects()).toEqual([3, 1]);
    v.setColor(4, [1, 0, 0]);
    expect(v.getColoredObjects()).toEqual([3, 1]);
    mesh(4);
    expect(v.getColor(4)).toBeNull();
    expect(v.getColoredObjects()).toEqual([3, 1]);
    for (const id of v.getColoredObjects()) expect(v.getColor(id)).not.toBeNull();

    v.clearColors();
    expect(v.getColoredObjects()).toEqual([]);
    expect(v.getColor(1)).toBeNull();
    expect(v.getColor(3)).toBeNull();
    v.clearColors(); // nothing to do

    v.setColor([1, 2], [1, 0, 0]);
    v.clear();
    expect(v.getColoredObjects()).toEqual([]);
    mesh(1);
    expect(v.getColoredObjects()).toEqual([]);
  });
});

describe('colour plugin', () => {
  it('menu entries colour and reset the selection; removed with the plugin', () => {
    hv = createHeadlessViewer({ autoSelect: true, plugins: [colorPlugin()] });
    const v = hv.viewer;
    const geo = v.primitives.box();
    const mat = v.createMaterial();
    v.addMesh({ geometry: geo, material: mat, objectId: 1 });
    v.addMesh({ geometry: geo, material: mat, objectId: 2 });
    const hit = (objectId: number) => ({ meshId: 0, objectId, position: [0, 0, 0] as [number, number, number], distance: 1 });
    // the submenu's colours are flattened in: `Red` is the first entry of "Change colour"
    const entries = (h: ReturnType<typeof hit> | null) => {
      const top = v.contextMenuAt(0, 0, 'mouse', h).items;
      const flat = (list: readonly ContextMenuEntry[]): [string, ContextMenuEntry][] => list.flatMap((e) => [[e.label, e] as [string, ContextMenuEntry], ...flat(e.items ?? [])]);
      return Object.fromEntries(flat(top));
    };

    let m = entries(null);
    expect(m['Change colour'].enabled).toBe(false); // nothing selected
    expect(m.Red.enabled).toBe(true); // the colours themselves are plain; the closed submenu guards them
    expect(m['Reset colour'].enabled).toBe(false);
    m = entries(hit(1)); // acts on object 1 (nothing selected)
    expect(m['Change colour'].enabled).toBe(true);
    expect(m['Change colour'].items!.map((e) => e.label)).toEqual(['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Purple', 'Magenta', 'Grey', 'White']);
    expect(m.Blue.color).toEqual([0.1, 0.4, 1]);
    expect(m['Reset colour'].enabled).toBe(false);
    m.Red.run();
    expect(v.getColor(1)).toEqual([1, 0, 0, 1]);
    expect(v.getColor(2)).toBeNull();
    m.Blue.run();
    expect(v.getColor(1)).toEqual([0.1, 0.4, 1, 1]);
    m = entries(hit(1));
    expect(m['Reset colour'].enabled).toBe(true);
    m['Reset colour'].run();
    expect(v.getColor(1)).toBeNull();

    const p = v.getPlugin<ColorPlugin>('color')!;
    p.apply([2]);
    expect(v.getColor(2)).toEqual([1, 0, 0, 1]);
    p.apply([2], [0, 1, 0]);
    expect(v.getColor(2)).toEqual([0, 1, 0, 1]);
    p.reset([2]);
    expect(v.getColor(2)).toBeNull();
    expect(p.color).toEqual([1, 0, 0]);
    expect(p.colors.map((c) => c.label)).toEqual(DEFAULT_COLORS.map((c) => c.label));
    expect(p.colors.length).toBe(10);

    // the coloured object is no longer selected (a click elsewhere): "Reset colour" still works
    // and removes every colour override in the viewer
    m = entries(hit(1));
    m.Red.run();
    p.apply([2]);
    v.select([]);
    m = entries(null);
    expect(m['Change colour'].enabled).toBe(false);
    expect(m['Reset colour'].enabled).toBe(true);
    m['Reset colour'].run();
    expect(v.getColor(1)).toBeNull();
    expect(v.getColor(2)).toBeNull();
    m = entries(null);
    expect(m['Reset colour'].enabled).toBe(false);
    // ... also when the selection is an uncoloured object; a coloured selection resets only itself
    p.apply([1]);
    m = entries(hit(2));
    expect(m['Reset colour'].enabled).toBe(true);
    m['Reset colour'].run();
    expect(v.getColor(1)).toBeNull();
    p.apply([1, 2]);
    v.select([2]);
    p.reset(); // default: the selection, as it is coloured
    expect(v.getColor(1)).toEqual([1, 0, 0, 1]);
    expect(v.getColor(2)).toBeNull();
    v.select([]);
    p.reset(); // default with nothing coloured selected: every override
    expect(v.getColor(1)).toBeNull();
    // overrides set by the application (or another plugin) are reset too
    v.setColor([2], [0, 1, 0]);
    m = entries(null);
    expect(m['Reset colour'].enabled).toBe(true);
    m['Reset colour'].run();
    expect(v.getColor(2)).toBeNull();
    expect(v.getColoredObjects()).toEqual([]);
    expect(entries(null)['Reset colour'].enabled).toBe(false);
    // the selected object is coloured: only the selection is reset
    p.apply([1]);
    v.setColor([2], [0, 1, 0]);
    m = entries(hit(1));
    m['Reset colour'].run();
    expect(v.getColor(1)).toBeNull();
    expect(v.getColor(2)).toEqual([0, 1, 0, 1]);
    v.setColor([2], null);

    v.removePlugin('color');
    expect(Object.keys(entries(null))).toEqual([]);
  });

  it('options: palette, default colour, labels, no reset entry, name', () => {
    hv = createHeadlessViewer({
      plugins: [
        colorPlugin({
          name: 'paint',
          colors: [
            { label: 'Sky', color: [0.5, 0.8, 1] },
            { label: 'Glass', color: [0, 0, 1, 0.5] },
          ],
          label: 'Paint',
          resetLabel: null,
          order: 3,
        }),
      ],
    });
    const items = hv.viewer.contextMenuAt(0, 0, 'mouse', null).items;
    expect(items.map((e) => [e.label, e.order, e.items!.map((s) => [s.label, s.color])])).toEqual([
      ['Paint', 3, [['Sky', [0.5, 0.8, 1]], ['Glass', [0, 0, 1, 0.5]]]],
    ]);
    const p = hv.viewer.getPlugin<ColorPlugin>('paint')!;
    expect(p.color).toEqual([0.5, 0.8, 1]); // the first palette colour
    expect(p.colors.map((c) => c.label)).toEqual(['Sky', 'Glass']);
    expect(Object.isFrozen(p.colors[0].color)).toBe(true);

    // `color` sets the default of apply() independently of the palette; no palette: no submenu
    const headless = createHeadlessViewer({ plugins: [colorPlugin({ colors: [], color: [0, 0, 1, 0.5] })] });
    expect(headless.viewer.contextMenuAt(0, 0, 'mouse', null).items.map((e) => e.label)).toEqual(['Reset colour']);
    expect(headless.viewer.getPlugin<ColorPlugin>('color')!.color).toEqual([0, 0, 1, 0.5]);
    headless.viewer.dispose();

    expect(() => colorPlugin({ color: [2, 0, 0] })).toThrow(/0\.\.1/);
    expect(() => colorPlugin({ colors: [{ label: 'x', color: [1, 0] as never }] })).toThrow(/colors\[0\]/);
    expect(() => colorPlugin({ colors: [{ color: [1, 0, 0] } as never] })).toThrow(/label/);
    expect(() => colorPlugin({ colors: [] })).toThrow(/empty/);
  });
});

describe('screenshot plugin', () => {
  /** `viewer.getScreenshot` replaced by a spy (the real one needs GL): resolves with an empty blob. */
  const spyScreenshot = (v: object) => {
    const fn = vi.fn((_w: number, _h: number, _o?: unknown) => Promise.resolve(new Blob([])));
    (v as { getScreenshot: typeof fn }).getScreenshot = fn;
    return fn;
  };

  it('installs with default size and option overrides', () => {
    hv = createHeadlessViewer({ plugins: [screenshotPlugin()] });
    const p = hv.viewer.getPlugin<ScreenshotPlugin>('screenshot')!;
    expect(p).toBeDefined();
    expect(p.width).toBe(4000);
    expect(p.height).toBe(3000);
    expect(hv.viewer.plugins).toEqual(['screenshot']);
    hv.dispose();

    hv = createHeadlessViewer({ plugins: [screenshotPlugin({ name: 'shot', width: 1920, height: 1080 })] });
    const q = hv.viewer.getPlugin<ScreenshotPlugin>('shot')!;
    expect(q.width).toBe(1920);
    expect(q.height).toBe(1080);
    q.width = 800;
    q.height = 600;
    expect([q.width, q.height]).toEqual([800, 600]);
    expect(() => (q.width = 0)).toThrow(RangeError);
    expect(() => (q.height = 1.5)).toThrow(RangeError);
    expect([q.width, q.height]).toEqual([800, 600]);
  });

  it('validates the size options', () => {
    expect(() => screenshotPlugin({ width: 0 })).toThrow(RangeError);
    expect(() => screenshotPlugin({ width: 10.5 })).toThrow(/width must be a positive integer/);
    expect(() => screenshotPlugin({ height: -1 })).toThrow(RangeError);
    expect(() => screenshotPlugin({ height: NaN })).toThrow(RangeError);
    expect(() => screenshotPlugin({ width: 1, height: 1 })).not.toThrow();
  });

  it('capture() forwards to viewer.getScreenshot with the type and quality', async () => {
    hv = createHeadlessViewer({ plugins: [screenshotPlugin({ width: 640, height: 480 })] });
    const v = hv.viewer;
    const spy = spyScreenshot(v);
    const p = v.getPlugin<ScreenshotPlugin>('screenshot')!;
    const blob = await p.capture();
    expect(blob).toBeInstanceOf(Blob);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([640, 480, { type: 'image/png' }]);
    await p.capture(100, 50);
    expect(spy.mock.calls[1]).toEqual([100, 50, { type: 'image/png' }]);
    hv.dispose();

    hv = createHeadlessViewer({ plugins: [screenshotPlugin({ type: 'image/jpeg', quality: 0.8 })] });
    const spy2 = spyScreenshot(hv.viewer);
    await hv.viewer.getPlugin<ScreenshotPlugin>('screenshot')!.capture(10, 20);
    expect(spy2.mock.calls[0]).toEqual([10, 20, { type: 'image/jpeg', quality: 0.8 }]);
  });

  it('capture() rejects as the viewer does', async () => {
    hv = createHeadlessViewer({ plugins: [screenshotPlugin()] });
    const v = hv.viewer;
    (v as { getScreenshot: unknown }).getScreenshot = vi.fn(() => Promise.reject(new RangeError('too big')));
    await expect(v.getPlugin<ScreenshotPlugin>('screenshot')!.capture(1e6, 1e6)).rejects.toThrow(RangeError);
  });

  it('open() rejects without a browser window; capture is untouched', async () => {
    hv = createHeadlessViewer({ plugins: [screenshotPlugin()] });
    const v = hv.viewer;
    const spy = spyScreenshot(v);
    const p = v.getPlugin<ScreenshotPlugin>('screenshot')!;
    await expect(p.open()).rejects.toThrow(/needs a browser window/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('dispose: removed with the plugin, capture rejects afterwards', async () => {
    hv = createHeadlessViewer({ plugins: [screenshotPlugin()] });
    const v = hv.viewer;
    spyScreenshot(v);
    const p = v.getPlugin<ScreenshotPlugin>('screenshot')!;
    expect(v.removePlugin('screenshot')).toBe(true);
    expect(v.getPlugin('screenshot')).toBeUndefined();
    await expect(p.capture()).rejects.toThrow(/disposed/);
    p.dispose!(); // idempotent
  });

  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(64_000)).toBe('64 kB');
    expect(formatBytes(1_234_567)).toBe('1.2 MB');
    expect(formatBytes(45_000_000)).toBe('45 MB');
    expect(formatBytes(2_500_000_000)).toBe('2.50 GB');
  });
});

describe('measure overlay geometry', () => {
  it('2D clipping to the canvas', () => {
    const s = new Float64Array([-50, 50, 150, 50]);
    expect(clipSegment2D(s, 0, 0, 100, 100)).toBe(true);
    expect(Array.from(s)).toEqual([0, 50, 100, 50]);
    const out = new Float64Array([-50, -10, 150, -10]);
    expect(clipSegment2D(out, 0, 0, 100, 100)).toBe(false);
    const diag = new Float64Array([-100, -100, 1e9, 1e9]);
    expect(clipSegment2D(diag, 0, 0, 100, 100)).toBe(true);
    expect(diag[0]).toBeCloseTo(0, 6);
    expect(diag[3]).toBeCloseTo(100, 6);
  });

  it('near cut parameter', () => {
    expect(depthCutT(10, -10, 0)).toBe(0.5);
    expect(depthCutT(-5, 15, 1)).toBeCloseTo(0.3, 12);
  });

  it('labels sit on long lines and beside short ones (upper side)', () => {
    const o = new Float64Array(2);
    labelOffset(300, 0, 60, 30, 6, o);
    expect(Array.from(o)).toEqual([0, 0]);
    labelOffset(40, 0, 60, 30, 6, o); // short horizontal line: label above
    expect(o[0]).toBeCloseTo(0, 9);
    expect(o[1]).toBeCloseTo(-21, 9);
    labelOffset(0, 30, 60, 30, 6, o); // short vertical line: label beside (x), never below
    expect(Math.abs(o[0])).toBeCloseTo(36, 9);
    labelOffset(0, 0, 60, 30, 6, o); // zero length: above
    expect(o[1]).toBeCloseTo(-21, 9);
  });
});

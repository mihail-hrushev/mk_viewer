/**
 * Viewer plugin system, the active-tool mechanism, worldToScreen and the measurement plugin's
 * headless API, on the real Viewer (headless, no DOM / GL).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from '../__tests__/headlessViewer';
import type { ToolEndReason, ViewerTool } from '../types';
import type { ViewerUi } from '../ui/ViewerUi';
import type { ViewerPlugin } from './types';
import { measurePlugin, type MeasurePlugin, type Measurement } from './measure/measurePlugin';
import { clipSegment2D, depthCutT, formatDistance, labelOffset } from './measure/geometry';

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

  it('ui hook adds a toggle and a menu item, and removes them again', () => {
    hv = createHeadlessViewer({ plugins: [measurePlugin()] });
    const m = hv.viewer.getPlugin<MeasurePlugin>('measure')!;
    const toggle = { element: {} as HTMLButtonElement, on: false, removed: false, remove() { this.removed = true; } };
    let item: { label: string; enabled?: (s: number[]) => boolean; onClick: (s: number[]) => void } | null = null;
    let onClick: (() => void) | null = null;
    const fakeUi = {
      addToggle: (b: { onClick: () => void }) => {
        onClick = b.onClick;
        return toggle;
      },
      addMenuItem: (i: typeof item) => {
        item = i;
        return () => (item = null);
      },
    } as unknown as ViewerUi;
    const cleanup = m.ui!(fakeUi) as () => void;
    expect(item!.label).toBe('Clear measurements');
    expect(item!.enabled!([])).toBe(false);
    m.add([0, 0, 0], [1, 0, 0]);
    expect(item!.enabled!([])).toBe(true);
    onClick!();
    expect(m.active).toBe(true);
    expect(toggle.on).toBe(true);
    m.deactivate();
    expect(toggle.on).toBe(false);
    item!.onClick([]);
    expect(m.measurements.length).toBe(0);
    cleanup();
    expect(toggle.removed).toBe(true);
    expect(item).toBeNull();
  });

  it('custom format, deltas option and name', () => {
    hv = createHeadlessViewer({ plugins: [measurePlugin({ name: 'ruler', format: (d) => `${(d * 1000).toFixed(0)} mm` })] });
    const m = hv.viewer.getPlugin<MeasurePlugin>('ruler')!;
    expect(m.format(1.2345)).toBe('1235 mm');
    expect(formatDistance(2, 3, '')).toBe('2.000');
    expect(formatDistance(2.5, 1, 'ft')).toBe('2.5 ft');
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

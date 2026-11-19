/**
 * Model-level visibility (`model.visible`) and the `visibility` event, on the real Viewer in node:
 * the flag follows model.setVisible / isolate, viewer.showAll and object-level isolate / setVisible,
 * which is what the eyes of the model tree and the Models panel mirror.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from './__tests__/headlessViewer';
import type { LoaderPlugin, Model } from './loaders';
import { box } from './primitives';
import type { VisibilityChange } from './types';

/** n boxes, one object each. */
const boxes: LoaderPlugin<{ n: number }> = {
  name: 'boxes',
  extensions: ['boxes'],
  up: 'y',
  async load(_source, ctx) {
    const n = ctx.options.n ?? 3;
    const g = ctx.createGeometry(box([1, 1, 1]));
    const mat = ctx.createMaterial({ color: [0.5, 0.5, 0.5] });
    const first = ctx.allocObjectIds(n);
    const root = ctx.hierarchy.addNode(-1, 'root');
    for (let i = 0; i < n; i++) {
      const t = new Float64Array(16);
      t[0] = t[5] = t[10] = t[15] = 1;
      t[12] = i * 2;
      ctx.addMesh({ geometry: g, material: mat, transform: t, objectId: first + i });
      ctx.hierarchy.addNode(root, `box ${i}`, first + i);
    }
  },
};

let hv: HeadlessViewer | null = null;
afterEach(() => {
  hv?.dispose();
  hv = null;
});

async function setup(): Promise<{ a: Model; b: Model; events: VisibilityChange[] }> {
  hv = createHeadlessViewer({ loaders: [boxes] });
  const v = hv.viewer;
  const a = await v.load(new Uint8Array(1), { name: 'a.boxes', options: { n: 3 } });
  const b = await v.load(new Uint8Array(1), { name: 'b.boxes', options: { n: 4 } });
  const events: VisibilityChange[] = [];
  v.on('visibility', (e) => events.push(e));
  return { a, b, events };
}

const first = (m: Model) => m.objectIdRange.first;

describe('model visibility', () => {
  it('model.setVisible emits visibility with the flag already updated', async () => {
    const { a, b, events } = await setup();
    const seen: boolean[] = [];
    hv!.viewer.on('visibility', () => seen.push(a.visible));
    a.setVisible(false);
    expect(a.visible).toBe(false);
    expect(b.visible).toBe(true);
    expect(events.map((e) => e.cause)).toEqual(['setVisible']);
    expect(seen).toEqual([false]);
  });

  it('showAll and isolate(null) show every model again', async () => {
    const { a, b, events } = await setup();
    a.setVisible(false);
    b.setVisible(false);
    hv!.viewer.showAll();
    expect([a.visible, b.visible]).toEqual([true, true]);
    expect(events[events.length - 1]?.cause).toBe('showAll');
    a.setVisible(false);
    hv!.viewer.isolate(null);
    expect(a.visible).toBe(true);
    expect(events[events.length - 1]?.cause).toBe('isolate');
  });

  it('isolate hiding the rest hides models without isolated objects; ghosting keeps them', async () => {
    const { a, b } = await setup();
    const v = hv!.viewer;
    v.isolate([first(a) + 1], true);
    expect([a.visible, b.visible]).toEqual([true, false]);
    v.isolate({ first: first(b), count: 2 }, true);
    expect([a.visible, b.visible]).toEqual([false, true]);
    v.isolate(first(a), false); // ghost mode: b stays as it is (shown), a is shown again
    expect([a.visible, b.visible]).toEqual([true, true]);
    b.isolate(true);
    expect([a.visible, b.visible]).toEqual([false, true]);
  });

  it('object-level setVisible: showing any object shows its model, hiding objects does not hide it', async () => {
    const { a, b } = await setup();
    const v = hv!.viewer;
    v.setVisible(a.objectIds(), false);
    expect(a.visible).toBe(true);
    a.setVisible(false);
    v.setVisible([first(a) + 2], true);
    expect(a.visible).toBe(true);
    b.setVisible(false);
    v.setVisible({ first: first(b) + 1, count: 1 }, true);
    expect(b.visible).toBe(true);
  });
});

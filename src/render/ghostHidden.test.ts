/**
 * Ghost-hidden mode: the Hidden flag kept by the scene, the ghostHidden uber pass, the BVH
 * traversal that keeps fully hidden draw items, and the public setGhostHidden / getGhostHidden
 * (node, fake GL; the pixels are checked in a browser, see CLAUDE.md).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from '../__tests__/headlessViewer';
import { DrawList, type CullView } from '../core/DrawBVH';
import { FragFlags } from '../layout';
import { createFakeContext } from '../gl/__tests__/fakeGl';
import { UberProgram, applyPassState } from '../gl/UberProgram';
import { LAYOUT_CONSTANTS } from '../gl/shaders/common';

const V = FragFlags.Visible;
const G = FragFlags.Ghosted;
const H = FragFlags.Hidden;

/** A view that accepts everything (zero normals, positive d) and skips no item for size. */
function everything(): CullView {
  const planes = new Float32Array(24);
  for (let p = 0; p < 6; p++) planes[p * 4 + 3] = 1;
  return { planes, eye: [0, 0, 0], orthographic: false, pixelScale: 1, pixelThreshold: 0 };
}

describe('Hidden flag', () => {
  let hv: HeadlessViewer | null = null;
  afterEach(() => {
    hv?.dispose();
    hv = null;
  });

  it('is a new bit, mirrored into the GLSL constants', () => {
    expect(H & (V | FragFlags.Selected | G | FragFlags.Highlighted | FragFlags.NotPickable)).toBe(0);
    expect(LAYOUT_CONSTANTS).toContain(`const uint FLAG_HIDDEN = ${H}u;`);
  });

  it('replaces Visible while an object is hidden, by setVisible, isolate and showAll; removed slots have no flags', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const g = v.primitives.box();
    const m = v.createMaterial();
    const a = v.addMesh({ geometry: g, material: m, objectId: 1 });
    const b = v.addMesh({ geometry: g, material: m, objectId: 2 });
    const c = v.addMesh({ geometry: g, material: m, objectId: 3 });
    const flags = v.scene.fragments.flags;
    expect(flags[a]).toBe(V);

    v.setVisible(1, false);
    expect(flags[a]).toBe(H);
    v.setVisible(1, true);
    expect(flags[a]).toBe(V);

    v.isolate(2, true); // others hidden
    expect(flags[a]).toBe(H);
    expect(flags[b]).toBe(V);
    expect(flags[c]).toBe(H);
    v.isolate(3); // others ghosted: hidden ones stay hidden (and ghosted)
    expect(flags[a]).toBe(H | G);
    expect(flags[b]).toBe(V | G);
    expect(flags[c]).toBe(V);
    v.showAll();
    expect([flags[a], flags[b], flags[c]]).toEqual([V, V, V]);

    v.setVisible([1, 2], false);
    v.select([1]); // other bits survive hiding
    expect(flags[a]).toBe(H | FragFlags.Selected);
    v.remove(a);
    expect(flags[a]).toBe(0);
    expect(flags[b]).toBe(H);
  });
});

describe('ghostHidden pass', () => {
  it('draws hidden fragments of any material, ghost shading, blended, no ids', () => {
    const { ctx, fake } = createFakeContext();
    const gl = ctx.gl;
    const p = new UberProgram(ctx);
    fake.reset();
    p.setPass('ghostHidden', false);
    expect(fake.callsOf('uniform1ui').map((c) => c.args[1])).toEqual([V | H, H]);
    const ints = fake.callsOf('uniform1i').map((c) => [(c.args[0] as { uniform: string }).uniform, c.args[1]]);
    expect(ints).toContainEqual(['u_passKind', 2]); // PassKind.Ghost
    expect(ints).toContainEqual(['u_writeId', 0]);
    expect(ints).toContainEqual(['u_materialFilter', 0]);
    // the plain ghost pass is unchanged
    fake.reset();
    p.setPass('ghost', false);
    expect(fake.callsOf('uniform1ui').map((c) => c.args[1])).toEqual([V | G, V | G]);

    const modes: string[] = [];
    const targets = { setDrawBuffers: (m: string) => modes.push(m) };
    applyPassState(ctx, targets, 'opaque');
    fake.reset();
    modes.length = 0;
    applyPassState(ctx, targets, 'ghostHidden');
    expect(modes).toEqual(['color']);
    const last = (name: string) => fake.callsOf(name).slice(-1)[0]?.args[0];
    expect(last('depthFunc')).toBe(gl.LEQUAL);
    expect(last('depthMask')).toBe(false);
    expect(fake.callsOf('enable').some((c) => c.args[0] === gl.BLEND)).toBe(true);
    p.dispose();
  });
});

describe('Viewer.setGhostHidden', () => {
  let hv: HeadlessViewer | null = null;
  afterEach(() => {
    hv?.dispose();
    hv = null;
  });

  it('defaults off, switches the renderer, can start on through ViewerOptions', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    expect(v.getGhostHidden()).toBe(false);
    expect(v.renderer.isGhostHidden).toBe(false);
    v.setGhostHidden(true);
    expect(v.getGhostHidden()).toBe(true);
    expect(v.renderer.isGhostHidden).toBe(true);
    v.setGhostHidden(false);
    expect(v.renderer.isGhostHidden).toBe(false);
    hv.dispose();
    hv = createHeadlessViewer({ ghostHidden: true });
    expect(hv.viewer.getGhostHidden()).toBe(true);
  });

  it('counts hidden fragments and runs the extra ghost pass only in the mode and with something hidden', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const g = v.primitives.box();
    const m = v.createMaterial();
    for (let i = 0; i < 4; i++) v.addMesh({ geometry: g, material: m, objectId: 10 + i });
    hv.frame();
    const r = v.renderer as unknown as { ghostPassCount(): number; ghostPass(k: number): string };
    const host = v as unknown as { hiddenCount(): number; ghostCount(): number };
    expect(host.hiddenCount()).toBe(0);
    expect(r.ghostPassCount()).toBe(0);

    v.setVisible([10, 11], false);
    expect(host.hiddenCount()).toBe(2);
    expect(r.ghostPassCount()).toBe(0); // mode off: hidden stays hidden
    v.setGhostHidden(true);
    expect(r.ghostPassCount()).toBe(1);
    expect(r.ghostPass(0)).toBe('ghostHidden');

    v.isolate(12); // 13 ghosted; 10, 11 still hidden
    expect(host.ghostCount()).toBe(1);
    expect(host.hiddenCount()).toBe(2);
    expect(r.ghostPassCount()).toBe(2);
    expect([r.ghostPass(0), r.ghostPass(1)]).toEqual(['ghost', 'ghostHidden']);

    v.showAll();
    expect(host.hiddenCount()).toBe(0);
    expect(r.ghostPassCount()).toBe(0);
  });

  it('keeps fully hidden draw items in the traversal only in the mode', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const g = v.primitives.box();
    const m = v.createMaterial();
    const ids = [20, 21, 22].map((objectId) => v.addMesh({ geometry: g, material: m, objectId }));
    hv.frame();
    const list = new DrawList();
    const view = everything();
    const itemsOf = (): number[] => {
      v.scene.traverse(view, list);
      return Array.from(list.item.subarray(0, list.length)).sort();
    };
    const all = itemsOf();
    expect(all.length).toBeGreaterThan(0);

    v.setVisible([20, 21, 22], false);
    expect(itemsOf()).toEqual([]);
    view.includeHidden = true;
    expect(itemsOf()).toEqual(all);
    // the near-plane query sees the hidden content too
    const bvh = v.scene.bvh;
    const items = v.scene.items;
    expect(bvh.visibleDepthMax(items, 0, 0, -1, 10, 0, 0, 0, 1, 0)).toBe(-Infinity);
    expect(bvh.visibleDepthMax(items, 0, 0, -1, 10, 0, 0, 0, 1, 0, true)).toBeGreaterThan(0);
    // a removed mesh is not revived: its item goes once the last member is gone
    v.remove(ids);
    hv.frame();
    expect(itemsOf()).toEqual([]);
  });
});

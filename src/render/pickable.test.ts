/**
 * Not-pickable meshes: `MeshParams.pickable`, `MeshBatchParams.pickable`, `Viewer.setPickable`, the
 * NotPickable flag surviving every other flag update, and the uber passes that keep such fragments
 * out of the id buffer (node, fake GL; the pixels are checked in a browser, see CLAUDE.md).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from '../__tests__/headlessViewer';
import { FragFlags } from '../layout';
import { createFakeContext } from '../gl/__tests__/fakeGl';
import { UberProgram } from '../gl/UberProgram';
import { LAYOUT_CONSTANTS } from '../gl/shaders/common';
import { uberFragmentSource } from '../gl/shaders/uber';

const V = FragFlags.Visible;
const G = FragFlags.Ghosted;
const S = FragFlags.Selected;
const N = FragFlags.NotPickable;

describe('pickable', () => {
  let hv: HeadlessViewer | null = null;
  afterEach(() => {
    hv?.dispose();
    hv = null;
  });

  it('MeshParams.pickable false sets NotPickable; default and true do not', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const g = v.primitives.box();
    const m = v.createMaterial({ color: [1, 0, 0, 0.3] });
    const a = v.addMesh({ geometry: g, material: m, objectId: 1, pickable: false });
    const b = v.addMesh({ geometry: g, material: m, objectId: 2 });
    const c = v.addMesh({ geometry: g, material: m, objectId: 3, pickable: true });
    const flags = v.scene.fragments.flags;
    expect(flags[a]).toBe(V | N);
    expect(flags[b]).toBe(V);
    expect(flags[c]).toBe(V);
    hv.frame();
    expect(flags[a]).toBe(V | N);
  });

  it('MeshBatchParams.pickable false applies to every instance', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const g = v.primitives.box();
    const m = v.createMaterial();
    const t = new Float64Array(16 * 3);
    for (let i = 0; i < 3; i++) t.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i * 2, 0, 0, 1], i * 16);
    const first = v.addMeshes({ geometry: g, material: m, transforms: t, pickable: false });
    const other = v.addMeshes({ geometry: g, material: m, transforms: t });
    const flags = v.scene.fragments.flags;
    for (let i = 0; i < 3; i++) {
      expect(flags[first + i]).toBe(V | N);
      expect(flags[other + i]).toBe(V);
    }
  });

  it('setPickable toggles the flag and survives visibility, isolation, selection and hover', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const g = v.primitives.box();
    const m = v.createMaterial();
    const a = v.addMesh({ geometry: g, material: m, objectId: 1 });
    const a2 = v.addMesh({ geometry: g, material: m, objectId: 1 });
    const b = v.addMesh({ geometry: g, material: m, objectId: 2 });
    const flags = v.scene.fragments.flags;

    v.setPickable(1, false);
    expect([flags[a], flags[a2], flags[b]]).toEqual([V | N, V | N, V]);

    v.setVisible(1, false);
    v.setVisible(1, true);
    expect(flags[a]).toBe(V | N);
    v.isolate(2);
    expect(flags[a]).toBe(V | G | N);
    v.isolate(1, true);
    expect(flags[a]).toBe(V | N);
    v.showAll();
    expect(flags[a]).toBe(V | N);
    v.select([1]);
    expect(flags[a]).toBe(V | S | N);
    v.select([]);
    v.scene.setHighlighted(1);
    v.scene.setHighlighted(null);
    v.setColor(1, [0, 1, 0]);
    expect(flags[a]).toBe(V | N);

    v.setPickable([1, 2], true);
    expect([flags[a], flags[a2], flags[b]]).toEqual([V, V, V]);
    v.setPickable({ first: 2, count: 1 }, false);
    expect(flags[b]).toBe(V | N);
  });
});

describe('uber passes and NotPickable', () => {
  it('is a GLSL constant and the fragment shader writes id 0 for it', () => {
    expect(LAYOUT_CONSTANTS).toContain(`const uint FLAG_NOT_PICKABLE = ${N}u;`);
    expect(uberFragmentSource()).toContain('FLAG_NOT_PICKABLE | FLAG_GHOSTED');
  });

  it('transparentId and selectedId drop not-pickable fragments (no id, no depth); colour passes keep them', () => {
    const { ctx, fake } = createFakeContext();
    const p = new UberProgram(ctx);
    const filter = (pass: Parameters<UberProgram['setPass']>[0]) => {
      fake.reset();
      p.setPass(pass, false);
      return fake.callsOf('uniform1ui').map((c) => c.args[1] as number);
    };
    const [tMask, tValue] = filter('transparentId');
    expect(tMask & N).toBe(N);
    expect(tValue & N).toBe(0);
    const [sMask, sValue] = filter('selectedId');
    expect(sMask & N).toBe(N);
    expect(sValue & N).toBe(0);
    for (const pass of ['opaque', 'transparent', 'ghost'] as const) {
      expect(filter(pass)[0] & N).toBe(0); // still drawn
    }
    p.dispose();
  });
});

/**
 * Selection x-ray: the border shader, the colourless render target, the selectedId pass, the public
 * setSelectionXray / getSelectionXray and the renderer's collection of the draw items holding
 * selected fragments (node, fake GL; the pixels are checked in a browser, see CLAUDE.md).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from '../__tests__/headlessViewer';
import { FragFlags } from '../layout';
import { createFakeContext } from './__tests__/fakeGl';
import { RenderTargets } from './RenderTargets';
import { UberProgram, applyPassState } from './UberProgram';
import { COMPOSITE_FS, XRAY_FS, compositeFragmentSource } from './shaders/post';

describe('x-ray border shader', () => {
  it('marks the selected / not selected boundary within the radius and nothing else', () => {
    const x = XRAY_FS;
    for (const u of ['u_idTex', 'u_color', 'u_radius', 'u_offset']) expect(x).toContain(u);
    expect(x).toContain('for (int d = 1; d <= u_radius');
    expect(x).toContain('!= 0u) != selected');
    expect(x).toContain('if (!border) discard;');
    // borders only: no depth / normal / crease detection, no colour sampling
    for (const u of ['u_depthTex', 'u_normalTex', 'u_edgeParams', 'u_colorTex', 'edgeWeight']) expect(x).not.toContain(u);
    expect((x.match(/\{/g) ?? []).length).toBe((x.match(/\}/g) ?? []).length);
    // the edge display of the composite is untouched by the refactor
    expect(compositeFragmentSource({ edges: true })).toContain('float edgeWeight(ivec2 p, uint idc)');
    expect(COMPOSITE_FS).not.toContain('#define EDGES');
  });
});

describe('RenderTargets without a colour attachment', () => {
  it('allocates depth and ids only; all mode is id; colour is never cleared', () => {
    const { ctx, fake } = createFakeContext();
    const gl = ctx.gl;
    const t = new RenderTargets(ctx, { color: false });
    expect(t.hasColor).toBe(false);
    t.resize(100, 50);
    expect(t.colorTex).toBeNull();
    expect(t.idTex).not.toBeNull();
    expect(t.normalTex).toBeNull();
    expect(t.depthTex).not.toBeNull();
    expect(ctx.memory.renderTargets).toBe(100 * 50 * 8);
    expect(fake.callsOf('texStorage2D').filter((c) => c.args[2] === gl.RGBA8).length).toBe(1); // ids only

    fake.reset();
    t.setDrawBuffers('color');
    t.setDrawBuffers('all');
    t.setDrawBuffers('none');
    const lists = fake.callsOf('drawBuffers').map((c) => c.args[0]);
    expect(lists).toEqual([
      [gl.COLOR_ATTACHMENT0, gl.NONE],
      [gl.NONE, gl.COLOR_ATTACHMENT1],
      [gl.NONE, gl.NONE],
    ]);
    fake.reset();
    t.clear();
    expect(fake.callsOf('clearBufferfv').map((c) => c.args[1])).toEqual([1, 0]);
    // with normals (10 bytes per pixel)
    t.setNormals(true);
    expect(ctx.memory.renderTargets).toBe(100 * 50 * 10);
    t.dispose();
    expect(ctx.memory.renderTargets).toBe(0);
  });

  it('a default target still has colour', () => {
    const { ctx } = createFakeContext();
    const t = new RenderTargets(ctx);
    expect(t.hasColor).toBe(true);
    t.resize(10, 10);
    expect(t.colorTex).not.toBeNull();
    expect(ctx.memory.renderTargets).toBe(10 * 10 * 12);
    t.dispose();
  });
});

describe('selectedId pass', () => {
  it('draws visible, selected, non-ghosted fragments of any material with ids, depth LESS, no blend', () => {
    const { ctx, fake } = createFakeContext();
    const gl = ctx.gl;
    const p = new UberProgram(ctx);
    fake.reset();
    p.setPass('selectedId', false);
    const u1ui = fake.callsOf('uniform1ui').map((c) => c.args[1]);
    expect(u1ui).toEqual([FragFlags.Visible | FragFlags.Ghosted | FragFlags.Selected, FragFlags.Visible | FragFlags.Selected]);
    const modes: string[] = [];
    const targets = { setDrawBuffers: (m: string) => modes.push(m) };
    applyPassState(ctx, targets, 'transparent'); // LEQUAL, no depth write, blend on
    fake.reset();
    modes.length = 0;
    applyPassState(ctx, targets, 'selectedId');
    expect(modes).toEqual(['id']);
    const last = (name: string) => fake.callsOf(name).slice(-1)[0]?.args[0];
    expect(last('depthFunc')).toBe(gl.LESS);
    expect(last('depthMask')).toBe(true);
    expect(fake.callsOf('disable').some((c) => c.args[0] === gl.BLEND)).toBe(true);
    p.dispose();
  });
});

describe('Viewer.setSelectionXray', () => {
  let hv: HeadlessViewer | null = null;
  afterEach(() => {
    hv?.dispose();
    hv = null;
  });

  it('defaults off; on with the outline colour and a 2 px line; options validated; off again', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    expect(v.getSelectionXray()).toBeNull();
    v.setSelectionXray(true);
    expect(v.getSelectionXray()).toEqual({ color: [1, 0.62, 0.1], opacity: 1, width: 2 });
    expect(v.getEdges()).toBeNull(); // independent of the edge display
    v.setSelectionXray(true, { color: [0, 1, 0], opacity: 0.5, width: 4 });
    expect(v.getSelectionXray()).toEqual({ color: [0, 1, 0], opacity: 0.5, width: 4 });
    expect(() => v.setSelectionXray(true, { opacity: -1 })).toThrow(RangeError);
    expect(() => v.setSelectionXray(true, { width: 0 })).toThrow(RangeError);
    expect(() => v.setSelectionXray(true, { width: 9 })).toThrow(RangeError);
    expect(() => v.setSelectionXray(true, { color: [2, 0, 0] })).toThrow(RangeError);
    expect(v.getSelectionXray()?.width).toBe(4);
    v.setSelectionXray(false);
    expect(v.getSelectionXray()).toBeNull();
  });

  it('can start on through ViewerOptions.selectionXray', () => {
    hv = createHeadlessViewer({ selectionXray: { width: 3 } });
    expect(hv.viewer.getSelectionXray()).toEqual({ color: [1, 0.62, 0.1], opacity: 1, width: 3 });
  });

  it('collects the draw items of the selected objects once each, after batching', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    const g = v.primitives.box();
    const m = v.createMaterial();
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(v.addMesh({ geometry: g, material: m, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i * 3, 0, 0, 1], objectId: 100 + i }));
    }
    // two meshes of one object
    ids.push(v.addMesh({ geometry: g, material: m, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1], objectId: 100 }));
    hv.frame();
    const frags: number[] = [];
    v.select([100, 103]);
    v.scene.forEachSelectedFragment((f) => frags.push(f));
    expect(frags.sort((a, b) => a - b)).toEqual([ids[0], ids[3], ids[6]].sort((a, b) => a - b));

    // the renderer's item list: each item once, whatever the number of selected fragments in it
    const r = v.renderer as unknown as { collectXrayItems(): void; xrayItemCount: number; xrayItems: Int32Array };
    r.collectXrayItems();
    const items = new Set<number>();
    for (const f of frags) items.add(v.scene.fragments.item[f]);
    expect(r.xrayItemCount).toBe(items.size);
    expect(Array.from(r.xrayItems.subarray(0, r.xrayItemCount)).sort()).toEqual([...items].sort());
    for (const it of items) expect(it).toBeGreaterThanOrEqual(0);

    v.select([]);
    r.collectXrayItems();
    expect(r.xrayItemCount).toBe(0);
  });
});

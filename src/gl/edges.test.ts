/**
 * Edge display: shader variants, the optional normal attachment and the public setEdges / getEdges
 * (node, fake GL; the pixels are checked in a browser, see CLAUDE.md).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from '../__tests__/headlessViewer';
import { createFakeContext } from './__tests__/fakeGl';
import { RenderTargets } from './RenderTargets';
import { COMPOSITE_FS, compositeFragmentSource } from './shaders/post';
import { uberFragmentSource } from './shaders/uber';

describe('edge display shaders', () => {
  it('only the EDGES variants write normals / detect edges', () => {
    expect(uberFragmentSource()).not.toContain('#define EDGES');
    expect(uberFragmentSource({ edges: false })).toBe(uberFragmentSource());
    const fs = uberFragmentSource({ edges: true, sectionPlanes: true, environment: true });
    expect(fs).toContain('#define EDGES 1');
    expect(fs).toContain('layout(location = 2) out vec4 o_normal;');
    // derivatives are taken before the section-plane discard
    expect(fs.indexOf('dFdx(v_viewPos)')).toBeLessThan(fs.indexOf('discard;'));
    expect(COMPOSITE_FS).not.toContain('#define EDGES');
    expect(compositeFragmentSource()).toBe(COMPOSITE_FS);
    const c = compositeFragmentSource({ edges: true });
    expect(c).toContain('#define EDGES 1');
    for (const u of ['u_depthTex', 'u_normalTex', 'u_edgeColor', 'u_edgeParams', 'u_edgePixel']) expect(c).toContain(u);
    expect((c.match(/\{/g) ?? []).length).toBe((c.match(/\}/g) ?? []).length);
  });
});

describe('RenderTargets normal attachment', () => {
  it('exists only while enabled and joins the all / id draw buffers', () => {
    const { ctx, fake } = createFakeContext();
    const gl = ctx.gl;
    const t = new RenderTargets(ctx);
    t.resize(100, 50);
    expect(t.normalTex).toBeNull();
    expect(ctx.memory.renderTargets).toBe(100 * 50 * 12);

    expect(t.setNormals(true)).toBe(true);
    expect(t.setNormals(true)).toBe(false);
    expect(t.normalTex).not.toBeNull();
    expect(ctx.memory.renderTargets).toBe(100 * 50 * 14);
    expect(fake.callsOf('texStorage2D').some((c) => c.args[2] === gl.RG8)).toBe(true);

    fake.reset();
    t.setDrawBuffers('color');
    t.setDrawBuffers('all');
    t.setDrawBuffers('id');
    const lists = fake.callsOf('drawBuffers').map((c) => c.args[0]);
    expect(lists).toEqual([
      [gl.COLOR_ATTACHMENT0, gl.NONE, gl.NONE],
      [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2],
      [gl.NONE, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2],
    ]);

    fake.reset();
    t.clear();
    expect(fake.callsOf('clearBufferfv').map((c) => c.args[1])).toEqual([0, 1, 2, 0]);

    expect(t.setNormals(false)).toBe(true);
    expect(t.normalTex).toBeNull();
    expect(ctx.memory.renderTargets).toBe(100 * 50 * 12);
    fake.reset();
    t.clear();
    expect(fake.callsOf('clearBufferfv').map((c) => c.args[1])).toEqual([0, 1, 0]);
    t.dispose();
  });
});

describe('Viewer.setEdges', () => {
  let hv: HeadlessViewer | null = null;
  afterEach(() => {
    hv?.dispose();
    hv = null;
  });

  it('defaults off; on with defaults; options validated; off again', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    expect(v.getEdges()).toBeNull();
    v.setEdges(true);
    expect(v.getEdges()).toEqual({ color: [0.1, 0.1, 0.1], opacity: 0.75, creaseAngle: 20 });
    expect(v.renderer.targets.hasNormals).toBe(true);
    v.setEdges(true, { color: [1, 0, 0], opacity: 0.5, creaseAngle: 45 });
    expect(v.getEdges()).toEqual({ color: [1, 0, 0], opacity: 0.5, creaseAngle: 45 });
    expect(() => v.setEdges(true, { opacity: 2 })).toThrow(RangeError);
    expect(() => v.setEdges(true, { creaseAngle: 0 })).toThrow(RangeError);
    expect(() => v.setEdges(true, { color: [2, 0, 0] })).toThrow(RangeError);
    expect(v.getEdges()?.creaseAngle).toBe(45); // a rejected call changes nothing
    v.setEdges(false);
    expect(v.getEdges()).toBeNull();
    expect(v.renderer.targets.hasNormals).toBe(false);
  });

  it('can start on through ViewerOptions.edges', () => {
    hv = createHeadlessViewer({ edges: { opacity: 1 } });
    expect(hv.viewer.getEdges()).toEqual({ color: [0.1, 0.1, 0.1], opacity: 1, creaseAngle: 20 });
  });
});

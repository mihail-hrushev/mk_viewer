import { describe, expect, it } from 'vitest';
import { FRAG_FLOATS, FRAG_TEX_WIDTH, MERGED_VERTEX_STRIDE } from '../layout';
import { createFakeContext } from './__tests__/fakeGl';
import { DataTexture } from './DataTexture';
import { DirtyRanges } from './DirtyRanges';
import { DrawSubmitter } from './DrawSubmitter';
import { GeometryVao } from './GeometryVao';
import { MirroredBuffer } from './MirroredBuffer';

describe('MirroredBuffer', () => {
  it('reallocates on growth and uploads only dirty byte ranges', () => {
    const { ctx, fake } = createFakeContext();
    const buf = new MirroredBuffer(ctx, 'vertex');
    const page = new Float32Array(100); // 400 bytes
    expect(buf.setSource(page)).toBe(true);
    expect(buf.byteCapacity).toBe(400);
    expect(ctx.memory.buffers).toBe(400);
    expect(fake.callsOf('bufferData')).toHaveLength(1);

    fake.reset();
    expect(buf.setSource(page)).toBe(false);
    const ranges = new DirtyRanges();
    ranges.add(8, 16);
    ranges.add(100, 104);
    buf.uploadRanges(ranges);
    const subs = fake.callsOf('bufferSubData');
    expect(subs.map((c) => [c.args[1], c.args[3], c.args[4]])).toEqual([
      [8, 8, 8],
      [100, 100, 4],
    ]);
    // byte view of the source
    expect(subs[0].args[2]).toBeInstanceOf(Uint8Array);

    fake.reset();
    buf.upload(390, 9999); // clamped
    expect(fake.callsOf('bufferSubData')[0].args.slice(3)).toEqual([390, 10]);

    // growth keeps the same buffer object
    const b0 = buf.buffer;
    expect(buf.setSource(new Float32Array(200))).toBe(true);
    expect(buf.buffer).toBe(b0);
    expect(ctx.memory.buffers).toBe(800);
    buf.dispose();
    expect(ctx.memory.buffers).toBe(0);
  });

  it('binds index buffers with no VAO bound', () => {
    const { ctx, fake } = createFakeContext();
    const vb = new MirroredBuffer(ctx, 'vertex');
    const ib = new MirroredBuffer(ctx, 'index');
    vb.setSource(new Uint8Array(MERGED_VERTEX_STRIDE * 3));
    ib.setSource(new Uint32Array(3));
    const vao = GeometryVao.merged(ctx, vb, ib);
    vao.bind();
    fake.reset();
    ib.upload(0, 4);
    const names = fake.calls.map((c) => c.name);
    expect(names.indexOf('bindVertexArray')).toBeLessThan(names.indexOf('bindBuffer'));
    expect(fake.callsOf('bindVertexArray')[0].args[0]).toBe(null);
  });
});

describe('DataTexture', () => {
  it('uploads full rows and a partial last row', () => {
    const { ctx, fake } = createFakeContext();
    const tex = new DataTexture(ctx, FRAG_TEX_WIDTH, 'frag');
    const rowFloats = FRAG_TEX_WIDTH * 4;
    // 2.5 rows of data
    const data = new Float32Array(rowFloats * 2 + rowFloats / 2);
    expect(tex.setSource(data)).toBe(true);
    expect(tex.height).toBe(3);
    const subs = fake.callsOf('texSubImage2D');
    // rows 0..1 full, row 2 partial (half width)
    expect(subs.map((c) => [c.args[3], c.args[4], c.args[5], c.args[9]])).toEqual([
      [0, FRAG_TEX_WIDTH, 2, 0],
      [2, FRAG_TEX_WIDTH / 2, 1, rowFloats * 2],
    ]);

    fake.reset();
    // record 600 lives in row 1 (512 records per row)
    tex.uploadRecords(600, 601, FRAG_FLOATS);
    const s = fake.callsOf('texSubImage2D');
    expect(s).toHaveLength(1);
    expect(s[0].args.slice(3, 6)).toEqual([1, FRAG_TEX_WIDTH, 1]);
    expect(s[0].args[9]).toBe(rowFloats);
    expect(ctx.memory.textures).toBe(FRAG_TEX_WIDTH * 3 * 16);
  });

  it('refuses widths above MAX_TEXTURE_SIZE', () => {
    const { ctx } = createFakeContext({ maxTextureSize: 2048 });
    expect(() => new DataTexture(ctx, FRAG_TEX_WIDTH)).toThrow(/MAX_TEXTURE_SIZE/);
  });
});

describe('DrawSubmitter', () => {
  it('issues one multiDraw with byte offsets and fuses adjacent ranges', () => {
    const { ctx, fake } = createFakeContext({ multiDraw: true });
    const d = new DrawSubmitter(ctx);
    d.push(0, 30);
    d.push(30, 6); // adjacent -> fused
    d.push(100, 12);
    d.push(200, 0); // ignored
    d.flush();
    const md = fake.callsOf('multiDrawElementsWEBGL');
    expect(md).toHaveLength(1);
    expect(md[0].args[1]).toEqual([36, 12, ...new Array(254).fill(0)]);
    expect((md[0].args[4] as number[]).slice(0, 2)).toEqual([0, 400]);
    expect(md[0].args[6]).toBe(2);
    expect(d.drawCalls).toBe(1);
    expect(d.indicesDrawn).toBe(48);
    expect(fake.callsOf('drawElements')).toHaveLength(0);
  });

  it('falls back to a loop without the extension and grows scratch without losing data', () => {
    const { ctx, fake } = createFakeContext({ multiDraw: false });
    const d = new DrawSubmitter(ctx);
    for (let i = 0; i < 600; i++) d.push(i * 10, 3);
    d.flush();
    const de = fake.callsOf('drawElements');
    expect(de).toHaveLength(600);
    expect(de[599].args[1]).toBe(3);
    expect(de[599].args[3]).toBe(5990 * 4);
    expect(d.drawCalls).toBe(600);
    expect(d.pending).toBe(0);
  });

  it('instanced draws re-point the instance attribute only when the start changes', () => {
    const { ctx, fake } = createFakeContext();
    const vb = new MirroredBuffer(ctx, 'vertex');
    const ib = new MirroredBuffer(ctx, 'index');
    const inst = new MirroredBuffer(ctx, 'instance');
    vb.setSource(new Uint8Array(64));
    ib.setSource(new Uint32Array(36));
    inst.setSource(new Uint32Array(100));
    const vao = GeometryVao.instanced(ctx, vb, ib, inst);
    const d = new DrawSubmitter(ctx);
    fake.reset();
    d.drawInstancedRanges(vao, [0, 0, 6], [36, 36, 30], [0, 10, 10], [10, 20, 5], 0, 3);
    const ptr = fake.callsOf('vertexAttribIPointer');
    expect(ptr.map((c) => c.args[4])).toEqual([40]); // start 0 is the initial pointer; 10 -> 40 bytes, then unchanged
    const draws = fake.callsOf('drawElementsInstanced');
    expect(draws.map((c) => [c.args[1], c.args[3], c.args[4]])).toEqual([
      [36, 0, 10],
      [36, 0, 20],
      [30, 24, 5],
    ]);
    expect(d.instancesDrawn).toBe(35);
  });
});

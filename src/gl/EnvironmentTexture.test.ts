import { describe, expect, it } from 'vitest';
import { createFakeContext } from './__tests__/fakeGl';
import { EnvironmentTexture } from './EnvironmentTexture';
import { prepareEnvironment, studioEnvironment } from '../render/environment';

describe('EnvironmentTexture', () => {
  it('uploads every mip level as RGBA16F, counts memory, restores from the CPU copy', () => {
    const { ctx, fake } = createFakeContext();
    const gl = ctx.gl;
    const tex = new EnvironmentTexture(ctx);
    // placeholder: one 1x1 level
    expect(fake.callsOf('texImage2D')).toHaveLength(1);
    expect(ctx.memory.textures).toBe(8);
    expect(tex.hasImage).toBe(false);

    const p = prepareEnvironment(studioEnvironment(64, 32), 64, 32);
    fake.reset();
    tex.setLevels(p.levels);
    const uploads = fake.callsOf('texImage2D');
    expect(uploads).toHaveLength(p.levels.length); // 64x32 .. 1x1 = 7
    expect(uploads.map((c) => [c.args[1], c.args[2], c.args[3], c.args[4]])).toEqual(
      p.levels.map((l, i) => [i, gl.RGBA16F, l.width, l.height]),
    );
    expect(uploads.every((c) => c.args[6] === gl.RGBA && c.args[7] === gl.FLOAT)).toBe(true);
    const params = fake.callsOf('texParameteri').map((c) => [c.args[1], c.args[2]]);
    expect(params).toContainEqual([gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR]);
    expect(params).toContainEqual([gl.TEXTURE_WRAP_S, gl.REPEAT]);
    expect(params).toContainEqual([gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]);
    expect(params).toContainEqual([gl.TEXTURE_MAX_LEVEL, p.levels.length - 1]);
    expect(fake.callsOf('generateMipmap')).toHaveLength(0);
    const bytes = p.levels.reduce((s, l) => s + l.width * l.height * 8, 0);
    expect(ctx.memory.textures).toBe(bytes); // placeholder released
    expect(fake.callsOf('deleteTexture')).toHaveLength(1);

    // context restore: GlContext zeroes the counters, then restores every resource
    ctx.memory.textures = 0;
    fake.reset();
    tex.restore();
    expect(fake.callsOf('texImage2D')).toHaveLength(p.levels.length);
    expect(ctx.memory.textures).toBe(bytes);

    // back to the placeholder, then dispose
    tex.setLevels(null);
    expect(ctx.memory.textures).toBe(8);
    tex.dispose();
    expect(ctx.memory.textures).toBe(0);
  });

  it('rejects an inconsistent mip chain', () => {
    const { ctx } = createFakeContext();
    const tex = new EnvironmentTexture(ctx);
    expect(() =>
      tex.setLevels([
        { width: 4, height: 2, data: new Float32Array(32) },
        { width: 1, height: 1, data: new Float32Array(4) },
      ]),
    ).toThrow(/level 1 must be 2 x 1/);
  });
});

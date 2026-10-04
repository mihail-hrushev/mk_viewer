import { describe, expect, it } from 'vitest';
import {
  FRAG_COLOR,
  FRAG_DEQUANT_OFFSET,
  FRAG_DEQUANT_SCALE,
  FRAG_FLAGS,
  FRAG_MATERIAL,
  FRAG_MATRIX,
  FRAG_RECORDS_PER_ROW,
  FRAG_TEXELS,
  FRAG_FLOATS,
  MAT_COLOR,
  MAT_EMISSIVE,
  MAT_METALNESS,
  MAT_RECORDS_PER_ROW,
  MAT_ROUGHNESS,
  MAX_SECTION_PLANES,
  MERGED_VERTEX_STRIDE,
  SHARED_VERTEX_STRIDE,
  VERTEX_FRAGMENT_OFFSET,
  VERTEX_NORMAL_OFFSET,
  VERTEX_POSITION_OFFSET,
} from '../layout';
import { formatShaderError } from './Program';
import { FULLSCREEN_VS, SHADER_RECORD_ASSUMPTIONS, assembleShader } from './shaders/common';
import { BACKGROUND_FS, COMPOSITE_FS, OUTLINE_FS, PICK_RESOLVE_FS, PRESENT_FS } from './shaders/post';
import { uberFragmentSource, uberVertexSource } from './shaders/uber';

const ALL: Record<string, string> = {
  uberVS: uberVertexSource(),
  uberFS: uberFragmentSource(),
  uberFSsection: uberFragmentSource({ sectionPlanes: true }),
  fullscreenVS: FULLSCREEN_VS,
  present: PRESENT_FS,
  background: BACKGROUND_FS,
  outline: OUTLINE_FS,
  composite: COMPOSITE_FS,
  pickResolve: PICK_RESOLVE_FS,
};

describe('assembleShader', () => {
  it('puts #version on the very first line and adds defines', () => {
    const s = assembleShader('void main() {}', { A: true, B: false, C: 3, D: 'x + 1', E: undefined });
    const lines = s.split('\n');
    expect(lines[0]).toBe('#version 300 es');
    expect(s).toContain('#define A 1\n');
    expect(s).not.toContain('#define B');
    expect(s).toContain('#define C 3\n');
    expect(s).toContain('#define D x + 1\n');
    expect(s).not.toContain('#define E');
    expect(s.endsWith('void main() {}')).toBe(true);
  });
  it('rejects invalid define names', () => {
    expect(() => assembleShader('', { 'bad name': 1 })).toThrow();
  });
});

describe('shader sources (static GLSL ES 3.00 checks)', () => {
  for (const [name, src] of Object.entries(ALL)) {
    it(`${name}: version, precision, no stray template values`, () => {
      expect(src.startsWith('#version 300 es\n')).toBe(true);
      expect(src).toContain('precision highp float;');
      expect(src).not.toContain('undefined');
      expect(src).not.toContain('NaN');
      expect(src).not.toMatch(/\$\{/);
      // every sampler declared highp
      for (const m of src.matchAll(/uniform\s+(\w+\s+)?(u?sampler\w+)\s+(\w+)/g)) {
        expect(m[1]?.trim(), `${name}: ${m[3]} precision`).toBe('highp');
      }
      // integer varyings must be flat
      for (const m of src.matchAll(/^\s*(flat\s+)?(in|out)\s+(u?int|[iu]vec\d)\s+(v_\w+)/gm)) {
        expect(m[1], `${name}: ${m[4]} must be flat`).toBeTruthy();
      }
      // balanced braces
      expect((src.match(/\{/g) ?? []).length).toBe((src.match(/\}/g) ?? []).length);
      expect((src.match(/\(/g) ?? []).length).toBe((src.match(/\)/g) ?? []).length);
    });
  }

  it('uber VS uses fixed attribute locations 0/1/2', () => {
    const vs = ALL.uberVS;
    expect(vs).toContain('layout(location = 0) in vec3 a_position;');
    expect(vs).toContain('layout(location = 1) in vec2 a_normal;');
    expect(vs).toContain('layout(location = 2) in uint a_fragment;');
  });

  it('uber FS writes colour at location 0 and id at location 1', () => {
    expect(ALL.uberFS).toContain('layout(location = 0) out vec4 o_color;');
    expect(ALL.uberFS).toContain('layout(location = 1) out vec4 o_id;');
  });

  it('layout constants are baked in', () => {
    const vs = ALL.uberVS;
    expect(vs).toContain(`const uint FRAG_PER_ROW = ${FRAG_RECORDS_PER_ROW}u;`);
    expect(vs).toContain(`const uint FRAG_TEXELS_PER_RECORD = ${FRAG_TEXELS}u;`);
    expect(vs).toContain(`const uint MAT_PER_ROW = ${MAT_RECORDS_PER_ROW}u;`);
    expect(ALL.uberFSsection).toContain(`const int MAX_SECTION_PLANES = ${MAX_SECTION_PLANES};`);
  });

  it('section planes (discard) only in the section variant', () => {
    expect(ALL.uberFS).not.toContain('#define SECTION_PLANES');
    expect(ALL.uberFSsection).toContain('#define SECTION_PLANES 1');
  });

  it('shader texel assumptions match layout.ts float offsets', () => {
    const a = SHADER_RECORD_ASSUMPTIONS;
    expect(FRAG_FLOATS).toBe(FRAG_TEXELS * 4);
    expect(FRAG_MATRIX).toBe(a.matrixTexels[0] * 4);
    expect(FRAG_DEQUANT_SCALE).toBe(a.dequantScaleTexel * 4);
    expect(FRAG_MATERIAL).toBe(a.materialTexel * 4 + 3);
    expect(FRAG_DEQUANT_OFFSET).toBe(a.dequantOffsetTexel * 4);
    expect(FRAG_FLAGS).toBe(a.flagsTexel * 4 + 3);
    expect(FRAG_COLOR).toBe(a.colorTexel * 4);
    expect(MAT_COLOR).toBe(a.matColorTexel * 4);
    expect(MAT_METALNESS).toBe(a.matParamsTexel * 4);
    expect(MAT_ROUGHNESS).toBe(a.matParamsTexel * 4 + 1);
    expect(MAT_EMISSIVE).toBe(a.matParamsTexel * 4 + 2);
    // the GLSL uses these texel offsets literally
    expect(ALL.uberVS).toContain('fc + ivec2(4, 0)');
    expect(ALL.uberVS).toContain('fc + ivec2(3, 0)');
    expect(ALL.uberFS).toContain('fragTexel0(v_fragment) + ivec2(5, 0)');
  });

  it('vertex layout matches the attribute setup', () => {
    expect(VERTEX_POSITION_OFFSET).toBe(0);
    expect(VERTEX_NORMAL_OFFSET).toBe(6);
    expect(VERTEX_FRAGMENT_OFFSET).toBe(8);
    expect(SHARED_VERTEX_STRIDE).toBe(8);
    expect(MERGED_VERTEX_STRIDE).toBe(12);
    // WebGL requires offsets/strides aligned to the component size
    expect(MERGED_VERTEX_STRIDE % 4).toBe(0);
    expect(VERTEX_FRAGMENT_OFFSET % 4).toBe(0);
  });
});

describe('formatShaderError', () => {
  it('numbers lines and marks referenced ones', () => {
    const msg = formatShaderError('t', 'fragment', 'a\nb\nc', 'ERROR: 0:2: oops');
    expect(msg).toContain('oops');
    expect(msg).toContain('>2| b');
    expect(msg).toContain(' 1| a');
  });
});

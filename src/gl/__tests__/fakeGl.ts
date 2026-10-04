/**
 * Recording WebGL2 stand-in for node tests: every UPPER_CASE property is a distinct number, every
 * method call is recorded and returns a plausible value. Not a GL emulator.
 */
import { GlContext } from '../GlContext';

export interface Call {
  name: string;
  args: unknown[];
}

export interface FakeGl {
  gl: WebGL2RenderingContext;
  calls: Call[];
  callsOf(name: string): Call[];
  reset(): void;
}

export function createFakeGl(options: { multiDraw?: boolean; maxTextureSize?: number } = {}): FakeGl {
  const calls: Call[] = [];
  const constants = new Map<string, number>();
  let nextConst = 0x1000;
  let nextObj = 1;
  const multiDraw = {
    multiDrawElementsWEBGL: (...args: unknown[]) => {
      // copy typed arrays: they are scratch buffers reused by the caller
      calls.push({
        name: 'multiDrawElementsWEBGL',
        args: args.map((a) => (a instanceof Int32Array ? Array.from(a) : a)),
      });
    },
  };
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    getParameter: () => options.maxTextureSize ?? 16384,
    getExtension: (name: unknown) => (name === 'WEBGL_multi_draw' && options.multiDraw ? multiDraw : null),
    isContextLost: () => false,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'),
    getUniformLocation: (_p: unknown, name: unknown) => ({ uniform: name }),
  };
  function constant(name: string): number {
    let v = constants.get(name);
    if (v === undefined) {
      v = nextConst++;
      constants.set(name, v);
    }
    return v;
  }
  const gl = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        if (/^[A-Z0-9_]+$/.test(prop)) return constant(prop);
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
          if (prop in methods) return methods[prop](...args);
          if (prop.startsWith('create')) return { id: nextObj++, kind: prop.slice(6) };
          return undefined;
        };
      },
    },
  ) as WebGL2RenderingContext;
  return {
    gl,
    calls,
    callsOf: (name) => calls.filter((c) => c.name === name),
    reset: () => {
      calls.length = 0;
    },
  };
}

export function createFakeContext(options: { multiDraw?: boolean; maxTextureSize?: number } = {}): {
  ctx: GlContext;
  fake: FakeGl;
} {
  const fake = createFakeGl(options);
  const canvas = {
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement;
  const ctx = new GlContext(fake.gl, canvas);
  fake.reset();
  return { ctx, fake };
}

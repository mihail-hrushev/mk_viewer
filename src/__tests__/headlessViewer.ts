/**
 * The real `Viewer` (real core Scene, Batcher, GpuScene accounting) in node, on the recording fake
 * WebGL2 context. Frames are not run by requestAnimationFrame; `frame()` performs the CPU part of a
 * frame that matters for scene-state tests: batching (`scene.flush`) and the GPU mirror sync (buffer /
 * texture allocation and memory accounting). Not part of the library.
 */
import { Viewer } from '../Viewer';
import type { ViewerOptions } from '../types';
import { createFakeGl } from '../gl/__tests__/fakeGl';

export interface HeadlessViewer {
  viewer: Viewer;
  /** Batch queued meshes and sync the GPU mirror (like the start of a rendered frame). */
  frame(): void;
  /** GPU bytes tracked by the context (buffers + textures + render targets). */
  gpuBytes(): number;
  dispose(): void;
}

export function createHeadlessViewer(options: ViewerOptions = {}): HeadlessViewer {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.requestAnimationFrame !== 'function') {
    // frames are driven explicitly; a scheduled frame simply never runs
    let id = 0;
    g.requestAnimationFrame = () => ++id;
    g.cancelAnimationFrame = () => {};
  }
  const fake = createFakeGl({ multiDraw: true });
  // the proxy answers every lower-case property with a function: give the numeric ones real values
  const gl = new Proxy(fake.gl as unknown as object, {
    get(t, prop, r) {
      if (prop === 'drawingBufferWidth') return 800;
      if (prop === 'drawingBufferHeight') return 600;
      return Reflect.get(t, prop, r);
    },
  }) as WebGL2RenderingContext;
  const canvas = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    getContext: () => gl,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement;
  const viewer = new Viewer(canvas, { controls: false, autoSelect: false, ...options });
  fake.reset();
  return {
    viewer,
    frame() {
      viewer.scene.flush();
      viewer.renderer.gpu.sync(viewer.scene);
      fake.reset(); // the recorded calls would grow without bound
    },
    gpuBytes: () => viewer.ctx.gpuMemoryBytes,
    dispose: () => viewer.dispose(),
  };
}

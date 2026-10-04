/**
 * Tiny helpers shared by the examples (not part of the library). They only use the public API.
 */
import type { Viewer, ViewerStats } from '../src/index';

/** document.getElementById with a cast. */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** A button that calls `fn`. */
export function button(label: string, fn: () => void, title?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = fn;
  if (title) b.title = title;
  return b;
}

/** Column-major translation (and optional uniform/non-uniform scale) matrix. */
export function translation(x: number, y: number, z: number, sx = 1, sy = sx, sz = sx): number[] {
  return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1];
}

/**
 * Collects uncaught errors and unhandled rejections and shows them in `el` (if given). The list is
 * also returned, so test drivers can read it.
 */
export function captureErrors(el?: HTMLElement | null): string[] {
  const errors: string[] = [];
  const show = () => {
    if (el) el.textContent = errors.join('\n');
  };
  window.addEventListener('error', (e) => {
    errors.push(String(e.message));
    show();
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string } | undefined;
    errors.push(String(r?.message ?? r));
    show();
  });
  return errors;
}

/** Formats viewer stats on a few lines. */
export function formatStats(s: ViewerStats): string {
  const M = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : `${n}`);
  const gpu = Number.isFinite(s.gpuMs) ? `  gpu ${s.gpuMs.toFixed(1)} ms` : '';
  return (
    `fps ${s.fps.toFixed(0)}  cpu ${s.frameMs.toFixed(1)} ms${gpu}  progress ${(s.progress * 100).toFixed(0)}%\n` +
    `meshes ${M(s.meshes)}  triangles ${M(s.triangles)}\n` +
    `drawn: items ${s.drawItems}  calls ${s.drawCalls}  tris ${M(s.trianglesDrawn)}\n` +
    `gpu memory ${(s.gpuMemoryBytes / 1048576).toFixed(0)} MB`
  );
}

/** Refreshes `el` with the viewer's stats four times a second. */
export function showStats(viewer: Viewer, el: HTMLElement, extra?: () => string): void {
  setInterval(() => {
    const x = extra ? extra() : '';
    el.textContent = formatStats(viewer.stats) + (x ? `\n${x}` : '');
  }, 250);
}

/** The GPU the browser renders WebGL2 with (unmasked when the browser allows it). */
export function gpuName(): string {
  const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
  if (!gl) return 'no WebGL2';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return name;
}

/** Used JS heap in MB (Chrome only), or NaN. */
export function jsHeapMB(): number {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? mem.usedJSHeapSize / 1048576 : NaN;
}

/** Makes values reachable from the browser console as `window.mk` (handy for experiments). */
export function expose(values: Record<string, unknown>): void {
  (window as unknown as { mk: Record<string, unknown> }).mk = values;
}

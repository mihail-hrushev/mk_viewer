/**
 * The plugin overlay layer (`PluginContext.overlay()`): a pointer-transparent element over the
 * canvas, placed like the built-in UI overlay (fixed position following the canvas rectangle) and
 * one z-level below it, so toolbar and menus stay on top of plugin drawings.
 */
export interface CanvasLayer {
  readonly element: HTMLElement;
  dispose(): void;
}

export function createCanvasLayer(canvas: HTMLCanvasElement): CanvasLayer {
  const doc = canvas.ownerDocument;
  const el = doc.createElement('div');
  el.className = 'mkv-layer';
  const s = el.style;
  s.position = 'fixed';
  s.pointerEvents = 'none';
  s.overflow = 'hidden';
  s.zIndex = '9';
  s.font = "12px/1.35 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
  // right after the canvas, so it shares the canvas' stacking context
  if (canvas.parentElement) canvas.after(el);
  else doc.body.append(el);
  const place = (): void => {
    const r = canvas.getBoundingClientRect();
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
  };
  place();
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
  observer?.observe(canvas);
  const win = doc.defaultView;
  win?.addEventListener('resize', place);
  win?.addEventListener('scroll', place, true);
  return {
    element: el,
    dispose() {
      observer?.disconnect();
      win?.removeEventListener('resize', place);
      win?.removeEventListener('scroll', place, true);
      el.remove();
    },
  };
}

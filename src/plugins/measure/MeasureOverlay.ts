/**
 * DOM drawing of the measurement plugin: an SVG for lines and markers plus HTML labels, inside the
 * plugin overlay layer (on top of the model, not depth-tested). Positions come from
 * `viewer.worldToScreen`; segments are cut at the eye plane in world space before projecting (so a
 * point behind the camera never draws a wrong line) and clipped to the canvas.
 *
 * `update()` only writes attributes / transforms; elements are created when measurements appear.
 */
import type { ScreenPoint, SnapKind, ViewerApi } from '../../types';
import { clipSegment2D, depthCutT, labelOffset } from './geometry';

const SVG_NS = 'http://www.w3.org/2000/svg';
const STYLE_ID = 'mkv-measure-style';
/** Clip margin around the canvas (CSS px), so line caps at the border are not cut visibly. */
const MARGIN = 8;
/** Gap between a short line and the label beside it. */
const LABEL_GAP = 6;

const CSS = `
.mkv-measure{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;--mkv-m-color:#e8590c}
.mkv-measure svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}
.mkv-m-halo{stroke:rgba(255,255,255,.9);stroke-width:4.5;stroke-linecap:round}
.mkv-m-line{stroke:var(--mkv-m-color);stroke-width:2;stroke-linecap:round}
.mkv-m-rubber .mkv-m-line{stroke-dasharray:7 5}
.mkv-m-end{fill:var(--mkv-m-color);stroke:#fff;stroke-width:1.5}
.mkv-m-label{position:absolute;left:0;top:0;padding:2px 7px;border-radius:5px;background:rgba(20,22,26,.86);color:#fff;
  white-space:nowrap;text-align:center;font:600 12px/1.3 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  box-shadow:0 1px 3px rgba(0,0,0,.35);will-change:transform}
.mkv-m-sub{display:block;font-weight:400;font-size:11px;color:#c8cacc;white-space:pre}
.mkv-m-sub:empty{display:none}
.mkv-m-snap{stroke-width:2;fill:rgba(255,255,255,.75)}
.mkv-m-snap-vertex{stroke:#188038}
.mkv-m-snap-edge{stroke:#d56e00}
.mkv-m-snap-surface{stroke:#1a73e8}
.mkv-m-edge{stroke:#f9ab00;stroke-width:6;stroke-opacity:.6;stroke-linecap:round}
`;

type P3 = ArrayLike<number>;

/** A segment with an optional label, drawn as halo + line + end markers. */
class SegmentEls {
  readonly g: SVGGElement;
  private readonly halo: SVGLineElement;
  private readonly line: SVGLineElement;
  private readonly m0: SVGCircleElement;
  private readonly m1: SVGCircleElement;
  readonly label: HTMLDivElement;
  private readonly main: HTMLSpanElement;
  private readonly sub: HTMLSpanElement;
  private text = '';
  private subText = '';
  private lw = 0;
  private lh = 0;

  constructor(svg: SVGSVGElement, labels: HTMLElement, cls: string) {
    const doc = svg.ownerDocument;
    this.g = el(doc, 'g', cls);
    this.halo = el(doc, 'line', 'mkv-m-halo');
    this.line = el(doc, 'line', 'mkv-m-line');
    this.m0 = el(doc, 'circle', 'mkv-m-end');
    this.m1 = el(doc, 'circle', 'mkv-m-end');
    this.m0.setAttribute('r', '3.5');
    this.m1.setAttribute('r', '3.5');
    this.g.append(this.halo, this.line, this.m0, this.m1);
    svg.append(this.g);
    this.label = doc.createElement('div');
    this.label.className = 'mkv-m-label';
    this.main = doc.createElement('span');
    this.sub = doc.createElement('span');
    this.sub.className = 'mkv-m-sub';
    this.label.append(this.main, this.sub);
    labels.append(this.label);
  }

  setText(text: string, sub: string): void {
    if (text === this.text && sub === this.subText) return;
    this.text = text;
    this.subText = sub;
    this.main.textContent = text;
    this.sub.textContent = sub;
    this.lw = -1; // measured lazily (layout read) when next placed
  }

  /** Draws the visible part [x0, y0, x1, y1]; e0 / e1: show the end markers. null hides it. */
  place(seg: Float64Array | null, e0: boolean, e1: boolean, w: number, h: number, ends: boolean): void {
    if (!seg) {
      this.g.style.display = 'none';
      this.label.style.display = 'none';
      return;
    }
    this.g.style.display = '';
    setLine(this.halo, seg);
    setLine(this.line, seg);
    setCircle(this.m0, ends && e0, seg[0], seg[1]);
    setCircle(this.m1, ends && e1, seg[2], seg[3]);
    if (!this.text) {
      this.label.style.display = 'none';
      return;
    }
    this.label.style.display = '';
    if (this.lw < 0) {
      this.lw = this.label.offsetWidth;
      this.lh = this.label.offsetHeight;
    }
    const lw = this.lw, lh = this.lh;
    const off = offTmp;
    labelOffset(seg[2] - seg[0], seg[3] - seg[1], lw, lh, LABEL_GAP, off);
    let cx = (seg[0] + seg[2]) * 0.5 + off[0];
    let cy = (seg[1] + seg[3]) * 0.5 + off[1];
    // keep the label inside the canvas
    cx = Math.min(Math.max(cx, lw * 0.5 + 2), Math.max(lw * 0.5 + 2, w - lw * 0.5 - 2));
    cy = Math.min(Math.max(cy, lh * 0.5 + 2), Math.max(lh * 0.5 + 2, h - lh * 0.5 - 2));
    this.label.style.transform = `translate(${fmt(cx - lw * 0.5)}px,${fmt(cy - lh * 0.5)}px)`;
  }

  remove(): void {
    this.g.remove();
    this.label.remove();
  }
}

const offTmp = new Float64Array(2);

export interface OverlayMarker {
  position: P3;
  kind: SnapKind;
  edge?: [P3, P3];
}

export class MeasureOverlay {
  readonly root: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly labels: HTMLDivElement;
  private readonly viewer: ViewerApi;
  private readonly segs = new Map<number, SegmentEls>();
  private readonly rubber: SegmentEls;
  private readonly startMark: SVGCircleElement;
  private readonly edgeHi: SVGLineElement;
  private readonly snapVertex: SVGRectElement;
  private readonly snapEdge: SVGPathElement;
  private readonly snapSurface: SVGCircleElement;

  // scratch (update() does not allocate per segment)
  private readonly s0: ScreenPoint = { x: 0, y: 0, depth: 0, inFront: false, inView: false };
  private readonly s1: ScreenPoint = { x: 0, y: 0, depth: 0, inFront: false, inView: false };
  private readonly s2: ScreenPoint = { x: 0, y: 0, depth: 0, inFront: false, inView: false };
  private readonly cut = new Float64Array(3);
  private readonly seg = new Float64Array(4);
  private e0 = false;
  private e1 = false;

  constructor(viewer: ViewerApi, parent: HTMLElement, color?: string) {
    this.viewer = viewer;
    const doc = parent.ownerDocument;
    if (!doc.getElementById(STYLE_ID)) {
      const st = doc.createElement('style');
      st.id = STYLE_ID;
      st.textContent = CSS;
      doc.head.append(st);
    }
    this.root = doc.createElement('div');
    this.root.className = 'mkv-measure';
    if (color) this.root.style.setProperty('--mkv-m-color', color);
    this.svg = el(doc, 'svg', '');
    this.labels = doc.createElement('div');
    this.root.append(this.svg, this.labels);
    parent.append(this.root);
    // drawing order: measurements, then the rubber band, then the magnet marker on top
    this.edgeHi = el(doc, 'line', 'mkv-m-edge');
    this.rubber = new SegmentEls(this.svg, this.labels, 'mkv-m-rubber');
    this.startMark = el(doc, 'circle', 'mkv-m-end');
    this.startMark.setAttribute('r', '4');
    this.snapVertex = el(doc, 'rect', 'mkv-m-snap mkv-m-snap-vertex');
    this.snapVertex.setAttribute('width', '11');
    this.snapVertex.setAttribute('height', '11');
    this.snapEdge = el(doc, 'path', 'mkv-m-snap mkv-m-snap-edge');
    this.snapSurface = el(doc, 'circle', 'mkv-m-snap mkv-m-snap-surface');
    this.snapSurface.setAttribute('r', '5.5');
    this.svg.append(this.edgeHi, this.startMark, this.snapVertex, this.snapEdge, this.snapSurface);
    this.hideMarker();
    this.rubber.place(null, false, false, 0, 0, true);
    this.startMark.style.display = 'none';
  }

  /** Creates / removes the elements of measurements (ids); call when the list changes. */
  sync(ids: Iterable<number>): void {
    const keep = new Set(ids);
    for (const [id, s] of this.segs) {
      if (!keep.has(id)) {
        s.remove();
        this.segs.delete(id);
      }
    }
    for (const id of keep) {
      if (!this.segs.has(id)) {
        const s = new SegmentEls(this.svg, this.labels, 'mkv-m-item');
        // measurements below the rubber band and markers
        this.svg.insertBefore(s.g, this.edgeHi);
        this.segs.set(id, s);
      }
    }
  }

  /** Positions measurement `id` (its elements must exist, see sync). */
  drawMeasurement(id: number, a: P3, b: P3, text: string, sub: string): void {
    const s = this.segs.get(id);
    if (!s) return;
    s.setText(text, sub);
    const w = this.width(), h = this.height();
    const vis = this.project(a, b, w, h);
    s.place(vis ? this.seg : null, this.e0, this.e1, w, h, true);
  }

  /** The started point of a measurement in progress, and the rubber band to `end` (or null). */
  drawPending(start: P3 | null, end: P3 | null, text: string, sub: string): void {
    const w = this.width(), h = this.height();
    if (!start) {
      this.startMark.style.display = 'none';
      this.rubber.place(null, false, false, w, h, false);
      return;
    }
    const p = this.viewer.worldToScreen(start, this.s0);
    setCircle(this.startMark, p.inView, p.x, p.y);
    if (!end) {
      this.rubber.place(null, false, false, w, h, false);
      return;
    }
    this.rubber.setText(text, sub);
    const vis = this.project(start, end, w, h);
    this.rubber.place(vis ? this.seg : null, false, false, w, h, false);
  }

  /** The magnet marker (shape per snap kind; the edge segment highlighted), or null. */
  drawMarker(m: OverlayMarker | null): void {
    this.hideMarker();
    if (!m) return;
    const w = this.width(), h = this.height();
    if (m.kind === 'edge' && m.edge && this.project(m.edge[0], m.edge[1], w, h)) {
      setLine(this.edgeHi, this.seg);
      this.edgeHi.style.display = '';
    }
    const p = this.viewer.worldToScreen(m.position, this.s0);
    if (!p.inView) return;
    const x = p.x, y = p.y;
    if (m.kind === 'vertex') {
      this.snapVertex.setAttribute('x', fmt(x - 5.5));
      this.snapVertex.setAttribute('y', fmt(y - 5.5));
      this.snapVertex.style.display = '';
    } else if (m.kind === 'edge') {
      // a diamond
      this.snapEdge.setAttribute('d', `M${fmt(x)} ${fmt(y - 7)}L${fmt(x + 7)} ${fmt(y)}L${fmt(x)} ${fmt(y + 7)}L${fmt(x - 7)} ${fmt(y)}Z`);
      this.snapEdge.style.display = '';
    } else {
      this.snapSurface.setAttribute('cx', fmt(x));
      this.snapSurface.setAttribute('cy', fmt(y));
      this.snapSurface.style.display = '';
    }
  }

  dispose(): void {
    this.root.remove();
    this.segs.clear();
  }

  // ---------------------------------------------------------------------------------------------

  private width(): number {
    return this.viewer.canvas.clientWidth;
  }

  private height(): number {
    return this.viewer.canvas.clientHeight;
  }

  private hideMarker(): void {
    this.edgeHi.style.display = 'none';
    this.snapVertex.style.display = 'none';
    this.snapEdge.style.display = 'none';
    this.snapSurface.style.display = 'none';
  }

  /**
   * Screen segment of world segment ab into this.seg: the part behind the eye is cut away in world
   * space, the rest clipped to the canvas (plus a margin). e0 / e1: whether the ends are on screen.
   * False when nothing is visible.
   */
  private project(a: P3, b: P3, w: number, h: number): boolean {
    const v = this.viewer;
    const pa = v.worldToScreen(a, this.s0);
    const pb = v.worldToScreen(b, this.s1);
    const seg = this.seg;
    seg[0] = pa.x;
    seg[1] = pa.y;
    seg[2] = pb.x;
    seg[3] = pb.y;
    this.e0 = pa.inView;
    this.e1 = pb.inView;
    if (!pa.inFront || !pb.inFront) {
      if (!pa.inFront && !pb.inFront) return false;
      const eps = Math.max(Math.abs(pa.depth), Math.abs(pb.depth)) * 1e-4;
      const t = depthCutT(pa.depth, pb.depth, eps);
      const c = this.cut;
      for (let i = 0; i < 3; i++) c[i] = a[i] + (b[i] - a[i]) * t;
      const pc = v.worldToScreen(c, this.s2);
      if (!pa.inFront) {
        seg[0] = pc.x;
        seg[1] = pc.y;
      } else {
        seg[2] = pc.x;
        seg[3] = pc.y;
      }
    }
    return clipSegment2D(seg, -MARGIN, -MARGIN, w + MARGIN, h + MARGIN);
  }
}

function el<K extends keyof SVGElementTagNameMap>(doc: Document, tag: K, cls: string): SVGElementTagNameMap[K] {
  const e = doc.createElementNS(SVG_NS, tag);
  if (cls) e.setAttribute('class', cls);
  return e;
}

function setLine(l: SVGLineElement, s: Float64Array): void {
  l.setAttribute('x1', fmt(s[0]));
  l.setAttribute('y1', fmt(s[1]));
  l.setAttribute('x2', fmt(s[2]));
  l.setAttribute('y2', fmt(s[3]));
}

function setCircle(c: SVGCircleElement, show: boolean, x: number, y: number): void {
  if (!show) {
    c.style.display = 'none';
    return;
  }
  c.style.display = '';
  c.setAttribute('cx', fmt(x));
  c.setAttribute('cy', fmt(y));
}

/** Pixel value with 2 decimals (sub-pixel smooth, short strings). */
function fmt(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

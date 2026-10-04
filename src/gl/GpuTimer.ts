/**
 * Optional GPU frame timing with EXT_disjoint_timer_query_webgl2. Without the extension every
 * method is a cheap no-op and `available` is false. Results arrive a few frames late; `lastMs` is the
 * most recent completed measurement (NaN until one exists).
 *
 *   timer.begin(); ...draw the frame...; timer.end(); timer.poll();
 */
import type { GlContext, GlResource } from './GlContext';

export class GpuTimer implements GlResource {
  /** Most recent GPU time in ms, NaN when none yet. */
  lastMs = NaN;
  /** Exponential moving average of GPU time in ms, NaN when none yet. */
  averageMs = NaN;
  private active: WebGLQuery | null = null;
  private inFlight: WebGLQuery[] = [];
  private free: WebGLQuery[] = [];

  constructor(private readonly ctx: GlContext) {
    ctx.track(this);
  }

  get available(): boolean {
    return this.ctx.caps.timerQuery !== null && !this.ctx.isLost;
  }

  /** Starts timing (ignored when unavailable, or when a query is already active). */
  begin(): void {
    const ext = this.ctx.caps.timerQuery;
    if (!ext || this.active || this.ctx.isLost || this.inFlight.length > 8) return;
    const q = this.free.pop() ?? this.ctx.gl.createQuery();
    if (!q) return;
    this.ctx.gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    const ext = this.ctx.caps.timerQuery;
    if (!ext || !this.active) return;
    this.ctx.gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.inFlight.push(this.active);
    this.active = null;
  }

  /** Collects finished queries (non-blocking). Call once per frame. */
  poll(): void {
    const ext = this.ctx.caps.timerQuery;
    if (!ext || this.inFlight.length === 0 || this.ctx.isLost) return;
    const gl = this.ctx.gl;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    while (this.inFlight.length) {
      const q = this.inFlight[0];
      if (!disjoint && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.inFlight.shift();
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        this.lastMs = ns / 1e6;
        this.averageMs = Number.isNaN(this.averageMs) ? this.lastMs : this.averageMs * 0.9 + this.lastMs * 0.1;
      }
      this.free.push(q);
    }
  }

  restore(): void {
    this.active = null;
    this.inFlight = [];
    this.free = [];
  }

  dispose(): void {
    const gl = this.ctx.gl;
    if (this.active && this.ctx.caps.timerQuery) gl.endQuery(this.ctx.caps.timerQuery.TIME_ELAPSED_EXT);
    for (const q of [...this.inFlight, ...this.free]) gl.deleteQuery(q);
    if (this.active) gl.deleteQuery(this.active);
    this.restore();
    this.ctx.untrack(this);
  }
}

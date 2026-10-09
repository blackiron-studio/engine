interface TimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}
/** Non-blocking GPU elapsed queries. Unsupported/disjoint results stay null, never masquerade as zero. */
export class GpuProfiler {
  private extension: TimerExtension | null;
  private active: WebGLQuery | null = null;
  private pending: WebGLQuery[] = [];
  private samples: number[] = [];
  constructor(private gl: WebGL2RenderingContext) {
    this.extension = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  }
  begin(): void {
    this.poll();
    if (!this.extension || this.active || this.pending.length >= 8) return;
    this.active = this.gl.createQuery();
    if (this.active)
      this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, this.active);
  }
  end(): void {
    if (!this.active || !this.extension) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }
  poll(): void {
    const gl = this.gl,
      e = this.extension;
    if (!e) return;
    if (gl.getParameter(e.GPU_DISJOINT_EXT)) {
      for (const q of this.pending) gl.deleteQuery(q);
      this.pending = [];
      this.samples = [];
      return;
    }
    while (
      this.pending.length &&
      gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE)
    ) {
      const q = this.pending.shift()!,
        ms = Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6;
      gl.deleteQuery(q);
      if (Number.isFinite(ms) && ms >= 0) {
        this.samples.push(ms);
        if (this.samples.length > 240) this.samples.shift();
      }
    }
  }
  get report() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      supported: !!this.extension,
      samples: sorted.length,
      pending: this.pending.length,
      medianMs: sorted.length
        ? sorted[Math.floor((sorted.length - 1) * 0.5)]
        : null,
      p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
    };
  }
  destroy(): void {
    this.end();
    for (const q of this.pending) this.gl.deleteQuery(q);
    this.pending = [];
    this.samples = [];
  }
}

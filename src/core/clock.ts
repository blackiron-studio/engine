// Fixed-timestep accumulator. The App calls `advance` once per rendered frame and the
// callback runs zero or more times with a constant `step`, which keeps simulation
// deterministic regardless of display refresh rate.

export class FixedStep {
  private acc = 0;
  /** Simulated seconds elapsed across all steps. */
  time = 0;
  /** Number of steps taken so far. */
  ticks = 0;

  constructor(
    readonly step = 1 / 60,
    /** Largest real-time delta accepted per frame; protects against tab-switch spikes. */
    readonly maxFrame = 0.1,
    /** Cap on steps per frame so a slow device degrades instead of spiralling. */
    readonly maxSteps = 5,
  ) {}

  /** Returns the interpolation alpha in [0, 1) for rendering between steps. */
  advance(dt: number, tick: (step: number) => void): number {
    this.acc += Math.min(dt, this.maxFrame);
    let n = 0;
    while (this.acc >= this.step && n < this.maxSteps) {
      tick(this.step);
      this.acc -= this.step;
      this.time += this.step;
      this.ticks++;
      n++;
    }
    if (n === this.maxSteps) this.acc = 0;
    return this.acc / this.step;
  }

  reset(): void {
    this.acc = 0;
  }
}

/** Simple countdown helper for cooldowns and timers. */
export class Timer {
  remaining = 0;

  constructor(public duration = 1) {}

  start(duration = this.duration): void {
    this.duration = duration;
    this.remaining = duration;
  }

  /** Advance and report whether the timer just finished on this call. */
  update(dt: number): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= dt;
    return this.remaining <= 0;
  }

  get running(): boolean {
    return this.remaining > 0;
  }

  /** 0 at start, 1 when done. */
  get progress(): number {
    return this.duration <= 0 ? 1 : 1 - Math.max(0, this.remaining) / this.duration;
  }
}

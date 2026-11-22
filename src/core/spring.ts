// Spring: a damped spring on one number, for anything that should kick and settle instead of
// snapping: gun recoil, a camera punch, a body jolted by a hit, a bank into a turn. Kick it (add
// velocity) or move its target, then step it. It is stepped in small slices, so stiff springs stay
// stable and give the same motion at 30, 60 or 144 frames per second. Pure logic with no drawing.

/** Longest slice a step is cut into, in seconds. */
const SLICE = 0.006;
/** Most slices one step takes; longer frames are simulated in coarser slices instead. */
const MAX_SLICES = 256;

export class Spring {
  /** Where the spring is now. */
  value: number;
  /** How fast it is moving, per second. */
  velocity = 0;
  /** Where it settles; `step` can also be given a target for that step. */
  target: number;

  /**
   * @param stiffness Pull toward the target per unit away (per second squared). Higher is snappier.
   * @param damping   Drag on its speed (per second). About 2·√stiffness settles without overshoot;
   *                  less wobbles, more creeps.
   */
  constructor(
    public stiffness = 120,
    public damping = 14,
    value = 0,
  ) {
    if (![stiffness, damping, value].every(Number.isFinite) || stiffness < 0 || damping < 0)
      throw new RangeError("Spring stiffness and damping must be finite and nonnegative");
    this.value = value;
    this.target = value;
  }

  /** Damping that settles a spring of this stiffness as fast as possible without overshoot. */
  static critical(stiffness: number): number {
    return 2 * Math.sqrt(Math.max(0, stiffness));
  }

  /** Add speed (a hit, a shot's kick). */
  kick(velocity: number): this {
    if (!Number.isFinite(velocity)) throw new RangeError("Spring kick must be finite");
    this.velocity += velocity;
    return this;
  }

  /** Jump to `value` at rest (and settle there unless a target is given). */
  reset(value = 0, target = value): this {
    if (!Number.isFinite(value) || !Number.isFinite(target)) throw new RangeError("Spring reset must be finite");
    this.value = value;
    this.target = target;
    this.velocity = 0;
    return this;
  }

  /** Advance `dt` seconds toward `target` (which becomes the new target); returns the value. */
  step(dt: number, target = this.target): number {
    if (!Number.isFinite(target)) throw new RangeError("Spring target must be finite");
    this.target = target;
    if (!Number.isFinite(dt) || dt <= 0) return this.value;
    const n = Math.min(MAX_SLICES, Math.max(1, Math.ceil(dt / SLICE))),
      h = dt / n;
    let x = this.value,
      v = this.velocity;
    for (let i = 0; i < n; i++) {
      // Semi-implicit Euler: the speed first, then the position with the new speed.
      v += (-this.stiffness * (x - target) - this.damping * v) * h;
      x += v * h;
    }
    this.value = x;
    this.velocity = v;
    return x;
  }

  /** True once it is within `epsilon` of its target and nearly still. */
  settled(epsilon = 1e-4): boolean {
    return Math.abs(this.value - this.target) <= epsilon && Math.abs(this.velocity) <= epsilon * 10;
  }
}

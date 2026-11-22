// Heading: the way a body faces, turning toward a target angle at a limited speed. Push the
// angle you want each frame (the aim, the way it walks) and step it; `angle` is where the body
// actually faces. Shots and aim stay on the game's own angle: only the body lags. Pure logic
// with no drawing, so simulations, AI and tests can ask how long a turn will take.

import { TAU, angleDelta } from "./math.ts";

export interface HeadingOptions {
  /** Starting angle in radians (0 = +x, π/2 = +y). The target starts here too. */
  angle?: number;
  /** Seconds a half turn takes; 0 turns at once (a turret that snaps). */
  halfTurn?: number;
  /**
   * When the body is farther than this from the target (radians), it turns at `catchUpHalfTurn`
   * instead, so it never trails far behind the aim. Infinity (the default) never catches up.
   */
  catchUp?: number;
  /** Seconds a half turn takes while catching up. */
  catchUpHalfTurn?: number;
}

export class Heading {
  /** Where the body faces now, in (−π, π]. */
  angle: number;
  /** Where it is turning to. */
  target: number;
  /** Turn speed in radians per second; Infinity turns at once. */
  rate: number;
  catchUp: number;
  catchUpRate: number;
  /** The way the last turn went (+1, −1, or 0 before any), kept for targets straight behind. */
  private side = 0;

  constructor(o: HeadingOptions = {}) {
    this.angle = norm(o.angle ?? 0);
    this.target = this.angle;
    this.rate = rateOf(o.halfTurn ?? 0.15);
    this.catchUp = o.catchUp ?? Number.POSITIVE_INFINITY;
    this.catchUpRate = rateOf(o.catchUpHalfTurn ?? 0.05);
  }

  /** Seconds a half turn takes at the normal speed. */
  get halfTurn(): number {
    return Math.PI / this.rate;
  }

  set halfTurn(s: number) {
    this.rate = rateOf(s);
  }

  /** Turn toward a direction; a zero vector keeps the target. */
  towards(dx: number, dy: number): void {
    if (dx !== 0 || dy !== 0) this.target = Math.atan2(dy, dx);
  }

  /** Face an angle at once (the target by default), as when a body spawns. */
  snap(angle = this.target): void {
    this.angle = norm(angle);
    this.target = this.angle;
  }

  /** Signed angle still to turn, the way the body will turn. */
  get offset(): number {
    const d = angleDelta(this.angle, this.target);
    // Straight behind: keep turning the way the body already turns instead of wavering.
    if (Math.abs(d) > Math.PI - 1e-6 && this.side !== 0) return this.side * Math.abs(d);
    return d;
  }

  get turning(): boolean {
    return this.offset !== 0;
  }

  /** Step the turn by dt seconds; the result is the same at any frame rate. Returns the angle. */
  update(dt: number): number {
    if (!(dt > 0)) return this.angle;
    const d = this.offset;
    if (d === 0) return this.angle;
    const dir = Math.sign(d);
    this.side = dir;
    const left = Math.abs(d) - this.travel(Math.abs(d), dt);
    this.angle = left <= 0 ? norm(this.target) : norm(this.target - dir * left);
    return this.angle;
  }

  /** Seconds until the body faces `angle` to within `tolerance`, if the target is that angle. */
  timeToFace(angle = this.target, tolerance = 0): number {
    const d = Math.abs(angleDelta(this.angle, angle)) - tolerance;
    if (d <= 0) return 0;
    const fast = Math.max(0, d - this.catchUp);
    return seconds(fast, this.catchUpRate) + seconds(d - fast, this.rate);
  }

  /** How far the body turns in dt from `d` radians away: fast down to `catchUp`, then normal. */
  private travel(d: number, dt: number): number {
    let moved = 0;
    if (d > this.catchUp) {
      const fast = d - this.catchUp;
      const t = seconds(fast, this.catchUpRate);
      if (dt <= t) return dt * this.catchUpRate;
      moved = fast;
      dt -= t;
    }
    return Math.min(d, moved + dt * this.rate);
  }
}

const rateOf = (halfTurn: number): number => (halfTurn > 0 ? Math.PI / halfTurn : Number.POSITIVE_INFINITY);
const seconds = (radians: number, rate: number): number => (radians <= 0 || !Number.isFinite(rate) ? 0 : radians / rate);

/** An angle in (−π, π]. */
function norm(a: number): number {
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
}

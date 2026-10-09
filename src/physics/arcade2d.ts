import type { Rect } from "../core/math.ts";

export interface Position2D {
  x: number;
  y: number;
}
/** Static circle-versus-rectangle collision for lightweight top-down games. */
export class ArcadeWorld2D {
  constructor(
    readonly bounds: Rect,
    readonly solids: readonly Rect[],
  ) {
    if (
      [bounds, ...solids].some(
        (r) =>
          ![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0,
      )
    )
      throw new RangeError("Invalid collision rectangle");
  }
  free(x: number, y: number, radius: number): boolean {
    if (![x, y, radius].every(Number.isFinite) || radius <= 0) return false;
    const b = this.bounds;
    if (
      x - radius < b.x ||
      y - radius < b.y ||
      x + radius > b.x + b.w ||
      y + radius > b.y + b.h
    )
      return false;
    return !this.solids.some((r) => {
      const dx = x - Math.max(r.x, Math.min(x, r.x + r.w)),
        dy = y - Math.max(r.y, Math.min(y, r.y + r.h));
      return dx * dx + dy * dy < radius * radius;
    });
  }
  /** Resolve two circular actors, respecting static walls. shareA=0 keeps a stationary. */
  separate(
    a: Position2D,
    radiusA: number,
    b: Position2D,
    radiusB: number,
    shareA = 0.5,
  ): boolean {
    if (
      ![a.x, a.y, b.x, b.y, radiusA, radiusB, shareA].every(Number.isFinite) ||
      radiusA <= 0 ||
      radiusB <= 0 ||
      shareA < 0 ||
      shareA > 1
    )
      throw new RangeError("Invalid circle pair");
    const dx = b.x - a.x,
      dy = b.y - a.y,
      d = Math.hypot(dx, dy),
      overlap = radiusA + radiusB - d;
    if (overlap <= 0) return false;
    const nx = d > 1e-8 ? dx / d : 1,
      ny = d > 1e-8 ? dy / d : 0;
    this.move(a, -nx * overlap * shareA, -ny * overlap * shareA, radiusA);
    this.move(
      b,
      nx * overlap * (1 - shareA),
      ny * overlap * (1 - shareA),
      radiusB,
    );
    return true;
  }
  /** Bounded substeps prevent tunnelling; blocked axes slide along walls. Mutates position. */
  move(p: Position2D, dx: number, dy: number, radius: number): boolean {
    if (![p.x, p.y, dx, dy, radius].every(Number.isFinite) || radius <= 0)
      throw new RangeError("Invalid circle movement");
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(dx, dy) / Math.min(radius * 0.5, 4)),
    );
    if (steps > 4096) throw new RangeError("Movement exceeds substep budget");
    let hit = false;
    for (let i = 0; i < steps; i++) {
      if (this.free(p.x + dx / steps, p.y, radius)) p.x += dx / steps;
      else hit = true;
      if (this.free(p.x, p.y + dy / steps, radius)) p.y += dy / steps;
      else hit = true;
    }
    return hit;
  }
}
export interface VehicleTuning2D {
  topSpeed?: number;
  reverseSpeed?: number;
  acceleration?: number;
  braking?: number;
  drag?: number;
  steering?: number;
  grip?: number;
  radius?: number;
}
/** Arcade car dynamics, independent of rendering, input bindings and game rules. Angle 0 faces right. */
export class ArcadeVehicle2D implements Position2D {
  x: number;
  y: number;
  angle: number;
  speed = 0;
  vx = 0;
  vy = 0;
  readonly tuning: Required<VehicleTuning2D>;
  constructor(x: number, y: number, angle = 0, tuning: VehicleTuning2D = {}) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.tuning = {
      topSpeed: 340,
      reverseSpeed: 125,
      acceleration: 205,
      braking: 360,
      drag: 40,
      steering: 2.5,
      grip: 9,
      radius: 23,
      ...tuning,
    };
    if (
      ![x, y, angle, ...Object.values(this.tuning)].every(Number.isFinite) ||
      Object.values(this.tuning).some((v) => v <= 0)
    )
      throw new RangeError("Invalid vehicle tuning");
  }
  step(
    dt: number,
    input: { throttle: number; steer: number; handbrake?: boolean },
    world: ArcadeWorld2D,
  ): number {
    if (
      ![dt, input.throttle, input.steer].every(Number.isFinite) ||
      dt < 0 ||
      dt > 0.1
    )
      throw new RangeError("Invalid vehicle step");
    if (!dt) return 0;
    const t = this.tuning,
      throttle = Math.max(-1, Math.min(1, input.throttle));
    const opposing = throttle * this.speed < 0;
    if (throttle)
      this.speed += throttle * (opposing ? t.braking : t.acceleration) * dt;
    else
      this.speed =
        Math.sign(this.speed) * Math.max(0, Math.abs(this.speed) - t.drag * dt);
    if (input.handbrake) this.speed *= Math.exp(-1.6 * dt);
    this.speed = Math.max(-t.reverseSpeed, Math.min(t.topSpeed, this.speed));
    this.angle +=
      Math.max(-1, Math.min(1, input.steer)) *
      t.steering *
      Math.min(1, Math.abs(this.speed) / 65) *
      Math.sign(this.speed) *
      dt *
      (input.handbrake ? 1.4 : 1);
    this.angle = Math.atan2(Math.sin(this.angle), Math.cos(this.angle));
    const blend = 1 - Math.exp(-(input.handbrake ? 2.2 : t.grip) * dt);
    this.vx += (Math.cos(this.angle) * this.speed - this.vx) * blend;
    this.vy += (Math.sin(this.angle) * this.speed - this.vy) * blend;
    const impact = Math.hypot(this.vx, this.vy);
    if (world.move(this, this.vx * dt, this.vy * dt, t.radius)) {
      this.speed *= 0.28;
      this.vx *= 0.25;
      this.vy *= 0.25;
      return impact;
    }
    return 0;
  }
  stop(): void {
    this.speed = this.vx = this.vy = 0;
  }
}

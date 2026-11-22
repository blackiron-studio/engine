// Arcing throws over a height field: gravity, bounces off the floor that lose speed, bounces
// off walls and cliff faces, rolling to rest. Everything steps at a fixed 1/120 s, so the
// predicted arc drawn while aiming is exactly the path the real throw takes.

import type { SightGrid } from "../core/sight.ts";

/** Ground height at a world position; walls are `Infinity`. */
export type HeightField = (x: number, y: number) => number;

/** A height field from a sight grid: opaque cells are walls, heights are ledges. */
export function heightField(grid: SightGrid): HeightField {
  const cs = grid.cell ?? 1;
  return (x, y) => {
    const c = Math.floor(x / cs);
    const r = Math.floor(y / cs);
    if (grid.opaque(c, r)) return Infinity;
    return grid.height ? grid.height(c, r) : 0;
  };
}

export const THROW_STEP = 1 / 120;

export interface ThrowOptions {
  /** World units per second squared; 900 by default. */
  gravity?: number;
  /** Share of downward speed kept on a floor bounce; 0.42 by default. */
  bounce?: number;
  /** Share of ground speed kept on each floor bounce; 0.72 by default. */
  friction?: number;
  /** Share of speed kept off a wall; 0.5 by default. */
  wallBounce?: number;
  /** Ground speed lost per second while rolling, as a share; 3 by default. */
  drag?: number;
  /** Slower than this on the ground and it comes to rest; 6 by default. */
  restSpeed?: number;
  /** Falling slower than this onto the floor stops the bouncing; 40 by default. */
  minBounce?: number;
}

export interface ThrowEvent {
  kind: "bounce" | "wall" | "rest";
  x: number;
  y: number;
  z: number;
  /** Speed at the moment, world units per second. */
  speed: number;
}

export class Thrown2D {
  resting = false;
  /** Seconds in flight, in fixed steps. */
  time = 0;
  bounces = 0;
  /** Whether it has touched the floor yet. */
  landed = false;
  private acc = 0;
  private readonly g: number;
  private readonly o: Required<ThrowOptions>;

  constructor(
    public x: number,
    public y: number,
    public z: number,
    public vx: number,
    public vy: number,
    public vz: number,
    opts: ThrowOptions = {},
  ) {
    this.o = {
      gravity: opts.gravity ?? 900,
      bounce: opts.bounce ?? 0.42,
      friction: opts.friction ?? 0.72,
      wallBounce: opts.wallBounce ?? 0.5,
      drag: opts.drag ?? 3,
      restSpeed: opts.restSpeed ?? 6,
      minBounce: opts.minBounce ?? 40,
    };
    this.g = this.o.gravity;
  }

  /** Advance by `dt` in fixed steps; returns what happened. */
  step(dt: number, ground: HeightField): ThrowEvent[] {
    const events: ThrowEvent[] = [];
    this.acc += dt;
    while (this.acc >= THROW_STEP - 1e-12 && !this.resting) {
      this.acc -= THROW_STEP;
      this.substep(ground, events);
    }
    if (this.resting) this.acc = 0;
    return events;
  }

  /** One fixed step. */
  substep(ground: HeightField, events: ThrowEvent[] = []): ThrowEvent[] {
    if (this.resting) return events;
    const h = THROW_STEP;
    const o = this.o;
    this.time += h;
    // Horizontal moves one axis at a time, so a wall flips only the speed that ran into it.
    const nx = this.x + this.vx * h;
    if (ground(nx, this.y) > this.z + 1e-6) {
      this.vx = -this.vx * o.wallBounce;
      this.vy *= o.wallBounce;
      events.push({ kind: "wall", x: this.x, y: this.y, z: this.z, speed: this.speed });
    } else this.x = nx;
    const ny = this.y + this.vy * h;
    if (ground(this.x, ny) > this.z + 1e-6) {
      this.vy = -this.vy * o.wallBounce;
      this.vx *= o.wallBounce;
      events.push({ kind: "wall", x: this.x, y: this.y, z: this.z, speed: this.speed });
    } else this.y = ny;
    this.vz -= this.g * h;
    this.z += this.vz * h;
    const floor = ground(this.x, this.y);
    if (this.z <= floor) {
      this.z = floor;
      this.landed = true;
      if (this.vz < -o.minBounce) {
        this.vz = -this.vz * o.bounce;
        this.vx *= o.friction;
        this.vy *= o.friction;
        this.bounces++;
        events.push({ kind: "bounce", x: this.x, y: this.y, z: this.z, speed: this.speed });
      } else {
        this.vz = 0;
      }
    }
    if (this.vz === 0 && this.z <= floor + 1e-6) {
      const keep = Math.max(0, 1 - o.drag * h);
      this.vx *= keep;
      this.vy *= keep;
      if (Math.hypot(this.vx, this.vy) < o.restSpeed) {
        this.vx = 0;
        this.vy = 0;
        this.resting = true;
        events.push({ kind: "rest", x: this.x, y: this.y, z: this.z, speed: 0 });
      }
    }
    return events;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy, this.vz);
  }
}

export interface LaunchOptions {
  gravity?: number;
  /** Ground speed, world units per second; 320 by default. Ignored when `time` is given. */
  speed?: number;
  /** Seconds to reach the target. */
  time?: number;
  /** Shortest flight, seconds; 0.3 by default, so close throws still arc. */
  minTime?: number;
}

/** The launch velocity that lands from (x0, y0, z0) on (x1, y1, z1), ignoring anything in the way. */
export function launchVelocity(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, opts: LaunchOptions = {}): { vx: number; vy: number; vz: number; time: number } {
  const g = opts.gravity ?? 900;
  const d = Math.hypot(x1 - x0, y1 - y0);
  const time = opts.time ?? Math.max(opts.minTime ?? 0.3, d / (opts.speed ?? 320));
  return {
    vx: (x1 - x0) / time,
    vy: (y1 - y0) / time,
    vz: (z1 - z0 + 0.5 * g * time * time) / time,
    time,
  };
}

export interface ThrowPrediction {
  /** Points along the arc, every `every` fixed steps, starting at the launch. */
  path: { x: number; y: number; z: number }[];
  /** First floor contact, or null if it never lands within `maxTime`. */
  landing: { x: number; y: number; z: number } | null;
  /** Where it ends: at rest, or after `maxTime`. */
  end: { x: number; y: number; z: number };
  /** Seconds until the end. */
  time: number;
  bounces: number;
}

/** Simulate a throw to draw its arc; matches a `Thrown2D` launched the same way. */
export function predictThrow(
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  ground: HeightField,
  opts: ThrowOptions & { maxTime?: number; every?: number; stopAtLanding?: boolean } = {},
): ThrowPrediction {
  const t = new Thrown2D(x, y, z, vx, vy, vz, opts);
  const every = Math.max(1, opts.every ?? 3);
  const steps = Math.ceil((opts.maxTime ?? 4) / THROW_STEP);
  const path = [{ x, y, z }];
  let landing: ThrowPrediction["landing"] = null;
  for (let i = 1; i <= steps && !t.resting; i++) {
    t.substep(ground);
    if (i % every === 0) path.push({ x: t.x, y: t.y, z: t.z });
    if (!landing && t.landed) {
      landing = { x: t.x, y: t.y, z: t.z };
      if (opts.stopAtLanding) break;
    }
  }
  const end = { x: t.x, y: t.y, z: t.z };
  const last = path[path.length - 1]!;
  if (last.x !== end.x || last.y !== end.y || last.z !== end.z) path.push(end);
  return { path, landing, end, time: t.time, bounces: t.bounces };
}

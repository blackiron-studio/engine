// Pooled projectiles that sweep each step against walls and targets through a combat world,
// so fast shots never tunnel. A spent projectile goes back to the pool; when the pool is
// full the oldest is recycled.

import type { ExplosionSpec2D } from "./destructible.ts";
import type { Shot2D, WeaponDef2D } from "./weapon.ts";
import type { CombatTarget2D, CombatWorld2D, ImpactResult2D, Team, TraceHit2D } from "./world.ts";

export interface Projectile2D {
  active: boolean;
  id: number;
  x: number;
  y: number;
  z: number;
  /** Where it was at the start of the last step, for trails and interpolation. */
  px: number;
  py: number;
  vx: number;
  vy: number;
  /** Height gained per unit travelled: shots up to a ledge or down from one. */
  slope: number;
  angle: number;
  speed: number;
  /** Distance left before it fizzles. */
  rangeLeft: number;
  radius: number;
  team: Team | undefined;
  damage: number;
  kind: string;
  knockback: number;
  splash: ExplosionSpec2D | undefined;
  source: unknown;
  /** The weapon or kind of shot, for picking art. */
  tag: string;
  /** Seconds alive. */
  age: number;
}

export interface ProjectileSpec2D {
  x: number;
  y: number;
  z?: number;
  /** Height gained per unit travelled; level by default. */
  slope?: number;
  angle: number;
  speed: number;
  range: number;
  damage: number;
  team?: Team;
  radius?: number;
  kind?: string;
  knockback?: number;
  splash?: ExplosionSpec2D;
  /** The shooter; never hit by its own shot. */
  source?: unknown;
  tag?: string;
  /** Seconds already in flight (a shot's `age`): it is advanced this far at once. */
  age?: number;
}

export interface ProjectileImpact2D extends ImpactResult2D {
  projectile: Projectile2D;
}

export class Projectiles2D {
  readonly items: Projectile2D[] = [];
  private nextId = 1;
  private readonly early: ProjectileImpact2D[] = [];

  constructor(
    readonly world: CombatWorld2D,
    readonly capacity = 256,
  ) {}

  get count(): number {
    let n = 0;
    for (const p of this.items) if (p.active) n++;
    return n;
  }

  /** Active projectiles. */
  *[Symbol.iterator](): IterableIterator<Projectile2D> {
    for (const p of this.items) if (p.active) yield p;
  }

  fire(spec: ProjectileSpec2D): Projectile2D {
    let p = this.items.find((q) => !q.active);
    if (!p) {
      if (this.items.length < this.capacity) {
        p = {} as Projectile2D;
        this.items.push(p);
      } else {
        p = this.items.reduce((a, b) => (b.id < a.id ? b : a));
      }
    }
    Object.assign(p, {
      active: true,
      id: this.nextId++,
      x: spec.x,
      y: spec.y,
      px: spec.x,
      py: spec.y,
      z: spec.z ?? 0,
      vx: Math.cos(spec.angle) * spec.speed,
      vy: Math.sin(spec.angle) * spec.speed,
      slope: spec.slope ?? 0,
      angle: spec.angle,
      speed: spec.speed,
      rangeLeft: spec.range,
      radius: spec.radius ?? 0,
      team: spec.team,
      damage: spec.damage,
      kind: spec.kind ?? "bullet",
      knockback: spec.knockback ?? 0,
      splash: spec.splash,
      source: spec.source,
      tag: spec.tag ?? "",
      age: 0,
    } satisfies Projectile2D);
    if (spec.age && spec.age > 0) this.advance(p, spec.age, this.early);
    return p;
  }

  /** Fire a weapon's shot from (x, y): a projectile for guns with a speed, a hitscan otherwise. */
  shoot(def: WeaponDef2D, shot: Shot2D, x: number, y: number, opts: ShotOptions2D = {}): Projectile2D | ImpactResult2D | null {
    if (def.speed !== undefined) {
      return this.fire({
        x,
        y,
        z: opts.z,
        slope: opts.slope,
        angle: shot.angle,
        speed: def.speed,
        range: def.range,
        damage: shot.damage,
        team: opts.team,
        radius: def.radius,
        kind: def.kind ?? "bullet",
        knockback: def.knockback,
        splash: def.splash,
        source: opts.source,
        tag: def.id,
        age: shot.age,
      });
    }
    return hitscanShot(this.world, def, shot, x, y, opts);
  }

  /** Move every projectile; returns what they hit. */
  update(dt: number): ProjectileImpact2D[] {
    const out = this.early.splice(0);
    for (const p of this.items) if (p.active) this.advance(p, dt, out);
    return out;
  }

  private advance(p: Projectile2D, dt: number, out: ProjectileImpact2D[]): void {
    p.px = p.x;
    p.py = p.y;
    p.age += dt;
    const step = Math.min(p.speed * dt, p.rangeLeft);
    const dx = Math.cos(p.angle);
    const dy = Math.sin(p.angle);
    const x1 = p.x + dx * step;
    const y1 = p.y + dy * step;
    const ignore = p.source && typeof p.source === "object" ? (p.source as CombatTarget2D) : undefined;
    const z1 = p.z + p.slope * step;
    const hit = this.world.trace(p.x, p.y, x1, y1, { team: p.team, z0: p.z, z1, radius: p.radius, ignore });
    if (hit) {
      p.x = hit.x;
      p.y = hit.y;
      p.z += (z1 - p.z) * hit.t;
      p.active = false;
      const result = this.world.impact(hit, { damage: p.damage, kind: p.kind, knockback: p.knockback, team: p.team, source: p.source, splash: p.splash }, dx, dy, p.z);
      out.push({ ...result, projectile: p });
      return;
    }
    p.x = x1;
    p.y = y1;
    p.z = z1;
    p.rangeLeft -= step;
    if (p.rangeLeft <= 1e-9) p.active = false;
  }

  clear(): void {
    for (const p of this.items) p.active = false;
    this.early.length = 0;
  }
}

export interface ShotOptions2D {
  team?: Team;
  /** The shooter; never hit by its own shot. */
  source?: unknown;
  /** Muzzle height. */
  z?: number;
  /** Height gained per unit travelled, to shoot up onto a ledge or down from one. */
  slope?: number;
}

/** The slope that carries a shot from height `z0` to `z1` over `distance`. */
export function slopeTo(z0: number, z1: number, distance: number): number {
  return distance > 1e-6 ? (z1 - z0) / distance : 0;
}

/** A hitscan shot from (x, y): trace, then hurt what it met. Null when it hit nothing. */
export function hitscanShot(world: CombatWorld2D, def: WeaponDef2D, shot: Shot2D, x: number, y: number, opts: ShotOptions2D = {}): ImpactResult2D | null {
  const ignore = opts.source && typeof opts.source === "object" ? (opts.source as CombatTarget2D) : undefined;
  const z0 = opts.z;
  const z1 = z0 === undefined ? undefined : z0 + (opts.slope ?? 0) * def.range;
  const hit: TraceHit2D | null = world.hitscan(x, y, shot.angle, def.range, { team: opts.team, z0, z1, ignore });
  if (!hit) return null;
  const z = z0 === undefined ? 0 : z0 + (z1! - z0) * hit.t;
  return world.impact(hit, { damage: shot.damage, kind: def.kind ?? "bullet", knockback: def.knockback, team: opts.team, source: opts.source, splash: def.splash }, Math.cos(shot.angle), Math.sin(shot.angle), z);
}

import { Vec3 } from "./math.ts";
import { Rng } from "../core/rng.ts";
import { NativePhysicsWorld3D } from "./physics-native.ts";
import type { PhysicsBackend3D } from "./physics.ts";

export interface DamageEvent3D {
  amount: number;
  point: Readonly<Vec3>;
  direction: Readonly<Vec3>;
  source?: unknown;
}
export interface Damageable3D {
  takeDamage(event: DamageEvent3D): void;
}
export interface Hit3D {
  distance: number;
  point: Vec3;
  normal: Vec3;
  collider: number;
  target?: Damageable3D;
}
/** Physics queries stop at the nearest collider, including ordinary walls with no damage handler. */
export class CombatWorld3D {
  private targets = new Map<number, Damageable3D>();
  constructor(readonly physics: PhysicsBackend3D) {}
  register(collider: number, target: Damageable3D): () => void {
    if (this.targets.has(collider))
      throw new Error("Collider already has a damage target");
    this.targets.set(collider, target);
    return () => {
      if (this.targets.get(collider) === target) this.targets.delete(collider);
    };
  }
  cast(
    origin: Readonly<Vec3>,
    direction: Readonly<Vec3>,
    range: number,
    ignore?: number,
  ): Hit3D | null {
    if (
      ![
        origin.x,
        origin.y,
        origin.z,
        direction.x,
        direction.y,
        direction.z,
        range,
      ].every(Number.isFinite) ||
      range < 0
    )
      throw new RangeError("Invalid combat ray");
    const dir = new Vec3().copy(direction).normalize();
    if (dir.length < 0.5) throw new RangeError("Zero combat direction");
    const hit =
      this.physics instanceof NativePhysicsWorld3D
        ? this.physics.raycast(origin, dir, range, ignore)
        : this.physics.world.castRayAndGetNormal(
            new this.physics.api.Ray(origin, dir),
            range,
            true,
            undefined,
            undefined,
            undefined,
            undefined,
            (c) => c.handle !== ignore,
          );
    if (!hit) return null;
    return {
      distance: hit.timeOfImpact,
      point: new Vec3().copy(dir).multiplyScalar(hit.timeOfImpact).add(origin),
      normal: new Vec3(hit.normal.x, hit.normal.y, hit.normal.z),
      collider: hit.collider.handle,
      target: this.targets.get(hit.collider.handle),
    };
  }
  hitscan(
    origin: Readonly<Vec3>,
    direction: Readonly<Vec3>,
    range: number,
    damage: number,
    ignore?: number,
    source?: unknown,
  ): Hit3D | null {
    if (!Number.isFinite(damage) || damage < 0)
      throw new RangeError("Invalid damage");
    const hit = this.cast(origin, direction, range, ignore);
    hit?.target?.takeDamage({
      amount: damage,
      point: hit.point,
      direction,
      source,
    });
    return hit;
  }
  dispose(): void {
    this.targets.clear();
  }
  get targetCount(): number {
    return this.targets.size;
  }
}
export interface WeaponDefinition3D {
  id: string;
  magazine: number;
  reserve: number;
  interval: number;
  reloadSeconds: number;
  damage: number;
  range: number;
  pellets?: number;
  spread?: number;
  automatic?: boolean;
}
/** Content-configured weapon state; no game names, audio, models, or key bindings. */
export class Weapon3D {
  ammo: number;
  reserve: number;
  cooldown = 0;
  reloadRemaining = 0;
  private held = false;
  private readonly rng: Rng;
  constructor(
    readonly definition: Readonly<WeaponDefinition3D>,
    seed: string | number = 1,
  ) {
    const d = definition;
    if (
      !d.id ||
      ![
        d.magazine,
        d.reserve,
        d.interval,
        d.reloadSeconds,
        d.damage,
        d.range,
        d.pellets ?? 1,
        d.spread ?? 0,
      ].every(Number.isFinite) ||
      !Number.isInteger(d.magazine) ||
      d.magazine < 1 ||
      !Number.isInteger(d.reserve) ||
      d.reserve < 0 ||
      d.interval <= 0 ||
      d.reloadSeconds <= 0 ||
      d.damage < 0 ||
      d.range <= 0 ||
      !Number.isInteger(d.pellets ?? 1) ||
      (d.pellets ?? 1) < 1 ||
      (d.pellets ?? 1) > 128 ||
      (d.spread ?? 0) < 0 ||
      (d.spread ?? 0) >= Math.PI / 2
    )
      throw new RangeError("Invalid weapon definition");
    this.ammo = d.magazine;
    this.reserve = d.reserve;
    this.rng = new Rng(seed);
  }
  update(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0)
      throw new RangeError("Invalid weapon step");
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloadRemaining > 0) {
      this.reloadRemaining = Math.max(0, this.reloadRemaining - dt);
      if (this.reloadRemaining === 0) {
        const n = Math.min(this.definition.magazine - this.ammo, this.reserve);
        this.ammo += n;
        this.reserve -= n;
      }
    }
  }
  reload(): boolean {
    if (
      this.reloadRemaining > 0 ||
      this.ammo >= this.definition.magazine ||
      this.reserve === 0
    )
      return false;
    this.reloadRemaining = this.definition.reloadSeconds;
    return true;
  }
  release(): void {
    this.held = false;
  }
  trigger(down: boolean, direction: Readonly<Vec3>): Vec3[] {
    const edge = down && !this.held;
    this.held = down;
    if (
      !down ||
      (!this.definition.automatic && !edge) ||
      this.cooldown > 0 ||
      this.reloadRemaining > 0 ||
      this.ammo === 0
    )
      return [];
    if (![direction.x, direction.y, direction.z].every(Number.isFinite))
      throw new RangeError("Invalid weapon aim");
    const forward = new Vec3().copy(direction).normalize();
    if (forward.length < 0.5) throw new RangeError("Zero weapon aim");
    this.ammo--;
    this.cooldown = this.definition.interval;
    const right = new Vec3()
      .copy(forward)
      .cross(Math.abs(forward.y) > 0.99 ? new Vec3(0, 0, 1) : new Vec3(0, 1, 0))
      .normalize();
    const up = new Vec3().copy(right).cross(forward).normalize();
    return Array.from({ length: this.definition.pellets ?? 1 }, () => {
      const angle = this.rng.range(0, Math.PI * 2),
        r = Math.sqrt(this.rng.next()) * Math.tan(this.definition.spread ?? 0);
      return new Vec3()
        .copy(forward)
        .add(right.clone().multiplyScalar(Math.cos(angle) * r))
        .add(up.clone().multiplyScalar(Math.sin(angle) * r))
        .normalize();
    });
  }
}
/** Swept projectiles query their whole segment, so a fast shot cannot skip a thin wall. */
export class Projectile3D {
  readonly position: Vec3;
  alive = true;
  constructor(
    position: Readonly<Vec3>,
    readonly velocity: Vec3,
    public lifetime: number,
    readonly damage: number,
    readonly ignore?: number,
    readonly source?: unknown,
  ) {
    if (
      ![
        position.x,
        position.y,
        position.z,
        velocity.x,
        velocity.y,
        velocity.z,
        lifetime,
        damage,
      ].every(Number.isFinite) ||
      lifetime <= 0 ||
      damage < 0
    )
      throw new RangeError("Invalid projectile");
    this.position = new Vec3().copy(position);
  }
  step(world: CombatWorld3D, dt: number): Hit3D | null {
    if (!Number.isFinite(dt) || dt < 0)
      throw new RangeError("Invalid projectile step");
    if (!this.alive || dt === 0) return null;
    const step = Math.min(dt, this.lifetime),
      distance = this.velocity.length * step;
    const hit =
      distance > 0
        ? world.hitscan(
            this.position,
            this.velocity,
            distance,
            this.damage,
            this.ignore,
            this.source,
          )
        : null;
    if (hit) {
      this.position.copy(hit.point);
      this.alive = false;
      return hit;
    }
    this.position.add(this.velocity.clone().multiplyScalar(step));
    this.lifetime -= dt;
    if (this.lifetime <= 0) this.alive = false;
    return null;
  }
}

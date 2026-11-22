// Data-defined guns: fire interval, automatic or semi with a buffered pull, bursts, pellets,
// spread with bloom that grows per shot and recovers, recoil, magazine, reserve and reload.
// `step` returns the shots fired this frame with how long ago each went off, so fast guns
// stay steady at any frame rate. Spread draws from a seeded Rng, so replays match.

import { Rng } from "../core/rng.ts";
import type { ExplosionSpec2D } from "./destructible.ts";

export interface WeaponDef2D {
  id: string;
  damage: number;
  /** Seconds between shots (between bursts, for burst guns). */
  interval: number;
  magazine: number;
  /** Spare rounds; unlimited when omitted. */
  reserve?: number;
  reloadSeconds: number;
  range: number;
  /** Keeps firing while held; otherwise one shot (or burst) per pull. */
  automatic?: boolean;
  /** Shots per pull, `burstInterval` seconds apart. */
  burst?: number;
  burstInterval?: number;
  /** Pellets per shot, sharing one round, fanned across `spread`. */
  pellets?: number;
  /** Full cone, radians, shots scatter in before bloom. */
  spread?: number;
  /** Spread each shot adds, its cap, and how fast it recovers (radians per second). */
  bloom?: number;
  bloomMax?: number;
  bloomRecovery?: number;
  /** Kick each shot reports, for the camera or the shooter. */
  recoil?: number;
  /** Projectile speed, world units per second; hitscan when omitted. */
  speed?: number;
  /** Projectile radius. */
  radius?: number;
  knockback?: number;
  /** Damage kind; "bullet" by default. */
  kind?: string;
  /** Blows up where it lands. */
  splash?: ExplosionSpec2D;
  /** Rounds per shot; 1 by default. */
  ammoPerShot?: number;
  /** Reload on its own when the magazine runs dry; true by default. */
  autoReload?: boolean;
  /** Seconds a semi-automatic pull is remembered while the gun cycles; 0.12 by default. */
  buffer?: number;
}

export interface Shot2D {
  angle: number;
  /** Seconds ago, within this step, it went off: advance a projectile by this much. */
  age: number;
  damage: number;
  /** Which shot of this step and which pellet of that shot. */
  index: number;
  pellet: number;
  recoil: number;
}

export interface TriggerInput {
  fire: boolean;
  /** Aim, radians. */
  angle: number;
}

export function validateWeapon(d: WeaponDef2D): void {
  const nums = [d.damage, d.interval, d.magazine, d.reloadSeconds, d.range, d.pellets ?? 1, d.spread ?? 0, d.burst ?? 1];
  if (!d.id || !nums.every(Number.isFinite)) throw new RangeError(`Invalid weapon ${d.id || "(no id)"}`);
  if (!(d.interval > 0) || !(d.range > 0) || d.damage < 0 || d.reloadSeconds < 0) throw new RangeError(`Invalid weapon ${d.id}`);
  if (!Number.isInteger(d.magazine) || d.magazine < 1) throw new RangeError(`Weapon ${d.id} needs a whole magazine`);
  if (!Number.isInteger(d.pellets ?? 1) || (d.pellets ?? 1) < 1 || (d.pellets ?? 1) > 128) throw new RangeError(`Weapon ${d.id} pellets must be 1..128`);
  if (!Number.isInteger(d.burst ?? 1) || (d.burst ?? 1) < 1) throw new RangeError(`Weapon ${d.id} burst must be a whole number`);
  if ((d.spread ?? 0) < 0 || (d.spread ?? 0) >= Math.PI) throw new RangeError(`Weapon ${d.id} spread must be under a half turn`);
  if (d.speed !== undefined && !(d.speed > 0)) throw new RangeError(`Weapon ${d.id} speed must be positive`);
}

export class Weapon2D {
  ammo: number;
  reserve: number;
  /** Seconds until the next shot may fire. */
  cooldown = 0;
  /** Seconds of reload left; 0 when not reloading. */
  reloadLeft = 0;
  /** Extra spread from sustained fire, radians. */
  bloom = 0;
  private burstLeft = 0;
  private burstWait = 0;
  private held = false;
  private pulled = false;
  private pullAge = 0;
  private readonly rng: Rng;

  constructor(
    readonly def: Readonly<WeaponDef2D>,
    seed: number | string = 1,
  ) {
    validateWeapon(def);
    this.ammo = def.magazine;
    this.reserve = def.reserve ?? Infinity;
    this.rng = new Rng(seed);
  }

  get reloading(): boolean {
    return this.reloadLeft > 0;
  }

  /** Reload progress 0..1 while reloading. */
  get reloadProgress(): number {
    return this.reloadLeft > 0 && this.def.reloadSeconds > 0 ? 1 - this.reloadLeft / this.def.reloadSeconds : 0;
  }

  /** Current full cone of spread, radians. */
  get spread(): number {
    return (this.def.spread ?? 0) + this.bloom;
  }

  get empty(): boolean {
    return this.ammo < (this.def.ammoPerShot ?? 1);
  }

  /** Start a reload; false when full, out of spares or already reloading. */
  reload(): boolean {
    if (this.reloadLeft > 0 || this.ammo >= this.def.magazine || this.reserve <= 0) return false;
    this.burstLeft = 0;
    if (this.def.reloadSeconds === 0) {
      this.finishReload();
      return true;
    }
    this.reloadLeft = this.def.reloadSeconds;
    return true;
  }

  /** Add spare rounds; returns how many were taken. */
  addAmmo(rounds: number): number {
    if (this.reserve === Infinity || !(rounds > 0)) return 0;
    this.reserve += rounds;
    return rounds;
  }

  private finishReload(): void {
    const n = Math.min(this.def.magazine - this.ammo, this.reserve);
    this.ammo += n;
    this.reserve -= n;
    this.reloadLeft = 0;
  }

  /** Advance by `dt` with the trigger as given; returns the shots fired. */
  step(dt: number, input: TriggerInput): Shot2D[] {
    if (!(dt >= 0)) throw new RangeError("Invalid weapon step");
    const d = this.def;
    const per = d.ammoPerShot ?? 1;
    const edge = input.fire && !this.held;
    this.held = input.fire;
    if (edge) {
      this.pulled = true;
      this.pullAge = 0;
    } else if (this.pulled && !this.held) {
      this.pullAge += dt;
      if (this.pullAge > (d.buffer ?? 0.12)) this.pulled = false;
    }
    this.bloom = Math.max(0, this.bloom - (d.bloomRecovery ?? 0) * dt);
    const shots: Shot2D[] = [];
    let clock = 0;
    if (this.reloadLeft > 0) {
      if (this.reloadLeft > dt) {
        this.reloadLeft -= dt;
        this.cooldown = Math.max(0, this.cooldown - dt);
        return shots;
      }
      clock = this.reloadLeft;
      this.cooldown = Math.max(0, this.cooldown - clock);
      this.finishReload();
    }
    for (let guard = 0; guard < 4096; guard++) {
      const left = dt - clock;
      if (this.burstLeft > 0) {
        if (this.burstWait > left + 1e-9) break;
        clock = Math.min(dt, clock + this.burstWait);
        this.cooldown = Math.max(0, this.cooldown - this.burstWait);
        this.burstWait = 0;
        if (this.ammo < per) {
          this.burstLeft = 0;
          break;
        }
        this.fire(dt - clock, input.angle, shots);
        this.burstLeft--;
        this.burstWait = d.burstInterval ?? 0.06;
        continue;
      }
      const want = d.automatic ? input.fire : this.pulled;
      if (!want || this.ammo < per || this.cooldown > left + 1e-9) break;
      clock = Math.min(dt, clock + this.cooldown);
      this.cooldown = d.interval;
      this.pulled = false;
      this.fire(dt - clock, input.angle, shots);
      this.burstLeft = (d.burst ?? 1) - 1;
      this.burstWait = d.burstInterval ?? 0.06;
    }
    const rest = dt - clock;
    this.cooldown = Math.max(0, this.cooldown - rest);
    if (this.burstLeft > 0) this.burstWait = Math.max(0, this.burstWait - rest);
    if (this.ammo < per && (d.autoReload ?? true) && this.burstLeft === 0) this.reload();
    return shots;
  }

  private fire(age: number, angle: number, out: Shot2D[]): void {
    const d = this.def;
    this.ammo -= d.ammoPerShot ?? 1;
    const pellets = d.pellets ?? 1;
    const spread = d.spread ?? 0;
    const index = out.length === 0 ? 0 : out[out.length - 1]!.index + 1;
    for (let p = 0; p < pellets; p++) {
      let a = angle;
      if (pellets > 1) {
        // Fan evenly across the cone, jittered within each slice, so a shotgun reads as a spread.
        const slice = spread / pellets;
        a += -spread / 2 + (p + 0.5) * slice + this.rng.range(-0.5, 0.5) * slice;
        a += this.rng.range(-0.5, 0.5) * this.bloom;
      } else {
        a += this.rng.range(-0.5, 0.5) * (spread + this.bloom);
      }
      out.push({ angle: a, age, damage: d.damage, index, pellet: p, recoil: d.recoil ?? 0 });
    }
    this.bloom = Math.min(d.bloomMax ?? Infinity, this.bloom + (d.bloom ?? 0));
  }
}

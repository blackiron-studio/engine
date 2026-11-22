// Hit points with an armour pool, per-kind resistances and a short invulnerability window.

export interface HealthOptions {
  max: number;
  /** Starting hit points; `max` by default. */
  hp?: number;
  /** Armour soaks damage before hit points. */
  armour?: number;
  maxArmour?: number;
  /** Share of each hit the armour takes while it lasts, 0..1; all of it by default. */
  absorb?: number;
  /** Damage multipliers by kind: `{ explosive: 2, bullet: 0.5 }`. */
  resist?: Record<string, number>;
  /** Seconds a hit makes the owner immune to the next ones; 0 by default. */
  grace?: number;
}

export class Health {
  hp: number;
  max: number;
  armour: number;
  maxArmour: number;
  absorb: number;
  resist: Record<string, number>;
  grace: number;
  /** Seconds of immunity left. */
  invulnerable = 0;

  constructor(opts: HealthOptions | number) {
    const o = typeof opts === "number" ? { max: opts } : opts;
    if (!(o.max > 0)) throw new RangeError("Health needs a positive max");
    this.max = o.max;
    this.hp = Math.min(o.hp ?? o.max, o.max);
    this.armour = o.armour ?? 0;
    this.maxArmour = o.maxArmour ?? Math.max(this.armour, 0);
    this.absorb = Math.min(1, Math.max(0, o.absorb ?? 1));
    this.resist = o.resist ?? {};
    this.grace = o.grace ?? 0;
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  get dead(): boolean {
    return this.hp <= 0;
  }

  /** Hit points as a share of max, 0..1. */
  get fraction(): number {
    return Math.max(0, this.hp / this.max);
  }

  /** What a hit of `amount` and `kind` would cost after resistances, before armour. */
  scaled(amount: number, kind?: string): number {
    return Math.max(0, amount * (kind !== undefined ? (this.resist[kind] ?? 1) : 1));
  }

  /**
   * Take a hit; returns the hit points lost (armour soaks its share first). Nothing happens
   * while dead or invulnerable.
   */
  take(amount: number, kind?: string): number {
    if (this.dead || this.invulnerable > 0 || !(amount > 0)) return 0;
    let dmg = this.scaled(amount, kind);
    if (this.armour > 0 && dmg > 0) {
      const soak = Math.min(this.armour, dmg * this.absorb);
      this.armour -= soak;
      dmg -= soak;
    }
    const lost = Math.min(this.hp, dmg);
    this.hp -= lost;
    if (lost > 0 && this.grace > 0) this.invulnerable = this.grace;
    return lost;
  }

  heal(amount: number): number {
    if (this.dead || !(amount > 0)) return 0;
    const gained = Math.min(this.max - this.hp, amount);
    this.hp += gained;
    return gained;
  }

  repair(amount: number): number {
    if (!(amount > 0)) return 0;
    const gained = Math.min(this.maxArmour - this.armour, amount);
    this.armour += Math.max(0, gained);
    return Math.max(0, gained);
  }

  update(dt: number): void {
    if (this.invulnerable > 0) this.invulnerable = Math.max(0, this.invulnerable - dt);
  }

  /** Back to full, alive again. */
  reset(): void {
    this.hp = this.max;
    this.armour = this.maxArmour;
    this.invulnerable = 0;
  }
}

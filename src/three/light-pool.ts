// LightPool3D: a few point lights kept ready for short flashes (a muzzle lighting the room, an
// explosion, a spark shower). The renderer lights each surface with the eight strongest lights, so
// flashes come from a small fixed pool: when all are busy, the one closest to finished gives way.

import { Vec3 } from "./math.ts";
import { Node3D } from "./node.ts";
import { PointLight3D } from "./scene.ts";

type Vec3Like = Readonly<{ x: number; y: number; z: number }>;

export interface LightFlash3D {
  color?: number;
  /** Peak intensity. */
  intensity: number;
  /** Reach in metres. */
  range: number;
  /** Seconds until dark. */
  lifetime: number;
  /** How it dies: 2 (the default) drops fast then lingers, 1 is even. */
  falloff?: number;
}

interface Slot {
  light: PointLight3D;
  t: number;
  life: number;
  peak: number;
  falloff: number;
  follow: Node3D | null;
  readonly offset: Vec3;
}

export class LightPool3D extends Node3D {
  private readonly slots: Slot[] = [];

  /** Add it untransformed (positions are world space). */
  constructor(readonly capacity = 3) {
    super();
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) throw new RangeError("LightPool3D holds 1 to 8 lights");
    for (let i = 0; i < capacity; i++)
      this.slots.push({ light: this.add(new PointLight3D(0xffffff, 0, 1)), t: 1, life: 1, peak: 0, falloff: 2, follow: null, offset: new Vec3() });
  }

  /** Lights still glowing. */
  get activeCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.t < s.life) n++;
    return n;
  }

  /**
   * Flash a light at `position` (world space), or at `position` in `follow`'s space so it rides
   * along (a bolt, a burning wreck).
   */
  flash(position: Vec3Like, options: LightFlash3D, follow: Node3D | null = null): PointLight3D {
    const { intensity, range, lifetime, color = 0xffffff, falloff = 2 } = options;
    if (![position.x, position.y, position.z, intensity, range, lifetime, falloff].every(Number.isFinite) || intensity < 0 || range <= 0 || lifetime <= 0 || falloff <= 0)
      throw new RangeError("Light flashes need a finite position, nonnegative intensity and positive range, lifetime and falloff");
    let slot = this.slots[0];
    for (const s of this.slots) if (s.t / s.life > slot.t / slot.life) slot = s;
    slot.light.color = color;
    slot.light.range = range;
    slot.light.intensity = intensity;
    slot.peak = intensity;
    slot.t = 0;
    slot.life = lifetime;
    slot.falloff = falloff;
    slot.follow = follow;
    slot.offset.set(position.x, position.y, position.z);
    if (follow) follow.localToWorld(slot.offset, slot.light.position);
    else slot.light.position.copy(slot.offset);
    return slot.light;
  }

  /** Put every light out. */
  reset(): void {
    for (const s of this.slots) {
      s.t = s.life;
      s.light.intensity = 0;
      s.follow = null;
    }
  }

  override update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    for (const s of this.slots) {
      if (s.t >= s.life) continue;
      s.t += dt;
      if (s.follow) {
        if (s.follow.parent) s.follow.localToWorld(s.offset, s.light.position);
        else s.t = s.life;
      }
      const k = Math.max(0, 1 - s.t / s.life);
      s.light.intensity = s.peak * k ** s.falloff;
    }
  }
}

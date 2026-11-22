// LightPool: short-lived lights without a node each. Muzzle flashes, impacts and explosions
// `flash` a light that brightens the room and dies away; a moving glow (a bolt crossing the
// room) is `track`ed by key each frame and fades once it stops being tracked. The pool holds
// a fixed number of lights and, when full, drops the dimmest, so a firefight cannot flood
// the scene. Put it inside a LightLayer, like any Light2D.

import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";
import { placeAt, restorePlace } from "./place.ts";

/** How a flash dies over its life: brightness for t from 0 to 1. */
export type LightCurve = "linear" | "quad" | "smooth" | "hold" | ((t: number) => number);

export interface PooledLightStyle {
  color?: number;
  /** Radius in screen pixels at zoom 1. */
  radius?: number;
  intensity?: number;
  /** Squareness of the falloff; 1 is soft. */
  falloff?: number;
  /** Height above the ground in radius units, for normal-mapped shading. */
  height?: number;
}

export interface FlashOptions extends PooledLightStyle {
  /** Seconds the flash lasts. */
  life?: number;
  curve?: LightCurve;
}

export interface TrackOptions extends PooledLightStyle {
  /** Seconds a tracked light takes to fade once it stops being tracked. */
  fade?: number;
}

export interface LightPoolOptions {
  /** Lights at once; past it the dimmest gives way. */
  capacity?: number;
}

type Key = number | string;

interface PooledLight {
  key: Key | null;
  x: number;
  y: number;
  z: number;
  color: number;
  radius: number;
  intensity: number;
  falloff: number;
  height: number;
  life: number;
  age: number;
  curve: (t: number) => number;
  /** Tracked lights: fade length, whether tracked since the last step, and fade progress. */
  fade: number;
  touched: boolean;
  fading: number;
}

const CURVES: Record<Exclude<LightCurve, (t: number) => number>, (t: number) => number> = {
  linear: (t) => 1 - t,
  quad: (t) => (1 - t) * (1 - t),
  smooth: (t) => 1 - t * t * (3 - 2 * t),
  hold: (t) => (t < 0.5 ? 1 : 1 - (t - 0.5) * 2),
};

export class LightPool extends Node2D {
  readonly capacity: number;
  private readonly lights: PooledLight[] = [];

  constructor(opts: LightPoolOptions = {}) {
    super();
    this.capacity = Math.max(1, opts.capacity ?? 24);
  }

  /** Lights alive now. */
  get count(): number {
    return this.lights.length;
  }

  /** A light at (x, y, z) in this node's ground space that dies over `life`. False when the pool kept brighter lights instead. */
  flash(x: number, y: number, z = 0, o: FlashOptions = {}): boolean {
    const c = o.curve ?? "quad";
    const l = this.make(null, x, y, z, o);
    l.life = Math.max(1e-3, o.life ?? 0.12);
    l.curve = typeof c === "function" ? c : CURVES[c];
    return this.insert(l);
  }

  /** A light that follows something: call every frame with its position; it fades once the calls stop. */
  track(key: Key, x: number, y: number, z = 0, o: TrackOptions = {}): void {
    const l = this.lights.find((q) => q.key === key);
    if (l) {
      l.x = x;
      l.y = y;
      l.z = z;
      if (o.color !== undefined) l.color = o.color;
      if (o.radius !== undefined) l.radius = o.radius;
      if (o.intensity !== undefined) l.intensity = o.intensity;
      l.touched = true;
      l.fading = 0;
      return;
    }
    const n = this.make(key, x, y, z, o);
    n.fade = Math.max(1e-3, o.fade ?? 0.12);
    this.insert(n);
  }

  /** Start a tracked light's fade now. */
  release(key: Key): void {
    const l = this.lights.find((q) => q.key === key);
    if (l) l.touched = false;
  }

  freeAll(): void {
    this.lights.length = 0;
  }

  /** Current brightness of a pooled light, used to rank them. */
  private strength(l: PooledLight): number {
    return l.intensity * l.radius * this.level(l);
  }

  private level(l: PooledLight): number {
    if (l.key !== null) return 1 - l.fading / l.fade;
    return Math.max(0, l.curve(Math.min(1, l.age / l.life)));
  }

  private make(key: Key | null, x: number, y: number, z: number, o: PooledLightStyle): PooledLight {
    return {
      key,
      x,
      y,
      z,
      color: o.color ?? 0xffffff,
      radius: o.radius ?? 96,
      intensity: o.intensity ?? 1,
      falloff: o.falloff ?? 1,
      height: o.height ?? 0.6,
      life: Number.POSITIVE_INFINITY,
      age: 0,
      curve: CURVES.linear,
      fade: 0.12,
      touched: true,
      fading: 0,
    };
  }

  private insert(l: PooledLight): boolean {
    if (this.lights.length < this.capacity) {
      this.lights.push(l);
      return true;
    }
    let dim = 0;
    for (let i = 1; i < this.lights.length; i++) if (this.strength(this.lights[i]) < this.strength(this.lights[dim])) dim = i;
    if (this.strength(this.lights[dim]) >= this.strength(l)) return false;
    this.lights[dim] = l;
    return true;
  }

  override update(dt: number): void {
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const l = this.lights[i];
      l.age += dt;
      let dead: boolean;
      if (l.key !== null) {
        if (l.touched) l.touched = false;
        else l.fading += dt;
        dead = l.fading >= l.fade;
      } else dead = l.age >= l.life;
      if (dead) this.lights.splice(i, 1);
    }
  }

  override render(ctx: DrawContext): void {
    if (this.lights.length === 0) return;
    const bias = ctx.depthBias;
    for (const l of this.lights) {
      const k = this.level(l);
      if (k <= 0) continue;
      placeAt(ctx, this, bias, l.x, l.y, l.z);
      ctx.light(0, 0, l.radius, { color: l.color, intensity: l.intensity * k, falloff: l.falloff + 1, height: l.height });
    }
    restorePlace(ctx, this, bias);
  }
}

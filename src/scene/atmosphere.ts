// Ambient layers that sell an HD-2D look: drifting glowing motes and slow cloud shadows.

import { TAU, type Rect } from "../core/math.ts";
import { Rng } from "../core/rng.ts";
import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";

export interface MotesOptions {
  area: Rect;
  count?: number;
  color?: number;
  /** Pixel size range. */
  size?: [number, number];
  speed?: number;
  /** Draw as soft glowing blobs instead of hard pixels. */
  soft?: boolean;
  alpha?: number;
  seed?: number;
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  phase: number;
  freq: number;
}

/** Glowing specks that drift within an area and twinkle. Additive, so they bloom. */
export class Motes extends Node2D {
  private readonly motes: Mote[] = [];
  private readonly area: Rect;
  readonly color: number;
  readonly soft: boolean;
  readonly alpha0: number;
  private t = 0;

  constructor(opts: MotesOptions) {
    super();
    this.area = opts.area;
    this.color = opts.color ?? 0xffe9a3;
    this.soft = opts.soft ?? true;
    this.alpha0 = opts.alpha ?? 0.8;
    const rng = new Rng(opts.seed ?? 7);
    const speed = opts.speed ?? 6;
    const size = opts.size ?? [1, 3];
    for (let i = 0; i < (opts.count ?? 40); i++) {
      const a = rng.range(0, TAU);
      this.motes.push({
        x: rng.range(this.area.x, this.area.x + this.area.w),
        y: rng.range(this.area.y, this.area.y + this.area.h),
        vx: Math.cos(a) * speed * rng.range(0.4, 1),
        vy: Math.sin(a) * speed * rng.range(0.4, 1) - speed * 0.3,
        size: rng.range(size[0], size[1]),
        phase: rng.range(0, TAU),
        freq: rng.range(0.6, 1.6),
      });
    }
  }

  override update(dt: number): void {
    this.t += dt;
    const a = this.area;
    for (const m of this.motes) {
      m.x += (m.vx + Math.sin(this.t * 0.7 + m.phase) * 3) * dt;
      m.y += m.vy * dt;
      if (m.x < a.x) m.x += a.w;
      else if (m.x > a.x + a.w) m.x -= a.w;
      if (m.y < a.y) m.y += a.h;
      else if (m.y > a.y + a.h) m.y -= a.h;
    }
  }

  override render(ctx: DrawContext): void {
    for (const m of this.motes) {
      const tw = 0.55 + 0.45 * Math.sin(this.t * m.freq + m.phase);
      const alpha = this.alpha0 * tw;
      if (this.soft) {
        const s = (m.size * 3) / 64;
        ctx.sprite("__blob", m.x, m.y, { sx: s, sy: s, alpha, tint: this.color, additive: true });
      } else {
        const s = Math.max(1, Math.round(m.size));
        ctx.rect(Math.round(m.x), Math.round(m.y), s, s, this.color, alpha, true);
      }
    }
  }
}

export interface CloudShadowsOptions {
  area: Rect;
  count?: number;
  alpha?: number;
  /** Scale range applied to the 64px blob. */
  scale?: [number, number];
  speed?: [number, number];
  seed?: number;
}

interface Cloud {
  x: number;
  y: number;
  vx: number;
  sx: number;
  sy: number;
}

/** Large soft dark blobs scrolling across the ground, as if clouds passed overhead. */
export class CloudShadows extends Node2D {
  private readonly clouds: Cloud[] = [];
  private readonly area: Rect;
  readonly alpha0: number;

  constructor(opts: CloudShadowsOptions) {
    super();
    this.area = opts.area;
    this.alpha0 = opts.alpha ?? 0.22;
    const rng = new Rng(opts.seed ?? 11);
    const scale = opts.scale ?? [3, 6];
    const speed = opts.speed ?? [8, 16];
    for (let i = 0; i < (opts.count ?? 6); i++) {
      this.clouds.push({
        x: rng.range(this.area.x, this.area.x + this.area.w),
        y: rng.range(this.area.y, this.area.y + this.area.h),
        vx: rng.range(speed[0], speed[1]),
        sx: rng.range(scale[0], scale[1]),
        sy: rng.range(scale[0] * 0.5, scale[1] * 0.7),
      });
    }
  }

  override update(dt: number): void {
    const a = this.area;
    for (const c of this.clouds) {
      c.x += c.vx * dt;
      const margin = c.sx * 40;
      if (c.x > a.x + a.w + margin) c.x = a.x - margin;
    }
  }

  override render(ctx: DrawContext): void {
    for (const c of this.clouds) {
      ctx.sprite("__blob", c.x, c.y, { sx: c.sx, sy: c.sy, alpha: this.alpha0, tint: 0x000000 });
    }
  }
}

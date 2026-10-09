// Small reusable effects every action game wants: floating text that rises and fades
// (damage numbers, pickups, "+1"), pooled so a busy fight costs nothing in allocation.

import type { FontSpec } from "../render/types.ts";
import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";

export interface PopOptions {
  color?: number;
  font?: FontSpec | "pixel";
  /** Bitmap font scale. */
  scale?: number;
  /** Units risen over the life. */
  rise?: number;
  life?: number;
  shadow?: number | null;
  /** Sideways drift in units per second. */
  drift?: number;
}

interface Pop {
  text: string;
  x: number;
  y: number;
  vx: number;
  t: number;
  life: number;
  rise: number;
  color: number;
  scale: number;
  font: FontSpec | "pixel";
  shadow: number | null;
}

/**
 * Pooled floating text. `pop` reuses the oldest entry when the pool is full, so callers
 * never throttle themselves; put it in the world for damage numbers or in the UI for toasts.
 */
export class TextPops extends Node2D {
  private readonly pool: Pop[] = [];
  private next = 0;
  private live = 0;

  constructor(
    readonly capacity = 64,
    readonly defaults: PopOptions = {},
  ) {
    super();
    this.name = "pops";
    for (let i = 0; i < capacity; i++) this.pool.push({ text: "", x: 0, y: 0, vx: 0, t: 0, life: 0, rise: 0, color: 0xffffff, scale: 1, font: "pixel", shadow: null });
  }

  /** Live entries. */
  get count(): number {
    return this.live;
  }

  pop(text: string, x: number, y: number, o: PopOptions = {}): void {
    const d = this.defaults;
    const p = this.pool[this.next];
    this.next = (this.next + 1) % this.capacity;
    if (p.life <= 0) this.live++;
    p.text = text;
    p.x = x;
    p.y = y;
    p.vx = o.drift ?? d.drift ?? 0;
    p.t = 0;
    p.life = o.life ?? d.life ?? 0.7;
    p.rise = o.rise ?? d.rise ?? 28;
    p.color = o.color ?? d.color ?? 0xffffff;
    p.scale = o.scale ?? d.scale ?? 1;
    p.font = o.font ?? d.font ?? "pixel";
    p.shadow = o.shadow === undefined ? (d.shadow === undefined ? 0x000000 : d.shadow) : o.shadow;
  }

  override update(dt: number): void {
    let live = 0;
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.t += dt;
      p.x += p.vx * dt;
      if (p.t >= p.life) p.life = 0;
      else live++;
    }
    this.live = live;
  }

  override render(ctx: DrawContext): void {
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      const k = p.t / p.life;
      // Ease out on the way up, fade over the last half.
      const rise = p.rise * (1 - (1 - k) * (1 - k));
      const alpha = k < 0.5 ? 1 : 1 - (k - 0.5) * 2;
      ctx.text(p.text, p.x, p.y - rise, { align: "center", color: p.color, alpha, scale: p.scale, font: p.font, shadow: p.shadow });
    }
  }

  clearPops(): void {
    for (const p of this.pool) p.life = 0;
    this.live = 0;
  }
}

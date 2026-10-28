import { Node2D, Sprite, type DrawContext } from "@blackiron-studio/engine/scene";
import { Rng } from "@blackiron-studio/engine/core";
import type { GameState } from "./game.ts";
import { UI_SMALL } from "./fonts.ts";

/** A sprite whose alpha breathes: glowing caps, runes, moonstone. */
export class Pulse extends Sprite {
  private t: number;
  constructor(
    sprite: string,
    x: number,
    y: number,
    private base = 0.8,
    private depth = 0.2,
    private rate = 1.6,
    phase = 0,
  ) {
    super(sprite, x, y);
    this.t = phase;
    this.alpha = base;
  }
  override update(dt: number): void {
    this.t += dt;
    this.alpha = this.base + Math.sin(this.t * this.rate) * this.depth;
  }
}

/** Slow banks of ground fog that drift across the hollow and wrap around. */
export class FogBanks extends Node2D {
  private banks: { x: number; y: number; vx: number; s: number; a: number; v: number }[] = [];
  constructor(
    private w: number,
    private h: number,
    count: number,
    seed: number,
  ) {
    super();
    const rng = new Rng(seed);
    for (let i = 0; i < count; i++) this.banks.push({ x: rng.range(-200, w + 200), y: rng.range(0, h), vx: rng.range(6, 16), s: rng.range(1.2, 2.4), a: rng.range(0.12, 0.22), v: rng.int(0, 1) });
  }
  override update(dt: number): void {
    for (const b of this.banks) {
      b.x += b.vx * dt;
      if (b.x > this.w + 400) b.x = -400;
    }
  }
  override render(ctx: DrawContext): void {
    for (const b of this.banks) ctx.sprite(`wh.fog.${b.v}`, b.x, b.y, { sx: b.s, sy: b.s * 0.8, alpha: b.a });
  }
}

/** Fireflies: soft emissive dots that wander, blink and glow through the dark. */
export class Fireflies extends Node2D {
  private flies: { x: number; y: number; ax: number; ay: number; f: number; p: number; s: number }[] = [];
  private t = 0;
  constructor(w: number, h: number, count: number, seed: number) {
    super();
    const rng = new Rng(seed);
    for (let i = 0; i < count; i++) this.flies.push({ x: rng.range(0, w), y: rng.range(0, h), ax: rng.range(14, 40), ay: rng.range(10, 30), f: rng.range(0.15, 0.4), p: rng.range(0, 100), s: rng.range(0.1, 0.18) });
  }
  override update(dt: number): void {
    this.t += dt;
  }
  override render(ctx: DrawContext): void {
    const t = this.t;
    for (const f of this.flies) {
      const x = f.x + Math.sin(t * f.f + f.p) * f.ax + Math.sin(t * f.f * 2.3 + f.p * 2) * f.ax * 0.3;
      const y = f.y + Math.cos(t * f.f * 1.3 + f.p) * f.ay;
      const blink = Math.max(0, Math.sin(t * 1.7 + f.p * 3));
      const a = 0.15 + blink * blink * 0.85;
      ctx.sprite("__blob", x, y, { sx: f.s * 3.2, sy: f.s * 3.2, alpha: a * 0.5, tint: 0xb8ff6a, additive: true, emissive: true });
      ctx.sprite("__blob", x, y, { sx: f.s * 0.7, sy: f.s * 0.7, alpha: a, tint: 0xf8ffd0, additive: true, emissive: true });
    }
  }
}

/**
 * The lantern keeper: a hooded, scarfed traveller drawn from painted parts so the cloak can
 * bob, the boots can step and the lantern can swing on its own.
 */
export class LanternKeeper extends Node2D {
  private cloak: Node2D;
  private legs: Node2D;
  private bootL: Sprite;
  private bootR: Sprite;
  private body: Sprite;
  private lantern: Sprite;
  private t = 0;
  moving = false;
  facing = 1;
  constructor() {
    super();
    const shadow = this.add(new Sprite("wh.shadow.soft", 2, 1));
    shadow.scaleX = 0.5;
    shadow.scaleY = 0.42;
    this.legs = this.add(new Node2D());
    this.bootL = this.legs.add(new Sprite("keeper.boot", -5, 0));
    this.bootR = this.legs.add(new Sprite("keeper.boot", 5, 0));
    this.bootL.tint = 0xa8a0a8;
    this.cloak = this.add(new Node2D());
    this.body = this.cloak.add(new Sprite("keeper.body", 0, 0));
    this.lantern = this.cloak.add(new Sprite("keeper.lantern", 16, -19.5));
    this.lantern.emissive = true;
    this.scale = 1.15;
  }
  /** Lantern glass position relative to the keeper's feet, for lights and halos. */
  get lanternX(): number {
    return (16 + Math.sin(this.lantern.rotation) * -10) * this.facing * this.scaleX;
  }
  get lanternY(): number {
    return (-9 + this.cloak.y) * this.scaleY;
  }
  override update(dt: number): void {
    this.t += dt;
    const step = this.moving ? Math.sin(this.t * 13) : 0;
    this.cloak.y = this.moving ? -Math.abs(Math.sin(this.t * 13)) * 1.6 : Math.sin(this.t * 2) * 0.6;
    this.cloak.scaleX = this.facing;
    this.legs.scaleX = this.facing;
    this.body.scaleY = this.moving ? 1 : 1 + Math.sin(this.t * 2) * 0.008;
    this.bootL.x = -5 + step * 3;
    this.bootR.x = 5 - step * 3;
    this.bootL.y = step > 0 ? -step * 2 : 0;
    this.bootR.y = step < 0 ? step * 2 : 0;
    this.legs.rotation = 0;
    this.lantern.rotation = this.moving ? Math.sin(this.t * 13 + 0.6) * 0.12 : Math.sin(this.t * 1.6) * 0.04;
  }
}

/** A small compass makes distant embers discoverable without covering the playfield. */
export class EmberCompass extends Node2D {
  private t = 0;
  constructor(private state: GameState) {
    super();
  }
  override update(dt: number): void {
    this.t += dt;
  }
  override render(ctx: DrawContext): void {
    const p = this.state.player;
    const e = this.state.embers.reduce<(typeof this.state.embers)[number] | null>(
      (best, v) => (!best || Math.hypot(v.x - p.x, v.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? v : best),
      null,
    );
    ctx.sprite("wh.ui.compass", 0, 0);
    if (!e) return;
    const dx = e.x - p.x,
      dy = e.y - p.y,
      d = Math.hypot(dx, dy),
      a = Math.atan2(dy, dx);
    const pulse = 0.85 + Math.sin(this.t * 4) * 0.15;
    ctx.sprite("wh.ui.needle", 0, 0, { rot: a, alpha: pulse });
    ctx.sprite("wh.ui.ember", 0, -7, { sx: 0.55, sy: 0.55 });
    ctx.text(`${Math.round(d / 32)}m`, 0, 1, { align: "center", color: 0xffe3ae, font: UI_SMALL, shadow: 0x02060c });
  }
}

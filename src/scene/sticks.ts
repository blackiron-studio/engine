// Analog virtual sticks for touch. Each stick owns a zone of the screen; the first finger
// that lands in the zone becomes the stick until it lifts, and the base follows a long drag
// so the thumb never runs out of travel. Games read vectors, not actions: a survivors game
// moves with the left stick and aims with the right, a single-stick game uses one "any" zone.

import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";

/** Half of the screen, all of it, or a rectangle in fractions of the screen. */
export type StickZone = "any" | "left" | "right" | "top" | "bottom" | { x: number; y: number; w: number; h: number };

export interface VirtualStickSpec {
  zone: StickZone;
  /** Where the idle stick is drawn, in fractions of the screen; a sensible corner by zone. */
  rest?: [number, number];
}

export interface VirtualSticksOptions {
  sticks: VirtualStickSpec[];
  /** Radius of full deflection, in viewport units. */
  size?: number;
  /** Show and read even without a touch pointer, for tests and mouse play. */
  always?: boolean;
  /** Opacity of the drawn sticks; 0 hides them and leaves the reading. */
  opacity?: number;
}

interface StickState {
  id: number | null;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
}

function inZone(zone: StickZone, x: number, y: number, w: number, h: number): boolean {
  if (zone === "any") return true;
  if (zone === "left") return x < w / 2;
  if (zone === "right") return x >= w / 2;
  if (zone === "top") return y < h / 2;
  if (zone === "bottom") return y >= h / 2;
  return x >= zone.x * w && x < (zone.x + zone.w) * w && y >= zone.y * h && y < (zone.y + zone.h) * h;
}

function restOf(spec: VirtualStickSpec): [number, number] {
  if (spec.rest) return spec.rest;
  const z = spec.zone;
  if (z === "right") return [0.86, 0.8];
  if (z === "top") return [0.5, 0.2];
  if (z === "bottom") return [0.5, 0.8];
  if (z === "any" || z === "left") return [0.14, 0.8];
  return [z.x + z.w / 2, z.y + z.h / 2];
}

export class VirtualSticks extends Node2D {
  readonly specs: VirtualStickSpec[];
  size: number;
  always: boolean;
  opacity: number;
  private readonly st: StickState[];

  constructor(opts: VirtualSticksOptions) {
    super();
    this.name = "sticks";
    this.specs = opts.sticks;
    this.size = opts.size ?? 56;
    this.always = opts.always ?? false;
    this.opacity = opts.opacity ?? 1;
    this.st = opts.sticks.map(() => ({ id: null, ox: 0, oy: 0, dx: 0, dy: 0 }));
  }

  /** Whether the sticks read touches now: a touch pointer, or `always`. */
  get active(): boolean {
    const app = this.scene?.attachedApp;
    return !!app && (this.always || app.pointer.type === "touch");
  }

  /** Whether a finger holds stick `i`. */
  held(i: number): boolean {
    return this.st[i]?.id !== null && this.st[i]?.id !== undefined;
  }

  /** Stick `i` as a vector, each axis in [-1, 1]; zero when nothing holds it. */
  vector(i: number): { x: number; y: number } {
    const s = this.st[i];
    if (!s || s.id === null) return { x: 0, y: 0 };
    return { x: s.dx / this.size, y: s.dy / this.size };
  }

  override update(): void {
    const app = this.scene?.attachedApp;
    if (!app || !this.active) {
      for (const s of this.st) s.id = null;
      return;
    }
    const w = this.scene?.width ?? 0;
    const h = this.scene?.height ?? 0;
    const touches = app.pointer.touches;
    for (let i = 0; i < this.st.length; i++) {
      const s = this.st[i];
      if (s.id !== null && !touches.has(s.id)) s.id = null;
      if (s.id === null) {
        for (const [id, t] of touches) {
          if (this.st.some((o) => o.id === id)) continue;
          if (!inZone(this.specs[i].zone, t.x, t.y, w, h)) continue;
          s.id = id;
          s.ox = t.x;
          s.oy = t.y;
          s.dx = 0;
          s.dy = 0;
          break;
        }
      }
      if (s.id === null) continue;
      const t = touches.get(s.id);
      if (!t) continue;
      let dx = t.x - s.ox;
      let dy = t.y - s.oy;
      const l = Math.hypot(dx, dy);
      if (l > this.size) {
        // The base follows the finger so a long drag keeps steering.
        const over = l - this.size;
        s.ox += (dx / l) * over;
        s.oy += (dy / l) * over;
        dx = (dx / l) * this.size;
        dy = (dy / l) * this.size;
      }
      s.dx = dx;
      s.dy = dy;
    }
  }

  override render(ctx: DrawContext): void {
    if (!this.active || this.opacity <= 0) return;
    const w = ctx.width;
    const h = ctx.height;
    for (let i = 0; i < this.st.length; i++) {
      const s = this.st[i];
      const [rx, ry] = restOf(this.specs[i]);
      const ox = s.id !== null ? s.ox : rx * w;
      const oy = s.id !== null ? s.oy : ry * h;
      const held = s.id !== null;
      const k = (this.size * 2.2) / 32;
      ctx.sprite("__ring", ox, oy, { sx: k, sy: k, alpha: (held ? 0.5 : 0.22) * this.opacity });
      const kk = (this.size * 0.9) / 64;
      ctx.sprite("__blob", ox + s.dx, oy + s.dy, { sx: kk, sy: kk, alpha: (held ? 0.8 : 0.3) * this.opacity });
    }
  }
}

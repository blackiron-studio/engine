// Phone controls: an analog stick under the left thumb, and gas, brake, drift and a
// contextual action button under the right. They show on phones and tablets from the first
// frame (and after the first touch elsewhere), and stay out of the way of mouse and keyboard
// play. Everything is laid out in the UI layer's own units, so it grows with the HUD.
import { Node2D, type DrawContext } from "@blackiron-studio/engine/scene";
import { C, text, withTextFloor } from "./presentation.ts";

interface Button {
  id: "gas" | "brake" | "drift" | "act";
  x: number;
  y: number;
  r: number;
}

export class DrivePad extends Node2D {
  /** Show and read without a touch pointer (touch screens, screenshots, tests). */
  always = false;
  /** Label for the contextual button, or "" to hide it. */
  action = "";
  /** Whether the pad drives a car (gas/brake/drift) or walks (stick only). */
  driving = false;
  /** Analog stick, -1..1 on each axis. */
  sx = 0;
  sy = 0;
  readonly held = { gas: false, brake: false, drift: false, act: false };
  private actQueued = false;
  private stick: { id: number | null; ox: number; oy: number } = { id: null, ox: 0, oy: 0 };
  /** Touches that started on a button or the HUD never become the stick. */
  private claimed = new Set<number>();
  /** UI rectangles the stick must not steal touches from (HUD tap targets). */
  blocked: { x: number; y: number; w: number; h: number }[] = [];
  readonly radius = 62;

  get active(): boolean {
    const app = this.scene?.app;
    return !!app && (this.always || app.pointer.type === "touch");
  }
  /** True once per tap of the action button. */
  takeAction(): boolean {
    const a = this.actQueued;
    this.actQueued = false;
    return a;
  }
  buttons(): Button[] {
    const s = this.scene!,
      [, right, bottom] = s.uiInsets,
      W = s.uiWidth - right,
      H = s.uiHeight - bottom;
    const out: Button[] = [];
    if (this.driving) {
      out.push({ id: "gas", x: W - 108, y: H - 112, r: 62 }, { id: "brake", x: W - 244, y: H - 70, r: 44 }, { id: "drift", x: W - 236, y: H - 190, r: 44 });
    }
    if (this.action) out.push({ id: "act", x: W - 108, y: H - (this.driving ? 252 : 112), r: 46 });
    return out;
  }
  /** Where the stick rests, clear of the notch and the home bar. */
  rest(): [number, number] {
    const s = this.scene!,
      [, , bottom, left] = s.uiInsets;
    return [left + 150, s.uiHeight - bottom - 140];
  }
  override update() {
    const s = this.scene,
      app = s?.app;
    if (!s || !app) return;
    this.held.gas = this.held.brake = this.held.drift = false;
    const wasAct = this.held.act;
    this.held.act = false;
    if (!this.active || !this.visible) {
      this.sx = this.sy = 0;
      this.stick.id = null;
      return;
    }
    const touches = app.pointer.touches,
      w = s.uiWidth,
      h = s.uiHeight,
      buttons = this.buttons();
    for (const id of [...this.claimed]) if (!touches.has(id)) this.claimed.delete(id);
    if (this.stick.id !== null && !touches.has(this.stick.id)) this.stick.id = null;
    for (const [id, raw] of touches) {
      // Touches arrive in screen units; the UI layer grows on phones.
      const t = s.toUI(raw.x, raw.y);
      const b = buttons.find((b) => (t.x - b.x) ** 2 + (t.y - b.y) ** 2 <= (b.r + 10) ** 2);
      if (b && id !== this.stick.id) {
        this.held[b.id] = true;
        this.claimed.add(id);
        continue;
      }
      if (this.stick.id === null && !this.claimed.has(id) && t.x < w * 0.45 && t.y > h * 0.4 && !this.blocked.some((r) => t.x >= r.x && t.x < r.x + r.w && t.y >= r.y && t.y < r.y + r.h))
        this.stick = { id, ox: t.x, oy: t.y };
      else if (id !== this.stick.id) this.claimed.add(id);
    }
    if (this.held.act && !wasAct) this.actQueued = true;
    const raw = this.stick.id !== null ? touches.get(this.stick.id) : undefined;
    if (raw) {
      const t = s.toUI(raw.x, raw.y);
      let dx = t.x - this.stick.ox,
        dy = t.y - this.stick.oy;
      const d = Math.hypot(dx, dy),
        max = this.radius;
      // The base follows a long drag so the thumb never runs out of travel.
      if (d > max) {
        this.stick.ox += (dx * (d - max)) / d;
        this.stick.oy += (dy * (d - max)) / d;
        dx = (dx * max) / d;
        dy = (dy * max) / d;
      }
      const dead = 0.12,
        m = Math.hypot(dx, dy) / max,
        k = m < dead ? 0 : (m - dead) / (1 - dead) / Math.max(m, 1e-6);
      this.sx = (dx / max) * k;
      this.sy = (dy / max) * k;
    } else this.sx = this.sy = 0;
  }
  override render(ctx: DrawContext) {
    if (!this.active) return;
    const s = this.scene as (typeof this.scene & { textFloor?: number }) | null;
    withTextFloor(s?.textFloor ?? 0, () => this.draw(ctx));
  }
  private draw(ctx: DrawContext) {
    const [rx, ry] = this.rest(),
      on = this.stick.id !== null,
      ox = on ? this.stick.ox : rx,
      oy = on ? this.stick.oy : ry;
    ctx.sprite("ll.ui.shadow", ox, oy + 6, { sx: 170 / 36, sy: 170 / 36, alpha: 0.35, smooth: true });
    ctx.sprite("__blob", ox, oy, { sx: (this.radius * 2.3) / 64, sy: (this.radius * 2.3) / 64, tint: C.ink, alpha: 0.5 });
    ctx.sprite("__ring", ox, oy, { sx: (this.radius * 2.2) / 32, sy: (this.radius * 2.2) / 32, tint: 0xffffff, alpha: on ? 0.45 : 0.22 });
    const kx = ox + this.sx * this.radius,
      ky = oy + this.sy * this.radius;
    ctx.sprite("ll.fx.glow", kx, ky, { sx: 1.1, sy: 1.1, tint: C.gold, alpha: on ? 0.35 : 0.12, additive: true, smooth: true });
    ctx.sprite("__blob", kx, ky, { sx: 52 / 64, sy: 52 / 64, tint: on ? C.gold : 0xd8d2c4, alpha: on ? 0.9 : 0.45 });
    const label = { gas: "GAS", brake: "BRAKE", drift: "DRIFT", act: this.action } as const;
    for (const b of this.buttons()) {
      const held = this.held[b.id],
        accent = b.id === "gas" ? C.gold : b.id === "act" ? C.mint : b.id === "drift" ? C.pink : 0xd8d2c4;
      ctx.sprite("ll.ui.shadow", b.x, b.y + 5, { sx: (b.r * 2.6) / 36, sy: (b.r * 2.6) / 36, alpha: 0.45, smooth: true });
      ctx.sprite("__blob", b.x, b.y, { sx: (b.r * 2.1) / 64, sy: (b.r * 2.1) / 64, tint: held ? accent : C.ink, alpha: held ? 0.85 : 0.62 });
      ctx.sprite("__ring", b.x, b.y, { sx: (b.r * 2) / 32, sy: (b.r * 2) / 32, tint: accent, alpha: held ? 1 : 0.7 });
      text(ctx, label[b.id], b.x, b.y - 7, b.id === "gas" ? 15 : 12, held ? C.ink : C.paper, "center", 900);
      this.scene?.reportTarget(label[b.id] || b.id, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
    }
  }
}

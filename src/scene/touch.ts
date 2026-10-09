// On-screen touch controls: a virtual stick on the left and action buttons on the right.
// They press the same named actions as the keyboard, so games need no special code.

import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";

export interface TouchButton {
  action: string;
  label: string;
}

export interface TouchControlsOptions {
  /** Actions pressed by the stick's four directions. */
  stick?: { left: string; right: string; up: string; down: string };
  buttons?: TouchButton[];
  /** Show even without a touch pointer, for testing. */
  always?: boolean;
  size?: number;
}

interface StickState {
  id: number | null;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
}

export class TouchControls extends Node2D {
  readonly stick: TouchControlsOptions["stick"];
  readonly buttons: TouchButton[];
  readonly always: boolean;
  readonly size: number;
  private st: StickState = { id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
  private held = new Set<string>();
  private buttonDown = new Map<string, number | null>();

  constructor(opts: TouchControlsOptions = {}) {
    super();
    this.stick = opts.stick;
    this.buttons = opts.buttons ?? [];
    this.always = opts.always ?? false;
    this.size = opts.size ?? 48;
    this.name = "touch";
  }

  private get active(): boolean {
    const app = this.scene?.app;
    if (!app) return false;
    return this.always || app.pointer.type === "touch";
  }

  private buttonRect(i: number, w: number, h: number): { x: number; y: number; r: number } {
    const r = this.size * 0.55;
    const x = w - this.size * 1.2 - i * this.size * 1.4;
    const y = h - this.size * 1.2;
    return { x, y, r };
  }

  override update(): void {
    const app = this.scene?.app;
    if (!app) return;
    const active = this.active;
    const w = this.scene?.width ?? 0;
    const h = this.scene?.height ?? 0;
    const touches = app.pointer.touches;
    const dead = this.size * 0.25;
    const press = (a: string) => {
      if (!this.held.has(a)) {
        this.held.add(a);
        app.input.press(a);
      }
    };
    const release = (a: string) => {
      if (this.held.has(a)) {
        this.held.delete(a);
        app.input.release(a);
      }
    };
    if (!active) {
      for (const a of [...this.held]) release(a);
      this.st.id = null;
      return;
    }
    // Stick: the first touch on the left half owns it until it lifts.
    if (this.stick) {
      if (this.st.id !== null && !touches.has(this.st.id)) this.st.id = null;
      if (this.st.id === null) {
        for (const [id, t] of touches) {
          if (t.x < w / 2 && t.y > h * 0.3) {
            this.st = { id, ox: t.x, oy: t.y, dx: 0, dy: 0 };
            break;
          }
        }
      }
      if (this.st.id !== null) {
        const t = touches.get(this.st.id);
        if (t) {
          this.st.dx = Math.max(-this.size, Math.min(this.size, t.x - this.st.ox));
          this.st.dy = Math.max(-this.size, Math.min(this.size, t.y - this.st.oy));
        }
      } else {
        this.st.dx = 0;
        this.st.dy = 0;
      }
      const s = this.stick;
      if (this.st.dx < -dead) press(s.left);
      else release(s.left);
      if (this.st.dx > dead) press(s.right);
      else release(s.right);
      if (this.st.dy < -dead) press(s.up);
      else release(s.up);
      if (this.st.dy > dead) press(s.down);
      else release(s.down);
    }
    // Buttons: any touch inside the circle holds it.
    this.buttons.forEach((b, i) => {
      const { x, y, r } = this.buttonRect(i, w, h);
      let down = false;
      for (const t of touches.values()) if ((t.x - x) ** 2 + (t.y - y) ** 2 <= r * r) down = true;
      if (down) press(b.action);
      else release(b.action);
    });
  }

  override render(ctx: DrawContext): void {
    if (!this.active) return;
    const w = ctx.width;
    const h = ctx.height;
    if (this.stick) {
      const ox = this.st.id !== null ? this.st.ox : this.size * 1.4;
      const oy = this.st.id !== null ? this.st.oy : h - this.size * 1.4;
      const k = (this.size * 2.2) / 32;
      ctx.sprite("__ring", ox, oy, { sx: k, sy: k, alpha: 0.35 });
      const kk = (this.size * 0.9) / 64;
      ctx.sprite("__blob", ox + this.st.dx, oy + this.st.dy, { sx: kk, sy: kk, alpha: 0.55 });
    }
    this.buttons.forEach((b, i) => {
      const { x, y, r } = this.buttonRect(i, w, h);
      const k = (r * 2.1) / 32;
      const held = this.held.has(b.action);
      ctx.sprite("__ring", x, y, { sx: k, sy: k, alpha: held ? 0.9 : 0.4 });
      ctx.text(b.label, x, y - 4, { align: "center", color: 0xffffff, alpha: held ? 1 : 0.6 });
    });
  }

  override exit(): void {
    const input = this.scene?.attachedApp?.input;
    for (const action of this.held) input?.release(action);
    this.held.clear();
    this.buttonDown.clear();
    this.st = { id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
  }
}

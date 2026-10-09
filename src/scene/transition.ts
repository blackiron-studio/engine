// Scene transitions: an overlay scene that covers the screen, swaps the scene underneath
// at the midpoint, then uncovers. Used by `scenes.change(scene, { transition: "fade" })`.

import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";
import { Scene } from "./scene.ts";

export type TransitionKind = "fade" | "wipe" | "slide" | "circle";

export interface TransitionOptions {
  transition?: TransitionKind;
  /** Whole transition in seconds; half covers, half uncovers. */
  duration?: number;
  color?: number;
}

class Cover extends Node2D {
  t = 0;
  constructor(
    readonly kind: TransitionKind,
    readonly color: number,
  ) {
    super();
  }

  override render(ctx: DrawContext): void {
    const w = ctx.width;
    const h = ctx.height;
    // Coverage rises to 1 at the midpoint and falls back to 0.
    const c = this.t < 0.5 ? this.t * 2 : 2 - this.t * 2;
    switch (this.kind) {
      case "fade":
        ctx.rect(0, 0, w, h, this.color, Math.min(1, c));
        break;
      case "wipe":
        if (this.t < 0.5) ctx.rect(0, 0, Math.round(w * c), h, this.color);
        else ctx.rect(Math.round(w * (1 - c)), 0, Math.ceil(w * c), h, this.color);
        break;
      case "slide":
        if (this.t < 0.5) ctx.rect(Math.round(w * (c - 1)), 0, w, h, this.color);
        else ctx.rect(Math.round(w * (1 - c)), 0, w, h, this.color);
        break;
      case "circle": {
        // Concentric rings approximate an iris: cheap and works on every renderer.
        const r = Math.hypot(w, h) / 2 * (1 - c);
        const cx = w / 2;
        const cy = h / 2;
        ctx.rect(0, 0, w, Math.max(0, cy - r), this.color);
        ctx.rect(0, Math.min(h, cy + r), w, Math.max(0, h - cy - r), this.color);
        const steps = 24;
        for (let i = 0; i < steps; i++) {
          const y0 = cy - r + (i * 2 * r) / steps;
          const y1 = cy - r + ((i + 1) * 2 * r) / steps;
          const ym = (y0 + y1) / 2;
          const half = Math.sqrt(Math.max(0, r * r - (ym - cy) * (ym - cy)));
          ctx.rect(0, y0, Math.max(0, cx - half), y1 - y0 + 1, this.color);
          ctx.rect(cx + half, y0, Math.max(0, w - cx - half), y1 - y0 + 1, this.color);
        }
        break;
      }
    }
  }
}

/** The overlay scene that runs a transition. `onMid` swaps the scene under it. */
export class TransitionScene extends Scene {
  private t = 0;
  private swapped = false;
  private readonly cover: Cover;

  constructor(
    readonly kind: TransitionKind,
    readonly duration: number,
    color: number,
    private readonly onMid: () => void,
    private readonly onDone: () => void,
  ) {
    super();
    this.name = "transition";
    this.cover = new Cover(kind, color);
  }

  override ready(): void {
    this.ui.add(this.cover);
  }

  override update(dt: number): void {
    this.t = Math.min(1, this.t + dt / Math.max(0.01, this.duration));
    this.cover.t = this.t;
    if (!this.swapped && this.t >= 0.5) {
      this.swapped = true;
      this.onMid();
    }
    if (this.t >= 1) this.onDone();
  }
}

import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";

export interface TileLayerOptions {
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  /** Sprite name for a cell, or null/undefined for empty. Called only for visible cells. */
  tileAt: (col: number, row: number) => string | null | undefined;
}

/**
 * Draws a grid of sprites, culled to the visible view. Tiles are anchored at their
 * top-left corner regardless of the sprite's origin. Assumes the layer is not rotated
 * or scaled relative to its layer root.
 */
export class TileLayer extends Node2D {
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  tileAt: TileLayerOptions["tileAt"];
  /** Extra tiles drawn beyond the view edge, for oversize tiles. */
  overscan = 1;

  constructor(opts: TileLayerOptions) {
    super();
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.tileW = opts.tileW;
    this.tileH = opts.tileH;
    this.tileAt = opts.tileAt;
  }

  get pixelWidth(): number {
    return this.cols * this.tileW;
  }

  get pixelHeight(): number {
    return this.rows * this.tileH;
  }

  override render(ctx: DrawContext): void {
    const v = ctx.view;
    const [ox, oy] = this.positionIn(this.scene?.world ?? this);
    const c0 = Math.max(0, Math.floor((v.x - ox) / this.tileW) - this.overscan);
    const c1 = Math.min(this.cols - 1, Math.ceil((v.x + v.w - ox) / this.tileW) + this.overscan);
    const r0 = Math.max(0, Math.floor((v.y - oy) / this.tileH) - this.overscan);
    const r1 = Math.min(this.rows - 1, Math.ceil((v.y + v.h - oy) / this.tileH) + this.overscan);
    const prevCull = ctx.cull;
    ctx.cull = false;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const name = this.tileAt(c, r);
        if (!name) continue;
        ctx.sprite(name, c * this.tileW, r * this.tileH, { ox: 0, oy: 0 });
      }
    }
    ctx.cull = prevCull;
  }
}

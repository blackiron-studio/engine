import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";

/**
 * A world-space layer that scrolls slower (or faster) than the camera. Factor 1 moves with
 * the world, 0 stays fixed to the screen, 0.3 is a distant backdrop. Children are laid out
 * in the layer's own space starting at `offsetX/offsetY`.
 */
export class ParallaxLayer extends Node2D {
  constructor(
    public factorX = 0.5,
    public factorY = factorX,
    public offsetX = 0,
    public offsetY = 0,
  ) {
    super();
  }

  override drawTree(ctx: DrawContext): void {
    const v = ctx.view;
    this.x = this.offsetX + v.x * (1 - this.factorX);
    this.y = this.offsetY + v.y * (1 - this.factorY);
    super.drawTree(ctx);
  }

  /** Visible rect in this layer's space, for tiling backdrops across the view. */
  visibleRect(ctx: DrawContext): { x: number; y: number; w: number; h: number } {
    const v = ctx.view;
    return { x: v.x - this.x, y: v.y - this.y, w: v.w, h: v.h };
  }
}

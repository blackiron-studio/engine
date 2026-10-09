import type { DrawContext } from "@kiln/engine/scene";
import { Node2D, ParallaxLayer } from "@kiln/engine/scene";

/** Dusk sky bands that follow the camera. */
class Sky extends Node2D {
  override render(ctx: DrawContext): void {
    const v = ctx.view;
    const bands = [0x2b2d5c, 0x3d3a6e, 0x5b4577, 0x84557d, 0xb0697a, 0xd1846c];
    const bh = Math.ceil(v.h / bands.length) + 1;
    for (let i = 0; i < bands.length; i++) ctx.rect(v.x, v.y + i * bh, v.w, bh, bands[i]);
  }
}

/** Sprites repeated across the visible width of a parallax layer. */
class Repeat extends Node2D {
  constructor(
    private readonly layer: ParallaxLayer,
    private readonly sprite: string,
    private readonly period: number,
    private readonly rowY: (i: number, viewBottom: number) => number,
    private readonly opacity = 1,
  ) {
    super();
  }

  override render(ctx: DrawContext): void {
    const v = this.layer.visibleRect(ctx);
    const first = Math.floor(v.x / this.period) - 1;
    const last = Math.ceil((v.x + v.w) / this.period) + 1;
    for (let i = first; i <= last; i++) ctx.sprite(this.sprite, i * this.period, this.rowY(i, v.y + v.h), { alpha: this.opacity });
  }
}

/** Sky, distant hills and clouds, each scrolling at its own speed. `horizonY` is where the hills sit. */
export function buildBackdrop(parent: Node2D, horizonY: number): void {
  parent.add(new Sky());
  const clouds = parent.add(new ParallaxLayer(0.15));
  clouds.add(new Repeat(clouds, "cloud", 280, (i) => 60 + ((Math.abs(i) * 7) % 3) * 40, 0.85));
  const hills = parent.add(new ParallaxLayer(0.35));
  hills.add(new Repeat(hills, "hills", 192, () => horizonY));
}

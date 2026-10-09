import { Graphics2D, Node2D, type DrawContext } from "@kiln/engine/scene";
import { Rng } from "@kiln/engine/core";
import type { GameState } from "./game.ts";

/** No texture assets: reusable retained silhouettes, shaded with nested colour shapes. */
export function groveTree(x: number, y: number, seed: number): Graphics2D {
  const rng = new Rng(seed),
    g = new Graphics2D(x, y);
  const h = rng.range(78, 122),
    w = rng.range(36, 52);
  g.ellipse(5, 6, w, 13, { color: 0x101d2a, alpha: 0.4 }, 20)
    .polygon(
      [
        [-11, 0],
        [-6, -h * 0.62],
        [3, -h * 0.69],
        [12, 0],
      ],
      0x52414e,
    )
    .polygon(
      [
        [-6, -h * 0.65],
        [-3, -4],
        [1, -2],
        [2, -h * 0.72],
      ],
      0x947666,
    )
    .polyline(
      [
        [-3, -30],
        [-24, -h * 0.55],
      ],
      5,
      0x68505a,
    )
    .polyline(
      [
        [4, -38],
        [24, -h * 0.68],
      ],
      4,
      0x68505a,
    );
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2,
      cx = Math.cos(a) * w * 0.52,
      cy = -h * 0.72 + Math.sin(a) * h * 0.18;
    const rx = rng.range(w * 0.48, w * 0.69),
      ry = rng.range(18, 27);
    g.ellipse(cx + 3, cy + 7, rx, ry, 0x153a48, 16)
      .ellipse(cx, cy, rx, ry, i % 3 === 0 ? 0x38745f : 0x285c59, 16)
      .ellipse(
        cx - 5,
        cy - 6,
        rx * 0.72,
        ry * 0.58,
        i % 3 === 0 ? 0x63957b : 0x3d7a69,
        14,
      );
  }
  for (let i = 0; i < 10; i++)
    g.ellipse(
      rng.range(-w * 0.72, w * 0.72),
      rng.range(-h, -h * 0.54),
      2.6,
      1.5,
      0x8ca684,
      8,
    );
  return g;
}

export function moonShrine(x: number, y: number): Graphics2D {
  const g = new Graphics2D(x, y);
  g.ellipse(0, 12, 106, 44, { color: 0x0f2938, alpha: 0.6 })
    .ellipse(0, 7, 94, 36, 0x50686c)
    .ellipse(0, 3, 88, 32, 0x758581)
    .ellipse(0, 3, 66, 23, 0x415e65)
    .ellipse(0, 3, 59, 19, 0x2c4756);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.ellipse(Math.cos(a) * 76, Math.sin(a) * 27, 3, 2, 0xc6c9a3, 8);
  }
  g.polygon(
    [
      [-24, 0],
      [-19, -62],
      [-9, -79],
      [9, -79],
      [20, -61],
      [24, 0],
    ],
    0x304c59,
  )
    .polygon(
      [
        [-19, -62],
        [-9, -79],
        [9, -79],
        [4, -57],
        [-3, -2],
        [-24, 0],
      ],
      0x82958b,
    )
    .polygon(
      [
        [4, -57],
        [9, -79],
        [20, -61],
        [24, 0],
        [7, -5],
      ],
      0x4b6e70,
    )
    .ellipse(0, -45, 11, 13, 0x193b4a)
    .ellipse(0, -47, 7, 9, 0x9fe1cb)
    .ellipse(4, -50, 7, 8, 0x274b56)
    .polyline(
      [
        [-6, -22],
        [0, -18],
        [5, -23],
      ],
      2,
      0xb7d3b1,
    );
  return g;
}

export class LanternKeeper extends Node2D {
  private cloak: Graphics2D;
  private legs: Graphics2D;
  private t = 0;
  moving = false;
  facing = 1;
  constructor() {
    super();
    this.add(
      new Graphics2D().ellipse(
        1,
        2,
        17,
        6,
        { color: 0x102335, alpha: 0.5 },
        20,
      ),
    );
    this.legs = this.add(
      new Graphics2D()
        .roundedRect(-10, -10, 7, 12, 2, 0x27364c)
        .roundedRect(3, -10, 7, 12, 2, 0x27364c),
    );
    this.cloak = this.add(
      new Graphics2D()
        .polygon(
          [
            [-12, -35],
            [8, -35],
            [19, -5],
            [6, -1],
            [-4, -4],
            [-20, -4],
          ],
          0x323e61,
        )
        .polygon(
          [
            [-11, -35],
            [1, -34],
            [5, -4],
            [-4, -7],
            [-17, -6],
          ],
          0x7d81a2,
        )
        .polygon(
          [
            [1, -34],
            [8, -35],
            [19, -5],
            [8, -6],
          ],
          0x505978,
        )
        .ellipse(-1, -37, 14, 14, 0x273e53, 24)
        .ellipse(-3, -40, 12, 11, 0x829caf, 24)
        .ellipse(0, -36, 9, 9, 0x273644, 20)
        .ellipse(1, -34, 6, 6, 0xeac8a2, 20)
        .rect(0, -36, 2, 2, 0x24394a)
        .rect(5, -36, 2, 2, 0x24394a)
        .polyline(
          [
            [10, -26],
            [19, -22],
            [21, -14],
          ],
          4,
          0x9290a9,
        )
        .roundedRect(15, -16, 13, 16, 3, 0x5c4b3e)
        .roundedRect(18, -13, 7, 10, 2, 0xffd58c)
        .rect(20, -11, 3, 6, 0xfff3c6)
        .polyline(
          [
            [18, -17],
            [18, -21],
            [24, -21],
            [24, -17],
          ],
          2,
          0xbd9764,
        ),
    );
  }
  override update(dt: number): void {
    this.t += dt;
    this.cloak.y = this.moving
      ? Math.sin(this.t * 13) * 1.5
      : Math.sin(this.t * 2) * 0.7;
    this.cloak.scaleX = this.facing;
    this.legs.rotation = this.moving ? Math.sin(this.t * 13) * 0.12 : 0;
  }
}

/** A small compass makes distant embers discoverable without covering the playfield. */
export class EmberCompass extends Node2D {
  constructor(private state: GameState) {
    super();
  }
  override render(ctx: DrawContext): void {
    const p = this.state.player;
    const e = this.state.embers.reduce<
      (typeof this.state.embers)[number] | null
    >(
      (best, v) =>
        !best ||
        Math.hypot(v.x - p.x, v.y - p.y) <
          Math.hypot(best.x - p.x, best.y - p.y)
          ? v
          : best,
      null,
    );
    if (!e) return;
    const dx = e.x - p.x,
      dy = e.y - p.y,
      d = Math.hypot(dx, dy),
      a = Math.atan2(dy, dx),
      x = Math.cos(a) * 24,
      y = Math.sin(a) * 24;
    ctx.light(0, 0, 44, { color: 0xe9b97e, intensity: 0.22 });
    ctx.quad(
      [
        x + Math.cos(a) * 8,
        y + Math.sin(a) * 8,
        x + Math.cos(a + 2.4) * 7,
        y + Math.sin(a + 2.4) * 7,
        x,
        y,
        x + Math.cos(a - 2.4) * 7,
        y + Math.sin(a - 2.4) * 7,
      ],
      0xffdb98,
    );
    ctx.text(`${Math.round(d / 32)}m`, 0, -4, {
      align: "center",
      color: 0xffe3ae,
      scale: 1,
    });
  }
}

import { Graphics2D, Node2D, type DrawContext } from "@kiln/engine/scene";
import { Rng } from "@kiln/engine/core";
import { SIZE, XS, YS, buildings, type Car } from "./city.ts";
export const C = {
  ink: 0x122a35,
  paper: 0xf6ead1,
  muted: 0x9aafaf,
  mint: 0x8ce4c6,
  gold: 0xf0b96d,
  coral: 0xe88874,
};
export function text(
  ctx: DrawContext,
  s: string,
  x: number,
  y: number,
  size = 14,
  color = C.paper,
  align: "left" | "center" | "right" = "left",
  weight = 600,
) {
  ctx.text(s, x, y, { font: { family: "Arial", size, weight }, color, align });
}
class Sign extends Node2D {
  constructor(
    x: number,
    y: number,
    readonly label: string,
    readonly size = 12,
    readonly ink = C.paper,
  ) {
    super(x, y);
  }
  override render(ctx: DrawContext) {
    text(ctx, this.label, 0, 0, this.size, this.ink, "center", 700);
  }
}
function tree(root: Node2D, x: number, y: number, seed: number) {
  const g = root.add(new Graphics2D(x, y));
  g.ellipse(7, 9, 23, 20, { color: 0x071e26, alpha: 0.3 }, 12)
    .rect(-2, -4, 4, 18, 0x857761)
    .ellipse(0, 0, 23, 21, 0x385e58, 12)
    .ellipse(-6, -5, 17, 16, seed % 2 ? 0x507c6a : 0x69816a, 12)
    .ellipse(-9, -8, 9, 8, 0x829774, 10);
}
export function buildCity(root: Node2D) {
  root.add(new Graphics2D()).rect(0, 0, SIZE.w, SIZE.h, 0x244553);
  const shore = root.add(new Graphics2D());
  for (let i = 0; i < 30; i++)
    shore.rect(2350 + (i % 3) * 24, 60 + i * 76, 130, 2, {
      color: 0x68929a,
      alpha: 0.28,
    });
  shore
    .rect(124, 124, 2220, 1900, 0x657478)
    .rect(140, 140, 2188, 1868, 0x828984);
  for (const x of XS) {
    const g = root.add(new Graphics2D(x - 56, 140));
    g.rect(-9, 0, 130, 1868, 0xb1aca0)
      .rect(-3, 0, 118, 1868, 0x343f4b)
      .rect(0, 0, 112, 1868, 0x3c4652);
    for (let y = 10; y < 1860; y += 58) g.rect(55, y, 2, 27, 0xb8ae8e);
  }
  for (const y of YS) {
    const g = root.add(new Graphics2D(140, y - 56));
    g.rect(0, -9, 2188, 130, 0xb1aca0)
      .rect(0, -3, 2188, 118, 0x343f4b)
      .rect(0, 0, 2188, 112, 0x3c4652);
    for (let x = 10; x < 2180; x += 58) g.rect(x, 55, 27, 2, 0xb8ae8e);
  }
  for (const x of XS)
    for (const y of YS) {
      const g = root.add(new Graphics2D(x, y));
      g.rect(-56, -56, 112, 112, 0x3c4652);
      for (let k = -44; k < 48; k += 15) {
        g.rect(k, -71, 7, 17, 0xc4c2ab)
          .rect(k, 54, 7, 17, 0xc4c2ab)
          .rect(-71, k, 17, 7, 0xc4c2ab)
          .rect(54, k, 17, 7, 0xc4c2ab);
      }
      g.rect(-67, -67, 6, 6, 0xed9f6f).rect(60, 60, 6, 6, 0xa0d8af);
    }
  const park = root.add(new Graphics2D(812, 812));
  park
    .roundedRect(0, 0, 336, 336, 18, 0x49695e)
    .rect(151, 0, 34, 336, 0xb5aa88)
    .rect(0, 151, 336, 34, 0xb5aa88)
    .ellipse(168, 168, 63, 63, 0xc4b799)
    .ellipse(168, 168, 51, 51, 0x446a77)
    .ellipse(164, 164, 40, 40, 0x5d93a0)
    .ellipse(168, 168, 10, 10, 0xaad5c3);
  for (let i = 0; i < 8; i++)
    tree(root, 855 + (i % 2) * 250, 855 + Math.floor(i / 2) * 76, i);
  root.add(new Sign(980, 1130, "PALM SQUARE", 14, 0xd5d4b0));
  const rng = new Rng(71);
  for (const b of buildings) {
    const g = root.add(new Graphics2D(b.x, b.y));
    g.polygon(
      [
        [0, 0],
        [b.w, 0],
        [b.w + 24, 24],
        [b.w + 24, b.h + 24],
        [24, b.h + 24],
        [0, b.h],
      ],
      { color: 0x182c37, alpha: 0.42 },
    );
    g.rect(0, 0, b.w, b.h, 0x303f4a)
      .rect(0, 0, b.w - 5, b.h - 7, b.color)
      .rect(7, 7, b.w - 19, b.h - 22, 0x424f59)
      .rect(12, 12, b.w - 29, b.h - 32, b.color);
    g.rect(0, b.h - 17, b.w - 5, 4, b.trim).rect(0, 0, 4, b.h, 0xb29f8c);
    for (let y = 26; y < b.h - 40; y += 34) {
      g.rect(b.w - 10, y, 5, 18, 0xe8ba7a);
      g.rect(8, y, 6, 18, 0x293e4e);
    }
    for (let k = 0; k < (b.w > 100 ? 3 : 1); k++) {
      const x = 27 + k * 46,
        y = 35 + rng.int(0, 3) * 31;
      g.rect(x + 3, y + 4, 27, 38, 0x38434a)
        .rect(x, y, 27, 38, 0x91a09e)
        .rect(x + 4, y + 5, 19, 28, 0x657782);
      for (let v = 0; v < 5; v++) g.rect(x + 5, y + 7 + v * 5, 17, 2, 0x374853);
    }
    if (b.kind === 0)
      g.rect(30, b.h - 91, b.w - 65, 48, 0x303f50).rect(
        34,
        b.h - 87,
        b.w - 73,
        40,
        0x517984,
      );
    if (b.label) {
      const sg = root.add(new Graphics2D(b.x - 4, b.y + b.h + 5));
      sg.rect(0, 0, b.w, 25, 0x243d47);
      root.add(new Sign(b.x + b.w / 2, b.y + b.h + 10, b.label, 11, b.trim));
    }
    for (let k = 0; k < 2; k++) tree(root, b.x + 34 + k * 91, b.y - 18, k);
  }
  // Docks, parking and landmark fixtures.
  const docks = root.add(new Graphics2D());
  for (let i = 0; i < 3; i++) {
    docks.rect(2315, 1520 + i * 100, 195, 46, 0x937d66);
    for (let j = 0; j < 10; j++)
      docks.rect(2320 + j * 18, 1522 + i * 100, 2, 42, 0x685c56);
  }
  docks.rect(2255, 1545, 49, 127, 0x9e6b59).rect(2260, 1550, 39, 117, 0xbb8764);
  for (let i = 0; i < 8; i++) docks.rect(2261, 1556 + i * 14, 36, 3, 0x795b53);
  root.add(new Sign(2255, 1780, "PIER 09", 22, C.paper));
  root.add(new Sign(980, 1202, "PALM BOULEVARD", 12, 0x9da9aa));
  root.add(new Sign(1930, 242, "NORTH QUAY", 12, 0x9da9aa));
  root.add(new Sign(498, 1680, "THE LOWLINE", 13, 0x9da9aa));
  for (let i = 0; i < 18; i++) {
    const x = XS[i % 5] + 77,
      y = YS[Math.floor(i / 5)] + 110;
    const g = root.add(new Graphics2D(x, y));
    g.rect(-3, -3, 6, 24, 0x354b51)
      .ellipse(0, -4, 6, 6, 0xf1d198, 10)
      .ellipse(
        0,
        -4,
        24,
        24,
        { color: 0xf3cb8f, alpha: 0.07, additive: true },
        16,
      );
  }
}
export function carArt(c: Car): Node2D {
  const root = new Node2D(),
    g = root.add(new Graphics2D());
  g.roundedRect(-25, -13, 58, 35, 9, { color: 0x091e2a, alpha: 0.55 });
  g.rect(-19, -19, 12, 7, 0x162933)
    .rect(12, -19, 12, 7, 0x162933)
    .rect(-19, 12, 12, 7, 0x162933)
    .rect(12, 12, 12, 7, 0x162933);
  g.roundedRect(-29, -15, 58, 30, 7, c.color)
    .rect(-24, -12, 47, 2, 0xf3d9aa)
    .rect(-25, 11, 46, 3, 0x354b53);
  g.polygon(
    [
      [6, -12],
      [15, -10],
      [15, 10],
      [6, 12],
    ],
    0x223e50,
  )
    .polygon(
      [
        [-18, -11],
        [-11, -12],
        [-11, 12],
        [-18, 11],
      ],
      0x294859,
    )
    .rect(-10, -11, 15, 22, c.kind === "police" ? 0x253948 : c.color);
  g.rect(26, -11, 4, 7, 0xfbe9af)
    .rect(26, 4, 4, 7, 0xfbe9af)
    .rect(-30, -11, 3, 6, 0xe4886f)
    .rect(-30, 5, 3, 6, 0xe4886f);
  g.polygon(
    [
      [29, -10],
      [125, -36],
      [125, 25],
      [29, 10],
    ],
    { color: 0xf1dba4, alpha: 0.045, additive: true },
  );
  if (c.kind === "police")
    g.rect(-5, -13, 5, 12, 0xee837d).rect(-5, 1, 5, 12, 0x8ad5f4);
  return root;
}
export function personArt(color = 0xdfbd99) {
  const g = new Graphics2D();
  g.ellipse(3, 5, 9, 7, { color: 0x0f2630, alpha: 0.4 }, 10)
    .rect(-5, -5, 9, 10, 0x203843)
    .ellipse(0, 0, 7, 5, color, 10)
    .ellipse(3, 0, 4, 4, 0xe5c6aa, 10);
  return g;
}

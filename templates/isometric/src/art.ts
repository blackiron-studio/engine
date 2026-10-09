// Highground's art: isometric 64x32 tiles with cliff faces, a four-way hero, props that
// stand up as billboards, coins, sparks, a blob shadow and the cell marker. Every sprite is
// painted here; tiles use the painter's isometric helpers.

import { defineSprite, ramp } from "@kiln/engine/art";

export const TILE = { w: 64, h: 32, rise: 16 };

const GRASS = ramp("#8baa59");
const SAND = ramp("#d6be8d");
const STONE = ramp("#93ada6");
const WATER = ramp("#2e989d");
const EARTH = ramp("#688780");

function floor(name: string, colors: readonly string[], speckle: readonly string[]) {
  defineSprite(name, { w: 64, h: 32, origin: [0.5, 0.5] }, (p, { rng }) => {
    p.isoDiamond(32, 0, 64, 32, colors[3]);
    for (let i = 0; i < 18; i++) {
      const x = rng.int(4, 60);
      const y = rng.int(2, 30);
      // Keep speckles inside the diamond.
      if (Math.abs(x - 32) / 32 + Math.abs(y - 16) / 16 < 0.92) p.hline(x, y, rng.int(1, 3), speckle[rng.int(0, speckle.length - 1)]);
    }
    // A lighter edge on the far sides, a darker edge on the near sides, reads as a bevel.
    p.line(32, 0, 63, 16, colors[3]);
    p.line(0, 16, 32, 0, colors[3]);
    p.line(0, 16, 32, 31, colors[3]);
    p.line(32, 31, 63, 16, colors[3]);
  });
}

floor("grass.top", GRASS, [GRASS[2], GRASS[4], "#b7c875"]);
floor("sand.top", SAND, [SAND[2], SAND[4], "#efe0b5"]);
floor("stone.top", STONE, [STONE[2], STONE[4], "#c2d4c2"]);

defineSprite("water.top", { w: 64, h: 32, origin: [0.5, 0.5] }, (p, { rng }) => {
  p.isoDiamond(32, 0, 64, 32, WATER[3]);
  for (let i = 0; i < 8; i++) {
    const x = rng.int(8, 54);
    const y = rng.int(6, 26);
    if (Math.abs(x - 32) / 32 + Math.abs(y - 16) / 16 < 0.8) p.hline(x, y, rng.int(3, 7), WATER[4]);
  }
});

// Cliff faces sit below a floor diamond: the left face runs from the diamond's left vertex to
// its bottom vertex, the right face from the bottom vertex to the right vertex, `rise` tall.
defineSprite("cliff.left", { w: 32, h: 32, origin: [1, 0] }, (p, { rng }) => {
  p.isoFaceLeft(32, -16, 64, 32, 16, EARTH[2]);
  for (let i = 0; i < 15; i++) {
    const x = rng.int(1, 30), y = rng.int(2, 30);
    if (p.data[(y * 32 + x) * 4 + 3]) p.px(x, y, EARTH[rng.int(1, 3)]);
  }
  p.line(1, 8, 30, 22, EARTH[1]);
  p.line(0, 0, 31, 16, GRASS[2]);
});
defineSprite("cliff.right", { w: 32, h: 32, origin: [0, 0] }, (p, { rng }) => {
  p.isoFaceRight(0, -16, 64, 32, 16, EARTH[1]);
  for (let i = 0; i < 15; i++) {
    const x = rng.int(1, 30), y = rng.int(2, 30);
    if (p.data[(y * 32 + x) * 4 + 3]) p.px(x, y, EARTH[rng.int(0, 2)]);
  }
  p.line(1, 24, 30, 9, EARTH[0]);
  p.line(0, 16, 31, 0, GRASS[2]);
});

defineSprite("shadow", { w: 28, h: 14, origin: [0.5, 0.5] }, (p) => {
  p.ellipse(14, 7, 13, 6, "#00000070");
  p.ellipse(14, 7, 9, 4, "#00000060");
});

// A readable silhouette at gameplay zoom: pale face, teal coat, sun-gold scarf and boots.
// Separate stride poses make motion visible without imported textures or skeletal animation.
const SKIN = "#f1c6a0";
const COAT = ramp("#318d8c");
const HAIR = "#3a3432";
function hero(name: string, facing: "s" | "n" | "e" | "w", stride = 0) {
  defineSprite(name, { w: 26, h: 36, origin: [0.5, 1], style: "none" }, (p) => {
    p.rect(7, 27 - stride, 5, 7, "#21383d");
    p.rect(15, 27 + stride, 5, 7, "#21383d");
    p.rect(6, 32 - stride, 6, 3, "#e3d3ae");
    p.rect(15, 32 + stride, 6, 3, "#e3d3ae");
    p.box(6, 15, 14, 14, COAT);
    p.rect(3, 18 + stride, 4, 8, "#256b70");
    p.rect(19, 18 - stride, 4, 8, "#5bb1a5");
    p.rect(3, 24 + stride, 4, 3, SKIN);
    p.rect(19, 24 - stride, 4, 3, SKIN);
    p.ball(13, 9, 7, 7, ramp(SKIN));
    if (facing === "n") {
      p.rect(6, 3, 14, 10, HAIR);
      p.box(9, 19, 8, 8, ramp("#d5ab61"));
    }
    else {
      p.rect(6, 3, 14, 5, HAIR);
      p.rect(facing === "w" ? 17 : 6, 7, 3, 4, HAIR);
      if (facing !== "e") p.rect(9, 10, 2, 2, "#21383d");
      if (facing !== "w") p.rect(16, 10, 2, 2, "#21383d");
    }
    p.rect(7, 15, 12, 3, "#f3cc73");
    if (facing === "e") p.rect(3, 16, 6, 3, "#e59d58");
    if (facing === "w") p.rect(18, 16, 6, 3, "#e59d58");
    if (facing === "s") p.rect(14, 18, 4, 6, "#e59d58");
    p.outline("#173f44");
    p.line(8, 3, 15, 3, "#8c7355");
  });
}
for (const facing of ["s", "n", "e", "w"] as const) {
  hero(`hero.${facing}`, facing);
  hero(`hero.${facing}.stepL`, facing, -1);
  hero(`hero.${facing}.stepR`, facing, 1);
}

// Already projected ellipses: place at the actual terrace height, below the standing actor.
defineSprite("contact", { w: 38, h: 18, origin: [0.5, 0.5], style: "none" }, (p) => {
  p.ellipse(19, 9, 17, 7, "#123d3e25");
  p.ellipse(19, 9, 12, 5, "#123d3e60");
  p.ellipse(19, 9, 7, 3, "#123d3e75");
});
defineSprite("hero.ring", { w: 44, h: 22, origin: [0.5, 0.5], style: "none" }, (p) => {
  for (let i = 0; i < 36; i++) {
    const a = i * Math.PI / 18, b = (i + 1) * Math.PI / 18;
    p.line(22 + Math.cos(a) * 19, 11 + Math.sin(a) * 8, 22 + Math.cos(b) * 19, 11 + Math.sin(b) * 8, i < 18 ? "#d5f4d7" : "#7bd1bd");
  }
});

// Broad, layered crown with warm rim light and a cool undershadow. No external textures.
defineSprite("tree", { w: 54, h: 72, origin: [0.5, 0.94], style: "none" }, (p) => {
  p.cylinder(23, 43, 8, 25, ramp("#8f7352"));
  p.line(26, 48, 18, 36, "#755d45");
  p.line(27, 51, 36, 39, "#755d45");
  p.ellipse(28, 38, 23, 17, "#315b4b");
  p.ball(21, 29, 18, 17, ramp("#789749"), { lx: -0.65, ly: -0.8 });
  p.ball(36, 31, 16, 17, ramp("#7c9d4a"), { lx: -0.65, ly: -0.8 });
  p.ball(27, 19, 18, 16, ramp("#a1b85b"), { lx: -0.65, ly: -0.8 });
  p.ellipse(21, 13, 8, 4, "#cedb8c");
  p.ellipse(12, 27, 5, 3, "#b6ca74");
  p.ellipse(39, 30, 5, 3, "#a9c165");
});

defineSprite("flowers", { w: 24, h: 16, origin: [0.5, 0.86], style: "none" }, (p) => {
  for (const [x, y] of [[5, 7], [12, 4], [19, 9]]) {
    p.line(x, y, x - 1, 14, "#547d52");
    p.ellipse(x, y, 3, 2, "#f2d49e");
    p.px(x, y, "#bd785e");
  }
});

defineSprite("grass.tuft", { w: 22, h: 15, origin: [0.5, 0.86], style: "none" }, (p) => {
  p.ellipse(11, 12, 9, 2, "#365f4430");
  p.line(8, 13, 4, 5, "#648c48");
  p.line(10, 13, 10, 2, "#bfd281");
  p.line(12, 13, 15, 4, "#729449");
  p.line(13, 13, 19, 8, "#b0c471");
});

defineSprite("rock", { w: 26, h: 18, origin: [0.5, 0.85] }, (p) => {
  p.ball(13, 9, 12, 8, STONE, { lx: -0.5, ly: -0.7 });
  p.outline("#2a2d3a");
});

defineSprite("crate", { w: 32, h: 32, origin: [0.5, 0.75] }, (p) => {
  p.isoBlock(16, 0, 32, 16, 16, ramp("#b98650"));
  p.line(1, 8, 16, 16, "#5a3a1e");
  p.line(16, 16, 31, 8, "#5a3a1e");
  p.line(16, 16, 16, 31, "#5a3a1e");
});

defineSprite("coin", { w: 12, h: 12, origin: [0.5, 0.5] }, (p) => {
  p.ball(6, 6, 5, 5, ramp("#f0c040"), { lx: -0.4, ly: -0.6 });
  p.ring(6, 6, 4, "#a67c1c");
  p.px(4, 4, "#fff6c0");
});

defineSprite("spark", { w: 4, h: 4, origin: [0.5, 0.5] }, (p) => {
  p.rect(0, 0, 4, 4, "#ffd070");
  p.rect(1, 1, 2, 2, "#fff6d0");
});

defineSprite("marker", { w: 64, h: 32, origin: [0.5, 0.5] }, (p) => {
  p.line(32, 0, 63, 16, "#ffffff");
  p.line(63, 16, 32, 31, "#ffffff");
  p.line(32, 31, 0, 16, "#ffffff");
  p.line(0, 16, 32, 0, "#ffffff");
});

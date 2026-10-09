// All sprites, painted in code at 32 px density. Keep game logic out of this file.

import { type Painter, defineAnimation, defineAutotile, defineSprite, defineVariants, materials, ramp } from "@blackiron-studio/engine/art";

const GRASS = ramp("#4a8a4e", 0.9);
const GRASS_DARK = ramp("#3a6e40", 0.9);

export const GROUND = [
  ...defineVariants("grass", 3, { w: 32, h: 32 }, (p, { rng }) => {
    materials.grass(p, 0, 0, 32, 32, GRASS, rng, { blades: 10 + rng.int(0, 5) });
  }),
];

/** Dark patches autotile so their edges dissolve into the surrounding grass. */
export const DARK = defineAutotile("dark", { w: 32, h: 32 }, (p, { rng, north, east, south, west }) => {
  materials.grass(p, 0, 0, 32, 32, GRASS_DARK, rng, { blades: 12 });
  const fade = (x: number, y: number, w: number, h: number, flip: boolean) => {
    for (let i = 0; i < 8; i++) {
      const t = flip ? i / 8 : 1 - i / 8;
      if (w > h) p.dither(x, y + i, w, 1, GRASS_DARK[2], GRASS[2], t * 0.9);
      else p.dither(x + i, y, 1, h, GRASS_DARK[2], GRASS[2], t * 0.9);
    }
  };
  if (!north) fade(0, 0, 32, 8, false);
  if (!south) fade(0, 24, 32, 8, true);
  if (!west) fade(0, 0, 8, 32, false);
  if (!east) fade(24, 0, 8, 32, true);
});

export const FLOWERS = defineSprite("flowers", { w: 32, h: 32 }, (p, { rng }) => {
  materials.grass(p, 0, 0, 32, 32, GRASS, rng, { blades: 8, flowers: 5, flowerColors: ["#ffe08a", "#ff9ac2", "#ffffff", "#c9a6ff"] });
});

export const ROCK = defineSprite("rock", { w: 32, h: 28, origin: [0.5, 0.85] }, (p, { rng }) => {
  const R = ramp("#858b9c", 1.1);
  p.ellipse(16, 23.5, 13, 4, "#1b2a1e88");
  p.ball(16, 15, 11, 8, R, { lx: -0.6, ly: -0.7 });
  p.withMask(p.silhouette(), () => p.speckle(6, 9, 20, 12, R[1], 10, rng));
  p.edges(R[0], { bottom: true, right: true });
});

export const BUSH = defineSprite("bush", { w: 40, h: 32, origin: [0.5, 0.9] }, (p, { rng }) => {
  const R = ramp("#3f8a48", 1.2);
  p.ellipse(20, 28.5, 16, 4, "#16281a99");
  materials.foliage(p, 20, 15, 18, 12, R, rng, { clumps: 5 });
  if (rng.chance(0.6)) p.speckle(8, 8, 24, 16, "#d94a5e", 6, rng);
  p.edges(R[0], { bottom: true });
});

const SKIN = ramp("#e6b892", 0.8);
const TUNIC = ramp("#3d7dc4", 1.1);
const HAIR = ramp("#6a4a2c", 1);

function paintHero(p: Painter, legA: number, legB: number, bob: number, rng: Parameters<typeof materials.cloth>[6]): void {
  p.ellipse(16, 37, 10, 3, "#0e1a1288");
  p.rect(9, 25 + bob, 5, 11 + legA, "#2a2233");
  p.rect(18, 25 + bob, 5, 11 + legB, "#2a2233");
  p.hline(9, 35 + bob + legA, 5, "#3a3244");
  p.hline(18, 35 + bob + legB, 5, "#3a3244");
  materials.cloth(p, 8, 14 + bob, 16, 13, TUNIC, rng, { folds: 2 });
  p.hline(8, 21 + bob, 16, "#3a2a1e");
  p.ball(16, 8.5 + bob, 7.5, 7.5, SKIN, { lx: -0.4, ly: -0.7 });
  p.ball(16, 4.4 + bob, 8.5, 4.6, HAIR, { lx: -0.4, ly: -0.8 });
  p.rect(13, 9 + bob, 2, 2, "#2a1a1a");
  p.rect(18, 9 + bob, 2, 2, "#2a1a1a");
  p.px(14, 8 + bob, "#ffffff");
  p.px(19, 8 + bob, "#ffffff");
  p.outline("#1a1420");
}

export const HERO_IDLE = defineSprite("hero.idle", { w: 32, h: 40, origin: [0.5, 0.95] }, (p, { rng }) => paintHero(p, 0, 0, 0, rng));
export const HERO_WALK = defineVariants("hero.walk", 2, { w: 32, h: 40, origin: [0.5, 0.95] }, (p, { index, rng }) => paintHero(p, index ? -3 : 0, index ? 0 : -3, index, rng));
defineAnimation("hero.idle", [HERO_IDLE], 1);
defineAnimation("hero.walk", HERO_WALK, 8);

export const GEM = defineVariants("gem", 2, { w: 16, h: 20 }, (p, { index }) => {
  const R = ramp("#5ee0d0", 1.2);
  p.polygon(
    [
      [8, 0],
      [15.5, 6],
      [8, 19.5],
      [0.5, 6],
    ],
    R[2],
  );
  p.line(1, 6, 14, 6, R[3]);
  p.line(8, 0, 8, 19, R[3]);
  p.polygon(
    [
      [8, 1],
      [14, 6],
      [8, 6],
    ],
    R[4],
  );
  p.rect(4, 3, 2, 2, index ? R[4] : "#ffffff");
  p.polygon(
    [
      [1, 6],
      [8, 6],
      [8, 18],
    ],
    R[1],
  );
  p.px(8, 17, R[0]);
});
defineAnimation("gem", GEM, 3);

export const SLIME = defineVariants("slime", 2, { w: 32, h: 26, origin: [0.5, 0.9] }, (p, { index }) => {
  const R = ramp("#8fd65a", 1);
  p.ellipse(16, 23.5, 13, 3, "#0e1a1288");
  p.ball(16, 14, 14.5, index ? 9.4 : 11, R, { lx: -0.4, ly: -0.8 });
  p.rect(10, 12, 3, 4, "#1d3a12");
  p.rect(19, 12, 3, 4, "#1d3a12");
  p.rect(11, 12, 1, 1, "#ffffff");
  p.rect(20, 12, 1, 1, "#ffffff");
  p.rect(8, 7, 3, 2, R[4]);
  p.edges(R[0], { bottom: true });
});
defineAnimation("slime", SLIME, 4);

function heart(p: Painter, R: string[] | null): void {
  const pts: [number, number][] = [
    [2, 2],
    [6, 0],
    [9, 2.4],
    [12, 0],
    [16, 2],
    [18, 6],
    [9, 16],
    [0, 6],
  ];
  if (!R) {
    p.polygon(pts, "#2a2436");
    p.outline("#4a4460");
    return;
  }
  p.polygon(pts, R[2]);
  p.rect(3, 3, 3, 2, R[4]);
  p.px(4, 3, "#ffffff");
  p.polygon(
    [
      [4, 10],
      [14, 10],
      [9, 15],
    ],
    R[0],
  );
  p.outline(R[0]);
}

export const HEART = defineSprite("heart", { w: 18, h: 16, origin: [0, 0] }, (p) => heart(p, ramp("#e04a5a", 1)));
export const HEART_EMPTY = defineSprite("heart.empty", { w: 18, h: 16, origin: [0, 0] }, (p) => heart(p, null));

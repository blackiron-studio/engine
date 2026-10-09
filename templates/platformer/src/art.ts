// All sprites, painted in code at 32 px density. Keep game logic out of this file.

import { type Painter, defineAnimation, defineAutotile, defineSprite, defineVariants, materials, ramp } from "@blackiron-studio/engine/art";

const DIRT = ramp("#6b4b34", 1);
const GRASS = ramp("#5aa650", 1);

/** Ground autotiles: dirt everywhere, a grass lip only where the tile above is not ground. */
export const GROUND = defineAutotile("ground", { w: 32, h: 32 }, (p, { rng, north, east, west }) => {
  p.box(0, 0, 32, 32, DIRT, { topLight: false, vert: 0.25, horiz: 0.08 });
  p.speckle(0, 0, 32, 32, DIRT[0], 14, rng);
  p.speckle(0, 0, 32, 32, DIRT[3], 8, rng);
  for (let i = 0; i < 3; i++) p.ellipse(rng.int(3, 28), rng.int(6, 28), 1.8, 1.2, DIRT[1]);
  if (!north) {
    p.rect(0, 0, 32, 6, GRASS[2]);
    p.hline(0, 0, 32, GRASS[4]);
    p.dither(0, 4, 32, 3, GRASS[2], DIRT[3], 0.5);
    for (let x = 0; x < 32; x += 2) if (rng.chance(0.5)) p.vline(x, 1, rng.int(2, 4), rng.chance(0.5) ? GRASS[3] : GRASS[1]);
  }
  if (!west) p.vline(0, 0, 32, DIRT[3]);
  if (!east) p.vline(31, 0, 32, DIRT[0]);
});

export const PLATFORM = defineSprite("platform", { w: 32, h: 32 }, (p, { rng }) => {
  materials.planks(p, 0, 0, 32, 10, ramp("#a67c52", 1), rng, { plankH: 10 });
  p.hline(0, 0, 32, "#d9b07c");
});

export const COIN = defineVariants("coin", 4, { w: 16, h: 16 }, (p, { index }) => {
  const G = ramp("#f2c14e", 1);
  const rx = [7, 4.8, 2, 4.8][index];
  p.ellipse(8, 8, rx, 7, G[2]);
  if (rx > 4) {
    p.ellipse(8, 8, rx - 2.2, 4.8, G[3]);
    p.rect(5, 4, 2, 2, G[4]);
    p.ellipse(8, 9, rx - 3.4, 3, G[2]);
  } else p.vline(8, 2, 12, G[4]);
  p.edges(G[0], { bottom: true, right: true });
});
defineAnimation("coin", COIN, 8);

export const SPIKE = defineSprite("spike", { w: 32, h: 32 }, (p) => {
  const S = ramp("#9aa0b4", 1);
  for (const x0 of [0, 11, 22]) {
    const w = x0 === 22 ? 10 : 11;
    p.polygon(
      [
        [x0, 32],
        [x0 + w / 2, 6],
        [x0 + w, 32],
      ],
      S[2],
    );
    p.line(x0 + w / 2, 7, x0 + 1, 31, S[4]);
    p.line(x0 + w / 2, 8, x0 + w - 1, 31, S[0]);
  }
});

export const FLAG = defineSprite("flag", { w: 32, h: 48, origin: [0, 1] }, (p) => {
  p.vline(6, 0, 48, "#3a3a4a");
  p.vline(7, 0, 48, "#8a8aa0");
  p.vline(8, 0, 48, "#5a5a70");
  const R = ramp("#e04a5a", 1);
  p.polygon(
    [
      [9, 2],
      [30, 10],
      [9, 18],
    ],
    R[2],
  );
  p.line(9, 2, 29, 10, R[4]);
  p.line(9, 17, 28, 10, R[0]);
  p.rect(6, 0, 3, 2, "#f2c14e");
});

const SKIN = ramp("#e6b892", 0.8);
const SUIT = ramp("#e0663f", 1.1);
const CAP = ramp("#c94a2c", 1);

function paintHero(p: Painter, legA: number, legB: number, arms: number, squash: number, rng: Parameters<typeof materials.cloth>[6]): void {
  const bob = squash;
  p.rect(6, 22 + bob, 4, 10 - legA, "#2a2233");
  p.rect(14, 22 + bob, 4, 10 - legB, "#2a2233");
  materials.cloth(p, 6, 12 + bob, 12, 12, SUIT, rng, { folds: 1 });
  p.rect(4 + arms, 16 + bob, 2, 4, SUIT[1]);
  p.rect(18 - arms, 16 + bob, 2, 4, SUIT[1]);
  p.ball(12, 8 + bob, 6, 6, SKIN, { lx: -0.4, ly: -0.7 });
  p.ball(12, 4.8 + bob, 6.8, 3.6, CAP, { lx: -0.4, ly: -0.8 });
  p.hline(6, 6 + bob, 14, CAP[1]);
  p.rect(14, 8 + bob, 2, 2, "#2a1a1a");
  p.outline("#1a1420");
}

export const HERO_IDLE = defineSprite("hero.idle", { w: 24, h: 32, origin: [0.5, 1] }, (p, { rng }) => paintHero(p, 0, 0, 0, 0, rng));
export const HERO_RUN = defineVariants("hero.run", 2, { w: 24, h: 32, origin: [0.5, 1] }, (p, { index, rng }) => paintHero(p, index ? 2 : 0, index ? 0 : 2, index, index, rng));
export const HERO_JUMP = defineSprite("hero.jump", { w: 24, h: 32, origin: [0.5, 1] }, (p, { rng }) => paintHero(p, 2, 0, -1, -1, rng));
defineAnimation("hero.idle", [HERO_IDLE], 1);
defineAnimation("hero.run", HERO_RUN, 10);
defineAnimation("hero.jump", [HERO_JUMP], 1);

export const HILLS = defineSprite("hills", { w: 192, h: 80, origin: [0, 1] }, (p) => {
  const H = ramp("#3a3f6e", 0.6);
  p.ellipse(48, 80, 60, 44, H[1]);
  p.ellipse(132, 80, 72, 60, H[1]);
  p.ellipse(180, 80, 44, 32, H[1]);
  p.ellipse(132, 80, 68, 52, H[2]);
  p.ellipse(48, 80, 54, 36, H[2]);
});

export const CLOUD = defineSprite("cloud", { w: 56, h: 24 }, (p) => {
  const C = ramp("#c8a0c0", 0.5);
  p.ellipse(16, 16, 14, 8, C[2]);
  p.ellipse(32, 12, 16, 10, C[2]);
  p.ellipse(44, 16, 12, 7, C[2]);
  p.ellipse(32, 10, 10, 6, C[3]);
});

export const SPARK = defineSprite("spark", { w: 5, h: 5 }, (p) => {
  p.rect(0, 0, 5, 5, "#fff3b0");
});

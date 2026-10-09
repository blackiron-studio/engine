// All sprites at 32 px density. Units come in two team colours as variants.

import { type Painter, type Ramp, defineSprite, defineVariants, materials, ramp } from "@blackiron-studio/engine/art";

const GRASS = ramp("#5c9a52", 0.9);

function board(p: Painter): void {
  p.hline(0, 31, 32, GRASS[1]);
  p.vline(31, 0, 32, GRASS[1]);
}

export const TILE_GRASS = defineSprite("grass", { w: 32, h: 32 }, (p, { rng }) => {
  materials.grass(p, 0, 0, 32, 32, GRASS, rng, { blades: 6 });
  board(p);
});

export const TILE_FOREST = defineSprite("forest", { w: 32, h: 32 }, (p, { rng }) => {
  materials.grass(p, 0, 0, 32, 32, ramp("#4f8a48", 0.9), rng, { blades: 4 });
  board(p);
  const R = ramp("#2f6b3a", 1.1);
  p.ellipse(16, 28, 10, 3, "#1a2e1e99");
  materials.bark(p, 14, 18, 5, 10, ramp("#5a3d2a"), rng, { streaks: 2, knots: 0 });
  materials.foliage(p, 16, 13, 11, 10, R, rng, { clumps: 4 });
});

export const TILE_WATER = defineSprite("water", { w: 32, h: 32 }, (p, { rng }) => {
  materials.water(p, 0, 0, 32, 32, ramp("#3a6fb5", 1), rng, { waves: 5 });
  p.hline(0, 31, 32, "#2f5f9e");
  p.vline(31, 0, 32, "#2f5f9e");
});

export const TILE_ROCK = defineSprite("rock", { w: 32, h: 32 }, (p, { rng }) => {
  materials.grass(p, 0, 0, 32, 32, GRASS, rng, { blades: 3 });
  board(p);
  const R = ramp("#8a8fa0", 1.1);
  p.ellipse(16, 27, 12, 3, "#1a2e1e99");
  p.ball(16, 17, 12, 9, R, { lx: -0.6, ly: -0.7 });
  p.withMask(p.silhouette(), () => p.speckle(6, 12, 20, 10, R[1], 8, rng));
});

const TEAM: Ramp[] = [ramp("#3d7dc4", 1.1), ramp("#c94a3c", 1.1)];
const SKIN = ramp("#e6b892", 0.8);

function base(p: Painter, team: Ramp, rng: Parameters<typeof materials.cloth>[6]): void {
  p.ellipse(16, 29, 9, 2.6, "#0e1a1288");
  p.rect(10, 20, 4, 8, "#2a2233");
  p.rect(18, 20, 4, 8, "#2a2233");
  materials.cloth(p, 10, 12, 12, 10, team, rng, { folds: 1 });
  p.ball(16, 8, 6, 6, SKIN, { lx: -0.4, ly: -0.7 });
  p.rect(14, 8, 2, 2, "#2a1a1a");
  p.rect(18, 8, 2, 2, "#2a1a1a");
}

export const SOLDIER = defineVariants("soldier", 2, { w: 32, h: 32, origin: [0.5, 0.95] }, (p, { index, rng }) => {
  const team = TEAM[index];
  base(p, team, rng);
  p.ball(16, 4.4, 6.8, 3.6, ramp("#8a8fa0"), { lx: -0.4, ly: -0.8 });
  p.stroke(22, 10, 26, 22, 2, ramp("#c9ced8"));
  p.box(4, 14, 6, 8, team, { vert: 0.5 });
  p.rect(6, 16, 2, 2, team[4]);
  p.outline("#1a1420");
});

export const ARCHER = defineVariants("archer", 2, { w: 32, h: 32, origin: [0.5, 0.95] }, (p, { index, rng }) => {
  const team = TEAM[index];
  base(p, team, rng);
  p.ball(16, 4, 6.8, 3.6, ramp("#4f7a3a"), { lx: -0.4, ly: -0.8 });
  p.line(24, 6, 24, 22, "#8a5a2a");
  p.line(24, 6, 28, 14, "#c9ced8");
  p.line(28, 14, 24, 22, "#c9ced8");
  p.outline("#1a1420");
});

export const BRUTE = defineVariants("brute", 2, { w: 32, h: 32, origin: [0.5, 0.95] }, (p, { index, rng }) => {
  const team = TEAM[index];
  p.ellipse(16, 29, 11, 2.8, "#0e1a1288");
  p.rect(8, 20, 6, 8, "#2a2233");
  p.rect(18, 20, 6, 8, "#2a2233");
  materials.cloth(p, 6, 10, 20, 12, team, rng, { folds: 2 });
  p.ball(16, 7, 6.8, 6.4, SKIN, { lx: -0.4, ly: -0.7 });
  p.rect(14, 8, 2, 2, "#2a1a1a");
  p.rect(18, 8, 2, 2, "#2a1a1a");
  p.stroke(2, 8, 6, 24, 3, ramp("#7a5a3a"));
  materials.metal(p, 0, 4, 8, 6, ramp("#8a8fa0"), rng, { sheen: true });
  p.outline("#1a1420");
});

export const CURSOR = defineSprite("cursor", { w: 32, h: 32 }, (p) => {
  const c = "#fff3b0";
  for (const [x, y] of [
    [0, 0],
    [24, 0],
    [0, 24],
    [24, 24],
  ]) {
    p.hline(x, y === 0 ? 0 : 31, 8, c);
    p.hline(x, y === 0 ? 1 : 30, 8, c);
    p.vline(x === 0 ? 0 : 31, y, 8, c);
    p.vline(x === 0 ? 1 : 30, y, 8, c);
  }
});

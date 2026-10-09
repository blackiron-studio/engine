// Every sprite in Wisp Hollow is painted in code at boot, at 32 px density. This module
// only defines art, so `kiln atlas` can import it headlessly to export PNGs.

import { defineAnimation, defineAutotile, defineRig, defineSprite, defineSpriteSet, defineVariants, materials, ramp, type Painter, type Ramp } from "@kiln/engine/art";

const GRASS = ramp("#386258", 0.9);
const GRASS_DARK = ramp("#31544f", 0.9);
const DIRT = ramp("#a09576", 1);

// --- Ground ------------------------------------------------------------------------

export const TILES = {
  grass: defineVariants("grass", 4, { w: 32, h: 32 }, (p, { rng }) => {
    p.rect(0, 0, 32, 32, "#3b625c");
    for (let i = 0; i < 3; i++) {
      const x = rng.int(1, 30), y = rng.int(2, 30);
      p.line(x, y, x + 1, y - 2, "#4a736777");
    }
  }),
  // Dark patches autotile so their edges dissolve into the lighter grass around them.
  dark: defineAutotile("dark", { w: 32, h: 32 }, (p, { rng, north, east, south, west }) => {
    materials.grass(p, 0, 0, 32, 32, GRASS_DARK, rng, { blades: 5 });
    p.dither(0, 0, 32, 32, GRASS_DARK[1], GRASS_DARK[0], 0.2);
    const fade = (x: number, y: number, w: number, h: number, flip: boolean) => {
      const steps = 8;
      for (let i = 0; i < steps; i++) {
        const t = flip ? i / steps : 1 - i / steps;
        if (w > h) p.dither(x, y + i, w, 1, GRASS_DARK[2], GRASS[2], t * 0.9);
        else p.dither(x + i, y, 1, h, GRASS_DARK[2], GRASS[2], t * 0.9);
      }
    };
    if (!north) fade(0, 0, 32, 8, false);
    if (!south) fade(0, 24, 32, 8, true);
    if (!west) fade(0, 0, 8, 32, false);
    if (!east) fade(24, 0, 8, 32, true);
  }),
  flowers: defineVariants("flowers", 2, { w: 32, h: 32 }, (p, { rng }) => {
    materials.grass(p, 0, 0, 32, 32, GRASS, rng, { blades: 8, flowers: 4 + rng.int(0, 3) });
  }),
  // The path autotiles: dirt in the middle, a grass fringe on any side that is not path.
  path: defineAutotile("path", { w: 32, h: 32 }, (p, { rng, north, east, south, west }) => {
    p.rect(0, 0, 32, 32, DIRT[2]);
    p.dither(0, 0, 32, 32, DIRT[2], DIRT[1], 0.3);
    p.speckle(0, 0, 32, 32, DIRT[3], 18, rng);
    p.speckle(0, 0, 32, 32, DIRT[0], 8, rng);
    for (let i = 0; i < 3; i++) {
      const x = rng.int(2, 27);
      const y = rng.int(2, 27);
      p.ellipse(x, y, 1.6, 1.1, DIRT[1]);
      p.px(x, y - 1, DIRT[4]);
    }
    const fringe = (x: number, y: number, w: number, h: number) => {
      p.rect(x, y, w, h, GRASS[2]);
      p.dither(x, y, w, h, GRASS[2], GRASS[1], 0.3);
    };
    if (!north) {
      fringe(0, 0, 32, 3);
      for (let x = 0; x < 32; x += 2) if (rng.chance(0.6)) p.vline(x, 3, rng.int(1, 3), GRASS[1]);
    }
    if (!south) {
      fringe(0, 29, 32, 3);
      for (let x = 0; x < 32; x += 2) if (rng.chance(0.6)) p.vline(x, 29 - rng.int(1, 3), 2, GRASS[3]);
    }
    if (!west) {
      fringe(0, 0, 3, 32);
      for (let y = 0; y < 32; y += 2) if (rng.chance(0.6)) p.hline(3, y, rng.int(1, 3), GRASS[1]);
    }
    if (!east) {
      fringe(29, 0, 3, 32);
      for (let y = 0; y < 32; y += 2) if (rng.chance(0.6)) p.hline(29 - rng.int(1, 3), y, 2, GRASS[3]);
    }
  }),
};

// --- Decorations (origin near the feet so y-sorting works) -----------------------------

export const ROCKS = defineVariants("rock", 3, { w: 32, h: 28, origin: [0.5, 0.85] }, (p, { rng, index }) => {
  const R = ramp("#7e8494", 1.1);
  p.ellipse(16, 23.5, 13, 4, "#1b2a1e88");
  p.ball(16, 15, 10 + index, 7.5 + index * 0.6, R, { lx: -0.6, ly: -0.7 });
  p.withMask(p.silhouette(), () => {
    p.speckle(6, 9, 20, 12, R[1], 12, rng);
    p.speckle(6, 8, 20, 8, R[4], 6, rng);
    p.hatch(6, 16, 20, 8, R[1], 4, true);
  });
  p.edges(R[0], { bottom: true, right: true });
  p.px(10 - index, 9, R[4]);
});

export const BUSHES = defineVariants("bush", 2, { w: 40, h: 32, origin: [0.5, 0.9] }, (p, { rng, index }) => {
  const R = ramp(index === 0 ? "#3d7f45" : "#46884a", 1.2);
  p.ellipse(20, 28.5, 16, 4, "#16281a99");
  materials.foliage(p, 20, 15, 18, 12, R, rng, { clumps: 5 });
  if (rng.chance(0.7)) p.speckle(8, 8, 24, 16, "#d94a5e", 6, rng);
  p.edges(R[0], { bottom: true });
});

// Bevel normals let the lantern light the side of a tree that faces it.
export const TREES = defineVariants("tree", 2, { w: 64, h: 96, origin: [0.5, 0.95], normal: "bevel" }, (p, { rng, index }) => {
  const trunk = ramp("#5a3d2a", 1.1);
  const leaf = ramp(index === 0 ? "#2f6d3a" : "#3b7a3f", 1.25);
  p.ellipse(32, 91, 24, 5, "#10201499");
  p.polygon(
    [
      [22, 92],
      [26, 58],
      [38, 58],
      [44, 92],
    ],
    trunk[2],
  );
  materials.bark(p, 26, 44, 12, 46, trunk, rng, { streaks: 8, knots: 1 });
  p.polygon(
    [
      [18, 92],
      [27, 78],
      [29, 92],
    ],
    trunk[1],
  );
  p.polygon(
    [
      [46, 92],
      [37, 80],
      [35, 92],
    ],
    trunk[1],
  );
  materials.foliage(p, 32, 32, 28, 24, leaf, rng, { clumps: 6, light: [-0.45, -0.8] });
  p.outline("#16281a");
});

export const MUSHROOM = defineSprite("mushroom", { w: 16, h: 16, origin: [0.5, 0.9] }, (p) => {
  const cap = ramp("#c9403f", 1);
  p.rect(6, 8, 4, 6, "#e9dcc4");
  p.vline(6, 9, 5, "#b9a98c");
  p.ball(8, 6.5, 7, 4.5, cap, { lx: -0.4, ly: -0.8 });
  p.px(5, 4, "#fff0e0");
  p.rect(9, 5, 2, 2, "#fff0e0");
  p.px(12, 7, "#fff0e0");
  p.hline(2, 10, 12, cap[0]);
});

// --- The lantern-bearer -----------------------------------------------------------------

const SKIN = ramp("#e2b48d", 0.8);
const HOOD = ramp("#4d3b66", 1);
const CLOAK = ramp("#6d3f92", 1.15);
const BOOT = ramp("#2a2233", 0.8);
const LANTERN = ramp("#d9a441", 1);

function paintHero(p: Painter, legA: number, legB: number, bob: number, rng: { int(a: number, b: number): number; chance(p: number): boolean; range(a: number, b: number): number; pick<T>(a: readonly T[]): T; sign(): number; next(): number }): void {
  p.ellipse(16, 45, 10, 3, "#0e1a1288");
  // Legs and boots.
  p.box(10, 31 + bob, 5, 10 + legA, BOOT as unknown as Ramp, { vert: 0.4 });
  p.box(18, 31 + bob, 5, 10 + legB, BOOT as unknown as Ramp, { vert: 0.4 });
  p.hline(10, 40 + bob + legA, 5, BOOT[3]);
  p.hline(18, 40 + bob + legB, 5, BOOT[3]);
  // Cloak with folds, a belt and a flared hem.
  materials.cloth(p, 8, 16 + bob, 16, 18, CLOAK, rng as never, { folds: 2, hem: false });
  p.polygon(
    [
      [8, 33 + bob],
      [24, 33 + bob],
      [26, 39 + bob],
      [6, 39 + bob],
    ],
    CLOAK[1],
  );
  p.hline(7, 39 + bob, 18, CLOAK[0]);
  p.hline(8, 24 + bob, 16, "#3a2a1e");
  p.px(16, 24 + bob, "#d9a441");
  // Head, hood, face.
  p.ball(16, 10 + bob, 7, 7, SKIN, { lx: -0.4, ly: -0.7 });
  p.ball(16, 6.5 + bob, 8.5, 5, HOOD, { lx: -0.4, ly: -0.8 });
  p.polygon(
    [
      [8, 8 + bob],
      [24, 8 + bob],
      [22, 13 + bob],
      [10, 13 + bob],
    ],
    HOOD[1],
  );
  p.ellipse(16, 12.5 + bob, 5, 4, SKIN[2]);
  p.px(13, 12 + bob, "#3a2a2a");
  p.px(19, 12 + bob, "#3a2a2a");
  p.px(14, 11 + bob, "#ffffff");
  p.px(20, 11 + bob, "#ffffff");
  p.hline(15, 15 + bob, 3, SKIN[1]);
  // Arm and lantern.
  p.stroke(23, 22 + bob, 28, 30 + bob, 3, CLOAK);
  p.line(28, 31 + bob, 28, 33 + bob, "#3a3a3a");
  p.box(25, 33 + bob, 7, 8, LANTERN, { vert: 0.4 });
  p.rect(27, 35 + bob, 3, 4, "#fff6c8");
  p.px(28, 36 + bob, "#ffffff");
  p.px(28, 39 + bob, "#ffd36b");
  p.outline("#1a1420");
}

export const HERO_IDLE = defineSprite("hero.idle", { w: 32, h: 48, origin: [0.5, 0.92] }, (p, { rng }) => paintHero(p, 0, 0, 0, rng));
export const HERO_WALK = defineVariants("hero.walk", 4, { w: 32, h: 48, origin: [0.5, 0.92] }, (p, { index, rng }) => {
  const legs = [
    [0, -2],
    [-2, 0],
    [-2, 0],
    [0, -2],
  ][index];
  paintHero(p, legs[0], legs[1], index % 2 === 1 ? 1 : 0, rng);
});
defineAnimation("hero.idle", [HERO_IDLE], 1);
defineAnimation("hero.walk", HERO_WALK, 9);

// The same role from a generated sheet: sixteen poses of a knight an image model drew, run
// through `kiln art import` into assets/knight.png. Press K in the game to swap heroes and
// judge imported art against the painted one on the same ground, under the same light.
// The sprite set carries facings ("knight.idle" and "knight.walk" pick a side), a mirrored
// attack and a held hurt pose; the rig is the same knight as seven parts on the humanoid
// template, posed by the engine's clips.
defineSpriteSet("knight", "assets/knight.json", { origin: [0.5, 0.97], normal: "bevel" });
defineRig("knight-rig", "assets/knight-rig.json", { normal: "bevel" });

// --- Embers and wisps --------------------------------------------------------------------

export const EMBER = defineVariants("ember", 2, { w: 16, h: 16 }, (p, { index }) => {
  const r = index === 0 ? 6.2 : 5.6;
  p.ellipse(8, 8, r, r, "#e0521f");
  p.ellipse(8, 8, r - 1.5, r - 1.5, "#ffb347");
  p.ellipse(8, 8 - (index === 0 ? 0.5 : 0), 2.8, 2.8, "#fff7c8");
  p.px(index === 0 ? 4 : 10, 4, "#ffd36b");
  p.px(index === 0 ? 11 : 5, 11, "#ff8c2a");
});
defineAnimation("ember", EMBER, 4);

export const WISP = defineVariants("wisp", 2, { w: 24, h: 28, origin: [0.5, 0.5] }, (p, { index, rng }) => {
  const R = ramp("#8de9d8", 0.9);
  p.ball(12, 12, 8.8, 10, R, { lx: -0.3, ly: -0.9 });
  p.ellipse(12, 20, 6, 5, R[2]);
  p.px(6, 24, R[1]);
  p.rect(11, 25, 2, 2, R[1]);
  p.px(18, 24 - index, R[1]);
  p.rect(8, 10, 2, 2 + index, "#0f3540");
  p.rect(15, 10, 2, 2 + index, "#0f3540");
  p.speckle(4, 4, 16, 12, "#ffffff", 3, rng);
  p.edges(R[4], { top: true, left: true });
});
defineAnimation("wisp", WISP, 3);

export const SPARK = defineSprite("spark", { w: 7, h: 7 }, (p) => {
  p.hline(0, 3, 7, "#fff2b0");
  p.vline(3, 0, 7, "#fff2b0");
  p.rect(2, 2, 3, 3, "#ffffff");
});

// --- HUD -------------------------------------------------------------------------------

function heart(p: Painter, R: Ramp | null): void {
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
  p.polygon(
    [
      [3, 3],
      [6, 2],
      [8, 4],
      [5, 7],
    ],
    R[4],
  );
  p.px(4, 3, "#ffffff");
  p.hline(5, 12, 8, R[1]);
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

export const HEART = defineSprite("heart", { w: 18, h: 16, origin: [0, 0] }, (p) => heart(p, ramp("#d93a4a", 1)));
export const HEART_EMPTY = defineSprite("heart.empty", { w: 18, h: 16, origin: [0, 0] }, (p) => heart(p, null));

import { defineAnimation, defineSprite, defineVariants, materials, ramp } from "@kiln/engine/art";

const WOOD = ramp("#a4713f");
const STONE = ramp("#6d7383");
const GRASS = ramp("#4f8f45");
const SKIN = ramp("#e6b98e");
const COAT = ramp("#3f7fd0");

export const CRATE = defineSprite("crate", { w: 32, h: 32, origin: [0.5, 0.5] }, (p, { rng }) => {
  materials.planks(p, 0, 0, 32, 32, WOOD, rng);
  p.outline(WOOD[0]);
  p.line(0, 0, 31, 31, WOOD[0]);
  p.line(31, 0, 0, 31, WOOD[0]);
});

export const BALL = defineSprite("ball", { w: 24, h: 24, origin: [0.5, 0.5] }, (p) => {
  p.ball(12, 12, 11, 11, ramp("#e0574a"));
  p.rect(8, 6, 4, 2, "#ffd9d0");
});

export const GROUND = defineSprite("ground", { w: 32, h: 32 }, (p, { rng }) => {
  materials.stone(p, 0, 0, 32, 32, STONE, rng);
  materials.grass(p, 0, 0, 32, 6, GRASS, rng, { blades: 6 });
});

export const WALL = defineSprite("wall", { w: 32, h: 32 }, (p, { rng }) => {
  materials.stone(p, 0, 0, 32, 32, STONE, rng);
});

export const STAR = defineSprite("star", { w: 20, h: 20, origin: [0.5, 0.5] }, (p) => {
  const gold = ramp("#ffc857");
  p.ball(10, 10, 8, 8, gold);
  p.rect(9, 2, 2, 16, gold[3]);
  p.rect(2, 9, 16, 2, gold[3]);
});

function paintHero(p: Parameters<Parameters<typeof defineSprite>[2]>[0], lean: number, squash: number): void {
  const top = 6 + squash;
  p.box(9 + lean, top + 12, 14, 18, COAT);
  p.ball(16 + lean, top + 6, 7, 7, SKIN);
  p.rect(13 + lean, top + 4, 2, 2, "#2a2a30");
  p.rect(18 + lean, top + 4, 2, 2, "#2a2a30");
  p.rect(10 + lean, 30, 5, 8, "#2f2a3a");
  p.rect(17 + lean, 30, 5, 8, "#2f2a3a");
}

export const HERO_STAND = defineSprite("hero.stand", { w: 32, h: 40, origin: [0.5, 0.95] }, (p) => paintHero(p, 0, 0));
export const HERO_STEP = defineVariants("hero.step", 2, { w: 32, h: 40, origin: [0.5, 0.95] }, (p, { index }) => paintHero(p, index ? 1 : -1, index ? 1 : 0));
export const HERO_LEAP = defineSprite("hero.leap", { w: 32, h: 40, origin: [0.5, 0.95] }, (p) => paintHero(p, 0, -2));
// Animations the hero's state machine plays; single-frame ones keep the same API.
export const HERO_IDLE = defineAnimation("hero.idle", ["hero.stand"], 1);
export const HERO_RUN = defineAnimation("hero.run", ["hero.step.0", "hero.step.1"], 8);
export const HERO_JUMP = defineAnimation("hero.jump", ["hero.leap"], 1);

import { defineAutotile, defineSprite, defineVariants, materials, ramp } from "@blackiron-studio/engine/art";

const GRASS = ramp("#4f8f45");
const PATH = ramp("#8f7150");
const BUGS = ["#e0574a", "#4ab0e0", "#e0c04a", "#b060e0"];

export const GRASS_TILES = defineVariants("grass", 3, { w: 32, h: 32 }, (p, { rng }) => {
  materials.grass(p, 0, 0, 32, 32, GRASS, rng, { blades: 10 });
});

export const PATH_TILES = defineAutotile("path", { w: 32, h: 32 }, (p, { rng, north, east, south, west }) => {
  materials.grass(p, 0, 0, 32, 32, PATH, rng, { blades: 3 });
  const fade = (x: number, y: number, w: number, h: number, flip: boolean) => {
    for (let i = 0; i < 6; i++) {
      const t = flip ? i / 6 : 1 - i / 6;
      if (w > h) p.dither(x, y + i, w, 1, PATH[2], GRASS[2], t * 0.9);
      else p.dither(x + i, y, 1, h, PATH[2], GRASS[2], t * 0.9);
    }
  };
  if (!north) fade(0, 0, 32, 6, false);
  if (!south) fade(0, 26, 32, 6, true);
  if (!west) fade(0, 0, 6, 32, false);
  if (!east) fade(26, 0, 6, 32, true);
});

export const BUG = defineVariants("bug", 4, { w: 16, h: 16, origin: [0.5, 0.5] }, (p, { index }) => {
  const body = ramp(BUGS[index]);
  p.ball(8, 9, 5, 4, body);
  p.ball(8, 5, 3, 3, ramp("#2a2a30"));
  p.rect(6, 4, 1, 1, "#ffffff");
  p.rect(9, 4, 1, 1, "#ffffff");
  p.rect(2, 9, 2, 1, body[1]);
  p.rect(12, 9, 2, 1, body[1]);
});

export const SPARK = defineSprite("spark", { w: 4, h: 4, origin: [0.5, 0.5] }, (p) => {
  p.rect(0, 0, 4, 4, "#ffd070");
  p.rect(1, 1, 2, 2, "#fff6d0");
});

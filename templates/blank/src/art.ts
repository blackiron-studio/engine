// Sprites are painted in code. Keep this module free of game logic so `kiln atlas`
// can import it on its own.

import { defineSprite, materials, ramp } from "@kiln/engine/art";

export const HERO = defineSprite("hero", { w: 24, h: 32, origin: [0.5, 0.95] }, (p, { rng }) => {
  const body = ramp("#c0574a");
  const skin = ramp("#e2b48d");
  p.ellipse(12, 30, 8, 2.4, "#00000066");
  p.rect(7, 22, 4, 7, "#2a2233");
  p.rect(13, 22, 4, 7, "#2a2233");
  materials.cloth(p, 6, 12, 12, 11, body, rng, { folds: 2 });
  p.ball(12, 8, 6.5, 6.5, skin);
  p.px(10, 9, "#2a1a1a");
  p.px(14, 9, "#2a1a1a");
  p.outline("#1a1420");
});

export const STAR = defineSprite("star", { w: 12, h: 12 }, (p) => {
  p.hline(0, 6, 12, "#ffe9a3");
  p.vline(6, 0, 12, "#ffe9a3");
  p.rect(4, 4, 4, 4, "#ffffff");
});

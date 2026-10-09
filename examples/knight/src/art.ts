// The knight comes from a generated sheet, imported with `blackiron art import` (see package.json's
// `import` script) into a sprite set: one animation name, frames picked by facing, the attack
// mirrored from its right side, a hit event on the frame the sword lands, a held hurt pose.
// The same knight also runs as a cutout rig: `blackiron art parts` cut seven parts from frame 3 and
// worked out the bone pivots, and the engine's humanoid clips pose them. Everything else here
// is a few painted tiles for the floor.

import { defineRig, defineSprite, defineSpriteSet, defineStyle, defineVariants, materials, ramp } from "@blackiron-studio/engine/art";

// A small palette so the imported frames and the painted floor share one look.
defineStyle({
  palette: [
    "#0e0c14", "#1a2230", "#26303e", "#3a4658", "#5a6a7a", "#8a98a8", "#c8d0dc", "#f4f0ff",
    "#3a5a3a", "#4e7a48", "#6a9a5a", "#98c078", "#2a5a6a", "#3a8a9a", "#5ab8c8", "#8fe0f0",
    "#4a2a1a", "#6a3a22", "#8a5a30", "#b07a40", "#d8a860", "#f0d080", "#ffe08a", "#ffb040",
    "#5a1e1e", "#8a2a2a", "#c04040", "#e87060", "#f0d8c8", "#e6b892", "#c88a68", "#2a1a3a",
  ],
  outline: "#0e0c14",
  rim: { color: "#c8d0dc" },
});

// Frames "knight.0" … "knight.15"; animations "knight.idle", "knight.walk" (four facings),
// "knight.attack" (right, mirrored for left; fires "hit"), "knight.hurt" (held), "knight.victory",
// "knight.pickup", "knight.guard".
defineSpriteSet("knight", "assets/knight.json", { style: "full" });

// Parts "knight-rig.head", ".torso", ".arm.far" (the cape), ".arm.near", ".weapon", ".leg.far",
// ".leg.near" on the humanoid template, with the pivots the cut measured.
defineRig("knight-rig", "assets/knight-rig.json", { style: "full" });

const GRASS = ramp("#4e7a48", 0.9);
export const FLOOR = defineVariants("floor", 3, { w: 32, h: 32 }, (p, { rng, index }) => {
  p.rect(0, 0, 32, 32, GRASS[2]);
  p.speckle(0, 0, 32, 32, GRASS[1], 10 + index * 4, rng);
  for (let i = 0; i < 2 + index; i++) {
    const x = rng.int(2, 29);
    const y = rng.int(4, 29);
    p.vline(x, y - 3, 3, GRASS[3]);
  }
});
export const STONE = defineSprite("stone", { w: 32, h: 32 }, (p, { rng }) => {
  p.rect(0, 0, 32, 32, GRASS[2]);
  materials.stone(p, 4, 8, 24, 20, ramp("#8a98a8", 1), rng, {});
});

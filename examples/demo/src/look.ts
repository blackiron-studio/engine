// Names and sizes the scenes share with art.ts. Kept apart from art.ts so scenes can use them
// without importing (and so registering) the sprites; main.ts loads the art once.

import type { Scene } from "@blackiron-studio/engine/scene";

/** Ground tiles: a 4 x 4 grid of 160-unit tiles cut from one seamless 640-unit texture. */
export const GROUND_TILE = 160;
export const GROUND_GRID = 4;

/** Nine-slice button skins painted in art.ts. */
export const BUTTON_SKINS = {
  primary: { normal: "wh.ui.btn.gold", hover: "wh.ui.btn.gold.hover", pressed: "wh.ui.btn.gold.down", inset: 16 },
  quiet: { normal: "wh.ui.btn", hover: "wh.ui.btn.hover", pressed: "wh.ui.btn.down", inset: 16 },
};

/** Button height on a small screen, in UI units: 44 pt at the 0.8 pt a unit `ui.minPoints` gives. */
export const PHONE_TAP = 56;

/**
 * Speak touch in hints and leave key hints out: the screen is a touch screen (its on-screen
 * controls are always shown), or the last input on any other screen was a finger.
 */
export function touchFirst(scene: Scene): boolean {
  const app = scene.app;
  return scene.screenInfo.touch || app.input.lastDevice === "touch" || app.pointer.type === "touch";
}

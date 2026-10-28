// Names and sizes the scenes share with art.ts. Kept apart from art.ts so scenes can use them
// without importing (and so registering) the sprites; main.ts loads the art once.

/** Ground tiles: a 4 x 4 grid of 160-unit tiles cut from one seamless 640-unit texture. */
export const GROUND_TILE = 160;
export const GROUND_GRID = 4;

/** Nine-slice button skins painted in art.ts. */
export const BUTTON_SKINS = {
  primary: { normal: "wh.ui.btn.gold", hover: "wh.ui.btn.gold.hover", pressed: "wh.ui.btn.gold.down", inset: 16 },
  quiet: { normal: "wh.ui.btn", hover: "wh.ui.btn.hover", pressed: "wh.ui.btn.down", inset: 16 },
};

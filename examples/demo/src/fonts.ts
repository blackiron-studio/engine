// The demo's type: a pixel display face for titles and a clean sans for the HUD. Both
// load from the stylesheet in kiln.json; the fallbacks are the browser's sans-serif.

import type { FontSpec } from "@kiln/engine/render";

export const DISPLAY: FontSpec = { family: "Pixelify Sans", size: 72, weight: 700 };
export const DISPLAY_SMALL: FontSpec = { family: "Pixelify Sans", size: 40, weight: 700 };
export const UI: FontSpec = { family: "Instrument Sans", size: 22, weight: 600 };
export const UI_SMALL: FontSpec = { family: "Instrument Sans", size: 17, weight: 500 };
export const BUTTON: FontSpec = { family: "Instrument Sans", size: 20, weight: 700 };

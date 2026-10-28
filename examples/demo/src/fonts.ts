// The demo's type: an engraved serif display face for titles and a clean sans for the HUD.
// Both load from the stylesheet in blackiron.json; the fallbacks are the browser's sans-serif.

import type { FontSpec } from "@blackiron-studio/engine/render";

export const DISPLAY: FontSpec = { family: "Cinzel", size: 74, weight: 700 };
export const DISPLAY_SMALL: FontSpec = { family: "Cinzel", size: 38, weight: 700 };
export const SCORE: FontSpec = { family: "Cinzel", size: 30, weight: 700 };
export const UI: FontSpec = { family: "Instrument Sans", size: 21, weight: 600 };
export const UI_SMALL: FontSpec = { family: "Instrument Sans", size: 15, weight: 600 };
export const CAPTION: FontSpec = { family: "Instrument Sans", size: 12, weight: 700 };
export const BUTTON: FontSpec = { family: "Instrument Sans", size: 18, weight: 700 };

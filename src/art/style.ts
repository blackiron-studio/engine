// The style bible, enforced at bake time. A game declares one palette, one outline and one
// rim light; every sprite snaps to the palette when the atlas is baked and the sprites that
// ask for it get the outline and the rim. Painters stay free to compose; the bake makes the
// result read as one hand's work.

import { type ColorInput, parseColor } from "./color.ts";
import type { EdgeSides, Painter } from "./painter.ts";

export interface ArtStyle {
  /** Every pixel with enough alpha snaps to the nearest of these. */
  palette?: ColorInput[];
  /** Sprites styled "full" get this one-pixel outline after painting. */
  outline?: ColorInput | null;
  /** Sprites styled "full" get this rim on these sides (top by default). */
  rim?: { color: ColorInput; sides?: EdgeSides } | null;
  /** Pixels fainter than this keep their colour, so glows stay smooth. */
  minAlpha?: number;
}

/**
 * How much of the style a sprite takes: "full" (palette, outline, rim), "palette" (the
 * default: colours only, for tiles and effects), or "none" (imported images, UI chrome).
 */
export type SpriteStyle = "full" | "palette" | "none";

let current: ArtStyle | null = null;
let snapCache = new Map<number, number>();
let cachedFor: ColorInput[] | null = null;

/** Set the game's style; null clears it. Call once next to the sprite definitions. */
export function defineStyle(style: ArtStyle | null): void {
  current = style;
  snapCache = new Map();
  cachedFor = null;
}

export function artStyle(): ArtStyle | null {
  return current;
}

/** Snap every sufficiently opaque pixel to the nearest palette colour. */
export function snapPalette(p: Painter, palette: ColorInput[], minAlpha = 40): void {
  if (palette.length === 0) return;
  if (cachedFor !== palette) {
    snapCache = new Map();
    cachedFor = palette;
  }
  const pal = palette.map((c) => parseColor(c));
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a < minAlpha) continue;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let best = snapCache.get(key);
    if (best === undefined) {
      let bestDist = Number.POSITIVE_INFINITY;
      best = 0;
      for (let k = 0; k < pal.length; k++) {
        const c = pal[k];
        // Weighted distance: the eye is most sensitive to green, least to blue.
        const dr = d[i] - c.r;
        const dg = d[i + 1] - c.g;
        const db = d[i + 2] - c.b;
        const dist = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
        if (dist < bestDist) {
          bestDist = dist;
          best = k;
        }
      }
      snapCache.set(key, best);
    }
    const c = pal[best];
    d[i] = c.r;
    d[i + 1] = c.g;
    d[i + 2] = c.b;
  }
}

/** Apply the current style (or a given one) to a painted sprite. */
export function applyStyle(p: Painter, mode: SpriteStyle = "palette", style: ArtStyle | null = current): void {
  if (!style || mode === "none") return;
  if (mode === "full") {
    // Rim first: the outline would otherwise surround the sprite and no edge would face the open.
    if (style.rim) p.edges(style.rim.color, style.rim.sides ?? { top: true });
    if (style.outline) p.outline(style.outline);
  }
  if (style.palette?.length) snapPalette(p, style.palette, style.minAlpha ?? 40);
}

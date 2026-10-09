// Pixel art as text. Rows of characters with a legend from character to colour let a sprite
// be drawn with intent, pixel by pixel, and recoloured by swapping the legend. The same rows
// under fifteen legends are fifteen characters.

import type { ColorInput } from "./color.ts";
import type { Painter } from "./painter.ts";
import { type SpriteSpec, defineAnimation, defineSprite } from "./sprites.ts";
import type { SpriteStyle } from "./style.ts";

/** Character to colour; null (and any character not listed, plus "." and space) is transparent. */
export type Legend = Record<string, ColorInput | null>;

/** Width and height of a block of rows. */
export function rowsSize(rows: readonly string[]): { w: number; h: number } {
  let w = 0;
  for (const r of rows) if (r.length > w) w = r.length;
  return { w, h: rows.length };
}

/** Paint rows at an offset. */
export function paintRows(p: Painter, rows: readonly string[], legend: Legend, x = 0, y = 0): void {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === "." || ch === " ") continue;
      const color = legend[ch];
      if (color === undefined || color === null) continue;
      p.px(x + c, y + r, color);
    }
  }
}

/** Each row followed by its own reflection, for symmetric sprites drawn as a left half. */
export function mirrorRows(rows: readonly string[]): string[] {
  return rows.map((r) => r + [...r].reverse().join(""));
}

/** Stack blocks of rows vertically, left-aligned, padding shorter rows with transparency. */
export function stackRows(...blocks: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  let w = 0;
  for (const b of blocks) for (const r of b) if (r.length > w) w = r.length;
  for (const b of blocks) for (const r of b) out.push(r.padEnd(w, "."));
  return out;
}

/** Shift rows right by `dx` and down by `dy` inside a canvas of the given size. */
export function placeRows(rows: readonly string[], w: number, h: number, dx: number, dy: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    const src = rows[y - dy];
    const line = src === undefined ? "" : ".".repeat(Math.max(0, dx)) + src;
    out.push(line.padEnd(w, ".").slice(0, w));
  }
  return out;
}

export interface RowSpriteSpec extends Partial<Omit<SpriteSpec, "w" | "h">> {
  /** Canvas size; defaults to the rows' own size. */
  w?: number;
  h?: number;
  /** Anchor the rows inside the canvas: offset in pixels. */
  dx?: number;
  dy?: number;
  style?: SpriteStyle;
  /** Runs before the rows are painted, for shadows or backdrops. */
  before?: (p: Painter) => void;
  /** Runs after the rows are painted, before the style pass. */
  after?: (p: Painter) => void;
}

/** Register a sprite drawn from rows. Returns its name. */
export function defineRowSprite(name: string, rows: readonly string[], legend: Legend, spec: RowSpriteSpec = {}): string {
  const size = rowsSize(rows);
  const w = spec.w ?? size.w;
  const h = spec.h ?? size.h;
  const dx = spec.dx ?? Math.floor((w - size.w) / 2);
  const dy = spec.dy ?? h - size.h;
  return defineSprite(
    name,
    { w, h, origin: spec.origin, seed: spec.seed, style: spec.style ?? "full" },
    (p) => {
      spec.before?.(p);
      paintRows(p, rows, legend, dx, dy);
      spec.after?.(p);
    },
  );
}

/** Register frames drawn from rows as `name.0`, `name.1`, ... and an animation of the same name. */
export function defineRowAnimation(name: string, frames: readonly (readonly string[])[], legend: Legend, spec: RowSpriteSpec & { fps?: number; loop?: boolean } = {}): string[] {
  // One canvas for every frame so they line up.
  let w = spec.w ?? 0;
  let h = spec.h ?? 0;
  if (!spec.w || !spec.h) {
    for (const f of frames) {
      const s = rowsSize(f);
      if (!spec.w && s.w > w) w = s.w;
      if (!spec.h && s.h > h) h = s.h;
    }
  }
  const names = frames.map((rows, i) => defineRowSprite(`${name}.${i}`, rows, legend, { ...spec, w, h, seed: spec.seed !== undefined ? `${spec.seed}:${i}` : `${name}:${i}` }));
  defineAnimation(name, names, spec.fps ?? 8, spec.loop ?? true);
  return names;
}

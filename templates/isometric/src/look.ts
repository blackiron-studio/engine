// Shared presentation for Highground's scenes: the smooth-sampled iso map, terrace shading
// decals and shoreline foam, sea-depth tints, and the HUD kit (glass panels, buttons, fonts).

import { noise, sliceNine } from "@blackiron-studio/engine/art";

const clamp = (v: number) => Math.max(0, Math.min(1, v));
import { Button, IsoTileMap, Node2D, Sprite, type ButtonStyle, type DrawContext } from "@blackiron-studio/engine/scene";
import { PauseScene, type PauseOptions } from "@blackiron-studio/engine/shell";

export const UI_FONT = { family: "Instrument Sans", size: 14, weight: 600 };
/** The deep ink used for outlines, text shadows and the chart's markers. */
export const INK = 0x0b2129;

export const BUTTON: ButtonStyle = {
  skin: { normal: "ui.btn", hover: "ui.btn.hover", pressed: "ui.btn.pressed", inset: 10 },
  text: 0xf3ead2, textShadow: null, border: null, bevel: null,
};
export const GOLD_BUTTON: ButtonStyle = {
  skin: { normal: "ui.btn.gold", hover: "ui.btn.gold.hover", pressed: "ui.btn.gold", inset: 10 },
  text: 0x3a2410, textShadow: null, border: null, bevel: null,
};

/**
 * IsoTileMap draws its kernel batch without linear filtering; the high-resolution tiles want it.
 * Engine gap: `IsoTileMap` has no `smooth` option, so this passes it through `ctx.batch3`.
 */
export class SmoothIsoTileMap extends IsoTileMap {
  override render(ctx: DrawContext): void {
    const own = Object.prototype.hasOwnProperty.call(ctx, "batch3");
    const original = ctx.batch3;
    ctx.batch3 = (id, o = {}) => original.call(ctx, id, { ...o, smooth: true });
    try {
      super.render(ctx);
    } finally {
      if (own) ctx.batch3 = original;
      else delete (ctx as { batch3?: unknown }).batch3;
    }
  }
}

/** A stable value in [0, 1) per cell, for decoration that must not disturb gameplay randomness. */
export function cellHash(c: number, r: number, salt = 0): number {
  let h = Math.imul(c + 374761393, 668265263) ^ Math.imul(r + 1442695041, 2246822519) ^ Math.imul(salt + 3266489917, 374761393);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Multiply two 0xRRGGBB tints. */
export function mulTint(a: number, b: number): number {
  const r = (((a >> 16) & 255) * ((b >> 16) & 255)) / 255;
  const g = (((a >> 8) & 255) * ((b >> 8) & 255)) / 255;
  const bl = ((a & 255) * (b & 255)) / 255;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

export function mixTint(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Sea tints by distance from land: shallows stay bright, open water deepens. */
const SEA_DEPTH = [0xffffff, 0xffffff, 0xeef5f6, 0xe0ecef, 0xd5e5ea, 0xcde0e6];
/** The colour of the open sea beyond the map, matching the deepest tinted water. */
export const SEA_BACKGROUND = 0x2f9aa8;

export interface Decals {
  /** Resting tint per cell (row-major). */
  tints: number[];
  /** Foam sprites with a phase each, and the cell they belong to. */
  foam: { sprite: Sprite; phase: number; key: number }[];
}

/**
 * Ambient occlusion where a terrace rises behind a lower cell, foam where the sea meets land,
 * and the resting tints: sea depth by distance from the shore, a little warmth variation on land.
 */
export function terraceDecals(world: Node2D, map: IsoTileMap, water: number): Decals {
  const cols = map.cols, rows = map.rows, n = cols * rows;
  const dist = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (map.get(i % cols, Math.floor(i / cols)) !== water) { dist[i] = 0; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q], c = i % cols, r = Math.floor(i / cols);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr, j = nr * cols + nc;
      if (!map.inBounds(nc, nr) || dist[j] >= 0) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  const tints: number[] = [];
  const foam: Decals["foam"] = [];
  const half = map.cell / 2, rise = map.tile.rise;
  const decal = (name: string, c: number, r: number, alpha = 1): Sprite => {
    const [x, y] = map.cellCenter(c, r);
    const s = world.add(new Sprite(name, x, y));
    s.z = map.elevationAt(c, r) * rise;
    s.depthBias = -half + 0.1;
    s.alpha = alpha;
    return s;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c, id = map.get(c, r), e = map.elevationAt(c, r);
      if (id === water) tints.push(SEA_DEPTH[Math.min(SEA_DEPTH.length - 1, dist[i] < 0 ? 9 : dist[i])]);
      else {
        // Meadow-scale light: a slow noise across cells, so variation spans several tiles.
        const broad = noise.fbm(c * 0.18, r * 0.18, { seed: 7, octaves: 3 });
        tints.push(mixTint(mixTint(0xfff6e0, 0xe2ecdc, clamp(0.5 - broad * 1.6)), 0xf6f6ec, cellHash(c, r, 1) * 0.35));
      }
      const dw = map.elevationAt(c - 1, r) - e, dn = map.elevationAt(c, r - 1) - e, dc = map.elevationAt(c - 1, r - 1) - e;
      if (dw > 0) decal("ao.w", c, r, Math.min(1, 0.8 + dw * 0.2));
      if (dn > 0) decal("ao.n", c, r, Math.min(1, 0.8 + dn * 0.2));
      if (dc > 0 && dw <= 0 && dn <= 0) decal("ao.c", c, r);
      if (id !== water) continue;
      for (const [dir, nc, nr] of [["w", c - 1, r], ["n", c, r - 1], ["e", c + 1, r], ["s", c, r + 1]] as const) {
        if (!map.inBounds(nc, nr) || map.get(nc, nr) === water) continue;
        foam.push({ sprite: decal(`foam.${dir}`, c, r), phase: cellHash(c, r, dir.charCodeAt(0)) * Math.PI * 2, key: i });
      }
    }
  }
  return { tints, foam };
}

const sliceCache = new WeakMap<object, Map<string, ReturnType<typeof sliceNine>>>();
function slicesOf(ctx: DrawContext, name: string, inset: number): ReturnType<typeof sliceNine> {
  let byAtlas = sliceCache.get(ctx.atlas);
  if (!byAtlas) sliceCache.set(ctx.atlas, (byAtlas = new Map()));
  const key = `${name}:${inset}`;
  let parts = byAtlas.get(key);
  if (!parts) byAtlas.set(key, (parts = sliceNine(ctx.region(name), inset, ctx.atlas.width, ctx.atlas.height)));
  return parts;
}

/** Draw a sprite as nine slices (corners fixed) at x, y, w x h. */
export function drawNine(ctx: DrawContext, name: string, x: number, y: number, w: number, h: number, inset: number, alpha = 1): void {
  // Whole units keep the slices edge to edge; fractional sizes open hairline gaps when snapped.
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  const parts = slicesOf(ctx, name, inset);
  const i = Math.min(parts[0].w, w / 2), j = Math.min(parts[0].h, h / 2);
  const ws = [i, Math.max(0, w - i * 2), i], hs = [j, Math.max(0, h - j * 2), j];
  const xs = [x, x + i, x + i + ws[1]], ys = [y, y + j, y + j + hs[1]];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const part = parts[row * 3 + col];
    if (part.w && part.h && ws[col] && hs[row]) ctx.sprite(part, xs[col], ys[row], { sx: ws[col] / part.w, sy: hs[row] / part.h, alpha });
  }
}

/** The glass HUD panel: the sprite carries 8 units of soft shadow around the w x h body. */
export function drawPanel(ctx: DrawContext, x: number, y: number, w: number, h: number, alpha = 1): void {
  drawNine(ctx, "ui.panel", x - 8, y - 8, w + 16, h + 16, 20, alpha);
}

class GlassPanel extends Node2D {
  constructor(x: number, y: number, public w: number, public h: number) { super(x, y); }
  override render(ctx: DrawContext): void { drawPanel(ctx, 0, 0, this.w, this.h); }
}

export const panel = (x: number, y: number, w: number, h: number): Node2D => new GlassPanel(x, y, w, h);

/** A glass plate sized by a callback, centred on its parent. */
export class SizedPlate extends Node2D {
  constructor(private readonly size: () => { w: number; h: number }) { super(); }
  override render(ctx: DrawContext): void {
    const { w, h } = this.size();
    drawPanel(ctx, -w / 2, -h / 2, w, h);
  }
}

/** The shell's pause menu on Highground's glass plate, with the HUD's buttons. */
export class GlassPause extends PauseScene {
  constructor(options: PauseOptions) {
    super(options);
    this.menu.panel = false;
  }

  override ready(): void {
    super.ready();
    const plate = this.panel.add(new SizedPlate(() => {
      this.column.layout();
      return { w: this.column.w + 72, h: this.column.h + 56 };
    }));
    plate.zIndex = -1;
    this.rows.forEach((row, i) => {
      if (row instanceof Button) {
        Object.assign(row.style, i === 0 ? GOLD_BUTTON : BUTTON);
        row.style.font = { ...UI_FONT, size: 17, weight: 700 };
      }
    });
  }
}

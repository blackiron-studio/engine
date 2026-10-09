// Sprite and animation registry. Games describe art as painter functions; the atlas
// bakes every registered sprite into one texture at boot, or the CLI exports them.

import type { SpriteEdge } from "./atlas.ts";
import { Rng, hashString } from "../core/rng.ts";
import type { Painter } from "./painter.ts";
import { type SpriteStyle, defineStyle } from "./style.ts";
import { resetAnimationSets } from "./spritesets.ts";
import { BLOB_MASKS } from "../core/tilemap.ts";
import { resetRigs } from "./rigs.ts";

export interface SpriteSpec {
  w: number;
  h: number;
  /** Origin as a fraction of the size; default is the centre. */
  origin?: [number, number];
  /** Seed for the painter's rng; defaults to a hash of the name. */
  seed?: number | string;
  /** How much of the game's style bible the bake applies; "palette" by default. */
  style?: SpriteStyle;
  /** A normal map: a painter drawing it, or "bevel" to derive one from the sprite's shape and shading. */
  normal?: PaintFn | "bevel";
  /** What the atlas padding holds at this sprite's edge; "auto" extrudes tiles and clears props. */
  edge?: SpriteEdge;
}

export interface PaintContext {
  rng: Rng;
  name: string;
  w: number;
  h: number;
  /** Variant index when defined through `defineVariants`, else 0. */
  index: number;
}

export type PaintFn = (p: Painter, ctx: PaintContext) => void;

export interface SpriteDef {
  name: string;
  w: number;
  h: number;
  origin: [number, number];
  seed: number;
  index: number;
  paint: PaintFn;
  style: SpriteStyle;
  normal: PaintFn | "bevel" | null;
  edge?: SpriteEdge;
}

export interface AnimationDef {
  name: string;
  frames: string[];
  fps: number;
  /** Optional per-frame duration in seconds, preserving imported timing. */
  durations?: number[];
  loop: boolean;
}

const sprites = new Map<string, SpriteDef>();
const animations = new Map<string, AnimationDef>();

/** Register a sprite. Returns its name so it can be assigned inline. */
export function defineSprite(name: string, spec: SpriteSpec, paint: PaintFn): string {
  if (sprites.has(name)) throw new Error(`Sprite "${name}" is already defined`);
  sprites.set(name, {
    name,
    w: spec.w,
    h: spec.h,
    origin: spec.origin ?? [0.5, 0.5],
    seed: typeof spec.seed === "string" ? hashString(spec.seed) : (spec.seed ?? hashString(name)),
    index: 0,
    paint,
    style: spec.style ?? "palette",
    normal: spec.normal ?? null,
    edge: spec.edge,
  });
  return name;
}

/** Register `count` variants named `name.0`, `name.1`, ... sharing one painter. */
export function defineVariants(name: string, count: number, spec: SpriteSpec, paint: PaintFn): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = `${name}.${i}`;
    defineSprite(n, { ...spec, seed: spec.seed !== undefined ? `${spec.seed}:${i}` : `${name}:${i}` }, paint);
    (sprites.get(n) as SpriteDef).index = i;
    names.push(n);
  }
  return names;
}

export interface AutotileContext extends PaintContext {
  /** Four-bit mask: north 1, east 2, south 4, west 8. */
  mask: number;
  /** Whether the neighbour on that side is the same terrain. */
  north: boolean;
  east: boolean;
  south: boolean;
  west: boolean;
  /** Blob sets: the eight-bit mask and the corners (only set when both edges beside them are). */
  mask8: number;
  northEast: boolean;
  southEast: boolean;
  southWest: boolean;
  northWest: boolean;
}

export type AutotileMode = "edges" | "blob";
const autotileModes = new Map<string, AutotileMode>();

/** How a set's tiles are named: 16 by edge mask, or 47 by blob index. */
export const autotileMode = (set: string): AutotileMode => autotileModes.get(set) ?? "edges";

/** Register the mode of a set whose tiles come from elsewhere (an imported tileset). */
export function setAutotileMode(set: string, mode: AutotileMode): void {
  autotileModes.set(set, mode);
}

/**
 * Register the sixteen variants of an autotile set, `${set}.${mask}`. The painter gets
 * which neighbours match, so it can draw edges only where the terrain ends.
 */
/**
 * Sixteen tiles by edge mask (`${set}.${mask}`), or with `{ mode: "blob" }` the 47 tiles a
 * blob set needs (`${set}.${index}`, indexed like `BLOB_MASKS`), each painted from the
 * neighbours it joins. A TileMap entry `{ autotile: set }` picks them by the cell's neighbours.
 */
export function defineAutotile(set: string, spec: SpriteSpec, paint: (p: Painter, ctx: AutotileContext) => void, opts: { mode?: AutotileMode } = {}): string[] {
  const out: string[] = [];
  const mode = opts.mode ?? "edges";
  autotileModes.set(set, mode);
  if (mode === "blob") {
    BLOB_MASKS.forEach((m8, index) => {
      const name = `${set}.${index}`;
      const mask = (m8 & 1 ? 1 : 0) | (m8 & 4 ? 2 : 0) | (m8 & 16 ? 4 : 0) | (m8 & 64 ? 8 : 0);
      defineSprite(name, { ...spec, seed: spec.seed !== undefined ? `${spec.seed}:${index}` : `${set}:${index}` }, (p, ctx) =>
        paint(p, { ...ctx, mask, north: (m8 & 1) !== 0, east: (m8 & 4) !== 0, south: (m8 & 16) !== 0, west: (m8 & 64) !== 0, mask8: m8, northEast: (m8 & 2) !== 0, southEast: (m8 & 8) !== 0, southWest: (m8 & 32) !== 0, northWest: (m8 & 128) !== 0 }),
      );
      out.push(name);
    });
    return out;
  }
  for (let mask = 0; mask < 16; mask++) {
    const name = `${set}.${mask}`;
    const m8 = (mask & 1 ? 1 : 0) | (mask & 2 ? 4 : 0) | (mask & 4 ? 16 : 0) | (mask & 8 ? 64 : 0);
    defineSprite(name, { ...spec, seed: spec.seed !== undefined ? `${spec.seed}:${mask}` : `${set}:${mask}` }, (p, ctx) =>
      paint(p, { ...ctx, mask, north: (mask & 1) !== 0, east: (mask & 2) !== 0, south: (mask & 4) !== 0, west: (mask & 8) !== 0, mask8: m8, northEast: false, southEast: false, southWest: false, northWest: false }),
    );
    out.push(name);
  }
  return out;
}

export function defineAnimation(name: string, frames: string[], fps = 8, loop = true, durations?: number[]): AnimationDef {
  if (!frames.length || !Number.isFinite(fps) || fps <= 0) throw new RangeError("Animation requires frames and positive finite fps");
  if (durations && (durations.length !== frames.length || durations.some(d => !Number.isFinite(d) || d <= 0))) throw new RangeError("Animation durations must match frames and be positive");
  const def: AnimationDef = { name, frames: [...frames], fps, loop, ...(durations ? { durations: [...durations] } : {}) };
  animations.set(name, def);
  return def;
}

export const getAnimation = (name: string): AnimationDef | undefined => animations.get(name);
export const getSpriteDef = (name: string): SpriteDef | undefined => sprites.get(name);
export const hasSprite = (name: string): boolean => sprites.has(name);
export const spriteDefs = (): SpriteDef[] => [...sprites.values()];
export const animationDefs = (): AnimationDef[] => [...animations.values()];

/** Forget every sprite and animation. Tests use this between cases. */
export function resetSpriteRegistry(): void {
  sprites.clear();
  animations.clear();
  defineStyle(null);
  resetAnimationSets();
  resetRigs();
  autotileModes.clear();
}

/** The rng handed to a painter is derived from the sprite's own seed, so art is reproducible. */
export function paintContextFor(def: SpriteDef): PaintContext {
  return { rng: new Rng(def.seed), name: def.name, w: def.w, h: def.h, index: def.index };
}

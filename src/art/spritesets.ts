// Sprite sets: a sheet plus a manifest that says how its frames animate. Animations carry
// facings (down, up, left, right), a mirror flag so one side stands for both, per-frame
// events (a footstep, the frame a sword lands) and hitboxes. Games name a set and play an
// animation; the sprite picks the frames for the way it faces.

import type { Rect } from "../core/math.ts";
import { type ImageItem, type ImageSpriteSpec, registerAssetLoader } from "./images.ts";
import { defineAnimation } from "./sprites.ts";

export type Facing = "down" | "up" | "left" | "right";
export const FACINGS: readonly Facing[] = ["down", "up", "left", "right"];

export interface SetAnimationSpec {
  fps?: number;
  loop?: boolean;
  /** Frames when there is no facing, or the fallback. */
  frames?: number[];
  facings?: Partial<Record<Facing, number[]>>;
  /** A missing left is the right flipped, and the other way round. */
  mirror?: boolean;
  /** Frame index (as a string key) to event name. */
  events?: Record<string, string>;
  /** Seconds a single-frame pose holds before it counts as finished. */
  hold?: number;
}

export interface SpriteSetManifest {
  frames: { filename?: string; frame: Rect; duration?: number }[];
  meta: {
    image: string;
    size?: { w: number; h: number };
    /** Source pixels per game pixel the sheet was imported at. */
    pitch?: number;
    /** Height of the character in game pixels, for the style check. */
    height?: number;
    /** Origin as a fraction of the frame, feet at [0.5, 1]. */
    anchor?: [number, number];
    animations?: Record<string, SetAnimationSpec>;
    /** Frame index to a rectangle in frame pixels. */
    hitboxes?: Record<string, Rect>;
    /** Aseprite tags, still honoured. */
    frameTags?: { name: string; from: number; to: number; direction?: string }[];
  };
}

/** An animation resolved to sprite names, one list per facing that exists. */
export interface AnimationSetDef {
  name: string;
  fps: number;
  loop: boolean;
  mirror: boolean;
  frames: string[];
  facings: Partial<Record<Facing, string[]>>;
  /** Sprite name to event name. */
  events: Map<string, string>;
  hold: number;
}

const sets = new Map<string, AnimationSetDef>();
const hitboxes = new Map<string, Rect>();

export function defineAnimationSet(def: AnimationSetDef): AnimationSetDef {
  sets.set(def.name, def);
  // Plain animations too, so `play("knight.walk.left")` and older code keep working.
  defineAnimation(def.name, def.frames, def.fps, def.loop);
  for (const f of FACINGS) {
    const frames = def.facings[f];
    if (frames && frames.length) defineAnimation(`${def.name}.${f}`, frames, def.fps, def.loop);
  }
  return def;
}

export const getAnimationSet = (name: string): AnimationSetDef | undefined => sets.get(name);

/** The hitbox of a frame, in frame pixels from its top-left. */
export const hitboxOf = (sprite: string): Rect | undefined => hitboxes.get(sprite);

export function defineHitbox(sprite: string, rect: Rect): void {
  hitboxes.set(sprite, rect);
}

export function resetAnimationSets(): void {
  sets.clear();
  hitboxes.clear();
}

/** The frames a set animation resolves to for a facing, with whether they need mirroring. */
export function framesFor(def: AnimationSetDef, facing: Facing): { frames: string[]; flip: boolean } {
  const own = def.facings[facing];
  if (own && own.length) return { frames: own, flip: false };
  if (def.mirror) {
    const opposite: Facing | null = facing === "left" ? "right" : facing === "right" ? "left" : null;
    const other = opposite ? def.facings[opposite] : undefined;
    if (other && other.length) return { frames: other, flip: true };
  }
  return { frames: def.frames, flip: false };
}

/** Which of four facings a movement vector points to; the previous one when it is still. */
export function facingFrom(x: number, y: number, current: Facing = "down"): Facing {
  if (Math.abs(x) < 0.05 && Math.abs(y) < 0.05) return current;
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? "left" : "right";
  return y < 0 ? "up" : "down";
}

/**
 * Register a sprite set from its manifest. Frames become `${prefix}.${filename}` (the index
 * when frames have no names), animations `${prefix}.${animation}`. Loads when the App starts,
 * like every imported image.
 */
export function defineSpriteSet(prefix: string, jsonUrl: string, spec: ImageSpriteSpec = {}): void {
  registerAssetLoader(async (platform) => {
    const json = await platform.loadJson<SpriteSetManifest>(jsonUrl);
    const base = jsonUrl.slice(0, jsonUrl.lastIndexOf("/") + 1);
    const imageUrl = json.meta.image.startsWith("http") || json.meta.image.startsWith("/") ? json.meta.image : base + json.meta.image;
    const img = await platform.loadImage(imageUrl);
    const origin = spec.origin ?? json.meta.anchor ?? [0.5, 0.5];
    const names = json.frames.map((f, i) => `${prefix}.${(f.filename ?? String(i)).replace(/\.(png|jpe?g|gif|webp|ase|aseprite)$/i, "")}`);
    const items: ImageItem[] = json.frames.map((f, i) => ({
      name: names[i],
      w: f.frame.w,
      h: f.frame.h,
      data: crop(img, f.frame),
      origin,
      style: spec.style,
      normal: spec.normal === "bevel" ? "bevel" : undefined,
    }));
    for (const [index, rect] of Object.entries(json.meta.hitboxes ?? {})) {
      const n = names[Number(index)];
      if (n) defineHitbox(n, rect);
    }
    const byIndex = (list: number[] | undefined) => (list ?? []).map((i) => names[i]).filter((n): n is string => !!n);
    for (const [anim, a] of Object.entries(json.meta.animations ?? {})) {
      const facings: Partial<Record<Facing, string[]>> = {};
      for (const f of FACINGS) if (a.facings?.[f]) facings[f] = byIndex(a.facings[f]);
      const first = FACINGS.map((f) => facings[f]).find((x) => x && x.length);
      const frames = a.frames ? byIndex(a.frames) : (first ?? []);
      const events = new Map<string, string>();
      for (const [index, ev] of Object.entries(a.events ?? {})) {
        const n = names[Number(index)];
        if (n) events.set(n, ev);
      }
      defineAnimationSet({ name: `${prefix}.${anim}`, fps: a.fps ?? 8, loop: a.loop ?? !(a.hold && frames.length === 1), mirror: a.mirror ?? false, frames, facings, events, hold: a.hold ?? 0 });
    }
    // Aseprite tags still make plain animations.
    for (const tag of json.meta.frameTags ?? []) {
      const frames = names.slice(tag.from, tag.to + 1);
      const ms = json.frames.slice(tag.from, tag.to + 1).reduce((s, f) => s + (f.duration || 100), 0) / Math.max(1, frames.length);
      if (!sets.has(`${prefix}.${tag.name}`)) defineAnimation(`${prefix}.${tag.name}`, frames, 1000 / Math.max(1, ms), tag.direction !== "once");
    }
    return items;
  });
}

function crop(img: { width: number; height: number; data: Uint8ClampedArray }, r: Rect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let row = 0; row < r.h; row++) {
    const src = ((r.y + row) * img.width + r.x) * 4;
    out.set(img.data.subarray(src, src + r.w * 4), row * r.w * 4);
  }
  return out;
}

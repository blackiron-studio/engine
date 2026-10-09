// Imported art: PNG images and Aseprite sprite sheets, registered like painted sprites
// and packed into the same atlas at boot. Loading goes through the platform, so a
// native shell can serve files however it likes.

import type { SpriteEdge } from "./atlas.ts";
import type { Platform } from "../platform/types.ts";
import { defineAnimation } from "./sprites.ts";
import type { SpriteStyle } from "./style.ts";

export interface ImageSpriteSpec {
  origin?: [number, number];
  /** Sample with linear filtering when drawn; for high-resolution art. */
  smooth?: boolean;
  /** How much of the game's style bible the bake applies; "palette" by default, "none" for photos and UI. */
  style?: SpriteStyle;
  /** A normal map: the URL of an image laid out like this one, or "bevel" to derive one from the pixels. */
  normal?: string;
  /** Edge mode for every frame; "auto" by default. */
  edge?: SpriteEdge;
}

export interface ImageItem {
  name: string;
  w: number;
  h: number;
  data: Uint8ClampedArray;
  origin: [number, number];
  style?: SpriteStyle;
  /** Normal-map pixels the size of `data`, or "bevel" for the bake to derive them. */
  normal?: Uint8ClampedArray | "bevel";
  /** What the atlas padding holds at the edge; "auto" extrudes tiles and clears props. */
  edge?: SpriteEdge;
}

type Raw = { width: number; height: number; data: Uint8ClampedArray };

/** The normal source for an image item: bevel, pixels cropped from a normal image, or nothing. */
function normalFor(spec: ImageSpriteSpec, nimg: Raw | null, x: number, y: number, w: number, h: number): Uint8ClampedArray | "bevel" | undefined {
  if (spec.normal === "bevel") return "bevel";
  if (nimg) return crop(nimg, x, y, w, h);
  return undefined;
}

const resolveUrl = (url: string, base: string): string => (url.startsWith("http") || url.startsWith("/") ? url : base + url);

/** Load the normal image a spec names, when it names one. */
async function loadNormal(platform: Platform, spec: ImageSpriteSpec, base: string): Promise<Raw | null> {
  if (!spec.normal || spec.normal === "bevel") return null;
  return platform.loadImage(resolveUrl(spec.normal, base));
}

interface AsepriteFrame {
  frame: { x: number; y: number; w: number; h: number };
  duration: number;
  rotated?: boolean;
  trimmed?: boolean;
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
  filename?: string;
}

interface AsepriteJson {
  frames: Record<string, AsepriteFrame> | AsepriteFrame[];
  meta: { image: string; frameTags?: { name: string; from: number; to: number; direction?: string }[] };
}

export type Loader = (platform: Platform) => Promise<ImageItem[]>;

const pending: Loader[] = [];
const loaded: ImageItem[] = [];
const names = new Set<string>();

function crop(img: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number, w: number, h: number): Uint8ClampedArray {
  if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > img.width || y + h > img.height) throw new RangeError("Image crop outside source bounds");
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * img.width + x) * 4;
    out.set(img.data.subarray(src, src + w * 4), row * w * 4);
  }
  return out;
}

/** A whole image file as one sprite. Loaded when the App starts. */
export function defineImageSprite(name: string, url: string, spec: ImageSpriteSpec = {}): string {
  if (names.has(name)) throw new Error(`Image sprite "${name}" is already defined`);
  names.add(name);
  pending.push(async (platform) => {
    const img = await platform.loadImage(url);
    const nimg = await loadNormal(platform, spec, url.slice(0, url.lastIndexOf("/") + 1));
    return [{ name, w: img.width, h: img.height, data: img.data, origin: spec.origin ?? [0.5, 0.5], style: spec.style, normal: normalFor(spec, nimg, 0, 0, img.width, img.height) }];
  });
  return name;
}

/** A regular grid of frames in one image, named `${prefix}.${index}`. Returns the frame names. */
export function defineImageGrid(prefix: string, url: string, frameW: number, frameH: number, count: number, spec: ImageSpriteSpec = {}): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(`${prefix}.${i}`);
  pending.push(async (platform) => {
    const img = await platform.loadImage(url);
    const nimg = await loadNormal(platform, spec, url.slice(0, url.lastIndexOf("/") + 1));
    const cols = Math.max(1, Math.floor(img.width / frameW));
    const items: ImageItem[] = [];
    for (let i = 0; i < count; i++) {
      const x = (i % cols) * frameW;
      const y = Math.floor(i / cols) * frameH;
      items.push({ name: out[i], w: frameW, h: frameH, data: crop(img, x, y, frameW, frameH), origin: spec.origin ?? [0.5, 0.5], style: spec.style, normal: normalFor(spec, nimg, x, y, frameW, frameH) });
    }
    return items;
  });
  return out;
}

/**
 * An Aseprite JSON export (hash or array frames). Frames become sprites named
 * `${prefix}.${frameName}` and frame tags become animations named `${prefix}.${tag}`.
 */
export function defineSheet(prefix: string, jsonUrl: string, spec: ImageSpriteSpec = {}): void {
  pending.push(async (platform) => {
    const json = await platform.loadJson<AsepriteJson>(jsonUrl);
    const base = jsonUrl.slice(0, jsonUrl.lastIndexOf("/") + 1);
    const img = await platform.loadImage(resolveUrl(json.meta.image, base));
    const nimg = await loadNormal(platform, spec, base);
    const list: { name: string; f: AsepriteFrame }[] = Array.isArray(json.frames)
      ? json.frames.map((f, i) => ({ name: (f.filename ?? String(i)).replace(/\.[a-z]+$/i, ""), f }))
      : Object.entries(json.frames).map(([name, f]) => ({ name: name.replace(/\.[a-z]+$/i, ""), f }));
    const items: ImageItem[] = list.map(({ name, f }) => ({
      name: `${prefix}.${name}`,
      w: f.sourceSize?.w ?? (f.rotated ? f.frame.h : f.frame.w),
      h: f.sourceSize?.h ?? (f.rotated ? f.frame.w : f.frame.h),
      data: restoreFrame(img, f),
      origin: spec.origin ?? [0.5, 0.5],
      style: spec.style, edge: spec.edge,
      normal: spec.normal === "bevel" ? "bevel" : nimg ? restoreFrame(nimg, f) : undefined,
    }));
    for (const tag of json.meta.frameTags ?? []) {
      if (!Number.isInteger(tag.from) || !Number.isInteger(tag.to) || tag.from < 0 || tag.to < tag.from || tag.to >= list.length) throw new RangeError(`Invalid Aseprite tag: ${tag.name}`);
      let sequence = list.slice(tag.from, tag.to + 1);
      const direction = tag.direction ?? "forward";
      if (!["forward", "reverse", "pingpong", "pingpong_reverse", "once"].includes(direction)) throw new Error(`Unsupported Aseprite direction: ${direction}`);
      if (direction === "reverse" || direction === "pingpong_reverse") sequence.reverse();
      if (direction.startsWith("pingpong") && sequence.length > 2) sequence = [...sequence, ...sequence.slice(1, -1).reverse()];
      const durations = sequence.map(e => (e.f.duration ?? 100) / 1000);
      defineAnimation(`${prefix}.${tag.name}`, sequence.map(e => `${prefix}.${e.name}`), 10, direction !== "once", durations);
    }
    return items;
  });
}

/** Queue a loader that runs when the App starts; sprite sets and rigs use this. */
export function registerAssetLoader(loader: Loader): void {
  pending.push(loader);
}

export const hasPendingAssets = (): boolean => pending.length > 0;

/** Load everything registered so far. The App awaits this before baking the atlas. */
let resolving: Promise<ImageItem[]> | null = null;
export function resolveAssets(platform: Platform): Promise<ImageItem[]> {
  if (resolving) return resolving;
  resolving = (async () => {
    while (pending.length) {
      // Remove only a successful loader. A failed batch remains retryable.
      const loader = pending[0];
      const items = await loader(platform);
      loaded.push(...items);
      pending.shift();
    }
    return loaded;
  })().finally(() => { resolving = null; });
  return resolving;
}

/** Items loaded so far, for a second bake. */
export const loadedImages = (): ImageItem[] => loaded;

export function resetImageRegistry(): void {
  pending.length = 0;
  loaded.length = 0;
  names.clear();
}

/** Expand trimmed frames to the authored canvas and undo clockwise atlas rotation. */
function restoreFrame(img: Raw, f: AsepriteFrame): Uint8ClampedArray {
  const packed = crop(img, f.frame.x, f.frame.y, f.frame.w, f.frame.h);
  const w = f.rotated ? f.frame.h : f.frame.w, h = f.rotated ? f.frame.w : f.frame.h;
  const source = f.sourceSize ?? { w, h }, rect = f.spriteSourceSize ?? { x: 0, y: 0, w, h };
  if (![source.w, source.h, rect.x, rect.y].every(Number.isInteger) || source.w <= 0 || source.h <= 0 || source.w * source.h > 16777216 || rect.x < 0 || rect.y < 0 || rect.w !== w || rect.h !== h || rect.x + w > source.w || rect.y + h > source.h) throw new RangeError("Invalid Aseprite source rectangle");
  const out = new Uint8ClampedArray(source.w * source.h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = f.rotated ? h - 1 - y : x, sy = f.rotated ? x : y;
    const at = (sy * f.frame.w + sx) * 4;
    out.set(packed.subarray(at, at + 4), ((rect.y + y) * source.w + rect.x + x) * 4);
  }
  return out;
}

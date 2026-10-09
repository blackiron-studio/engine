// Bakes every registered sprite, the font, and a few engine built-ins into one RGBA
// texture with shelf packing. Runs anywhere: browser, tests, CLI.

import { Painter } from "./painter.ts";
import { FONT_CHARS, FONT_H, FONT_W, glyphKey, glyphRows } from "./font.ts";
import { type SpriteDef, paintContextFor, spriteDefs } from "./sprites.ts";
import { type SpriteStyle, applyStyle } from "./style.ts";

export interface Region {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Origin offset in pixels from the top-left of the region. */
  ox: number;
  oy: number;
}

export interface BakeOptions {
  /** Explicit packing width cap; omitted means automatic growth. */
  maxWidth?: number;
  /** Maximum texture width and height supported by the target. Default 4096. */
  maxTextureSize?: number;
  padding?: number;
  /** Explicit sprite list; defaults to the registry. */
  defs?: SpriteDef[];
  /** Include the built-in font glyphs. Default true. */
  font?: boolean;
  /** Include `__white`, `__blob`, `__missing`. Default true. */
  builtins?: boolean;
  /** Imported images to pack next to the painted sprites. */
  images?: { name: string; w: number; h: number; data: Uint8ClampedArray; origin: [number, number]; style?: SpriteStyle; normal?: Uint8ClampedArray | "bevel"; edge?: SpriteEdge }[];
}

/**
 * What the padding around a sprite holds. "extrude" repeats the sprite's edge texels one
 * texel outward, so a tile drawn at any scale never blends with the clear gap at its edge (the
 * seams between tiles). "clear" keeps the gap transparent, which an outline material needs to
 * find a sprite's silhouette. "auto", the default, extrudes sprites whose whole border is
 * opaque (tiles, panels) and clears the rest (characters, props).
 */
export type SpriteEdge = "auto" | "extrude" | "clear";

/** Whether every border texel of a painter is fully opaque: a tile, not a prop. */
export function opaqueEdged(p: Painter): boolean {
  const { width: w, height: h, data: d } = p;
  if (w < 2 || h < 2) return false;
  for (let x = 0; x < w; x++) if (d[x * 4 + 3] !== 255 || d[((h - 1) * w + x) * 4 + 3] !== 255) return false;
  for (let y = 0; y < h; y++) if (d[y * w * 4 + 3] !== 255 || d[(y * w + w - 1) * 4 + 3] !== 255) return false;
  return true;
}

/** Repeat the edge texels of the `w` by `h` block at (x, y) one texel outward, corners included. */
function extrudeEdges(dst: Uint8ClampedArray, W: number, x: number, y: number, w: number, h: number): void {
  const at = (xx: number, yy: number) => (yy * W + xx) * 4;
  dst.copyWithin(at(x, y - 1), at(x, y), at(x + w, y));
  dst.copyWithin(at(x, y + h), at(x, y + h - 1), at(x + w, y + h - 1));
  for (let yy = y - 1; yy <= y + h; yy++) {
    dst.copyWithin(at(x - 1, yy), at(x, yy), at(x + 1, yy));
    dst.copyWithin(at(x + w, yy), at(x + w - 1, yy), at(x + w, yy));
  }
}

export class Atlas {
  private regions = new Map<string, Region>();
  private warned = new Set<string>();
  readonly missing: Region;
  /** Texture coordinate of a guaranteed-white texel, used for untextured rects. */
  readonly whiteU: number;
  readonly whiteV: number;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly data: Uint8ClampedArray,
    regions: Region[],
    /** Normal maps laid out like `data`; transparent where a sprite has none. Null when no sprite has one. */
    readonly normals: Uint8ClampedArray | null = null,
  ) {
    for (const r of regions) this.regions.set(r.name, r);
    this.missing = this.regions.get("__missing") ?? regions[0];
    const white = this.regions.get("__white");
    this.whiteU = white ? (white.x + white.w / 2) / width : 0;
    this.whiteV = white ? (white.y + white.h / 2) / height : 0;
  }

  has(name: string): boolean {
    return this.regions.has(name);
  }

  /** Look up a region by sprite name. Unknown names return a magenta placeholder once-warned. */
  region(name: string): Region {
    const r = this.regions.get(name);
    if (r) return r;
    if (!this.warned.has(name)) {
      this.warned.add(name);
      console.warn(`[kiln] sprite "${name}" is not in the atlas`);
    }
    return this.missing;
  }

  glyph(ch: string): Region {
    return this.regions.get(`__g:${glyphKey(ch)}`) ?? this.missing;
  }

  names(): string[] {
    return [...this.regions.keys()];
  }

  all(): Region[] {
    return [...this.regions.values()];
  }

  /** Rebuild an atlas from a manifest plus raw RGBA, for prebaked art shipped with a native build. */
  static fromManifest(manifest: { width: number; height: number; sprites: Record<string, { x: number; y: number; w: number; h: number; ox: number; oy: number }>; normals?: boolean }, data: Uint8ClampedArray, normals: Uint8ClampedArray | null = null): Atlas {
    const regions: Region[] = [];
    for (const [name, s] of Object.entries(manifest.sprites)) {
      regions.push({ name, x: s.x, y: s.y, w: s.w, h: s.h, u0: s.x / manifest.width, v0: s.y / manifest.height, u1: (s.x + s.w) / manifest.width, v1: (s.y + s.h) / manifest.height, ox: s.ox, oy: s.oy });
    }
    return new Atlas(manifest.width, manifest.height, data, regions, normals);
  }

  /** Copy one region back out as a painter; used by the CLI's per-sprite export. */
  extract(name: string): Painter {
    const r = this.region(name);
    const p = new Painter(r.w, r.h);
    for (let y = 0; y < r.h; y++) {
      const src = ((r.y + y) * this.width + r.x) * 4;
      p.data.set(this.data.subarray(src, src + r.w * 4), y * r.w * 4);
    }
    return p;
  }
}

interface Item {
  name: string;
  painter: Painter;
  ox: number;
  oy: number;
  /** The sprite's normal map, when it has one. */
  normal?: Painter | null;
  edge?: SpriteEdge;
}

/** Run one sprite's painter and return the finished surface. */
export function paintSprite(def: SpriteDef): Painter {
  const p = new Painter(def.w, def.h);
  def.paint(p, paintContextFor(def));
  applyStyle(p, def.style);
  return p;
}

/**
 * A normal map derived from a sprite's shape and shading: the silhouette is a plateau whose
 * edges slope down, and brighter pixels sit a little higher, so lights catch outlines and folds.
 * Encoded the usual way, +y up in green, with alpha 255 where the sprite has pixels.
 */
export function bevelNormals(p: Painter, strength = 1): Painter {
  const w = p.width;
  const h = p.height;
  const height = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = p.data[i * 4 + 3];
    if (a < 8) continue;
    const lum = (p.data[i * 4] * 0.299 + p.data[i * 4 + 1] * 0.587 + p.data[i * 4 + 2] * 0.114) / 255;
    height[i] = 0.6 + 0.4 * lum;
  }
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : height[y * w + x]);
  const out = new Painter(w, h);
  const k = 1.5 * strength;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (p.data[i * 4 + 3] < 8) continue;
      const dx = (at(x + 1, y) - at(x - 1, y)) * k;
      const dy = (at(x, y + 1) - at(x, y - 1)) * k;
      const len = Math.hypot(dx, dy, 1);
      const nx = -dx / len;
      const ny = dy / len;
      const nz = 1 / len;
      out.data[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      out.data[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out.data[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out.data[i * 4 + 3] = 255;
    }
  }
  return out;
}

/** The normal painter for a sprite definition, if it declares one. */
function paintNormal(def: SpriteDef, painted: Painter): Painter | null {
  if (!def.normal) return null;
  if (def.normal === "bevel") return bevelNormals(painted);
  const p = new Painter(def.w, def.h);
  def.normal(p, paintContextFor(def));
  return p;
}

function builtinItems(): Item[] {
  const white = new Painter(4, 4);
  white.clear("#ffffff");
  const missing = new Painter(8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) missing.px(x, y, ((x >> 2) + (y >> 2)) & 1 ? "#ff00ff" : "#1a001a");
  const blob = new Painter(64, 64);
  blob.glow(32, 32, 32, "#ffffff", 2);
  const ring = new Painter(32, 32);
  ring.ring(16, 16, 14, "#ffffff");
  ring.ring(16, 16, 13, "#ffffff");
  // A soft wedge pointing +x, for cone lights: glow falloff times an angular falloff.
  const cone = new Painter(64, 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const dx = x + 0.5 - 8;
      const dy = y + 0.5 - 32;
      const d = Math.hypot(dx, dy) / 56;
      if (d >= 1 || dx <= 0) continue;
      const ang = Math.abs(Math.atan2(dy, dx)) / (Math.PI / 4);
      if (ang >= 1) continue;
      const a = (1 - d) ** 2 * (1 - ang) ** 1.5;
      cone.px(x, y, `#ffffff${Math.round(a * 255).toString(16).padStart(2, "0")}`);
    }
  }
  return [
    { name: "__white", painter: white, ox: 2, oy: 2 },
    { name: "__missing", painter: missing, ox: 4, oy: 4 },
    { name: "__blob", painter: blob, ox: 32, oy: 32 },
    { name: "__ring", painter: ring, ox: 16, oy: 16 },
    { name: "__cone", painter: cone, ox: 8, oy: 32 },
  ];
}

function fontItems(): Item[] {
  return FONT_CHARS.map((ch) => {
    const p = new Painter(FONT_W, FONT_H);
    const rows = glyphRows(ch);
    for (let y = 0; y < FONT_H; y++) for (let x = 0; x < FONT_W; x++) if (rows[y][x] === "#") p.px(x, y, "#ffffff");
    return { name: `__g:${ch}`, painter: p, ox: 0, oy: 0 };
  });
}

export function bakeAtlas(opts: BakeOptions = {}): Atlas {
  const limit = opts.maxTextureSize ?? 4096;
  if (!Number.isInteger(limit) || limit < 4) throw new RangeError("Atlas maxTextureSize must be an integer of at least 4");
  if (opts.maxWidth !== undefined && (!Number.isInteger(opts.maxWidth) || opts.maxWidth < 4 || opts.maxWidth > limit)) {
    throw new RangeError(`Atlas maxWidth must be between 4 and maxTextureSize (${limit})`);
  }
  let maxWidth = opts.maxWidth ?? Math.min(1024, limit);
  // Two texels of padding, so an outline material can sample one texel outside a sprite.
  const pad = opts.padding ?? 2;
  if (!Number.isInteger(pad) || pad < 0) throw new RangeError("Atlas padding must be a nonnegative integer");
  const items: Item[] = [];
  if (opts.builtins ?? true) items.push(...builtinItems());
  if (opts.font ?? true) items.push(...fontItems());
  for (const def of opts.defs ?? spriteDefs()) {
    const painter = paintSprite(def);
    items.push({
      name: def.name,
      painter,
      ox: Math.round(def.w * def.origin[0]),
      oy: Math.round(def.h * def.origin[1]),
      normal: paintNormal(def, painter),
      edge: def.edge,
    });
  }
  for (const img of opts.images ?? []) {
    const painter = new Painter(img.w, img.h, new Uint8ClampedArray(img.data));
    applyStyle(painter, img.style ?? "palette");
    const normal = img.normal === "bevel" ? bevelNormals(painter) : img.normal ? new Painter(img.w, img.h, new Uint8ClampedArray(img.normal)) : null;
    items.push({ name: img.name, painter, ox: Math.round(img.w * img.origin[0]), oy: Math.round(img.h * img.origin[1]), normal, edge: img.edge });
  }
  // Pack the painted items once, growing from actual item dimensions and packing height.
  // Both dimensions are bounded before allocating the output texture.
  const order = items.map((it, i) => i).sort((a, b) => {
    const dh = items[b].painter.height - items[a].painter.height;
    return dh !== 0 ? dh : items[b].painter.width - items[a].painter.width;
  });
  for (const it of items) {
    const w = it.painter.width + pad * 2;
    const h = it.painter.height + pad * 2;
    if (w > limit || h > limit) throw new RangeError(`Sprite "${it.name}" (${w}×${h} with padding) exceeds maximum texture size ${limit}`);
    if (opts.maxWidth === undefined) while (maxWidth < w) maxWidth = Math.min(limit, maxWidth * 2);
    else if (w > maxWidth) throw new RangeError(`Sprite "${it.name}" is wider than the atlas (${w} > ${maxWidth})`);
  }
  const placed: { item: Item; x: number; y: number }[] = [];
  let W = 4, H = 4;
  for (;;) {
    placed.length = 0;
    let cx = pad, cy = pad, shelf = 0, width = 0;
    for (const i of order) {
      const it = items[i], w = it.painter.width, h = it.painter.height;
      if (cx + w + pad > maxWidth) { cx = pad; cy += shelf + pad; shelf = 0; }
      placed.push({ item: it, x: cx, y: cy });
      cx += w + pad;
      shelf = Math.max(shelf, h);
      width = Math.max(width, cx);
    }
    W = Math.max(4, Math.min(maxWidth, Math.ceil(width / 4) * 4));
    H = Math.max(4, Math.ceil((cy + shelf + pad) / 4) * 4);
    if (H <= limit) break;
    if (opts.maxWidth !== undefined || maxWidth >= limit) {
      throw new RangeError(`Atlas packing needs ${W}×${H}, exceeding maximum texture size ${limit}; split the asset set into loading groups`);
    }
    maxWidth = Math.min(limit, maxWidth * 2);
  }

  const data = new Uint8ClampedArray(W * H * 4);
  const anyNormals = placed.some((pl) => pl.item.normal);
  const normals = anyNormals ? new Uint8ClampedArray(W * H * 4) : null;
  const regions: Region[] = [];
  for (const { item, x, y } of placed) {
    const p = item.painter;
    for (let row = 0; row < p.height; row++) {
      data.set(p.data.subarray(row * p.width * 4, (row + 1) * p.width * 4), ((y + row) * W + x) * 4);
      if (normals && item.normal) normals.set(item.normal.data.subarray(row * p.width * 4, (row + 1) * p.width * 4), ((y + row) * W + x) * 4);
    }
    const edge = item.edge ?? "auto";
    if (pad >= 1 && (edge === "extrude" || (edge === "auto" && opaqueEdged(p)))) {
      extrudeEdges(data, W, x, y, p.width, p.height);
      if (normals && item.normal) extrudeEdges(normals, W, x, y, p.width, p.height);
    }
    regions.push({
      name: item.name,
      x,
      y,
      w: p.width,
      h: p.height,
      u0: x / W,
      v0: y / H,
      u1: (x + p.width) / W,
      v1: (y + p.height) / H,
      ox: item.ox,
      oy: item.oy,
    });
  }
  return new Atlas(W, H, data, regions, normals);
}

/** Serialisable description of an atlas layout, written next to the PNG by the CLI. */
export function atlasManifest(atlas: Atlas): { width: number; height: number; sprites: Record<string, Omit<Region, "name" | "u0" | "v0" | "u1" | "v1">>; normals: boolean } {
  const sprites: Record<string, Omit<Region, "name" | "u0" | "v0" | "u1" | "v1">> = {};
  for (const r of atlas.all()) sprites[r.name] = { x: r.x, y: r.y, w: r.w, h: r.h, ox: r.ox, oy: r.oy };
  return { width: atlas.width, height: atlas.height, sprites, normals: !!atlas.normals };
}

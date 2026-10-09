// Glyph cache: renders characters of any web font with the browser's text engine at
// device resolution into paged canvases, which the WebGL2 backend uploads as a texture.
// Text then draws as batched quads like any sprite.

import type { FontSpec, TextSize } from "./types.ts";

export interface Glyph {
  /** Texture-array layer. Pages remain valid for all queued draws. */
  page: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Size in device pixels. */
  w: number;
  h: number;
  /** Pen-relative offsets in device pixels: left bearing and distance from baseline to the top. */
  left: number;
  top: number;
  advance: number;
}

interface FontInfo {
  css: string;
  ascent: number;
  descent: number;
}

export class GlyphCache {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly pages: HTMLCanvasElement[] = [];
  readonly dirtyPages = new Set<number>();
  private glyphs = new Map<string, Glyph>();
  private fonts = new Map<string, FontInfo>();
  private shelfX = 1;
  private shelfY = 1;
  private shelfH = 0;
  /** Bumped whenever the canvas changed and needs re-uploading. */
  version = 0;
  private uploaded = -1;
  /** Set when another page was allocated; existing glyphs are never invalidated. */
  overflowed = false;

  constructor(
    public pixelRatio = 1,
    readonly size = 1024,
    readonly maxPages = 16,
  ) {
    if (!Number.isInteger(size) || size < 8 || !Number.isInteger(maxPages) || maxPages < 1) throw new RangeError("Invalid glyph cache capacity");
    this.canvas = document.createElement("canvas");
    this.canvas.width = size;
    this.canvas.height = size;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: false }) as CanvasRenderingContext2D;
    this.pages.push(this.canvas);
    this.reset();
  }

  /** Change the device pixel ratio; glyphs are re-rendered at the new size. */
  setPixelRatio(r: number): void {
    if (Math.abs(r - this.pixelRatio) < 1e-3) return;
    this.pixelRatio = r;
    this.reset();
  }

  private reset(): void {
    this.pages.length = 1;
    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
    this.dirtyPages.clear();
    this.dirtyPages.add(0);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.size, this.size);
    this.glyphs.clear();
    this.fonts.clear();
    this.shelfX = 1;
    this.shelfY = 1;
    this.shelfH = 0;
    this.version++;
  }

  get dirty(): boolean {
    return this.uploaded !== this.version;
  }

  markUploaded(): void {
    this.uploaded = this.version;
    this.overflowed = false;
    this.dirtyPages.clear();
  }

  private font(f: FontSpec): FontInfo {
    const px = Math.max(1, Math.round(f.size * this.pixelRatio));
    const css = `${f.style ?? "normal"} ${f.weight ?? 400} ${px}px "${f.family}", sans-serif`;
    let info = this.fonts.get(css);
    if (!info) {
      this.ctx.font = css;
      const m = this.ctx.measureText("Hg");
      info = { css, ascent: m.fontBoundingBoxAscent ?? px * 0.8, descent: m.fontBoundingBoxDescent ?? px * 0.25 };
      this.fonts.set(css, info);
    }
    return info;
  }

  /** Font ascent and line height in logical units. */
  metrics(f: FontSpec): { ascent: number; lineHeight: number } {
    const info = this.font(f);
    return { ascent: info.ascent / this.pixelRatio, lineHeight: (info.ascent + info.descent) / this.pixelRatio };
  }

  glyph(ch: string, f: FontSpec): Glyph {
    const info = this.font(f);
    const key = `${info.css}\u0000${ch}`;
    const hit = this.glyphs.get(key);
    if (hit) return hit;
    let ctx = this.ctx;
    ctx.font = info.css;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#fff";
    const m = ctx.measureText(ch);
    const pad = 2;
    const left = Math.ceil(m.actualBoundingBoxLeft ?? 0);
    const right = Math.ceil(m.actualBoundingBoxRight ?? m.width);
    const asc = Math.ceil(m.actualBoundingBoxAscent ?? info.ascent);
    const desc = Math.ceil(m.actualBoundingBoxDescent ?? info.descent);
    const w = Math.max(1, left + right) + pad * 2;
    const h = Math.max(1, asc + desc) + pad * 2;
    if (w + 2 > this.size || h + 2 > this.size) {
      throw new RangeError(`Glyph "${ch}" (${w}×${h}) exceeds cache page ${this.size}`);
    }
    if (this.shelfX + w + 1 > this.size) {
      this.shelfX = 1;
      this.shelfY += this.shelfH + 1;
      this.shelfH = 0;
    }
    if (this.shelfY + h + 1 > this.size) {
      if (this.pages.length >= this.maxPages) throw new RangeError(`Glyph cache exhausted ${this.maxPages} pages; reduce font sizes or increase the cache budget`);
      const canvas = document.createElement("canvas");
      canvas.width = this.size;
      canvas.height = this.size;
      this.pages.push(canvas);
      this.ctx = ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.font = info.css;
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#fff";
      this.shelfX = 1;
      this.shelfY = 1;
      this.shelfH = 0;
      this.overflowed = true;
    }
    const x = this.shelfX;
    const y = this.shelfY;
    ctx.fillText(ch, x + pad + left, y + pad + asc);
    this.shelfX += w + 1;
    this.shelfH = Math.max(this.shelfH, h);
    this.version++;
    const page = this.pages.length - 1;
    this.dirtyPages.add(page);
    const g: Glyph = {
      page,
      u0: x / this.size,
      v0: y / this.size,
      u1: (x + w) / this.size,
      v1: (y + h) / this.size,
      w,
      h,
      left: -left - pad,
      top: -asc - pad,
      advance: m.width,
    };
    this.glyphs.set(key, g);
    return g;
  }

  measure(text: string, f: FontSpec): TextSize {
    const info = this.font(f);
    this.ctx.font = info.css;
    let width = 0;
    for (const line of text.split("\n")) width = Math.max(width, this.ctx.measureText(line).width);
    const lines = text.split("\n").length;
    return { width: width / this.pixelRatio, height: ((info.ascent + info.descent) * lines) / this.pixelRatio, ascent: info.ascent / this.pixelRatio };
  }
}

/** Rough metrics for backends without a text engine (tests). */
export function estimateText(text: string, f: FontSpec): TextSize {
  const lines = text.split("\n");
  const width = Math.max(...lines.map((l) => l.length)) * f.size * 0.56;
  return { width, height: f.size * 1.2 * lines.length, ascent: f.size * 0.9 };
}

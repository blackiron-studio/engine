import { glyphRows } from "../art/font.ts";
import type { GlyphBitmap, BlackironHostApi } from "../render/native.ts";
import type { Platform } from "../platform/types.ts";
let nextTexture = 1;
export type MinFilter3D = "nearest" | "linear" | "nearest-mipmap-nearest" | "linear-mipmap-nearest" | "nearest-mipmap-linear" | "linear-mipmap-linear";
/** CPU-backed RGBA texture, retained for context restoration and native upload. UV (0,0) is the image top left. */
export class Texture3D {
  readonly id = nextTexture++;
  readonly data: Uint8Array;
  version = 1;
  disposed = false;
  constructor(
    readonly width: number,
    readonly height: number,
    rgba: ArrayLike<number>,
    readonly filter: "nearest" | "linear" = "linear",
    readonly wrap: "repeat" | "clamp" | "mirror" = "repeat",
    /** Independent V wrap mode. Defaults to U for existing callers. */
    readonly wrapT: "repeat" | "clamp" | "mirror" = wrap,
    /** Minification and mip sampling; glTF imports request mipmaps explicitly. */
    readonly minFilter: MinFilter3D = filter,
  ) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 16777216 ||
      rgba.length !== width * height * 4
    )
      throw new RangeError("Invalid RGBA texture dimensions");
    this.data = new Uint8Array(rgba);
  }
  /** Rasterized sign/label textures on browser Canvas or native font services. */
  static fromText(
    text: string,
    options: {
      width: number;
      height: number;
      size: number;
      family?: string;
      weight?: number;
      color?: number;
      background?: number;
      padding?: number;
    },
    rasterize?: BlackironHostApi["rasterizeGlyph"],
  ): Texture3D {
    const { width, height, size } = options;
    if (text.length > 4096) throw RangeError("Text texture label is too long");
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 16777216 ||
      !Number.isFinite(size) ||
      size <= 0 ||
      size > 4096
    )
      throw RangeError("Invalid text texture dimensions");
    const family = options.family ?? "Arial",
      weight = options.weight ?? 700,
      padding = options.padding ?? 12;
    if (!Number.isFinite(padding) || padding < 0 || padding * 2 >= width)
      throw RangeError("Invalid text padding");
    const color = options.color ?? 0xffffff,
      background = options.background ?? 0x000000;
    const host = (globalThis as { __blackironHost?: BlackironHostApi }).__blackironHost;
    let paint = rasterize ?? host?.rasterizeGlyph?.bind(host);
    if (!paint && typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#" + background.toString(16).padStart(6, "0");
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#" + color.toString(16).padStart(6, "0");
      ctx.font = weight + " " + size + "px " + family;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, width / 2, height / 2 + 4, width - padding * 2);
      return new Texture3D(
        width,
        height,
        ctx.getImageData(0, 0, width, height).data,
        "linear",
        "clamp",
      );
    }
    if (!paint)
      paint = (_family, px, _weight, _style, ch) => {
        const unit = Math.max(1, Math.round(px / 7)),
          w = 5 * unit,
          h = 7 * unit,
          data = new Uint8Array(w * h),
          rows = glyphRows(ch);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++)
            data[y * w + x] =
              rows[Math.floor(y / unit)][Math.floor(x / unit)] === "#"
                ? 255
                : 0;
        return {
          w,
          h,
          left: 0,
          top: -h,
          advance: 6 * unit,
          ascent: h,
          descent: 0,
          data,
        };
      };
    const glyphs: GlyphBitmap[] = [];
    for (const ch of text) {
      const glyph = paint(family, size, weight, "normal", ch);
      if (!glyph) throw Error("Unable to rasterize text glyph: " + ch);
      glyphs.push(glyph);
    }
    const total = glyphs.reduce((n, g) => n + g.advance, 0),
      scale = Math.min(1, (width - padding * 2) / Math.max(1, total));
    const rgba = new Uint8Array(width * height * 4);
    const bg = [
        (background >> 16) & 255,
        (background >> 8) & 255,
        background & 255,
      ],
      fg = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
    for (let i = 0; i < rgba.length; i += 4) {
      rgba.set(bg, i);
      rgba[i + 3] = 255;
    }
    const ascent = Math.max(0, ...glyphs.map((g) => g.ascent)),
      descent = Math.max(0, ...glyphs.map((g) => g.descent));
    const baseline = (height - (ascent + descent) * scale) / 2 + ascent * scale;
    let pen = (width - total * scale) / 2;
    for (const g of glyphs) {
      const left = pen + g.left * scale,
        top = baseline + g.top * scale;
      for (
        let y = Math.max(0, Math.floor(top));
        y < Math.min(height, Math.ceil(top + g.h * scale));
        y++
      )
        for (
          let x = Math.max(0, Math.floor(left));
          x < Math.min(width, Math.ceil(left + g.w * scale));
          x++
        ) {
          const sx = Math.floor((x - left) / scale),
            sy = Math.floor((y - top) / scale);
          if (sx < 0 || sy < 0 || sx >= g.w || sy >= g.h) continue;
          const alpha = g.data[sy * g.w + sx] / 255,
            i = (y * width + x) * 4;
          for (let c = 0; c < 3; c++)
            rgba[i + c] = Math.round(fg[c] * alpha + rgba[i + c] * (1 - alpha));
        }
      pen += g.advance * scale;
    }
    return new Texture3D(width, height, rgba, "linear", "clamp");
  }
  static async load(platform: Platform, url: string): Promise<Texture3D> {
    const image = await platform.loadImage(url);
    return new Texture3D(image.width, image.height, image.data);
  }
  update(rgba: ArrayLike<number>): void {
    if (this.disposed || rgba.length !== this.data.length)
      throw new Error("Cannot update disposed or differently sized texture");
    this.data.set(rgba);
    this.version++;
  }
  dispose(): void {
    this.disposed = true;
  }
}

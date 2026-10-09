// Canvas 2D backend. Same contract as WebGL2 with cheaper approximations: bloom is a
// self-multiplied bright copy blurred and added, lighting is a multiplied half-resolution
// canvas, the overlay is its own canvas drawn last, and the grade uses CSS filters.
// Sprite tint, LUTs, grain and scanlines are not supported here.

import type { Atlas } from "../art/atlas.ts";
import { estimateText } from "./glyphs.ts";
import {
  type FontSpec,
  type LightDraw,
  type Mat,
  type Pass,
  type PostSettings,
  type Renderer,
  type RendererFeatures,
  type RendererOptions,
  type RenderStats,
  type SpriteDraw,
  type TextDraw,
  type TextSize,
  matIdentity,
} from "./types.ts";

function css(color: number, alpha = 1): string {
  return `rgba(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255},${alpha})`;
}

function fontCss(f: FontSpec, scale: number): string {
  return `${f.style ?? "normal"} ${f.weight ?? 400} ${Math.max(1, f.size * scale)}px "${f.family}", sans-serif`;
}

interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Device pixels per logical unit on this layer. */
  sx: number;
  sy: number;
}

export class Canvas2DRenderer implements Renderer {
  readonly kind = "canvas2d" as const;
  readonly stats: RenderStats = { drawCalls: 0, sprites: 0, frameMs: 0, targetWidth: 0, targetHeight: 0 };
  readonly features: RendererFeatures = { lighting: true, lut: false, smooth: true, text: true, normals: false, shadows: true, mesh3D: false };
  width: number;
  height: number;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly scaleMode: "native" | number;
  private scene!: Layer;
  private overlay!: Layer;
  private light!: Layer;
  private scratch!: Layer;
  private bloom!: Layer;
  private bloom2!: Layer;
  private cur!: Layer;
  private measurer: CanvasRenderingContext2D;
  private atlasCanvas: HTMLCanvasElement | null = null;
  private atlas: Atlas | null = null;
  private backingW = 0;
  private backingH = 0;
  private fbW = 0;
  private fbH = 0;
  private m: Mat = matIdentity();
  private lightUsed = false;
  private frameStart = 0;
  private vignetteCache: { w: number; h: number; grad: CanvasGradient } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    width: number,
    height: number,
    opts: RendererOptions = {},
  ) {
    this.width = width;
    this.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;
    this.scaleMode = opts.scale ?? (opts.renderScale ? Math.max(1, Math.floor(opts.renderScale)) : "native");
    this.measurer = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
    this.ensureLayers(Math.max(1, width), Math.max(1, height));
  }

  private layer(w: number, h: number): Layer {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return { canvas, ctx: canvas.getContext("2d") as CanvasRenderingContext2D, sx: w / this.width, sy: h / this.height };
  }

  private ensureLayers(w: number, h: number): void {
    if (w === this.fbW && h === this.fbH && this.scene) return;
    this.fbW = w;
    this.fbH = h;
    this.scene = this.layer(w, h);
    this.overlay = this.layer(w, h);
    this.light = this.layer(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    this.scratch = this.layer(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    this.bloom = this.layer(Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4)));
    this.bloom2 = this.layer(this.bloom.canvas.width, this.bloom.canvas.height);
    this.cur = this.scene;
    this.stats.targetWidth = w;
    this.stats.targetHeight = h;
  }

  private targetSize(): [number, number] {
    if (this.scaleMode === "native") return [this.backingW || this.width, this.backingH || this.height];
    return [Math.round(this.width * this.scaleMode), Math.round(this.height * this.scaleMode)];
  }

  setLogicalSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.fbW = 0;
    const [w, h] = this.targetSize();
    this.ensureLayers(w, h);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (w === this.backingW && h === this.backingH) return;
    this.backingW = w;
    this.backingH = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.vignetteCache = null;
    const [tw, th] = this.targetSize();
    this.ensureLayers(tw, th);
  }

  uploadAtlas(atlas: Atlas): void {
    this.atlas = atlas;
    const c = document.createElement("canvas");
    c.width = atlas.width;
    c.height = atlas.height;
    const cx = c.getContext("2d") as CanvasRenderingContext2D;
    const img = cx.createImageData(atlas.width, atlas.height);
    img.data.set(atlas.data);
    cx.putImageData(img, 0, 0);
    this.atlasCanvas = c;
  }

  begin(clearColor: number): void {
    this.frameStart = performance.now();
    this.stats.drawCalls = 0;
    this.stats.sprites = 0;
    this.m = matIdentity();
    this.lightUsed = false;
    const s = this.scene.ctx;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalAlpha = 1;
    s.globalCompositeOperation = "source-over";
    s.filter = "none";
    s.imageSmoothingEnabled = false;
    s.fillStyle = css(clearColor);
    s.fillRect(0, 0, this.scene.canvas.width, this.scene.canvas.height);
    const o = this.overlay.ctx;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.globalCompositeOperation = "source-over";
    o.clearRect(0, 0, this.overlay.canvas.width, this.overlay.canvas.height);
    this.cur = this.scene;
  }

  setPass(pass: Pass, clear = 0): void {
    if (pass === "light") {
      if (!this.lightUsed) {
        const l = this.light.ctx;
        l.setTransform(1, 0, 0, 1, 0, 0);
        l.globalCompositeOperation = "source-over";
        l.globalAlpha = 1;
        l.fillStyle = css(clear);
        l.fillRect(0, 0, this.light.canvas.width, this.light.canvas.height);
      }
      this.lightUsed = true;
      this.cur = this.light;
    } else if (pass === "scratch") {
      const c = this.scratch.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = "source-over";
      c.clearRect(0, 0, this.scratch.canvas.width, this.scratch.canvas.height);
      this.cur = this.scratch;
    } else this.cur = pass === "world" ? this.scene : this.overlay;
  }

  /** A radial gradient stands in for the procedural light; normals are not shaded here. */
  drawLight(d: LightDraw): void {
    const m = this.m;
    const L = this.cur;
    const c = L.ctx;
    const cx = m[0] * d.x + m[2] * d.y + m[4];
    const cy = m[1] * d.x + m[3] * d.y + m[5];
    const scale = Math.max(Math.abs(m[0]) + Math.abs(m[2]), Math.abs(m[1]) + Math.abs(m[3]));
    const r = Math.max(1, d.radius * scale);
    c.setTransform(L.sx, 0, 0, L.sy, 0, 0);
    const k = Math.min(1, d.intensity);
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, css(d.color, k));
    g.addColorStop(0.5, css(d.color, k * 0.5 ** d.falloff));
    g.addColorStop(1, css(d.color, 0));
    c.globalAlpha = 1;
    c.globalCompositeOperation = "lighter";
    c.fillStyle = g;
    c.fillRect(cx - r, cy - r, r * 2, r * 2);
    this.stats.sprites++;
    this.stats.drawCalls++;
  }

  drawQuad(points: ArrayLike<number>, color: number, alpha: number, erase = false): void {
    const m = this.m;
    const L = this.cur;
    const c = L.ctx;
    c.setTransform(m[0] * L.sx, m[1] * L.sy, m[2] * L.sx, m[3] * L.sy, m[4] * L.sx, m[5] * L.sy);
    c.globalAlpha = alpha;
    c.globalCompositeOperation = erase ? "destination-out" : "source-over";
    c.fillStyle = css(color);
    c.beginPath();
    c.moveTo(points[0], points[1]);
    for (let k = 1; k < 4; k++) c.lineTo(points[k * 2], points[k * 2 + 1]);
    c.closePath();
    c.fill();
    c.globalCompositeOperation = "source-over";
    this.stats.drawCalls++;
  }

  /** Textured triangles: each is clipped and the atlas drawn through the affine map its corners define. */
  drawMesh(verts: ArrayLike<number>, count: number, _tint: number, alpha: number, additive = false, smooth = false): void {
    if (!this.atlasCanvas || !this.atlas) return;
    const m = this.m;
    const L = this.cur;
    const c = L.ctx;
    const aw = this.atlas.width;
    const ah = this.atlas.height;
    for (let t = 0; t + 2 < count; t += 3) {
      const o = t * 4;
      const [x0, y0, u0, v0] = [verts[o], verts[o + 1], verts[o + 2] * aw, verts[o + 3] * ah];
      const [x1, y1, u1, v1] = [verts[o + 4], verts[o + 5], verts[o + 6] * aw, verts[o + 7] * ah];
      const [x2, y2, u2, v2] = [verts[o + 8], verts[o + 9], verts[o + 10] * aw, verts[o + 11] * ah];
      const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
      if (Math.abs(det) < 1e-9) continue;
      const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det;
      const cc = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
      const b = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / det;
      const d = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
      const e = x0 - a * u0 - cc * v0;
      const f = y0 - b * u0 - d * v0;
      c.save();
      c.setTransform(m[0] * L.sx, m[1] * L.sy, m[2] * L.sx, m[3] * L.sy, m[4] * L.sx, m[5] * L.sy);
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x1, y1);
      c.lineTo(x2, y2);
      c.closePath();
      c.clip();
      c.transform(a, b, cc, d, e, f);
      c.globalAlpha = alpha;
      c.globalCompositeOperation = additive ? "lighter" : "source-over";
      c.imageSmoothingEnabled = smooth;
      c.drawImage(this.atlasCanvas, 0, 0);
      c.restore();
      this.stats.drawCalls++;
    }
    this.stats.sprites += Math.floor(count / 3);
  }

  blitScratch(): void {
    const l = this.light.ctx;
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalAlpha = 1;
    l.globalCompositeOperation = "lighter";
    l.drawImage(this.scratch.canvas, 0, 0);
    l.globalCompositeOperation = "source-over";
    this.stats.drawCalls++;
  }

  setTransform(m: Readonly<Mat>): void {
    for (let i = 0; i < 6; i++) this.m[i] = m[i];
  }

  sprite(d: SpriteDraw): void {
    if (!this.atlasCanvas) return;
    const r = d.region;
    const sx = d.sx ?? 1;
    const sy = d.sy ?? 1;
    const ox = d.ox ?? r.ox;
    const oy = d.oy ?? r.oy;
    const rot = d.rot ?? 0;
    let cos = 1;
    let sin = 0;
    if (rot !== 0) {
      cos = Math.cos(rot);
      sin = Math.sin(rot);
    }
    const m = this.m;
    const L = this.cur;
    const tx = m[0] * d.x + m[2] * d.y + m[4];
    const ty = m[1] * d.x + m[3] * d.y + m[5];
    const ax = (m[0] * cos + m[2] * sin) * sx;
    const ay = (m[1] * cos + m[3] * sin) * sx;
    const bx = (-m[0] * sin + m[2] * cos) * sy;
    const by = (-m[1] * sin + m[3] * cos) * sy;
    const c = L.ctx;
    c.setTransform(ax * L.sx, ay * L.sy, bx * L.sx, by * L.sy, tx * L.sx, ty * L.sy);
    c.globalAlpha = d.alpha ?? 1;
    c.globalCompositeOperation = d.erase ? "destination-out" : d.additive ? "lighter" : "source-over";
    c.imageSmoothingEnabled = d.smooth ?? false;
    c.drawImage(this.atlasCanvas, r.x, r.y, r.w, r.h, -ox, -oy, r.w, r.h);
    // Materials are approximated: a flash brightens the sprite; the rest draw plainly.
    if (d.material?.kind === "flash" && (d.material.p0 ?? 1) > 0) {
      c.globalCompositeOperation = "lighter";
      c.globalAlpha = (d.alpha ?? 1) * Math.min(1, d.material.p0 ?? 1) * 0.7;
      c.drawImage(this.atlasCanvas, r.x, r.y, r.w, r.h, -ox, -oy, r.w, r.h);
      c.globalCompositeOperation = "source-over";
    }
    this.stats.sprites++;
    this.stats.drawCalls++;
  }

  private clipped = 0;

  clip(x: number, y: number, w: number, h: number): void {
    const m = this.m;
    const L = this.cur;
    const c = L.ctx;
    c.save();
    c.setTransform(m[0] * L.sx, m[1] * L.sy, m[2] * L.sx, m[3] * L.sy, m[4] * L.sx, m[5] * L.sy);
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    this.clipped++;
  }

  unclip(): void {
    if (this.clipped > 0) {
      this.cur.ctx.restore();
      this.clipped--;
    }
  }

  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1, additive = false): void {
    const m = this.m;
    const L = this.cur;
    const c = L.ctx;
    c.setTransform(m[0] * L.sx, m[1] * L.sy, m[2] * L.sx, m[3] * L.sy, m[4] * L.sx, m[5] * L.sy);
    c.globalAlpha = alpha;
    c.globalCompositeOperation = additive ? "lighter" : "source-over";
    c.fillStyle = css(color);
    c.fillRect(x, y, w, h);
    this.stats.sprites++;
    this.stats.drawCalls++;
  }

  measureText(text: string, font: FontSpec): TextSize {
    const k = this.scene ? this.scene.sx : 1;
    const mctx = this.measurer;
    mctx.font = fontCss(font, k);
    let width = 0;
    const lines = text.split("\n");
    let ascent = font.size * 0.9;
    let lineH = font.size * 1.2;
    for (const line of lines) {
      const mm = mctx.measureText(line);
      width = Math.max(width, mm.width);
      ascent = (mm.fontBoundingBoxAscent ?? ascent * k) / k;
      lineH = ((mm.fontBoundingBoxAscent ?? 0) + (mm.fontBoundingBoxDescent ?? 0)) / k || lineH;
    }
    if (width === 0 && text.length) return estimateText(text, font);
    return { width: width / k, height: lineH * lines.length, ascent };
  }

  text(d: TextDraw): void {
    const L = this.cur;
    const c = L.ctx;
    const m = this.m;
    c.setTransform(m[0] * L.sx, m[1] * L.sy, m[2] * L.sx, m[3] * L.sy, m[4] * L.sx, m[5] * L.sy);
    c.globalAlpha = d.alpha;
    c.globalCompositeOperation = d.additive ? "lighter" : "source-over";
    c.font = fontCss(d.font, 1);
    c.textAlign = d.align;
    c.textBaseline = "top";
    const lineH = this.measureText("Hg", d.font).height;
    const lines = d.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const y = d.y + i * lineH;
      if (d.shadow !== undefined && d.shadow !== null) {
        c.fillStyle = css(d.shadow);
        c.fillText(lines[i], d.x + 1, y + 1);
      }
      c.fillStyle = css(d.color);
      c.fillText(lines[i], d.x, y);
      this.stats.drawCalls++;
    }
  }

  end(post: PostSettings, offsetX = 0, offsetY = 0): void {
    const s = this.scene.ctx;
    const sw = this.scene.canvas.width;
    const sh = this.scene.canvas.height;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalAlpha = 1;
    s.filter = "none";

    if (this.lightUsed) {
      s.globalCompositeOperation = "multiply";
      s.imageSmoothingEnabled = true;
      s.drawImage(this.light.canvas, 0, 0, sw, sh);
      s.imageSmoothingEnabled = false;
      s.globalCompositeOperation = "source-over";
      this.stats.drawCalls++;
    }

    if (post.bloom > 0) {
      const b = this.bloom.ctx;
      const bw = this.bloom.canvas.width;
      const bh = this.bloom.canvas.height;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.globalCompositeOperation = "source-over";
      b.globalAlpha = 1;
      b.filter = "none";
      b.imageSmoothingEnabled = true;
      b.drawImage(this.scene.canvas, 0, 0, bw, bh);
      // Bright pass without shaders: multiplying the image by itself raises it to a
      // power, which crushes mid-tones and keeps highlights.
      b.globalCompositeOperation = "multiply";
      const knee = Math.max(1, Math.round(post.bloomThreshold * 4));
      for (let i = 0; i < knee; i++) b.drawImage(this.bloom.canvas, 0, 0);
      b.globalCompositeOperation = "source-over";
      const b2 = this.bloom2.ctx;
      b2.setTransform(1, 0, 0, 1, 0, 0);
      b2.globalCompositeOperation = "source-over";
      b2.clearRect(0, 0, bw, bh);
      b2.filter = `blur(${(1 + post.bloomPasses * 1.2).toFixed(1)}px)`;
      b2.drawImage(this.bloom.canvas, 0, 0);
      b2.filter = "none";
      s.globalCompositeOperation = "lighter";
      s.globalAlpha = Math.min(1, post.bloom);
      s.imageSmoothingEnabled = true;
      s.drawImage(this.bloom2.canvas, 0, 0, sw, sh);
      s.imageSmoothingEnabled = false;
      s.globalAlpha = 1;
      s.globalCompositeOperation = "source-over";
      this.stats.drawCalls += 3 + knee;
    }

    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-over";
    c.globalAlpha = 1;
    const exact = this.backingW === sw && this.backingH === sh;
    const integer = this.backingW % sw === 0 && this.backingH % sh === 0;
    c.imageSmoothingEnabled = !(exact || integer);
    c.fillStyle = "#000";
    c.fillRect(0, 0, this.backingW, this.backingH);
    const filters: string[] = [];
    if (post.saturation !== 1) filters.push(`saturate(${post.saturation})`);
    if (post.contrast !== 1) filters.push(`contrast(${post.contrast})`);
    if (post.brightness !== 1) filters.push(`brightness(${post.brightness})`);
    c.filter = filters.length ? filters.join(" ") : "none";
    const kx = this.backingW / this.width;
    const ky = this.backingH / this.height;
    c.drawImage(this.scene.canvas, offsetX * kx, offsetY * ky, this.backingW, this.backingH);
    c.filter = "none";
    this.stats.drawCalls++;

    if (post.tintAmount > 0) {
      c.globalCompositeOperation = "multiply";
      c.fillStyle = css(post.tint, post.tintAmount);
      c.fillRect(0, 0, this.backingW, this.backingH);
      c.globalCompositeOperation = "source-over";
    }
    if (post.vignette > 0) {
      if (!this.vignetteCache || this.vignetteCache.w !== this.backingW || this.vignetteCache.h !== this.backingH) {
        const grad = c.createRadialGradient(this.backingW / 2, this.backingH / 2, Math.min(this.backingW, this.backingH) * 0.3, this.backingW / 2, this.backingH / 2, Math.max(this.backingW, this.backingH) * 0.72);
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(1, "rgba(0,0,0,1)");
        this.vignetteCache = { w: this.backingW, h: this.backingH, grad };
      }
      c.globalAlpha = post.vignette;
      c.fillStyle = this.vignetteCache.grad;
      c.fillRect(0, 0, this.backingW, this.backingH);
      c.globalAlpha = 1;
    }
    c.imageSmoothingEnabled = !(exact || integer);
    c.drawImage(this.overlay.canvas, 0, 0, this.backingW, this.backingH);
    this.stats.drawCalls++;
    this.stats.frameMs = performance.now() - this.frameStart;
  }

  snapshot(): string | null {
    try {
      return this.canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.atlasCanvas = null;
  }
}

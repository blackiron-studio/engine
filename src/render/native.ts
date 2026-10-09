import { Native3DEncoder } from "../three/native.ts";
import type { RenderFrame3D } from "../three/scene.ts";
// Native renderer backend. It does not draw; it packs each frame into one vertex buffer
// and a short command list and hands them to the host once per frame. A native host
// (Metal, Vulkan, anything) decodes the same protocol. This is the seam that makes the
// engine portable: everything above it is unchanged between the browser and a phone.

import type { Atlas } from "../art/atlas.ts";
import type { NativeAudioHost } from "../audio/native.ts";
import type { Rect } from "../core/math.ts";
import { type Kernel, type ProjectionMatrix, STAT } from "../kernel/protocol.ts";
import { StreamWriter } from "../kernel/stream.ts";
import { TsKernel } from "../kernel/ts.ts";
import { estimateText } from "./glyphs.ts";
import { resolveLut } from "./lut.ts";
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
} from "./types.ts";

/** Command words in the Uint32Array the host receives. */
export const CMD = { BEGIN: 1, PASS: 2, DRAW: 3, END: 4, SCISSOR: 5 } as const;
export const PASS_ID: Record<Pass, number> = { world: 0, light: 1, overlay: 2, scratch: 3 };
/** Texture slots the host keeps. */
export const TEX = { ATLAS: 0, GLYPHS: 1, LUT: 2, NORMALS: 3 } as const;
export const FLOATS_PER_VERT = 12;
/** Layout of the post Float32Array. */
export const POST = {
  BLOOM: 0, THRESHOLD: 1, PASSES: 2, VIGNETTE: 3, TINT_R: 4, TINT_G: 5, TINT_B: 6, TINT_AMOUNT: 7,
  SATURATION: 8, CONTRAST: 9, BRIGHTNESS: 10, USE_LUT: 11, GRAIN: 12, SCANLINES: 13, OFFSET_X: 14, OFFSET_Y: 15,
  LIGHTING: 16, VIEW_X: 17, VIEW_Y: 18, VIEW_W: 19, VIEW_H: 20, TARGET_W: 21, TARGET_H: 22, TIME: 23, LOGICAL_W: 24, LOGICAL_H: 25,
  SIZE: 26,
} as const;
export const PROTOCOL_VERSION = 1;

export interface GlyphBitmap {
  w: number;
  h: number;
  /** Pen-relative offsets in device pixels. */
  left: number;
  top: number;
  advance: number;
  /** Font metrics in device pixels. */
  ascent: number;
  descent: number;
  /** Alpha coverage, w*h bytes. */
  data: Uint8Array;
}

/** What the host installs on the global before the game script runs. */
export interface BlackironHostApi {
  now(): number;
  /** Request OS relative mouse capture; acknowledgment arrives through HostBridge. */
  setPointerCapture?(capture:boolean):void;
  log?(level: string, message: string): void;
  storageGet(key: string): string | null;
  /** False reports a rejected write. Legacy hosts return void. */
  storageSet(key: string, value: string): boolean | void;
  storageRemove(key: string): boolean | void;
  loadBytes(path: string): Uint8Array | null;
  loadText(path: string): string | null;
  decodeImage?(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } | null;
  loadImage?(path: string): { width: number; height: number; data: Uint8Array } | null;
  uploadTexture(slot: number, width: number, height: number, rgba: Uint8Array): void;
  /** Present the frame the kernel just produced: `vertexCount` vertices and `commandCount` command words. */
  submit(post: Float32Array, vertexCount: number, commandCount: number): void;
  submit3D?(packet: string): void;
  physics3D?(command: string): string;
  rendererDiagnostics?(): { geometries: number; textures: number; meshBytes: number };
  /** The host's compiled kernel; without one the renderer runs the reference kernel in script. */
  kernel?: Kernel;
  rasterizeGlyph?(family: string, size: number, weight: number, style: string, ch: string): GlyphBitmap | null;
  snapshot?(): string | null;
  /** The host's audio synthesiser, when it has one. */
  audio?: NativeAudioHost;
  haptic?(kind: string): void;
  /** Read text through the platform's screen reader when one is on. */
  announce?(text: string): void;
  /** Show or hide the on-screen keyboard, where the host has one. */
  showKeyboard?(visible: boolean): void;
  /** Set by hosts running a synthetic clock (`blackiron verify`), so unseeded games stay reproducible. */
  deterministic?: boolean;
  /** Current screen in points, device scale and safe-area insets (top, right, bottom, left). */
  screen: { width: number; height: number; scale: number; insets: [number, number, number, number] };
}

interface NativeGlyph {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  w: number;
  h: number;
  left: number;
  top: number;
  advance: number;
}

/** Glyphs rasterised by the host and packed into one RGBA texture on the script side. */
class NativeGlyphCache {
  readonly size = 1024;
  readonly data: Uint8ClampedArray;
  private glyphs = new Map<string, NativeGlyph>();
  private fonts = new Map<string, { ascent: number; descent: number }>();
  private shelfX = 1;
  private shelfY = 1;
  private shelfH = 0;
  dirty = false;

  constructor(
    private readonly host: BlackironHostApi,
    public pixelRatio = 1,
  ) {
    this.data = new Uint8ClampedArray(this.size * this.size * 4);
  }

  setPixelRatio(r: number): void {
    if (Math.abs(r - this.pixelRatio) < 1e-3) return;
    this.pixelRatio = r;
    this.reset();
  }

  private reset(): void {
    this.data.fill(0);
    this.glyphs.clear();
    this.fonts.clear();
    this.shelfX = 1;
    this.shelfY = 1;
    this.shelfH = 0;
    this.dirty = true;
  }

  private key(f: FontSpec): string {
    return `${f.family}|${Math.max(1, Math.round(f.size * this.pixelRatio))}|${f.weight ?? 400}|${f.style ?? "normal"}`;
  }

  metrics(f: FontSpec): { ascent: number; lineHeight: number } {
    const k = this.key(f);
    let m = this.fonts.get(k);
    if (!m) {
      this.glyph("H", f);
      m = this.fonts.get(k) ?? { ascent: f.size * 0.8 * this.pixelRatio, descent: f.size * 0.25 * this.pixelRatio };
    }
    return { ascent: m.ascent / this.pixelRatio, lineHeight: (m.ascent + m.descent) / this.pixelRatio };
  }

  glyph(ch: string, f: FontSpec): NativeGlyph | null {
    const k = `${this.key(f)}|${ch}`;
    const hit = this.glyphs.get(k);
    if (hit) return hit;
    const px = Math.max(1, Math.round(f.size * this.pixelRatio));
    const weight = typeof f.weight === "number" ? f.weight : f.weight === "bold" ? 700 : 400;
    const g = this.host.rasterizeGlyph?.(f.family, px, weight, f.style ?? "normal", ch);
    if (!g) return null;
    this.fonts.set(this.key(f), { ascent: g.ascent, descent: g.descent });
    const w = g.w + 2;
    const h = g.h + 2;
    if (this.shelfX + w + 1 > this.size) {
      this.shelfX = 1;
      this.shelfY += this.shelfH + 1;
      this.shelfH = 0;
    }
    if (this.shelfY + h + 1 > this.size) this.reset();
    const x = this.shelfX;
    const y = this.shelfY;
    for (let row = 0; row < g.h; row++) {
      for (let col = 0; col < g.w; col++) {
        const a = g.data[row * g.w + col];
        const i = ((y + 1 + row) * this.size + x + 1 + col) * 4;
        this.data[i] = 255;
        this.data[i + 1] = 255;
        this.data[i + 2] = 255;
        this.data[i + 3] = a;
      }
    }
    this.shelfX += w + 1;
    this.shelfH = Math.max(this.shelfH, h);
    this.dirty = true;
    const out: NativeGlyph = { u0: x / this.size, v0: y / this.size, u1: (x + w) / this.size, v1: (y + h) / this.size, w, h, left: g.left - 1, top: g.top - 1, advance: g.advance };
    this.glyphs.set(k, out);
    return out;
  }

  measure(text: string, f: FontSpec): TextSize {
    const { ascent, lineHeight } = this.metrics(f);
    let width = 0;
    const lines = text.split("\n");
    for (const line of lines) {
      let w = 0;
      for (const ch of line) w += (this.glyph(ch, f)?.advance ?? 0) / this.pixelRatio;
      width = Math.max(width, w);
    }
    return { width, height: lineHeight * lines.length, ascent };
  }
}

export class NativeRenderer implements Renderer {
  readonly kind = "webgl2" as const;
  readonly stats: RenderStats = { drawCalls: 0, sprites: 0, frameMs: 0, targetWidth: 0, targetHeight: 0 };
  readonly features: RendererFeatures;
  /** The kernel that expands this renderer's stream: the host's compiled one, or the reference. */
  readonly kernel: Kernel;
  width: number;
  height: number;

  get diagnostics() { return { mesh: this.host.rendererDiagnostics?.() ?? { geometries: 0, textures: 0, meshBytes: 0 }, gpu: { supported: false, samples: 0, pending: 0, medianMs: null, p95Ms: null } }; }
  private meshFrame: RenderFrame3D | null = null;
  private meshEncoder = new Native3DEncoder();
  private hadMeshes = false;
  render3D(frame: RenderFrame3D): void {
    if (!this.host.submit3D) throw new Error("Native host lacks mesh protocol v1");
    if (this.meshFrame) throw new Error("One 3D world per frame is supported");
    this.meshFrame = frame;
  }
  private readonly writer: StreamWriter;
  private readonly scaleMode: "native" | number;
  private readonly post = new Float32Array(POST.SIZE);
  private atlas: Atlas | null = null;
  private glyphs: NativeGlyphCache | null = null;
  private lutKey: string | Uint8Array | null = null;
  private backingW = 0;
  private backingH = 0;
  private fbW = 0;
  private fbH = 0;
  private present = { x: 0, y: 0, w: 0, h: 0 };
  private lightUsed = false;
  private frameStart = 0;
  private readonly t0: number;

  constructor(
    readonly host: BlackironHostApi,
    width: number,
    height: number,
    opts: RendererOptions = {},
    kernel?: Kernel,
  ) {
    this.width = width;
    this.height = height;
    this.scaleMode = opts.scale ?? (opts.renderScale ? Math.max(1, Math.floor(opts.renderScale)) : "native");
    this.features = { lighting: true, lut: true, smooth: true, text: typeof host.rasterizeGlyph === "function", normals: true, shadows: true, mesh3D: typeof host.submit3D === "function" };
    this.kernel = kernel ?? host.kernel ?? new TsKernel();
    this.writer = new StreamWriter(this.kernel);
    this.t0 = host.now();
  }

  /** Where the composed frame lands on the drawable, in device pixels. The App sets this on layout. */
  setPresentRect(x: number, y: number, w: number, h: number): void {
    this.present = { x, y, w, h };
  }

  private targets(): void {
    const w = this.scaleMode === "native" ? this.backingW : Math.round(this.width * this.scaleMode);
    const h = this.scaleMode === "native" ? this.backingH : Math.round(this.height * this.scaleMode);
    if (w <= 0 || h <= 0 || (w === this.fbW && h === this.fbH)) return;
    this.fbW = w;
    this.fbH = h;
    this.stats.targetWidth = w;
    this.stats.targetHeight = h;
    this.glyphs?.setPixelRatio(w / this.width);
  }

  setLogicalSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.fbW = 0;
    this.targets();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.backingW = Math.max(1, Math.round(cssWidth * dpr));
    this.backingH = Math.max(1, Math.round(cssHeight * dpr));
    if (this.present.w === 0) this.present = { x: 0, y: 0, w: this.backingW, h: this.backingH };
    this.targets();
  }

  uploadAtlas(atlas: Atlas): void {
    this.atlas = atlas;
    this.kernel.setWhite(atlas.whiteU, atlas.whiteV);
    // A sprite named "shadow" is what the kernel draws under nodes that ask for one.
    if (atlas.has("shadow")) {
      const sh = atlas.region("shadow");
      this.kernel.setShadow(sh.w, sh.h, sh.ox, sh.oy, sh.u0, sh.v0, sh.u1, sh.v1);
    }
    this.host.uploadTexture(TEX.ATLAS, atlas.width, atlas.height, new Uint8Array(atlas.data.buffer, atlas.data.byteOffset, atlas.data.byteLength));
    if (atlas.normals) this.host.uploadTexture(TEX.NORMALS, atlas.width, atlas.height, new Uint8Array(atlas.normals.buffer, atlas.normals.byteOffset, atlas.normals.byteLength));
  }

  drawLight(d: LightDraw): void {
    this.writer.light(d.x, d.y, d.radius, d.color, d.intensity, d.falloff, d.height);
  }

  drawQuad(points: ArrayLike<number>, color: number, alpha: number, erase = false): void {
    this.writer.quad(points, color, alpha, erase);
  }

  drawMesh(verts: ArrayLike<number>, count: number, tint: number, alpha: number, additive = false, smooth = false): void {
    this.writer.mesh(verts, count, tint, alpha, additive, smooth);
  }

  blitScratch(): void {
    this.writer.blitScratch(this.width, this.height);
  }

  begin(clearColor: number): void {
    this.meshFrame = null;
    this.frameStart = this.host.now();
    this.stats.drawCalls = 0;
    this.stats.sprites = 0;
    this.lightUsed = false;
    this.writer.begin(clearColor, this.width, this.height);
  }

  setPass(pass: Pass, clear = 0): void {
    if (pass === "light") this.lightUsed = true;
    this.writer.pass(PASS_ID[pass], clear);
  }

  setTransform(m: Readonly<Mat>): void {
    this.writer.transform(m);
  }

  sprite(d: SpriteDraw): void {
    this.writer.sprite(d);
  }

  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1, additive = false): void {
    if (!this.atlas) return;
    this.writer.rect(x, y, w, h, color, alpha, additive);
  }

  drawBatch(id: number, alpha: number, tint: number, cull: Rect | null, additive: boolean, smooth: boolean): void {
    this.writer.batch(id, alpha, tint, cull, additive, smooth);
  }

  drawParticles(id: number, dt: number, emitting: boolean, ex: number, ey: number, alpha: number, snap: boolean): void {
    this.writer.particles(id, dt, emitting, ex, ey, alpha, snap);
  }

  drawNodes(id: number, alpha: number, tint: number, additive: boolean, smooth: boolean): void {
    this.writer.nodes(id, alpha, tint, additive, smooth);
  }

  setProjection(p: ProjectionMatrix, cam: Readonly<Mat>, sorted: boolean): void {
    this.writer.projection(p, cam, sorted);
  }

  endProjection(): void {
    this.writer.projectionEnd();
  }

  setTransform3(a: number, b: number, c: number, d: number, gx: number, gy: number, gz: number, depthBias: number, shadow: boolean, shadowAlpha: number): void {
    this.writer.transform3(a, b, c, d, gx, gy, gz, depthBias, shadow, shadowAlpha);
  }

  drawBatch3(id: number, alpha: number, tint: number, additive: boolean, smooth: boolean): void {
    this.writer.batch3(id, alpha, tint, additive, smooth);
  }

  clip(x: number, y: number, w: number, h: number): void {
    this.writer.clip(x, y, w, h);
  }

  unclip(): void {
    this.writer.clipEnd();
  }

  private glyphCache(): NativeGlyphCache | null {
    if (!this.features.text) return null;
    if (!this.glyphs) this.glyphs = new NativeGlyphCache(this.host, this.fbW > 0 ? this.fbW / this.width : this.host.screen.scale);
    return this.glyphs;
  }

  measureText(text: string, font: FontSpec): TextSize {
    const cache = this.glyphCache();
    return cache ? cache.measure(text, font) : estimateText(text, font);
  }

  text(d: TextDraw): void {
    const cache = this.glyphCache();
    if (!cache) return;
    const ratio = cache.pixelRatio;
    const { ascent, lineHeight } = cache.metrics(d.font);
    const lines = d.text.split("\n");
    const draw = (line: string, x0: number, y0: number, color: number) => {
      let pen = x0;
      for (const ch of line) {
        const gl = cache.glyph(ch, d.font);
        if (!gl) continue;
        if (ch !== " ") {
          this.writer.glyph(pen + gl.left / ratio, y0 + ascent + gl.top / ratio, gl.w / ratio, gl.h / ratio, gl.u0, gl.v0, gl.u1, gl.v1, color, d.alpha, d.additive ?? false);
        }
        pen += gl.advance / ratio;
      }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const w = cache.measure(line, d.font).width;
      const x = d.align === "center" ? d.x - w / 2 : d.align === "right" ? d.x - w : d.x;
      const y = d.y + i * lineHeight;
      if (d.shadow !== undefined && d.shadow !== null) draw(line, x + 1, y + 1, d.shadow);
      draw(line, x, y, d.color);
    }
  }

  end(post: PostSettings, offsetX = 0, offsetY = 0): void {
    this.writer.end();
    this.kernel.run(this.writer.length);
    const st = this.kernel.stats;
    this.stats.drawCalls = st[STAT.DRAWS];
    this.stats.sprites = st[STAT.SPRITES];
    if (this.glyphs?.dirty) {
      this.host.uploadTexture(TEX.GLYPHS, this.glyphs.size, this.glyphs.size, new Uint8Array(this.glyphs.data.buffer));
      this.glyphs.dirty = false;
    }
    let useLut = 0;
    const lut = resolveLut(post.lut);
    if (lut) {
      useLut = 1;
      if (this.lutKey !== post.lut) {
        const rgba = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
          rgba[i * 4] = lut[i * 3];
          rgba[i * 4 + 1] = lut[i * 3 + 1];
          rgba[i * 4 + 2] = lut[i * 3 + 2];
          rgba[i * 4 + 3] = 255;
        }
        this.host.uploadTexture(TEX.LUT, 256, 1, rgba);
        this.lutKey = post.lut;
      }
    }
    const p = this.post;
    p[POST.BLOOM] = post.bloom;
    p[POST.THRESHOLD] = post.bloomThreshold;
    p[POST.PASSES] = Math.max(1, Math.round(post.bloomPasses));
    p[POST.VIGNETTE] = post.vignette;
    p[POST.TINT_R] = ((post.tint >> 16) & 255) / 255;
    p[POST.TINT_G] = ((post.tint >> 8) & 255) / 255;
    p[POST.TINT_B] = (post.tint & 255) / 255;
    p[POST.TINT_AMOUNT] = post.tintAmount;
    p[POST.SATURATION] = post.saturation;
    p[POST.CONTRAST] = post.contrast;
    p[POST.BRIGHTNESS] = post.brightness;
    p[POST.USE_LUT] = useLut;
    p[POST.GRAIN] = post.grain;
    p[POST.SCANLINES] = post.scanlines;
    p[POST.OFFSET_X] = offsetX / this.width;
    p[POST.OFFSET_Y] = -offsetY / this.height;
    p[POST.LIGHTING] = this.lightUsed ? 1 : 0;
    p[POST.VIEW_X] = this.present.x;
    p[POST.VIEW_Y] = this.present.y;
    p[POST.VIEW_W] = this.present.w;
    p[POST.VIEW_H] = this.present.h;
    p[POST.TARGET_W] = this.fbW;
    p[POST.TARGET_H] = this.fbH;
    p[POST.TIME] = ((this.host.now() - this.t0) % 100000) / 1000;
    p[POST.LOGICAL_W] = this.width;
    p[POST.LOGICAL_H] = this.height;
    if (this.meshFrame || this.hadMeshes) this.host.submit3D?.(this.meshEncoder.encode(this.meshFrame));
    this.hadMeshes = !!this.meshFrame;
    this.host.submit(p, st[STAT.VERTICES], st[STAT.COMMANDS]);
    this.stats.frameMs = this.host.now() - this.frameStart;
  }

  snapshot(): string | null {
    return this.host.snapshot?.() ?? null;
  }

  destroy(): void {
    if (this.hadMeshes) this.host.submit3D?.(this.meshEncoder.encode(null));
    this.hadMeshes = false; this.meshFrame = null;
    this.writer.length = 0;
  }
}

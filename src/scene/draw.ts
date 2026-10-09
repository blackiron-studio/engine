// DrawContext is what nodes receive in `render`. It tracks the current transform, alpha
// and pass, culls in screen space, and turns sprite names and text into renderer calls.

import type { Atlas, Region } from "../art/atlas.ts";
import { FONT_ADVANCE, FONT_H, FONT_LINE, FONT_W, measureText } from "../art/font.ts";
import type { Rect } from "../core/math.ts";
import type { Kernel, ProjectionMatrix } from "../kernel/protocol.ts";
import { type FontSpec, IDENTITY as IDENTITY_MAT, type Mat, type Pass, type Renderer, type SpriteDraw, matIdentity, type SpriteMaterial } from "../render/types.ts";

export interface SpriteOptions {
  sx?: number;
  sy?: number;
  rot?: number;
  alpha?: number;
  tint?: number;
  additive?: boolean;
  /** Linear filtering, for imported high-resolution art. */
  smooth?: boolean;
  /** Also add the sprite to the light pass, so it stays bright in the dark and blooms. */
  emissive?: boolean;
  flipX?: boolean;
  flipY?: boolean;
  /** Origin override in pixels from the region's top-left. */
  ox?: number;
  oy?: number;
  /** A fragment effect: flash toward white, dissolve, a one-texel outline, or a flat silhouette. */
  material?: SpriteMaterial | null;
  /** Multiply the target by 1 - alpha instead of drawing; shadow geometry uses it. */
  erase?: boolean;
}

export interface LightOptions2 {
  color?: number;
  intensity?: number;
  /** Exponent of (1 - distance): 2 is soft, higher is tighter. */
  falloff?: number;
  /** Height above the ground in radius units, for normal-mapped shading. */
  height?: number;
}

export interface TextOptions {
  color?: number;
  /** Bitmap font scale; ignored for web fonts. */
  scale?: number;
  align?: "left" | "center" | "right";
  alpha?: number;
  additive?: boolean;
  /** Draw a one-unit shadow in this colour first. */
  shadow?: number | null;
  /** Extra pixels between bitmap glyphs. */
  spacing?: number;
  /** A web font, or "pixel" for the built-in 5x7 bitmap font (the default). */
  font?: FontSpec | "pixel";
}

interface QueuedSprite {
  draw: SpriteDraw;
  transform: Mat;
  alpha: number;
}

export class DrawContext {
  /** Current transform from local to logical screen space. */
  readonly transform: Mat = matIdentity();
  /** Transform of the current layer's root (camera for the world, identity for UI). */
  readonly rootTransform: Mat = matIdentity();
  alpha = 1;
  /** Visible rectangle in the current layer's coordinate space (world units under the camera). */
  view: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Whether sprites outside the screen are skipped. */
  cull = true;
  /** Round sprite positions to whole units before drawing. */
  pixelSnap = true;
  /** Which target draws currently go to. */
  pass: Pass = "world";
  /** Whether a light pass ran this frame. */
  lightUsed = false;
  /** The layer's projection: ground (x, y, z) to screen and depth, or null for a flat layer. */
  projection: { p: ProjectionMatrix; cam: Mat; sorted: boolean } | null = null;
  /** Ground-space transform and height of the current node under a projection. */
  readonly ground: Mat = matIdentity();
  groundZ = 0;
  depthBias = 0;
  private dirty = true;
  private readonly emissive: QueuedSprite[] = [];

  constructor(
    public renderer: Renderer,
    public atlas: Atlas,
  ) {}

  get width(): number {
    return this.renderer.width;
  }

  get height(): number {
    return this.renderer.height;
  }

  /** Reset per-frame state. The App calls this before drawing. */
  beginFrame(): void {
    this.emissive.length = 0;
    this.lightUsed = false;
    this.pass = "world";
    this.dirty = true;
  }

  /**
   * Start a layer: subsequent transforms compose on top of `root`. With a projection, nodes
   * are placed in ground space (x, y, z) and the kernel sorts the layer by depth.
   */
  beginLayer(root: Readonly<Mat>, view: Rect, cull = true, projection: ProjectionMatrix | null = null, sorted = true): void {
    if (this.projection && !projection) this.renderer.endProjection?.();
    for (let i = 0; i < 6; i++) this.rootTransform[i] = root[i];
    this.projection = null;
    this.setTransform(root, 1);
    this.view = view;
    this.cull = cull;
    this.depthBias = 0;
    if (projection) {
      this.projection = { p: projection, cam: [...root] as Mat, sorted };
      this.renderer.setProjection?.(projection, root, sorted);
      for (let i = 0; i < 6; i++) this.ground[i] = IDENTITY_MAT[i];
      this.groundZ = 0;
    }
  }

  /** Screen position of a ground point under the layer's projection and camera. */
  project(x: number, y: number, z = 0): [number, number] {
    const pr = this.projection;
    if (!pr) return [x, y - z];
    const p = pr.p;
    const sx = p[0] * x + p[1] * y + p[2] * z + p[3];
    const sy = p[4] * x + p[5] * y + p[6] * z + p[7];
    const c = pr.cam;
    return [c[0] * sx + c[2] * sy + c[4], c[1] * sx + c[3] * sy + c[5]];
  }

  /**
   * A node's transform under a projection: `ground` is its ground-space matrix (position in
   * world units, linear part kept in screen space), `gz` its height. The screen transform
   * that results is what `transform` holds afterwards.
   */
  setTransform3(ground: Readonly<Mat>, gz: number, alpha: number, depthBias = 0, shadow = false, shadowAlpha = 0.5): void {
    const pr = this.projection;
    if (!pr) {
      this.setTransform(ground, alpha);
      return;
    }
    for (let i = 0; i < 6; i++) this.ground[i] = ground[i];
    this.groundZ = gz;
    this.depthBias = depthBias;
    const [sx, sy] = this.project(ground[4], ground[5], gz);
    const c = pr.cam;
    const t = this.transform;
    t[0] = c[0] * ground[0] + c[2] * ground[1];
    t[1] = c[1] * ground[0] + c[3] * ground[1];
    t[2] = c[0] * ground[2] + c[2] * ground[3];
    t[3] = c[1] * ground[2] + c[3] * ground[3];
    t[4] = sx;
    t[5] = sy;
    this.alpha = alpha;
    if (this.renderer.setTransform3) {
      this.renderer.setTransform3(ground[0], ground[1], ground[2], ground[3], ground[4], ground[5], gz, depthBias, shadow, shadowAlpha);
      this.dirty = false;
    } else {
      this.dirty = true;
      if (shadow) this.shadowFallback(ground[4], ground[5], gz, shadowAlpha);
    }
  }

  /** Without a kernel there is no depth sort; the shadow is drawn where the node will be. */
  private shadowFallback(gx: number, gy: number, gz: number, alpha: number): void {
    if (!this.atlas.has("shadow")) return;
    const k = Math.max(0.4, 1 - gz / 160);
    const a = alpha * Math.max(0.2, 1 - gz / 200);
    this.sprite3(this.atlas.region("shadow"), gx - this.ground[4], gy - this.ground[5], -this.groundZ, { sx: k, sy: k, alpha: a });
  }

  /** Draw a sprite at a ground offset from the current node, projected; for renderers without a kernel. */
  sprite3(name: string | Region, gx: number, gy: number, gz: number, o: SpriteOptions = {}): void {
    const r = this.region(name);
    const [sx, sy] = this.project(this.ground[4] + gx, this.ground[5] + gy, this.groundZ + gz);
    const pr = this.projection;
    const c: Mat = pr ? [pr.cam[0], pr.cam[1], pr.cam[2], pr.cam[3], sx, sy] : [1, 0, 0, 1, sx, sy];
    const scale = Math.max(Math.abs(c[0]) + Math.abs(c[2]), Math.abs(c[1]) + Math.abs(c[3]));
    const extent = Math.max(r.w * Math.abs(o.sx ?? 1), r.h * Math.abs(o.sy ?? 1)) * scale;
    if (this.cull && (sx + extent < 0 || sy + extent < 0 || sx - extent > this.renderer.width || sy - extent > this.renderer.height)) return;
    this.renderer.setTransform(c);
    this.dirty = true;
    let sxs = o.sx ?? 1;
    let sys = o.sy ?? 1;
    if (o.flipX) sxs = -sxs;
    if (o.flipY) sys = -sys;
    this.renderer.sprite({ region: r, x: 0, y: 0, sx: sxs, sy: sys, rot: o.rot, alpha: (o.alpha ?? 1) * this.alpha, tint: o.tint, additive: o.additive, smooth: o.smooth, ox: o.ox, oy: o.oy });
  }

  /** Draw a kernel world-space batch (an isometric map) under the current node. */
  batch3(id: number, o: { alpha?: number; tint?: number; additive?: boolean; smooth?: boolean } = {}): void {
    if (!this.renderer.drawBatch3) return;
    this.apply();
    this.renderer.drawBatch3(id, (o.alpha ?? 1) * this.alpha, o.tint ?? 0xffffff, o.additive ?? false, o.smooth ?? false);
  }

  /** Switch render target. Entering the light pass replays queued emissive sprites. */
  beginPass(pass: Pass, clear = 0): void {
    if ((pass === "light" || pass === "scratch") && !this.renderer.features.lighting) return;
    if (pass === "scratch" && !this.renderer.features.shadows) return;
    this.renderer.setPass(pass, clear);
    this.pass = pass;
    this.dirty = true;
    if (pass === "light") {
      this.lightUsed = true;
      const saved: Mat = [...this.transform] as Mat;
      const savedAlpha = this.alpha;
      for (const q of this.emissive) {
        this.renderer.setTransform(q.transform);
        this.renderer.sprite({ ...q.draw, additive: true, alpha: q.draw.alpha });
      }
      this.emissive.length = 0;
      this.renderer.setTransform(saved);
      this.alpha = savedAlpha;
    }
  }

  setTransform(m: Readonly<Mat>, alpha: number): void {
    const t = this.transform;
    if (t[0] !== m[0] || t[1] !== m[1] || t[2] !== m[2] || t[3] !== m[3] || t[4] !== m[4] || t[5] !== m[5]) {
      for (let i = 0; i < 6; i++) t[i] = m[i];
      this.dirty = true;
    }
    this.alpha = alpha;
  }

  private apply(): void {
    if (this.dirty) {
      this.renderer.setTransform(this.transform);
      this.dirty = false;
    }
  }

  private visible(x: number, y: number, extent: number): boolean {
    if (!this.cull) return true;
    const t = this.transform;
    const sx = t[0] * x + t[2] * y + t[4];
    const sy = t[1] * x + t[3] * y + t[5];
    const scale = Math.max(Math.abs(t[0]) + Math.abs(t[2]), Math.abs(t[1]) + Math.abs(t[3]));
    const m = extent * scale;
    return sx + m >= 0 && sy + m >= 0 && sx - m <= this.renderer.width && sy - m <= this.renderer.height;
  }

  region(name: string | Region): Region {
    return typeof name === "string" ? this.atlas.region(name) : name;
  }

  sprite(name: string | Region, x = 0, y = 0, o: SpriteOptions = {}): void {
    const r = this.region(name);
    let sx = o.sx ?? 1;
    let sy = o.sy ?? 1;
    if (o.flipX) sx = -sx;
    if (o.flipY) sy = -sy;
    const extent = Math.max(r.w * Math.abs(sx), r.h * Math.abs(sy));
    if (this.pixelSnap) {
      x = Math.round(x);
      y = Math.round(y);
    }
    if (!this.visible(x, y, extent)) return;
    this.apply();
    const draw: SpriteDraw = {
      region: r,
      x,
      y,
      sx,
      sy,
      rot: o.rot,
      alpha: (o.alpha ?? 1) * this.alpha,
      tint: o.tint,
      additive: o.additive,
      smooth: o.smooth,
      ox: o.ox,
      oy: o.oy,
      material: o.material ? this.materialParams(o.material) : undefined,
      erase: o.erase,
    };
    this.renderer.sprite(draw);
    if (o.emissive && this.pass === "world") this.emissive.push({ draw, transform: [...this.transform] as Mat, alpha: this.alpha });
  }

  /** Fill in a material's parameters: outlines need the atlas texel size, the others their defaults. */
  private materialParams(m: SpriteMaterial): SpriteMaterial {
    switch (m.kind) {
      case "outline":
        return { kind: "outline", p0: 1 / this.atlas.width, p1: 1 / this.atlas.height };
      case "flash":
        return { kind: "flash", p0: m.p0 ?? 1, p1: 0 };
      case "dissolve":
        return { kind: "dissolve", p0: m.p0 ?? 0, p1: m.p1 ?? 0.08 };
      default:
        return m;
    }
  }

  /**
   * A point light at (x, y) in the current space. Renderers with the light op shade it against
   * the scene's normals; the others draw the soft blob sprite.
   */
  light(x: number, y: number, radius: number, o: LightOptions2 = {}): void {
    if (!this.visible(x, y, radius)) return;
    this.apply();
    const color = o.color ?? 0xffffff;
    const intensity = (o.intensity ?? 1) * this.alpha;
    if (this.renderer.drawLight) {
      this.renderer.drawLight({ x, y, radius, color, intensity, falloff: o.falloff ?? 2, height: o.height ?? 0.6 });
      return;
    }
    const scale = (radius * 2) / 64;
    this.renderer.sprite({ region: this.atlas.region("__blob"), x, y, sx: scale, sy: scale, tint: color, alpha: intensity, additive: true });
  }

  /** Four points (x0, y0 … x3, y3) in the current space filled with one colour; `erase` for shadows. */
  quad(points: ArrayLike<number>, color: number, alpha = 1, erase = false): void {
    if (!this.renderer.drawQuad) return;
    this.apply();
    this.renderer.drawQuad(points, color, alpha * this.alpha, erase);
  }

  /** Textured triangles: `count` vertices of (x, y, u, v), u and v in atlas units. */
  mesh(verts: ArrayLike<number>, count: number, o: { tint?: number; alpha?: number; additive?: boolean; smooth?: boolean } = {}): void {
    if (!this.renderer.drawMesh) return;
    this.apply();
    this.renderer.drawMesh(verts, count, o.tint ?? 0xffffff, (o.alpha ?? 1) * this.alpha, o.additive ?? false, o.smooth ?? false);
  }

  /** Add the scratch target onto the light target; call after `beginPass("light")`. */
  blitScratch(): void {
    if (!this.renderer.blitScratch) return;
    this.renderer.blitScratch();
    // The blit set its own transform; the next draw restores ours.
    this.dirty = true;
  }

  /** The renderer's kernel, when retained batches and kernel particles are available. */
  get kernel(): Kernel | null {
    return this.renderer.kernel ?? null;
  }

  /** Draw a retained kernel batch under the current transform, culled to `cull` in batch space. */
  batch(id: number, cull: Rect | null, o: { alpha?: number; tint?: number; additive?: boolean; smooth?: boolean } = {}): void {
    if (!this.renderer.drawBatch) return;
    this.apply();
    this.renderer.drawBatch(id, (o.alpha ?? 1) * this.alpha, o.tint ?? 0xffffff, cull, o.additive ?? false, o.smooth ?? false);
  }

  /** Clip what follows to a rect in the current space; pair with `unclip`. Nested clips replace, not intersect. */
  clip(x: number, y: number, w: number, h: number): void {
    if (!this.renderer.clip) return;
    this.apply();
    this.renderer.clip(x, y, w, h);
  }

  unclip(): void {
    this.renderer.unclip?.();
  }

  /** Draw a kernel node table in the current space. */
  nodes(id: number, o: { alpha?: number; tint?: number; additive?: boolean; smooth?: boolean } = {}): void {
    if (!this.renderer.drawNodes) return;
    this.apply();
    this.renderer.drawNodes(id, (o.alpha ?? 1) * this.alpha, o.tint ?? 0xffffff, o.additive ?? false, o.smooth ?? false);
  }

  /** Step and draw a kernel particle emitter in the current space. */
  particles(id: number, dt: number, emitting: boolean, ex: number, ey: number): void {
    if (!this.renderer.drawParticles) return;
    this.apply();
    this.renderer.drawParticles(id, dt, emitting, ex, ey, this.alpha, this.pixelSnap);
  }

  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1, additive = false): void {
    if (!this.visible(x + w / 2, y + h / 2, Math.max(w, h))) return;
    this.apply();
    this.renderer.rect(x, y, w, h, color, alpha * this.alpha, additive);
  }

  /** One-pixel frame around a rect. */
  frame(x: number, y: number, w: number, h: number, color: number, alpha = 1, thickness = 1): void {
    this.rect(x, y, w, thickness, color, alpha);
    this.rect(x, y + h - thickness, w, thickness, color, alpha);
    this.rect(x, y, thickness, h, color, alpha);
    this.rect(x + w - thickness, y, thickness, h, color, alpha);
  }

  /** Width of a line of text, for either font kind. */
  measure(text: string, scale = 1, spacing = 0, font?: FontSpec | "pixel"): number {
    if (font && font !== "pixel") return this.renderer.measureText(text, font).width;
    return measureText(text, scale) + Math.max(0, text.length - 1) * spacing * scale;
  }

  /** Line height for either font kind. */
  lineHeight(scale = 1, font?: FontSpec | "pixel"): number {
    if (font && font !== "pixel") return this.renderer.measureText("Hg", font).height;
    return FONT_LINE * scale;
  }

  /** Draw text with the bitmap font or a web font. Returns the width drawn. Supports "\n". */
  text(text: string, x: number, y: number, o: TextOptions = {}): number {
    const color = o.color ?? 0xffffff;
    if (o.font && o.font !== "pixel" && this.renderer.features.text) {
      const w = this.renderer.measureText(text, o.font).width;
      if (this.pixelSnap) {
        x = Math.round(x);
        y = Math.round(y);
      }
      if (!this.visible(x, y, w + o.font.size * 2)) return w;
      this.apply();
      this.renderer.text({ text, x, y, font: o.font, color, alpha: (o.alpha ?? 1) * this.alpha, align: o.align ?? "left", additive: o.additive, shadow: o.shadow });
      return w;
    }
    const scale = o.scale ?? 1;
    const spacing = o.spacing ?? 0;
    const lines = text.split("\n");
    let maxW = 0;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const w = this.measure(line, scale, spacing);
      maxW = Math.max(maxW, w);
      let cx = x;
      if (o.align === "center") cx = x - w / 2;
      else if (o.align === "right") cx = x - w;
      cx = Math.round(cx);
      const cy = Math.round(y + li * FONT_LINE * scale);
      if (o.shadow !== undefined && o.shadow !== null) this.glyphRun(line, cx + scale, cy + scale, scale, spacing, o.shadow, o.alpha ?? 1, false);
      this.glyphRun(line, cx, cy, scale, spacing, color, o.alpha ?? 1, o.additive ?? false);
    }
    return maxW;
  }

  private glyphRun(line: string, x: number, y: number, scale: number, spacing: number, color: number, alpha: number, additive: boolean): void {
    if (!this.visible(x, y, this.measure(line, scale) + FONT_H * scale)) return;
    this.apply();
    const adv = (FONT_ADVANCE + spacing) * scale;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === " ") continue;
      const r = this.atlas.glyph(ch);
      this.renderer.sprite({ region: r, x: x + i * adv, y, sx: scale, sy: scale, alpha: alpha * this.alpha, tint: color, additive, ox: 0, oy: 0 });
    }
  }
}

export { FONT_W, FONT_H, FONT_LINE };

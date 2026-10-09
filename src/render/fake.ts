// Recording renderer for tests and headless runs. It stores every call so a test can
// assert what a scene drew without a browser.

import type { RenderFrame3D } from "../three/scene.ts";
import type { Atlas } from "../art/atlas.ts";
import { estimateText } from "./glyphs.ts";
import {
  type FontSpec,
  type Mat,
  type Pass,
  type PostSettings,
  type Renderer,
  type RendererFeatures,
  type RenderStats,
  type LightDraw,
  type SpriteDraw,
  type SpriteMaterial,
  type TextDraw,
  type TextSize,
  matIdentity,
} from "./types.ts";

export type FakeOp =
  | { op: "begin"; clear: number }
  | { op: "world3d"; meshes: Array<{ name: string; geometry: number; matrix: number[]; color: number; tint: number }>; camera: number[]; lights: number }
  | { op: "pass"; pass: Pass; clear: number }
  | { op: "sprite"; name: string; x: number; y: number; sx: number; sy: number; rot: number; alpha: number; tint: number; additive: boolean; smooth: boolean; material: SpriteMaterial | null; erase: boolean; pass: Pass; transform: Mat }
  | { op: "light"; x: number; y: number; radius: number; color: number; intensity: number; falloff: number; height: number; pass: Pass; transform: Mat }
  | { op: "quad"; points: number[]; color: number; alpha: number; erase: boolean; pass: Pass; transform: Mat }
  | { op: "mesh"; count: number; tint: number; alpha: number; pass: Pass; transform: Mat }
  | { op: "blit"; pass: Pass }
  | { op: "rect"; x: number; y: number; w: number; h: number; color: number; alpha: number; additive: boolean; pass: Pass; transform: Mat }
  | { op: "text"; text: string; x: number; y: number; font: FontSpec; color: number; align: string; pass: Pass; transform: Mat }
  | { op: "end"; post: PostSettings; offsetX: number; offsetY: number; lightUsed: boolean };

export class FakeRenderer implements Renderer {
  readonly kind = "fake" as const;
  readonly stats: RenderStats = { drawCalls: 0, sprites: 0, frameMs: 0, targetWidth: 0, targetHeight: 0 };
  readonly features: RendererFeatures = { lighting: true, lut: true, smooth: true, text: true, normals: true, shadows: true, mesh3D: true };
  ops: FakeOp[] = [];
  atlas: Atlas | null = null;
  cssWidth = 0;
  cssHeight = 0;
  dpr = 1;
  width: number;
  height: number;
  private m: Mat = matIdentity();
  private pass: Pass = "world";
  private lightUsed = false;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  setLogicalSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    this.stats.targetWidth = Math.round(cssWidth * dpr);
    this.stats.targetHeight = Math.round(cssHeight * dpr);
  }

  uploadAtlas(atlas: Atlas): void {
    this.atlas = atlas;
  }

  begin(clearColor: number): void {
    this.ops.length = 0;
    this.stats.drawCalls = 0;
    this.stats.sprites = 0;
    this.m = matIdentity();
    this.pass = "world";
    this.lightUsed = false;
    this.ops.push({ op: "begin", clear: clearColor });
  }

  render3D(frame: RenderFrame3D): void {
    this.ops.push({ op: "world3d", meshes: frame.meshes.map(mesh => ({ name: mesh.name, geometry: mesh.geometry.id, matrix: Array.from(mesh.worldMatrix), color: mesh.material.color, tint: mesh.tint })), camera: Array.from(frame.camera.viewProjection), lights: frame.lights.length });
  }

  setPass(pass: Pass, clear = 0): void {
    this.pass = pass;
    if (pass === "light") this.lightUsed = true;
    this.ops.push({ op: "pass", pass, clear });
  }

  setTransform(m: Readonly<Mat>): void {
    this.m = [m[0], m[1], m[2], m[3], m[4], m[5]];
  }

  sprite(d: SpriteDraw): void {
    this.stats.sprites++;
    this.ops.push({
      op: "sprite",
      name: d.region.name,
      x: d.x,
      y: d.y,
      sx: d.sx ?? 1,
      sy: d.sy ?? 1,
      rot: d.rot ?? 0,
      alpha: d.alpha ?? 1,
      tint: d.tint ?? 0xffffff,
      additive: d.additive ?? false,
      smooth: d.smooth ?? false,
      material: d.material ?? null,
      erase: d.erase ?? false,
      pass: this.pass,
      transform: [...this.m] as Mat,
    });
  }

  drawLight(d: LightDraw): void {
    this.stats.sprites++;
    this.ops.push({ op: "light", x: d.x, y: d.y, radius: d.radius, color: d.color, intensity: d.intensity, falloff: d.falloff, height: d.height, pass: this.pass, transform: [...this.m] as Mat });
  }

  drawQuad(points: ArrayLike<number>, color: number, alpha: number, erase = false): void {
    this.stats.sprites++;
    this.ops.push({ op: "quad", points: Array.from(points as number[]), color, alpha, erase, pass: this.pass, transform: [...this.m] as Mat });
  }

  drawMesh(_verts: ArrayLike<number>, count: number, tint: number, alpha: number): void {
    this.stats.sprites += Math.floor(count / 3);
    this.ops.push({ op: "mesh", count, tint, alpha, pass: this.pass, transform: [...this.m] as Mat });
  }

  blitScratch(): void {
    this.ops.push({ op: "blit", pass: this.pass });
  }

  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1, additive = false): void {
    this.stats.sprites++;
    this.ops.push({ op: "rect", x, y, w, h, color, alpha, additive, pass: this.pass, transform: [...this.m] as Mat });
  }

  text(d: TextDraw): void {
    this.stats.sprites += d.text.length;
    this.ops.push({ op: "text", text: d.text, x: d.x, y: d.y, font: d.font, color: d.color, align: d.align, pass: this.pass, transform: [...this.m] as Mat });
  }

  measureText(text: string, font: FontSpec): TextSize {
    return estimateText(text, font);
  }

  end(post: PostSettings, offsetX = 0, offsetY = 0): void {
    this.stats.drawCalls = 1;
    this.ops.push({ op: "end", post: { ...post }, offsetX, offsetY, lightUsed: this.lightUsed });
  }

  snapshot(): string | null {
    return null;
  }

  destroy(): void {
    this.ops.length = 0;
  }

  /** Sprites drawn on the last frame, by atlas name. */
  spritesNamed(name: string): Extract<FakeOp, { op: "sprite" }>[] {
    return this.ops.filter((o): o is Extract<FakeOp, { op: "sprite" }> => o.op === "sprite" && o.name === name);
  }
}

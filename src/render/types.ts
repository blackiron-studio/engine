// The renderer contract. Everything above this layer draws through `Renderer` only, so
// backends are interchangeable: WebGL2, Canvas 2D, a recording fake, or one day native.

import type { RenderFrame3D, RenderStats3D } from "../three/scene.ts";
import type { Atlas, Region } from "../art/atlas.ts";
import type { Rect } from "../core/math.ts";
import type { Kernel, ProjectionMatrix } from "../kernel/protocol.ts";

export type RendererKind = "webgl2" | "canvas2d" | "fake";

/** Affine transform in column form: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Readonly<Mat> = [1, 0, 0, 1, 0, 0];

export const matIdentity = (): Mat => [1, 0, 0, 1, 0, 0];

/** out = parent * local (apply `local` first, then `parent`). `out` may alias either input. */
export function matMul(out: Mat, p: Readonly<Mat>, l: Readonly<Mat>): Mat {
  const a = p[0] * l[0] + p[2] * l[1];
  const b = p[1] * l[0] + p[3] * l[1];
  const c = p[0] * l[2] + p[2] * l[3];
  const d = p[1] * l[2] + p[3] * l[3];
  const e = p[0] * l[4] + p[2] * l[5] + p[4];
  const f = p[1] * l[4] + p[3] * l[5] + p[5];
  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = d;
  out[4] = e;
  out[5] = f;
  return out;
}

/** Build translate(x, y) * rotate(rot) * scale(sx, sy). */
export function matCompose(out: Mat, x: number, y: number, sx = 1, sy = 1, rot = 0): Mat {
  if (rot === 0) {
    out[0] = sx;
    out[1] = 0;
    out[2] = 0;
    out[3] = sy;
  } else {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    out[0] = c * sx;
    out[1] = s * sx;
    out[2] = -s * sy;
    out[3] = c * sy;
  }
  out[4] = x;
  out[5] = y;
  return out;
}

export function matApply(m: Readonly<Mat>, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function matInvert(m: Readonly<Mat>): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0) return matIdentity();
  const id = 1 / det;
  return [m[3] * id, -m[1] * id, -m[2] * id, m[0] * id, (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id];
}

/**
 * Which target draws go to. World is lit and graded; light accumulates lights; overlay is drawn
 * last, untouched; scratch is a light-sized target one shadowed light draws into before it is
 * added to the light target.
 */
export type Pass = "world" | "light" | "overlay" | "scratch";

/** Per-draw fragment effects. `flash` mixes toward white by p0; `dissolve` hides texels whose
 * hash is under p0 and burns the p1 band above it in the tint colour; `outline` draws a one-texel
 * rim in the tint colour; `silhouette` fills the shape with the tint. */
export type MaterialKind = "none" | "flash" | "dissolve" | "outline" | "silhouette";

export interface SpriteMaterial {
  kind: MaterialKind;
  p0?: number;
  p1?: number;
}

/** A procedural point light drawn into the light pass. */
export interface LightDraw {
  x: number;
  y: number;
  radius: number;
  color: number;
  intensity: number;
  /** Exponent of (1 - distance): 2 is the soft default, higher is tighter. */
  falloff: number;
  /** Height above the ground in radius units, for normal-mapped shading. */
  height: number;
}

export interface SpriteDraw {
  region: Region;
  x: number;
  y: number;
  sx?: number;
  sy?: number;
  rot?: number;
  alpha?: number;
  /** 0xRRGGBB multiplied into the sprite; white leaves it unchanged. */
  tint?: number;
  additive?: boolean;
  /** Sample with linear filtering; for imported high-resolution art, not pixel art. */
  smooth?: boolean;
  /** Origin override in pixels from the region's top-left. */
  ox?: number;
  oy?: number;
  material?: SpriteMaterial | null;
  /** Multiply the target by 1 - alpha instead of drawing colour; shadows use it. */
  erase?: boolean;
}

export interface FontSpec {
  family: string;
  /** Size in logical units. */
  size: number;
  weight?: number | "normal" | "bold";
  style?: "normal" | "italic";
}

export interface TextDraw {
  text: string;
  x: number;
  y: number;
  font: FontSpec;
  color: number;
  alpha: number;
  align: "left" | "center" | "right";
  additive?: boolean;
  /** Draw a shadow of this colour one unit down-right first. */
  shadow?: number | null;
}

export interface TextSize {
  width: number;
  height: number;
  /** Distance from the top of the box to the baseline. */
  ascent: number;
}

export interface PostSettings {
  /** Bloom strength; 0 disables the passes entirely. */
  bloom: number;
  /** Brightness above which pixels contribute to bloom, in [0, 1]. */
  bloomThreshold: number;
  /** Number of blur iterations; more is softer and wider. */
  bloomPasses: number;
  /** Edge darkening in [0, 1]. */
  vignette: number;
  /** 0xRRGGBB multiply tint and how much of it to apply. */
  tint: number;
  tintAmount: number;
  saturation: number;
  contrast: number;
  brightness: number;
  /** Colour lookup: a preset name or 768 bytes (256 RGB entries); null for none. */
  lut: string | Uint8Array | null;
  /** Film grain amount in [0, 1]. */
  grain: number;
  /** Scanline darkening in [0, 1]. */
  scanlines: number;
}

export const defaultPost = (): PostSettings => ({
  bloom: 0,
  bloomThreshold: 0.6,
  bloomPasses: 2,
  vignette: 0,
  tint: 0xffffff,
  tintAmount: 0,
  saturation: 1,
  contrast: 1,
  brightness: 1,
  lut: null,
  grain: 0,
  scanlines: 0,
});

export interface RenderStats {
  drawCalls: number;
  sprites: number;
  /** CPU milliseconds spent between begin and end on the last frame. */
  frameMs: number;
  /** Size of the composed frame in device pixels. */
  targetWidth: number;
  targetHeight: number;
}

export interface RendererOptions {
  /** "native" composes at the canvas backing store's size; a number multiplies the logical size. */
  scale?: "native" | number;
  /** Legacy alias for a numeric scale. */
  renderScale?: number;
}

export interface RendererFeatures {
  lighting: boolean;
  lut: boolean;
  smooth: boolean;
  text: boolean;
  /** Normal-mapped lights and per-draw materials. */
  normals: boolean;
  /** The scratch pass, which shadowed lights need. */
  shadows: boolean;
  /** True 3D triangle meshes with depth testing; absent means unsupported. */
  mesh3D?: boolean;
}

export interface RendererDiagnostics {
  gpu?: { supported: boolean; samples: number; pending: number; medianMs: number | null; p95Ms: number | null };
  mesh?: { geometries: number; textures: number; geometryBytes?: number; textureBytes?: number; targetBytes?: number; meshBytes?: number };
  estimatedGpuBytes?: number;
}
export interface Renderer {
  readonly diagnostics?: RendererDiagnostics;
  profiling?: boolean;
  collectGarbage?(): void;
  readonly kind: RendererKind;
  /** Logical size in game units. Changes only through `setLogicalSize`. */
  readonly width: number;
  readonly height: number;
  readonly stats: RenderStats;
  readonly features: RendererFeatures;
  /** Last 3D stage counters, when supported. */
  readonly stats3D?: RenderStats3D;
  /** Queue one 3D background world before the frame’s 2D world/overlay draws. */
  render3D?(frame: RenderFrame3D): void;
  /** Called by the App when the viewport mode lets the logical size follow the window. */
  setLogicalSize(width: number, height: number): void;
  /** Called by the App whenever the canvas's CSS size or device pixel ratio changes. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  uploadAtlas(atlas: Atlas): void;
  begin(clearColor: number): void;
  /** Switch target. The light pass clears to `clear` (the ambient colour). */
  setPass(pass: Pass, clear?: number): void;
  /** Transform applied to subsequent draws (world to logical screen). */
  setTransform(m: Readonly<Mat>): void;
  sprite(d: SpriteDraw): void;
  rect(x: number, y: number, w: number, h: number, color: number, alpha?: number, additive?: boolean): void;
  text(d: TextDraw): void;
  measureText(text: string, font: FontSpec): TextSize;
  /** Flush, run the post chain and present. `offsetX/Y` shifts the final image (screen shake). */
  end(post: PostSettings, offsetX?: number, offsetY?: number): void;
  /** The kernel this backend batches through, when it has one; retained batches and particles need it. */
  readonly kernel?: Kernel;
  /** Draw a retained kernel batch under the current transform; `cull` is in the batch's own space. */
  drawBatch?(id: number, alpha: number, tint: number, cull: Rect | null, additive: boolean, smooth: boolean): void;
  /** Step a kernel particle emitter by `dt`, spawning at (ex, ey) in the current space, and draw it. */
  drawParticles?(id: number, dt: number, emitting: boolean, ex: number, ey: number, alpha: number, snap: boolean): void;
  /** Draw every live node of a kernel node table under the current transform. */
  drawNodes?(id: number, alpha: number, tint: number, additive: boolean, smooth: boolean): void;
  /** Start a projected layer: ground (x, y, z) through `p`, then the camera affine; `sorted` orders quads by depth. */
  setProjection?(p: ProjectionMatrix, cam: Readonly<Mat>, sorted: boolean): void;
  endProjection?(): void;
  /** A node's transform under the projection: its screen-space linear part, ground position, depth bias and shadow. */
  setTransform3?(a: number, b: number, c: number, d: number, gx: number, gy: number, gz: number, depthBias: number, shadow: boolean, shadowAlpha: number): void;
  /** Draw a kernel world-space batch under the current node's ground position. */
  drawBatch3?(id: number, alpha: number, tint: number, additive: boolean, smooth: boolean): void;
  /** A procedural light under the current transform, normal-mapped where the scene has normals. */
  drawLight?(d: LightDraw): void;
  /** Four points (x0, y0 … x3, y3) in the current space filled with one colour; `erase` for shadows. */
  drawQuad?(points: ArrayLike<number>, color: number, alpha: number, erase?: boolean): void;
  /** Textured triangles: `count` vertices of (x, y, u, v) in the current space, u and v in atlas units. */
  drawMesh?(verts: ArrayLike<number>, count: number, tint: number, alpha: number, additive?: boolean, smooth?: boolean): void;
  /** Add the scratch target onto the light target; call from the light pass. */
  blitScratch?(): void;
  /** Clip subsequent draws to a rect in the current transform's space, until `unclip`. */
  clip?(x: number, y: number, w: number, h: number): void;
  unclip?(): void;
  /** Read back the last presented frame as a PNG data URL, if the backend can. */
  snapshot?(): string | null;
  destroy(): void;
}

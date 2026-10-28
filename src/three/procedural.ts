// Procedural 3D content: tileable surface textures with colour, normal and roughness maps
// (tiles, concrete, metal panels, grass, dirt, rock, sand, planks, bricks, cobbles, hex
// panels), a gradient sky dome with a sun and clouds, and organic geometry (rocks, foliage,
// terrain). It all bakes on the CPU into Texture3D and Geometry3D, so it renders the same on
// WebGL2 and the native hosts with no assets to ship.

import { parseColor, type ColorInput } from "../art/color.ts";
import { fbm, hash01, perlin, ridged, smoothstep, turbulence, worley } from "../art/noise.ts";
import type { Camera3D } from "./camera.ts";
import { Geometry3D } from "./geometry.ts";
import { Material3D, type Material3DOptions } from "./material.ts";
import { Mesh3D } from "./scene.ts";
import { Texture3D } from "./texture.ts";

// ---------------------------------------------------------------------------- surfaces

export type SurfaceKind = "tiles" | "concrete" | "metal" | "grass" | "dirt" | "rock" | "sand" | "planks" | "bricks" | "cobbles" | "hex" | "plaster";

export interface SurfaceOptions {
  /** Texture size in texels (power of two recommended). Default 256. */
  size?: number;
  seed?: number;
  /** Main colour; each kind has a fitting default. */
  color?: ColorInput;
  /** Secondary colour (grout, seams, stains, dry grass). */
  accent?: ColorInput;
  /** Repetitions of the pattern across the texture (tiles per side, planks, panels). */
  repeat?: number;
  /** Normal-map strength. Default 1. */
  bump?: number;
  /** Colour variation between cells and patches, 0..1. Default per kind. */
  variation?: number;
  /** Wear, dirt and cracks, 0..1. Default 0.4. */
  wear?: number;
}

export interface SurfaceTextures {
  map: Texture3D;
  normalMap: Texture3D;
  metallicRoughnessMap: Texture3D;
  /** Suggested material settings to pair with the maps. */
  material: Material3DOptions;
}

type RGB = [number, number, number];
const rgbOf = (c: ColorInput): RGB => {
  const p = parseColor(c);
  return [p.r / 255, p.g / 255, p.b / 255];
};
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mulRGB = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const frac = (v: number): number => v - Math.floor(v);

interface Sample {
  height: number;
  color: RGB;
  rough: number;
  metal: number;
}

const DEFAULTS: Record<SurfaceKind, { color: string; accent: string; repeat: number; variation: number }> = {
  tiles: { color: "#b9b2a5", accent: "#5d574f", repeat: 4, variation: 0.25 },
  concrete: { color: "#8e8c86", accent: "#5c5a56", repeat: 1, variation: 0.3 },
  metal: { color: "#7c8590", accent: "#3a4048", repeat: 2, variation: 0.15 },
  grass: { color: "#4f7a37", accent: "#8f9a45", repeat: 1, variation: 0.45 },
  dirt: { color: "#6e5440", accent: "#4a382b", repeat: 1, variation: 0.35 },
  rock: { color: "#7d7a74", accent: "#4b4945", repeat: 1, variation: 0.3 },
  sand: { color: "#cdb487", accent: "#a88e63", repeat: 1, variation: 0.2 },
  planks: { color: "#8a6142", accent: "#3f2a1c", repeat: 5, variation: 0.35 },
  bricks: { color: "#9a5541", accent: "#cfc6b4", repeat: 4, variation: 0.3 },
  cobbles: { color: "#86827a", accent: "#3c3a36", repeat: 5, variation: 0.35 },
  hex: { color: "#3a4a5c", accent: "#1c242e", repeat: 4, variation: 0.15 },
  plaster: { color: "#d8cfbf", accent: "#a99f8e", repeat: 1, variation: 0.2 },
};

function sampler(kind: SurfaceKind, o: SurfaceOptions): (u: number, v: number) => Sample {
  const d = DEFAULTS[kind];
  const seed = o.seed ?? 1;
  const base = rgbOf(o.color ?? d.color);
  const accent = rgbOf(o.accent ?? d.accent);
  const n = o.repeat ?? d.repeat;
  const vary = o.variation ?? d.variation;
  const wear = o.wear ?? 0.4;
  // Fractal noise tiling once over the texture at frequency `f` cells.
  const F = (u: number, v: number, f: number, s = 0, octaves = 5) => fbm(u * f, v * f, { seed: seed + s, octaves, period: f });
  switch (kind) {
    case "tiles": {
      const grout = 0.035;
      return (u, v) => {
        const x = u * n;
        const y = v * n;
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const fx = x - ix;
        const fy = y - iy;
        const edge = Math.min(fx, fy, 1 - fx, 1 - fy);
        const tile = smoothstep(grout, grout + 0.05, edge);
        const id = hash01(((ix % n) + n) % n, ((iy % n) + n) % n, seed);
        const surf = F(u, v, 8, 3) * 0.5 + F(u, v, 32, 5, 3) * 0.25;
        const stain = smoothstep(0.1, 0.6, F(u, v, 3, 9)) * wear;
        let c = mulRGB(base, 0.9 + (id - 0.5) * vary + surf * 0.15);
        c = mixRGB(c, mulRGB(c, 0.75), stain);
        c = mixRGB(accent, c, tile);
        return { height: tile * (0.85 + surf * 0.1), color: c, rough: 0.45 + (1 - tile) * 0.4 + stain * 0.2, metal: 0 };
      };
    }
    case "concrete":
    case "plaster":
      return (u, v) => {
        const blot = F(u, v, 4, 1);
        const grain = F(u, v, 64, 2, 2);
        const crack = kind === "concrete" ? Math.max(0, 1 - ridged(u * 3, v * 3, { seed: seed + 4, period: 3, octaves: 4 }) * 1.15) : 0;
        const pit = kind === "concrete" ? smoothstep(0.62, 0.72, perlin(u * 40, v * 40, seed + 6, 40) * 0.5 + 0.5) : 0;
        let c = mulRGB(base, 1 + blot * vary * 0.8 + grain * 0.06);
        c = mixRGB(c, accent, (smoothstep(0.15, 0.7, F(u, v, 2, 8)) * 0.5 + crack * 0.8) * wear);
        return { height: 0.5 + grain * 0.05 + blot * 0.05 - crack * 0.4 * wear - pit * 0.15, color: c, rough: 0.8 + grain * 0.1, metal: 0 };
      };
    case "metal":
      return (u, v) => {
        const x = u * n;
        const y = v * n;
        const fx = frac(x);
        const fy = frac(y);
        const edge = Math.min(fx, fy, 1 - fx, 1 - fy);
        const seam = smoothstep(0.008, 0.02, edge);
        const id = hash01(Math.floor(x) % n, Math.floor(y) % n, seed);
        const brush = perlin(u * 4, v * 160, seed + 2, 4) * 0.5 + perlin(u * 8, v * 320, seed + 3, 8) * 0.25;
        const rivX = Math.min(fx, 1 - fx);
        const rivY = Math.min(fy, 1 - fy);
        const rivet = smoothstep(0.022, 0.012, Math.hypot(rivX - 0.05, rivY - 0.05));
        const grime = smoothstep(0.2, 0.75, F(u, v, 3, 7)) * wear;
        let c = mulRGB(base, 0.9 + (id - 0.5) * vary + brush * 0.08);
        c = mixRGB(c, accent, grime * 0.6 + (1 - seam) * 0.7);
        return { height: 0.6 * seam + rivet * 0.25 + brush * 0.02, color: c, rough: 0.32 + grime * 0.45 + (1 - seam) * 0.3 + Math.abs(brush) * 0.1, metal: 1 - grime * 0.6 - (1 - seam) * 0.5 };
      };
    case "grass":
      return (u, v) => {
        const patch = F(u, v, 3, 1);
        const dry = smoothstep(0.05, 0.55, F(u, v, 2, 2)) * vary;
        const blades = turbulence(u * 48, v * 48, { seed: seed + 3, period: 48, octaves: 3 });
        const fine = perlin(u * 128, v * 128, seed + 5, 128);
        let c = mulRGB(base, 0.85 + patch * 0.3 + blades * 0.35 + fine * 0.08);
        c = mixRGB(c, accent, dry);
        const soil = smoothstep(0.55, 0.8, F(u, v, 6, 9)) * wear * 0.6;
        c = mixRGB(c, [0.27, 0.21, 0.15], soil);
        return { height: 0.4 + blades * 0.5 + fine * 0.05 - soil * 0.2, color: c, rough: 0.9, metal: 0 };
      };
    case "dirt":
      return (u, v) => {
        const big = F(u, v, 3, 1);
        const cells = worley(u * 16, v * 16, seed + 2, 16);
        const pebble = smoothstep(0.32, 0.18, cells.f1);
        let c = mulRGB(base, 0.9 + big * vary + perlin(u * 64, v * 64, seed + 3, 64) * 0.06);
        c = mixRGB(c, accent, smoothstep(0, 0.5, F(u, v, 5, 4)) * 0.5);
        c = mixRGB(c, mixRGB([0.55, 0.52, 0.48], base, 0.4 + cells.id * 0.3), pebble * 0.85);
        return { height: 0.4 + big * 0.1 + pebble * (0.3 + cells.id * 0.2), color: c, rough: 0.92 - pebble * 0.2, metal: 0 };
      };
    case "rock":
      return (u, v) => {
        const r = ridged(u * 4, v * 4, { seed, period: 4, octaves: 6 });
        const cells = worley(u * 6, v * 6, seed + 3, 6);
        const crack = smoothstep(0.06, 0.0, cells.f2 - cells.f1) * wear;
        const strata = perlin(u * 2, v * 18, seed + 5, 2) * 0.5;
        let c = mulRGB(base, 0.75 + r * 0.45 + strata * 0.15 + (cells.id - 0.5) * vary * 0.4);
        c = mixRGB(c, accent, crack * 0.8 + smoothstep(0.3, 0.8, F(u, v, 3, 7)) * 0.3);
        return { height: r * 0.8 - crack * 0.4 + strata * 0.1, color: c, rough: 0.85, metal: 0 };
      };
    case "sand":
      return (u, v) => {
        const ripple = Math.sin((v + fbm(u * 2, v * 2, { seed, period: 2, octaves: 3 }) * 0.15) * Math.PI * 2 * 14) * 0.5 + 0.5;
        const grain = perlin(u * 160, v * 160, seed + 4, 160);
        let c = mulRGB(base, 0.92 + ripple * 0.08 + grain * 0.08 + F(u, v, 3, 2) * vary);
        c = mixRGB(c, accent, smoothstep(0.2, 0.7, F(u, v, 4, 5)) * 0.35);
        return { height: ripple * 0.35 + grain * 0.05, color: c, rough: 0.95, metal: 0 };
      };
    case "planks":
      return (u, v) => {
        const x = u * n;
        const ix = Math.floor(x);
        const fx = x - ix;
        const off = hash01(ix % n, 0, seed);
        const len = 1;
        const y = v * len + off;
        const fy = frac(y * 2);
        const gap = Math.min(smoothstep(0.0, 0.04, fx), smoothstep(1, 0.96, fx), smoothstep(0, 0.01, fy), smoothstep(1, 0.99, fy));
        const grain = perlin(fx * 3 + ix * 7, y * 40, seed + ix, 0) * 0.5 + perlin(fx * 8 + ix, y * 120, seed + 2, 0) * 0.25;
        const knot = smoothstep(0.12, 0.0, Math.hypot(fx - 0.5, frac(y * 2 + 0.3) - 0.5) * (1 + hash01(ix, 3, seed) * 3));
        const id = hash01(ix % n, Math.floor(y * 2), seed + 9);
        let c = mulRGB(base, 0.85 + (id - 0.5) * vary + grain * 0.25 - knot * 0.3);
        c = mixRGB(accent, c, gap);
        c = mixRGB(c, mulRGB(c, 0.7), smoothstep(0.3, 0.8, F(u, v, 3, 5)) * wear * 0.5);
        return { height: gap * (0.8 + grain * 0.05), color: c, rough: 0.6 + (1 - gap) * 0.3, metal: 0 };
      };
    case "bricks":
      return (u, v) => {
        const rows = n * 2;
        const y = v * rows;
        const iy = Math.floor(y);
        const x = u * n + (iy % 2) * 0.5;
        const ix = Math.floor(x);
        const fx = x - ix;
        const fy = y - iy;
        const edge = Math.min(fx * 2, fy, (1 - fx) * 2, 1 - fy);
        const brick = smoothstep(0.05, 0.11, edge);
        const id = hash01(((ix % n) + n) % n, iy % rows, seed);
        const surf = F(u, v, 16, 2, 3);
        let c = mulRGB(base, 0.82 + (id - 0.5) * vary * 1.4 + surf * 0.12);
        c = mixRGB(accent, c, brick);
        c = mixRGB(c, mulRGB(c, 0.6), smoothstep(0.3, 0.9, F(u, v, 3, 6)) * wear * 0.5);
        return { height: brick * (0.8 + surf * 0.1), color: c, rough: 0.85, metal: 0 };
      };
    case "cobbles":
      return (u, v) => {
        const cells = worley(u * n, v * n, seed, n, 0.75);
        const gap = smoothstep(0.02, 0.12, cells.f2 - cells.f1);
        const dome = Math.max(0, 1 - cells.f1 * 1.4);
        const surf = F(u, v, 24, 3, 3);
        let c = mulRGB(base, 0.8 + (cells.id - 0.5) * vary * 1.2 + surf * 0.15 + dome * 0.12);
        c = mixRGB(accent, c, gap);
        return { height: gap * (0.4 + dome * 0.5) + surf * 0.03, color: c, rough: 0.75 + (1 - gap) * 0.2, metal: 0 };
      };
    case "hex": {
      return (u, v) => {
        // Hex grid in a tileable 1 x sqrt(3) frame: map v so the pattern repeats exactly.
        const sx = u * n;
        const sy = v * n * 0.8660254 * 2 / Math.sqrt(3);
        const q = (sx * 2) / 3;
        const r = (-sx / 3 + (Math.sqrt(3) / 3) * sy) ;
        let rx = Math.round(q);
        let rz = Math.round(r);
        const ry = Math.round(-q - r);
        const dx = Math.abs(rx - q);
        const dz = Math.abs(rz - r);
        const dy = Math.abs(ry + q + r);
        if (dx > dy && dx > dz) rx = -ry - rz;
        else if (dz > dy) rz = -rx - ry;
        const cx = rx * 1.5;
        const cy = Math.sqrt(3) * (rz + rx / 2);
        const px = Math.abs(sx - cx);
        const py = Math.abs(sy - cy);
        const hexDist = Math.max(px * 0.8660254 + py * 0.5, py);
        const plate = smoothstep(0.86, 0.8, hexDist);
        const id = hash01(rx, rz, seed);
        const surf = F(u, v, 16, 3, 3);
        let c = mulRGB(base, 0.85 + (id - 0.5) * vary * 2 + surf * 0.1);
        c = mixRGB(accent, c, plate);
        return { height: plate * 0.7 + surf * 0.04, color: c, rough: 0.35 + (1 - plate) * 0.4 + surf * 0.1, metal: 0.6 * plate };
      };
    }
  }
}

/** sRGB conversions for packing: albedo maps are sRGB, the rest linear. */
const enc = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * Bake a tileable surface: colour, tangent-space normal and metallic/roughness maps. Use the
 * returned `material` options with `new Material3D({...s.material, ...yours})` and repeat the
 * texture with geometry UVs (see `terrain`, `tiledPlane`).
 */
export function surface(kind: SurfaceKind, o: SurfaceOptions = {}): SurfaceTextures {
  const size = o.size ?? 256;
  const sample = sampler(kind, o);
  const n = size * size;
  const height = new Float32Array(n);
  const albedo = new Uint8Array(n * 4);
  const mr = new Uint8Array(n * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = sample((x + 0.5) / size, (y + 0.5) / size);
      const i = y * size + x;
      height[i] = s.height;
      albedo[i * 4] = enc(s.color[0]);
      albedo[i * 4 + 1] = enc(s.color[1]);
      albedo[i * 4 + 2] = enc(s.color[2]);
      albedo[i * 4 + 3] = 255;
      mr[i * 4] = 255;
      mr[i * 4 + 1] = enc(s.rough);
      mr[i * 4 + 2] = enc(s.metal);
      mr[i * 4 + 3] = 255;
    }
  }
  const normal = heightToNormal(height, size, size, (o.bump ?? 1) * 2.5);
  const tex = (data: Uint8Array) => new Texture3D(size, size, data, "linear", "repeat", "repeat", "linear-mipmap-linear");
  const metal = kind === "metal" || kind === "hex";
  return {
    map: tex(albedo),
    normalMap: tex(normal),
    metallicRoughnessMap: tex(mr),
    material: { roughness: 1, metallic: metal ? 1 : 0 },
  };
}

/** A material using a baked surface's three maps, with extra options merged in. */
export function surfaceMaterial(kind: SurfaceKind, o: SurfaceOptions & Omit<Material3DOptions, "color"> = {}): Material3D {
  const s = surface(kind, o);
  const { size: _s, seed: _seed, color: _c, accent: _a, repeat: _r, bump: _b, variation: _v, wear: _w, ...materialOptions } = o;
  return new Material3D({ ...s.material, map: s.map, normalMap: s.normalMap, metallicRoughnessMap: s.metallicRoughnessMap, ...materialOptions, color: 0xffffff });
}

/** Tileable tangent-space normal map from a height field (Sobel), +y up in green. */
export function heightToNormal(h: Float32Array, w: number, hgt: number, strength = 2): Uint8Array {
  const out = new Uint8Array(w * hgt * 4);
  const at = (x: number, y: number) => h[(((y % hgt) + hgt) % hgt) * w + (((x % w) + w) % w)];
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) * strength;
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) * strength;
      const nx = -dx;
      const ny = dy;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const i = (y * w + x) * 4;
      out[i] = enc((nx / l) * 0.5 + 0.5);
      out[i + 1] = enc((ny / l) * 0.5 + 0.5);
      out[i + 2] = enc((nz / l) * 0.5 + 0.5);
      out[i + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------- sky

export interface SkyOptions {
  /** Colour straight up. */
  zenith?: ColorInput;
  /** Colour at the horizon. */
  horizon?: ColorInput;
  /** Colour below the horizon. */
  ground?: ColorInput;
  /** Direction toward the sun (need not be normalized). */
  sunDirection?: { x: number; y: number; z: number };
  sunColor?: ColorInput;
  /** Angular size of the sun disc in degrees; 0 hides it. */
  sunSize?: number;
  /** Width of the glow around the sun, 0..1. */
  sunGlow?: number;
  /** Cloud cover 0..1. */
  clouds?: number;
  cloudColor?: ColorInput;
  /** Stars in the dark part of the sky, 0..1. */
  stars?: number;
  seed?: number;
  /** Equirectangular texture width; height is half. Default 1024. */
  resolution?: number;
}

const skyCache = new Map<string, Texture3D>();

/**
 * Bake an equirectangular sky texture (u around, v from the zenith down). Identical options
 * return the same texture, so restarting a scene does not bake the sky again.
 */
export function skyTexture(o: SkyOptions = {}): Texture3D {
  const sd = o.sunDirection;
  const key = JSON.stringify({ ...o, sunDirection: sd ? [sd.x, sd.y, sd.z] : null });
  const hit = skyCache.get(key);
  if (hit && !hit.disposed) return hit;
  const t = bakeSky(o);
  skyCache.set(key, t);
  return t;
}

function bakeSky(o: SkyOptions): Texture3D {
  const W = o.resolution ?? 1024;
  const H = W / 2;
  const zen = rgbOf(o.zenith ?? "#3f6fb0");
  const hor = rgbOf(o.horizon ?? "#cfe0ea");
  const gnd = rgbOf(o.ground ?? "#5b6670");
  const sunC = rgbOf(o.sunColor ?? "#fff1d6");
  const sd = o.sunDirection ?? { x: -0.5, y: 0.45, z: 0.6 };
  const sl = Math.hypot(sd.x, sd.y, sd.z) || 1;
  const sx = sd.x / sl;
  const sy = sd.y / sl;
  const sz = sd.z / sl;
  const sunCos = Math.cos(((o.sunSize ?? 2.2) * Math.PI) / 180);
  const glow = o.sunGlow ?? 0.35;
  const cover = o.clouds ?? 0.35;
  const cloudC = rgbOf(o.cloudColor ?? "#ffffff");
  const stars = o.stars ?? 0;
  const seed = o.seed ?? 3;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const theta = ((y + 0.5) / H) * Math.PI;
    const dy = Math.cos(theta);
    for (let x = 0; x < W; x++) {
      const phi = ((x + 0.5) / W) * Math.PI * 2;
      const dx = Math.sin(theta) * Math.sin(phi);
      const dz = Math.sin(theta) * Math.cos(phi);
      let c: RGB;
      if (dy >= 0) {
        const t = Math.pow(dy, 0.45);
        c = mixRGB(hor, zen, t);
      } else c = mixRGB(hor, gnd, smoothstep(0, 0.25, -dy));
      const mu = dx * sx + dy * sy + dz * sz;
      // Glow: a broad halo toward the sun and a tight bright core.
      const halo = Math.pow(Math.max(0, mu), 8 / Math.max(0.05, glow)) * 0.6 + Math.pow(Math.max(0, mu), 200) * 0.6;
      c = [c[0] + sunC[0] * halo, c[1] + sunC[1] * halo, c[2] + sunC[2] * halo];
      if (dy > 0 && cover > 0) {
        // Clouds on a plane above: project the direction, then fractal noise.
        const k = 1 / Math.max(0.08, dy);
        const cx = dx * k * 0.35;
        const cz = dz * k * 0.35;
        const n = fbm(cx, cz, { seed, octaves: 6 }) * 0.5 + 0.5;
        const dens = smoothstep(1 - cover, 1 - cover + 0.35, n) * smoothstep(0.02, 0.2, dy);
        const lit = 0.75 + 0.25 * Math.max(0, mu) + (fbm(cx + 0.05, cz + 0.05, { seed, octaves: 4 }) - fbm(cx, cz, { seed, octaves: 4 })) * 2;
        c = mixRGB(c, mulRGB(mixRGB(cloudC, hor, 0.25), Math.max(0.5, Math.min(1.15, lit))), dens * 0.92);
      }
      if (stars > 0 && dy > 0) {
        const gx = Math.floor(x / 2);
        const gy = Math.floor(y / 2);
        const h = hash01(gx, gy, seed + 77);
        if (h > 1 - stars * 0.01) {
          const b = (h - (1 - stars * 0.01)) / (stars * 0.01);
          const dark = 1 - Math.min(1, (c[0] + c[1] + c[2]) / 1.2);
          c = mixRGB(c, [1, 1, 1], b * dark * smoothstep(0, 0.3, dy));
        }
      }
      if (mu > sunCos && (o.sunSize ?? 2.2) > 0) c = mixRGB(c, [1.4, 1.35, 1.25], smoothstep(sunCos, sunCos + 0.0004, mu));
      const i = (y * W + x) * 4;
      data[i] = enc(c[0]);
      data[i + 1] = enc(c[1]);
      data[i + 2] = enc(c[2]);
      data[i + 3] = 255;
    }
  }
  return new Texture3D(W, H, data, "linear", "repeat", "clamp", "linear");
}

/**
 * A sky sphere that stays centred on the camera, unlit, unfogged and shadowless. Add it to
 * `scene.world3D`; set the environment's fog colour near the sky's horizon so the world fades
 * into it.
 */
export class SkyDome3D extends Mesh3D {
  constructor(
    readonly camera: Camera3D,
    options: SkyOptions | Texture3D = {},
  ) {
    super(Geometry3D.sphere(1, 48, 24), new Material3D({ shading: "unlit", toneMapped: false, fog: false, doubleSided: true, map: options instanceof Texture3D ? options : skyTexture(options) }));
    this.castShadow = false;
    this.receiveShadow = false;
    this.frustumCulled = false;
    this.name = "sky";
  }

  override prepareRender3D(): void {
    super.prepareRender3D();
    const r = this.camera.far * 0.9;
    this.position.set(this.camera.position.x, this.camera.position.y, this.camera.position.z);
    this.scale.set(r, r, r);
  }
}

// ----------------------------------------------------------------------------- geometry

/** Smooth per-vertex normals from positions and triangles. */
export function computeNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      n[k] += nx;
      n[k + 1] += ny;
      n[k + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

/** A unit icosphere's positions and triangles, subdivided `detail` times. */
function icosphere(detail: number): { p: number[]; idx: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const p: number[] = [];
  const add = (x: number, y: number, z: number) => {
    const l = Math.hypot(x, y, z);
    p.push(x / l, y / l, z / l);
    return p.length / 3 - 1;
  };
  [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].forEach(([x, y, z]) => add(x, y, z));
  let faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let d = 0; d < detail; d++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let m = cache.get(key);
      if (m === undefined) {
        m = add((p[a * 3] + p[b * 3]) / 2, (p[a * 3 + 1] + p[b * 3 + 1]) / 2, (p[a * 3 + 2] + p[b * 3 + 2]) / 2);
        cache.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let f = 0; f < faces.length; f += 3) {
      const [a, b, c] = [faces[f], faces[f + 1], faces[f + 2]];
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }
  return { p, idx: faces };
}

/** Box-projected UVs (by dominant normal axis) scaled to `scale` repeats per unit. */
export function boxUVs(p: ArrayLike<number>, n: ArrayLike<number>, scale: number): number[] {
  const uv: number[] = [];
  for (let i = 0; i < p.length; i += 3) {
    const ax = Math.abs(n[i]);
    const ay = Math.abs(n[i + 1]);
    const az = Math.abs(n[i + 2]);
    if (ay >= ax && ay >= az) uv.push(p[i] * scale, p[i + 2] * scale);
    else if (ax >= az) uv.push(p[i + 2] * scale, p[i + 1] * scale);
    else uv.push(p[i] * scale, p[i + 1] * scale);
  }
  return uv;
}

export interface BlobOptions {
  /** Base radius. */
  radius?: number;
  /** Non-uniform scale, e.g. flatter rocks or taller bushes. */
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  /** Displacement as a fraction of the radius. */
  roughness?: number;
  /** Noise frequency over the sphere. */
  frequency?: number;
  /** Subdivisions: 2 is low-poly, 4 is smooth. */
  detail?: number;
  seed?: number;
  /** Flatten the bottom below this fraction of the height (rocks resting on the ground). */
  flattenBelow?: number;
  /** Texture repeats per unit for box-projected UVs. */
  uvScale?: number;
}

/** An organic lump: rocks, boulders, bushes, tree crowns and clouds. */
export function blobGeometry(o: BlobOptions = {}): Geometry3D {
  const { p, idx } = icosphere(o.detail ?? 3);
  const r = o.radius ?? 0.5;
  const rough = o.roughness ?? 0.25;
  const f = o.frequency ?? 1.6;
  const seed = o.seed ?? 1;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    // Three-plane noise approximates 3D noise on the sphere without seams.
    const nn = (fbm(x * f + 3.1, y * f, { seed, octaves: 4 }) + fbm(y * f, z * f + 7.7, { seed: seed + 1, octaves: 4 }) + fbm(z * f + 1.9, x * f, { seed: seed + 2, octaves: 4 })) / 3;
    const k = r * (1 + nn * rough * 2);
    p[i] = x * k * (o.scaleX ?? 1);
    p[i + 1] = y * k * (o.scaleY ?? 1);
    p[i + 2] = z * k * (o.scaleZ ?? 1);
    if (o.flattenBelow !== undefined) {
      const floor = -r * (o.scaleY ?? 1) * o.flattenBelow;
      if (p[i + 1] < floor) p[i + 1] = floor + (p[i + 1] - floor) * 0.15;
    }
  }
  const n = computeNormals(p, idx);
  return new Geometry3D(p, n, idx, boxUVs(p, n, o.uvScale ?? 1));
}

export interface TerrainOptions {
  width?: number;
  depth?: number;
  /** Quads along each side. */
  segments?: number;
  /** Height at world x, z. */
  height?: (x: number, z: number) => number;
  /** Texture repeats per world unit. */
  uvScale?: number;
}

/** A height-field grid centred on the origin with smooth normals and tiling UVs. */
export function terrainGeometry(o: TerrainOptions = {}): Geometry3D {
  const W = o.width ?? 40;
  const D = o.depth ?? 40;
  const S = o.segments ?? 64;
  const hf = o.height ?? (() => 0);
  const uvs = o.uvScale ?? 0.25;
  const p: number[] = [];
  const uv: number[] = [];
  for (let j = 0; j <= S; j++) {
    for (let i = 0; i <= S; i++) {
      const x = (i / S - 0.5) * W;
      const z = (j / S - 0.5) * D;
      p.push(x, hf(x, z), z);
      uv.push(x * uvs, z * uvs);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const a = j * (S + 1) + i;
      const b = a + 1;
      const c = a + S + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return new Geometry3D(p, computeNormals(p, idx), idx, uv);
}

/** A flat plane whose UVs repeat `uvScale` times per unit, for tiled floors and walls. */
export function tiledPlaneGeometry(width: number, depth: number, uvScale = 0.5): Geometry3D {
  return terrainGeometry({ width, depth, segments: 1, uvScale });
}

/**
 * A box (optionally bevelled) whose UVs repeat `uvScale` times per world unit on every face,
 * so a surface texture keeps its scale on walls, plinths and crates of any size.
 */
export function texturedBoxGeometry(width = 1, height = 1, depth = 1, o: { uvScale?: number; bevel?: number } = {}): Geometry3D {
  const g = o.bevel ? Geometry3D.beveledBox(width, height, depth, o.bevel) : Geometry3D.box(width, height, depth);
  return new Geometry3D(g.positions, g.normals, g.indices, boxUVs(g.positions, g.normals, o.uvScale ?? 0.5));
}

/** A Y-axis cylinder (or tapered cone) whose texture keeps world scale: around and along its height. */
export function texturedCylinderGeometry(radius = 0.5, height = 1, o: { radiusTop?: number; segments?: number; uvScale?: number } = {}): Geometry3D {
  const g = Geometry3D.cylinder(radius, height, o.segments ?? 16, o.radiusTop ?? radius);
  const k = o.uvScale ?? 0.5;
  const uv: number[] = [];
  for (let i = 0; i < g.positions.length; i += 3) {
    const x = g.positions[i], y = g.positions[i + 1], z = g.positions[i + 2];
    if (Math.abs(g.normals[i + 1]) > 0.9) uv.push(x * k, z * k);
    else uv.push((Math.atan2(x, z) / (Math.PI * 2) + 0.5) * Math.PI * 2 * radius * k, y * k);
  }
  return new Geometry3D(g.positions, g.normals, g.indices, uv);
}

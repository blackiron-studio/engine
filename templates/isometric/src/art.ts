// Highground's art: smooth, high-resolution isometric tiles (64x32 diamonds, 16 units of rise)
// with textured tops and shaded cliff faces, layered trees and props, an animated sea with
// shoreline foam, glinting sun coins, a four-way hero and a crisp HUD kit. Everything is painted
// here in code at three texels per unit (the HUD at four) and sampled smoothly.
//
// One light for the whole island: the sun sits up and to the left of the screen. Tops are the
// brightest planes, faces turned to the lower left are mid-tone, faces turned to the lower
// right are darkest, and shadows fall toward the lower right (+x on the ground).

import { type Painter, type Paint, blendInto, defineSprite, linear, noise, path, pen, radial } from "@blackiron-studio/engine/art";

export const TILE = { w: 64, h: 32, rise: 16 };

/** Texels per unit for everything in the world. Every tile of the map shares it. */
const D = 3;
/** Extra units around a floor diamond so smooth neighbours overlap instead of seaming. */
const M = 1;
const TW = TILE.w + M * 2;
const TH = TILE.h + M * 2;
export const WATER_FRAMES = 8;

// ------------------------------------------------------------------------------- helpers

type RGB = readonly [number, number, number];
const rgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const { fbm, worley, smoothstep: sstep, hash01 } = noise;

/** Recolour every opaque texel, keeping its alpha; `fn` gets logical x, y. */
function texture(p: Painter, fn: (x: number, y: number, c: RGB) => RGB | null): void {
  const d = p.data, k = p.density;
  for (let ty = 0; ty < p.height; ty++) {
    for (let tx = 0; tx < p.width; tx++) {
      const i = (ty * p.width + tx) * 4;
      if (d[i + 3] === 0) continue;
      const c = fn((tx + 0.5) / k, (ty + 0.5) / k, [d[i], d[i + 1], d[i + 2]]);
      if (!c) continue;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
    }
  }
}

/** Paint an rgba over opaque texels only (alpha kept), `fn` in logical units. */
function overlay(p: Painter, fn: (x: number, y: number) => readonly [number, number, number, number] | null): void {
  const d = p.data, k = p.density;
  for (let ty = 0; ty < p.height; ty++) {
    for (let tx = 0; tx < p.width; tx++) {
      const i = (ty * p.width + tx) * 4;
      if (d[i + 3] === 0) continue;
      const c = fn((tx + 0.5) / k, (ty + 0.5) / k);
      if (c && c[3] > 0) blendInto(d, i, c[0], c[1], c[2], c[3], "inside");
    }
  }
}

/** Fill a fresh texel buffer straight from a function returning rgba (0..255, alpha 0..1). */
function paintAll(p: Painter, fn: (x: number, y: number) => readonly [number, number, number, number] | null): void {
  const d = p.data, k = p.density;
  for (let ty = 0; ty < p.height; ty++) {
    for (let tx = 0; tx < p.width; tx++) {
      const c = fn((tx + 0.5) / k, (ty + 0.5) / k);
      if (!c || c[3] <= 0) continue;
      const i = (ty * p.width + tx) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = clamp01(c[3]) * 255;
    }
  }
}

/** Ground coordinates (0..1 each) of a point in a floor sprite: u runs toward +x, v toward +y. */
function groundUV(x: number, y: number): [number, number] {
  const a = (x - TW / 2) / (TILE.w / 2), b = (y - TH / 2) / (TILE.h / 2);
  return [(a + b) / 2 + 0.5, (b - a) / 2 + 0.5];
}

/** The floor diamond, grown a little so neighbours overlap. */
function diamond(grow = 0.7): ReturnType<typeof path> {
  const cx = TW / 2, cy = TH / 2, hw = TILE.w / 2 + grow * 2, hh = TILE.h / 2 + grow;
  return path().polygon([[cx, cy - hh], [cx + hw, cy], [cx, cy + hh], [cx - hw, cy]]);
}

/** Tile-wide light: brighter toward the far (top) corner, a soft rim toward the sun. */
function tileLight(u: number, v: number): number {
  const edgeLit = 1 - sstep(0, 0.04, u);            // upper-left edge catches the sun
  const edgeDark = sstep(0.96, 1, u) * 0.6 + sstep(0.96, 1, v) * 0.4; // near edges in shade
  return 1.02 - (u + v) * 0.02 + edgeLit * 0.03 - edgeDark * 0.03;
}

function floorTile(name: string, shader: (u: number, v: number) => RGB, lit = true): void {
  defineSprite(name, { w: TW, h: TH, origin: [0.5, 0.5], density: D }, (p) => {
    pen(p).fill(diamond(), "#808080");
    texture(p, (x, y) => {
      const [u0, v0] = groundUV(x, y);
      const u = clamp01(u0), v = clamp01(v0);
      return lit ? mul(shader(u, v), tileLight(u, v)) : shader(u, v);
    });
  });
}

// ------------------------------------------------------------------------------- floors

const GRASS_DARK = rgb("#668c40"), GRASS_MID = rgb("#93b553"), GRASS_LIGHT = rgb("#c5d47a"), GRASS_FLECK = rgb("#e4ef9a");
floorTile("grass.top", (u, v) => {
  const broad = fbm(u * 2, v * 2, { period: 2, octaves: 3, seed: 11 });
  const fine = fbm(u * 9, v * 9, { period: 9, octaves: 3, seed: 12 });
  let c = mixc(GRASS_DARK, GRASS_MID, clamp01(0.82 + broad * 0.35));
  c = mixc(c, GRASS_LIGHT, clamp01(broad * 0.6 + 0.3) * 0.4);
  c = mul(c, 1 + fine * 0.12);
  // Clover and blade highlights: small worley dots, lit on their upper side.
  const w = worley(u * 11, v * 11, 31, 11);
  if (w.id < 0.42) {
    const t = 1 - sstep(0.1, 0.24, w.f1);
    c = mixc(c, w.id < 0.14 ? GRASS_FLECK : mul(GRASS_DARK, 0.92), t * 0.55);
  }
  return c;
});

const SAND_DARK = rgb("#d8b77a"), SAND_MID = rgb("#ecd39b"), SAND_LIGHT = rgb("#f9ebc4");
floorTile("sand.top", (u, v) => {
  const broad = fbm(u * 2, v * 2, { period: 2, octaves: 3, seed: 21 });
  const ripple = Math.sin((u * 4 + v * 2) * Math.PI * 2 + fbm(u * 3, v * 3, { period: 3, octaves: 2, seed: 22 }) * 4);
  let c = mixc(SAND_MID, SAND_LIGHT, clamp01(0.45 + broad));
  c = mixc(c, SAND_DARK, sstep(0.55, 1, ripple) * 0.35);
  c = mixc(c, SAND_LIGHT, sstep(0.55, 1, -ripple) * 0.25);
  const grain = hash01(Math.floor(u * 160), Math.floor(v * 160), 23);
  if (grain > 0.93) c = mul(c, 0.9);
  else if (grain < 0.05) c = mixc(c, [255, 255, 245], 0.4);
  return c;
});

const SLAB = rgb("#e9dcc0"), SLAB_WARM = rgb("#f2e0bb"), SLAB_COOL = rgb("#dcd3bd"), GROUT = rgb("#b3a07e"), MOSS = rgb("#8aa452");
floorTile("stone.top", (u, v) => {
  // Two by two flagstones per cell, each with its own tone and a raised, bevelled edge.
  const su = (u * 2) % 1, sv = (v * 2) % 1, iu = Math.floor(u * 2), iv = Math.floor(v * 2);
  const tone = hash01(iu, iv, 41);
  let c = mixc(SLAB, tone < 0.5 ? SLAB_COOL : SLAB_WARM, Math.abs(tone - 0.5) * 1.4);
  const stain = fbm(u * 4, v * 4, { period: 4, octaves: 4, seed: 42 });
  c = mul(c, 1 + stain * 0.12);
  const grit = fbm(u * 18, v * 18, { period: 18, octaves: 2, seed: 43 });
  c = mul(c, 1 + grit * 0.06);
  const edge = Math.min(su, sv, 1 - su, 1 - sv);
  const lit = 1 - sstep(0.02, 0.1, Math.min(su, sv));
  const shade = 1 - sstep(0.02, 0.1, Math.min(1 - su, 1 - sv));
  c = mul(c, 1 + lit * 0.07 - shade * 0.07);
  // Hairline cracks from ridged noise, and moss creeping in from the joints.
  const crack = noise.ridged(u * 5, v * 5, { period: 5, octaves: 3, seed: 44 });
  if (crack > 0.82) c = mul(c, 0.86);
  const grout = (1 - sstep(0.012, 0.03, edge)) * 0.75;
  const mossy = sstep(0.1, 0.45, fbm(u * 3, v * 3, { period: 3, octaves: 3, seed: 45 }));
  c = mixc(c, mixc(GROUT, MOSS, mossy), grout);
  c = mixc(c, MOSS, mossy * (1 - sstep(0.04, 0.12, edge)) * 0.5);
  return c;
});

// The sea: shallow turquoise with drifting caustic light, looping over WATER_FRAMES frames.
// Per-cell tints in the game deepen it away from the shore.
const SEA = rgb("#3fb9bd"), SEA_DEEP = rgb("#2a9cae"), CAUSTIC = rgb("#c4f6ec");
for (let f = 0; f < WATER_FRAMES; f++) {
  const t = f / WATER_FRAMES;
  floorTile(`water.${f}`, (u, v) => {
    const swell = fbm(u * 2 + t * 2, v * 2, { period: 2, octaves: 3, seed: 61 });
    let c = mixc(SEA_DEEP, SEA, clamp01(0.55 + swell * 1.2));
    const a = worley(u * 2 + t * 2, v * 2 + t * 0, 62, 2);
    const b = worley(u * 3, v * 3 - t * 3, 63, 3);
    const lines = (1 - sstep(0, 0.09, a.f2 - a.f1)) * 0.5 + (1 - sstep(0, 0.07, b.f2 - b.f1)) * 0.35;
    c = mixc(c, CAUSTIC, clamp01(lines) * 0.5);
    return c;
  }, false);
}

// ------------------------------------------------------------------------------- terrace faces

/** Extra units above a face (its rim sits on the floor edge) and below (overlap with what's under). */
const RIM = 1, UNDER = 1;
const FACE_H = TILE.rise + TILE.h / 2 + RIM + UNDER;

type FaceShader = (s: number, t: number, side: "left" | "right") => RGB | null;

/**
 * A cliff face below a floor edge. `s` runs 0..1 along the face (seamless at 0 and 1), `t` is
 * units below the floor edge (-RIM at the rim, 16 at the foot).
 */
function cliffFace(name: string, side: "left" | "right", shader: FaceShader): void {
  // E units of overlap on every side, so neighbouring faces meet without hairline seams.
  const w = TILE.w / 2, E = 0.6, H = FACE_H;
  const left = side === "left";
  const anchor: [number, number] = [left ? w + E : E, RIM + E];
  defineSprite(name, { w: w + E * 2, h: H + E * 2, origin: [anchor[0] / (w + E * 2), anchor[1] / (H + E * 2)], density: D }, (p) => {
    const top = (x: number) => (left ? x / 2 : TILE.h / 2 - x / 2);
    const raw: [number, number][] = left
      ? [[-E, -E / 2], [w + E, TILE.h / 2 + E / 2], [w + E, H + E / 2], [-E, H - TILE.h / 2 - E / 2]]
      : [[-E, TILE.h / 2 + E / 2], [w + E, -E / 2], [w + E, H - TILE.h / 2 - E / 2], [-E, H + E / 2]];
    pen(p).fill(path().polygon(raw.map(([x, y]) => [x + E, y + E] as [number, number])), "#808080");
    texture(p, (px, py) => {
      const x = px - E, y = py - E;
      return shader((((x / w) % 1) + 1) % 1, y - RIM - top(x), side);
    });
  });
}

const EARTH_TOP = rgb("#d6a26a"), EARTH_LOW = rgb("#b07448"), EARTH_BAND = rgb("#c98c58"), LIP = rgb("#79a843"), LIP_DARK = rgb("#4f7c34"), RIM_LIGHT = rgb("#e4f0a0");
const grassFace: FaceShader = (s, t, side) => {
  const k = side === "left" ? 1 : 0.7;
  const drip = 2.6 + Math.abs(Math.sin(s * Math.PI * 5)) * 1.1 + fbm(s * 4, 0, { period: 4, octaves: 2, seed: 71 }) * 1.6;
  if (t < 0.35) return mixc(RIM_LIGHT, LIP, sstep(-1, 0.35, t) * 0.5);
  if (t < drip) {
    const g = mixc(LIP, LIP_DARK, (t - 0.35) / drip);
    return mul(g, k * (side === "left" ? 1 : 0.92));
  }
  // Earth with warped strata, darker in the band under the grass and toward the foot.
  const warp = fbm(s * 3, t * 0.2, { period: 3, octaves: 3, seed: 72 });
  const strata = Math.sin((t + warp * 3) * 1.25);
  let c = mixc(EARTH_TOP, EARTH_LOW, clamp01(t / 16));
  c = mixc(c, EARTH_BAND, sstep(0.4, 1, strata) * 0.5);
  const pebble = worley(s * 6, t * 0.45, 73, 6);
  if (pebble.id < 0.35) {
    const pb = 1 - sstep(0.16, 0.26, pebble.f1);
    c = mixc(c, mul(rgb("#e8c899"), 1 - (pebble.id) * 0.4), pb * 0.6);
  }
  c = mul(c, 1 + fbm(s * 12, t * 0.8, { period: 12, octaves: 2, seed: 74 }) * 0.1);
  const underLip = 1 - sstep(drip, drip + 2.6, t);
  const foot = sstep(9, 17, t);
  return mul(c, k * (1 - underLip * 0.32 - foot * 0.28));
};
cliffFace("cliff.left", "left", grassFace);
cliffFace("cliff.right", "right", grassFace);

const BLOCK = rgb("#e2cfa8"), BLOCK_DARK = rgb("#c4ab82"), MORTAR = rgb("#8f7a5c"), CAP = rgb("#f3e6c8");
const stoneFace: FaceShader = (s, t, side) => {
  const k = side === "left" ? 0.94 : 0.68;
  if (t < 0.3) return mul(rgb("#fff5dc"), side === "left" ? 1 : 0.86);
  if (t < 2.6) return mul(mixc(CAP, BLOCK, (t - 0.3) / 2.3), k);
  if (t < 3.4) return mul(MORTAR, k * 0.8);
  const ct = t - 3.4, course = Math.floor(ct / 6.4), ft = ct - course * 6.4;
  const len = 0.5, off = course % 2 ? 0.25 : 0;
  const bs = ((s + off) % 1) / len, bi = Math.floor(bs), fs = bs - bi;
  const tone = hash01(bi + course * 7, course, 81);
  let c = mixc(BLOCK, BLOCK_DARK, tone * 0.7);
  c = mul(c, 1 + fbm(s * 8, t * 0.5, { period: 8, octaves: 3, seed: 82 }) * 0.12);
  const lit = 1 - sstep(0.2, 1.1, ft);
  const low = sstep(4.6, 6.0, ft);
  c = mul(c, 1 + lit * 0.12 - low * 0.12);
  const joint = Math.min(fs * len * 32, (1 - fs) * len * 32);
  if (ft > 5.9 || joint < 0.45) c = MORTAR;
  const foot = sstep(9, 17, t);
  return mul(c, k * (1 - foot * 0.25));
};
cliffFace("stone.cliff.left", "left", stoneFace);
cliffFace("stone.cliff.right", "right", stoneFace);

// ------------------------------------------------------------------------------- floor decals

/**
 * Soft occlusion on a lower floor where a terrace rises behind it: `w` for a higher cell
 * toward -x (the upper-left edge, which also takes the cast shadow), `n` toward -y, `c` for a
 * higher diagonal corner only.
 */
const AO = rgb("#1d3a4a");
for (const [name, fn] of [
  ["ao.w", (u: number, v: number) => 1 - sstep(0, 0.42, u + Math.max(0, 0.08 - v) * 0)],
  ["ao.n", (u: number, v: number) => (1 - sstep(0, 0.26, v)) * 0.75],
  ["ao.c", (u: number, v: number) => 1 - sstep(0, 0.3, Math.hypot(u, v))],
] as const) {
  defineSprite(name, { w: TW, h: TH, origin: [0.5, 0.5], density: D }, (p) => {
    const mask = p.blank();
    pen(mask).fill(diamond(0.4), "#000000");
    paintAll(p, (x, y) => {
      const i = (Math.floor(y * D) * p.width + Math.floor(x * D)) * 4;
      const cover = mask.data[i + 3] / 255;
      if (!cover) return null;
      const [u, v] = groundUV(x, y);
      const a = fn(clamp01(u), clamp01(v));
      return [AO[0], AO[1], AO[2], a * a * 0.5 * cover];
    });
  });
}

/** Foam and a bright shallow band on a water cell along an edge that meets land. */
const FOAM = rgb("#f4fff9"), SHALLOW = rgb("#8fe3d6");
for (const dir of ["w", "n", "e", "s"] as const) {
  defineSprite(`foam.${dir}`, { w: TW, h: TH, origin: [0.5, 0.5], density: D }, (p) => {
    const mask = p.blank();
    pen(mask).fill(diamond(0.4), "#000000");
    paintAll(p, (x, y) => {
      const i = (Math.floor(y * D) * p.width + Math.floor(x * D)) * 4;
      const cover = mask.data[i + 3] / 255;
      if (!cover) return null;
      const [u0, v0] = groundUV(x, y);
      const u = clamp01(u0), v = clamp01(v0);
      const d = dir === "w" ? u : dir === "n" ? v : dir === "e" ? 1 - u : 1 - v;
      const along = dir === "w" || dir === "e" ? v : u;
      const wob = fbm(along * 4, 0.5, { period: 4, octaves: 2, seed: dir.charCodeAt(0) }) * 0.05;
      const shallow = (1 - sstep(0, 0.45, d)) * 0.55;
      const line = 1 - sstep(0.02, 0.07, Math.abs(d - 0.06 - wob));
      const line2 = (1 - sstep(0.01, 0.035, Math.abs(d - 0.2 - wob * 1.6))) * sstep(0.35, 0.6, Math.sin(along * Math.PI * 8 + wob * 30) * 0.5 + 0.5);
      const edge = 1 - sstep(0, 0.03, d);
      const foam = clamp01(line + line2 * 0.75 + edge);
      const c = mixc(SHALLOW, FOAM, foam);
      return [c[0], c[1], c[2], clamp01(shallow + foam * 0.95) * cover];
    });
  });
}

// ------------------------------------------------------------------------------- shadows

defineSprite("shadow", { w: 28, h: 14, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).ellipse(14, 7, 13, 6, radial(14, 7, 13, [[0, "#14303ccc"], [0.6, "#14303c66"], [1, "#14303c00"]], 6));
});

// Already projected ellipses: placed at the actual terrace height, below the standing actor.
defineSprite("contact", { w: 38, h: 18, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).ellipse(19, 9, 18, 8.5, radial(19, 9, 18, [[0, "#143040a8"], [0.45, "#14304070"], [1, "#14304000"]], 8.5));
});

// Trees and tall props cast long, soft shadows toward the lower right.
defineSprite("shadow.cast", { w: 64, h: 34, origin: [0.25, 0.4], density: D }, (p) => {
  const v = pen(p);
  v.with(() => {
    v.translate(28, 16).rotate(Math.atan2(1, 2));
    v.ellipse(0, 0, 22, 9, radial(0, 0, 22, [[0, "#14304088"], [0.55, "#14304055"], [1, "#14304000"]], 9));
  });
  v.ellipse(16, 13.6, 12, 6, radial(16, 13.6, 12, [[0, "#14304070"], [1, "#14304000"]], 6));
});

// ------------------------------------------------------------------------------- hero

// A small explorer: chestnut hair, teal coat, sun-gold scarf, leather boots and a satchel.
// Stride poses swing the arms and legs; west is east mirrored.
const SKIN_LIGHT = "#ffe4c9", SKIN = "#f4bd92", HAIR_LIGHT = "#8a5638", HAIR = "#4d2d22", COAT_LIGHT = "#5cc4b6", COAT = "#2b828a", COAT_DARK = "#226670";
const SCARF_LIGHT = "#ffd76a", SCARF = "#f19a3a", PANTS = "#34455f", BOOT = "#6d4630", INK = "#1b2a36";

function hero(name: string, facing: "s" | "n" | "e" | "w", stride = 0) {
  defineSprite(name, { w: 26, h: 36, origin: [0.5, 0.985], density: D }, (p) => {
    const v = pen(p);
    if (facing === "w") v.translate(26, 0).scale(-1, 1);
    const side = facing === "e" || facing === "w";
    const legL = -stride * 1.3, legR = stride * 1.3, armL = stride * 1.4, armR = -stride * 1.4;
    // Legs and boots.
    for (const [x, dl] of [[9.3, legL], [13.4, legR]] as const) {
      const lx = side ? x + 0.6 + dl * 0.8 : x;
      v.roundRect(lx, 26.5, 3.4, 6 + (side ? 0 : dl * 0.5), 1.2, linear(lx, 0, lx + 3.4, 0, [[0, "#465a78"], [1, PANTS]]));
      const by = 31.2 + (side ? 0 : Math.max(0, dl * 0.5));
      v.roundRect(lx - 0.4 + (side ? 0.4 : 0), by, side ? 4.6 : 4.2, 3.4, [1.4, 1.4, 1.1, 1.1], linear(0, by, 0, by + 3.4, [[0, "#8c5d3e"], [1, BOOT]]));
      v.roundRect(lx - 0.2, by + 2.6, side ? 4.8 : 4.6, 0.9, 0.45, "#3a2a22");
    }
    // Back arm (behind the body when side-on).
    if (side) {
      v.roundRect(10.8 + armR * 0.6, 18.8, 3.4, 7.6, 1.7, COAT_DARK);
      v.circle(12.5 + armR * 0.7, 26.4, 1.5, SKIN);
    }
    // Satchel on the back.
    if (side) {
      v.roundRect(4.8, 19.6, 4, 7.2, 1.6, linear(4.8, 0, 8.8, 0, [[0, "#b98353"], [1, "#7c5031"]]));
    }
    // Coat.
    const coat = linear(6, 17, 20, 30, [[0, COAT_LIGHT], [0.55, COAT], [1, COAT_DARK]]);
    if (facing === "n") v.roundRect(6.6, 17.6, 12.8, 12.4, [4, 4, 3, 3], coat), v.roundRect(7.6, 18.6, 10.8, 8.8, 2.2, linear(7.6, 18, 18.4, 27, [[0, "#b98353"], [1, "#7c5031"]])), v.roundRect(7.6, 18.6, 10.8, 3.4, [2.2, 2.2, 0.8, 0.8], linear(0, 18.6, 0, 22, [[0, "#d29a63"], [1, "#9a6a40"]])), v.circle(13, 21.6, 0.8, "#ffd76a");
    else v.roundRect(side ? 7.4 : 6.6, 17.6, side ? 11.6 : 12.8, 12.4, [4, 4, 3, 3], coat);
    if (facing === "s") {
      v.line(13, 20, 13, 29.4, 0.6, "#1f5c63", { opacity: 0.8 });
      v.circle(14.4, 22.4, 0.55, "#ffd76a");
      v.circle(14.4, 24.8, 0.55, "#ffd76a");
    }
    if (facing !== "n") {
      v.roundRect(side ? 7.4 : 6.6, 25.2, side ? 11.6 : 12.8, 1.7, 0.6, "#6a4329");
      v.roundRect(side ? 14.6 : 11.8, 25, 2.4, 2.1, 0.5, "#ffd76a");
    }
    // Front arms.
    if (side) {
      v.roundRect(12.6 + armL * 0.7, 18.6, 3.6, 7.8, 1.8, linear(12, 18, 16, 26, [[0, COAT_LIGHT], [1, COAT]]));
      v.circle(14.4 + armL * 0.9, 26.6, 1.6, linear(13, 25, 16, 28, [[0, SKIN_LIGHT], [1, SKIN]]));
    } else {
      v.roundRect(4.2, 18.6 + armL * 0.5, 3.6, 8, 1.8, linear(4, 18, 8, 26, [[0, COAT_LIGHT], [1, COAT]]));
      v.roundRect(18.2, 18.6 + armR * 0.5, 3.6, 8, 1.8, linear(18, 18, 22, 26, [[0, COAT], [1, COAT_DARK]]));
      v.circle(6, 26.8 + armL * 0.5, 1.6, SKIN);
      v.circle(20, 26.8 + armR * 0.5, 1.6, SKIN);
    }
    // Scarf, with a tail that streams behind.
    const scarf = linear(7, 16, 19, 20, [[0, SCARF_LIGHT], [1, SCARF]]);
    if (facing === "s") v.roundRect(15.2, 18.2, 2.8, 5.4, 1.2, linear(15, 18, 18, 24, [[0, SCARF], [1, "#d97e2c"]]));
    if (side) v.fill(path().moveTo(9, 17.2).quadTo(5, 18.6, 2.2, 21.8 + stride * 0.6).lineTo(3.4, 22.6 + stride * 0.6).quadTo(6.2, 20.6, 9.6, 19.6).close(), linear(2, 20, 10, 18, [[0, "#d97e2c"], [1, SCARF]]));
    if (facing === "n") v.fill(path().moveTo(11.6, 18.6).quadTo(10.6, 21.6, 11.2, 24.2).lineTo(13, 24).quadTo(12.6, 21.4, 13.4, 18.6).close(), "#e48a33");
    v.roundRect(side ? 8 : 7, 15.8, side ? 11 : 12, 3.6, 1.8, scarf);
    // Head.
    const hx = side ? 13.8 : 13;
    v.circle(hx, 10.6, 8.3, radial(hx - 2.4, 8, 10, [[0, SKIN_LIGHT], [0.7, SKIN], [1, "#e3a37a"]]));
    const hairPaint = linear(hx - 6, 2, hx + 6, 12, [[0, HAIR_LIGHT], [1, HAIR]]);
    if (facing === "n") {
      v.circle(hx, 10.4, 8.5, hairPaint);
      v.fill(path().moveTo(hx - 8, 10).quadTo(hx, 19.5, hx + 8, 10).quadTo(hx, 15, hx - 8, 10).close(), HAIR);
      v.stroke(path().ellipseArc(hx - 1, 8.4, 5.6, 4.6, Math.PI * 1.1, Math.PI * 1.6), 1, "#b0774f", { opacity: 0.8 });
    } else if (facing === "s") {
      v.circle(4.9, 11.6, 1.6, SKIN), v.circle(21.1, 11.6, 1.6, SKIN);
      v.fill(path().smoothPolygon([[4.2, 12.2], [4.4, 6.4], [7.8, 2.6], [13, 1.4], [18.2, 2.6], [21.6, 6.4], [21.8, 12.2], [20.2, 9], [17.6, 7.6], [15.6, 9.2], [13.4, 7.4], [10.6, 9.2], [8.2, 7.8], [5.8, 9.4]]), hairPaint);
      v.stroke(path().ellipseArc(11.5, 6.4, 5.2, 3.4, Math.PI * 1.08, Math.PI * 1.55), 1, "#b0774f", { opacity: 0.85 });
      v.ellipse(9.9, 12.6, 1.15, 1.6, INK), v.ellipse(16.1, 12.6, 1.15, 1.6, INK);
      v.circle(10.3, 12, 0.48, "#ffffff"), v.circle(16.5, 12, 0.48, "#ffffff");
      v.ellipse(7.9, 14.9, 1.6, 0.9, "#ff8f80", { opacity: 0.45 }), v.ellipse(18.1, 14.9, 1.6, 0.9, "#ff8f80", { opacity: 0.45 });
      v.stroke(path().ellipseArc(13, 14.6, 1.3, 1, Math.PI * 0.2, Math.PI * 0.8), 0.55, "#9a4c44");
    } else {
      v.circle(hx - 4.4, 11.8, 1.6, SKIN);
      v.fill(path().smoothPolygon([[hx - 8.4, 13.6], [hx - 8.6, 6.4], [hx - 5, 2.4], [hx + 0.6, 1.4], [hx + 5.8, 2.8], [hx + 8.6, 6.8], [hx + 8.6, 9.4], [hx + 6, 8], [hx + 3.6, 8.8], [hx + 1.4, 7.4], [hx - 1.4, 9], [hx - 3, 12.4], [hx - 5.6, 14.2]]), hairPaint);
      v.stroke(path().ellipseArc(hx, 6.2, 5.2, 3.4, Math.PI * 1.1, Math.PI * 1.6), 1, "#b0774f", { opacity: 0.85 });
      v.ellipse(hx + 1.6, 12.6, 1.05, 1.55, INK), v.ellipse(hx + 6.2, 12.6, 0.9, 1.45, INK);
      v.circle(hx + 2, 12, 0.45, "#ffffff"), v.circle(hx + 6.5, 12, 0.4, "#ffffff");
      v.ellipse(hx + 4.2, 15, 1.5, 0.85, "#ff8f80", { opacity: 0.45 });
      v.stroke(path().ellipseArc(hx + 4.2, 14.8, 1.1, 0.9, Math.PI * 0.2, Math.PI * 0.8), 0.5, "#9a4c44");
    }
    // A clean ink outline, then a soft top-left rim.
    p.dropShadow({ dx: 0, dy: 0, blur: 0.25, spread: 0.75, color: INK, opacity: 1 });
  });
}
for (const facing of ["s", "n", "e", "w"] as const) {
  hero(`hero.${facing}`, facing);
  hero(`hero.${facing}.stepL`, facing, -1);
  hero(`hero.${facing}.stepR`, facing, 1);
}

defineSprite("hero.ring", { w: 44, h: 22, origin: [0.5, 0.5], density: D }, (p) => {
  const v = pen(p);
  v.ellipse(22, 11, 19, 8.2, radial(22, 11, 19, [[0, "#fff3c400"], [0.75, "#fff3c400"], [1, "#fff3c455"]], 8.2));
  v.stroke(path().ellipse(22, 11, 18.4, 7.8), 1.1, linear(4, 0, 40, 0, [[0, "#ffe9a8"], [0.5, "#fffbe8"], [1, "#ffd27a"]]), { opacity: 0.9 });
  p.glowOutside("#ffe2a0", 1.4, 0.5);
});

// ------------------------------------------------------------------------------- vegetation

function blob(cx: number, cy: number, r: number, ry: number, rng: { range(a: number, b: number): number }, n = 11, rough = 0.1) {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + rng.range(-rough, rough);
    pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * ry * k]);
  }
  return path().smoothPolygon(pts);
}

const LEAF_DEEP = "#2f5a36", LEAF_DARK = "#4c8a3e", LEAF = "#86b74c", LEAF_LIGHT = "#c7de72", LEAF_SUN = "#eef4a6";

/** Leaf clumps: soft ambient occlusion between them, a radial sun gradient, worley dapples. */
function foliage(p: Painter, rng: { range(a: number, b: number): number }, clumps: readonly (readonly [number, number, number, number])[], palette = [LEAF_SUN, LEAF_LIGHT, LEAF, LEAF_DARK, LEAF_DEEP]) {
  const c = p.blank();
  const v = pen(c);
  for (const [x, y, r, ry] of clumps) {
    const shape = blob(x, y, r, ry, rng);
    v.fill(blob(x + 0.8, y + 1.6, r, ry, rng), palette[4], { opacity: 0.55 });
    v.fill(shape, radial(x - r * 0.38, y - ry * 0.45, r * 1.35, [[0, palette[0]], [0.22, palette[1]], [0.6, palette[2]], [1, palette[3]]], ry * 1.35));
  }
  const seed = Math.floor(rng.range(0, 1000));
  overlay(c, (x, y) => {
    const w = worley(x * 0.3, y * 0.36, seed);
    const edge = sstep(0.05, 0.4, w.f2 - w.f1);
    const dark = (1 - edge) * 0.1;
    return [30, 70, 40, dark];
  });
  overlay(c, (x, y) => {
    const w = worley(x * 0.3 + 0.3, y * 0.36 + 0.2, seed);
    const hi = (1 - sstep(0.05, 0.22, w.f1)) * sstep(0.6, 0.2, (y - 6) / 60) * 0.3;
    return [240, 248, 180, hi];
  });
  c.bevel({ size: 2.5, strength: 0.4, highlight: "#fbffd0", shadow: "#1d3a28" });
  p.composite(c);
}

defineSprite("tree", { w: 54, h: 72, origin: [0.5, 0.94], density: D }, (p, { rng }) => {
  const v = pen(p);
  v.fill(path().moveTo(23.4, 68.4).quadTo(25.6, 66, 25.4, 58).lineTo(25.8, 42).lineTo(28.6, 42).lineTo(28.8, 58).quadTo(28.6, 66, 31, 68.4).quadTo(27.2, 69.4, 23.4, 68.4).close(), linear(23, 0, 31, 0, [[0, "#c69468"], [0.45, "#8c6142"], [1, "#5b3c2b"]]));
  v.line(27, 50, 19.5, 39, 2, "#7a5338"), v.line(27.4, 48, 35, 38, 1.8, "#6b4830");
  foliage(p, rng, [[27, 36, 22, 17], [17, 38, 11.5, 10], [37.5, 37, 12, 10.5], [20, 25, 11, 10], [35, 24, 11, 10], [27.5, 19, 13, 11.5], [27, 41, 12, 9]]);
});

defineSprite("tree.pine", { w: 54, h: 72, origin: [0.5, 0.94], density: D }, (p, { rng }) => {
  const v = pen(p);
  v.fill(path().moveTo(24.6, 68.4).lineTo(25.6, 54).lineTo(28.4, 54).lineTo(29.4, 68.4).quadTo(27, 69.2, 24.6, 68.4).close(), linear(24, 0, 30, 0, [[0, "#b98a62"], [1, "#5b3c2b"]]));
  const c = p.blank();
  const cv = pen(c);
  const tiers: [number, number, number][] = [[57, 18, 40], [47, 15.5, 30], [37.5, 12.5, 21], [28.5, 9, 12]];
  tiers.forEach(([base, hw, apex], i) => {
    const pts = path().moveTo(27 + rng.range(-0.5, 0.5), apex - 9);
    pts.quadTo(27 + hw * 0.45, base - 8, 27 + hw, base);
    const n = 5;
    for (let k = n; k >= 0; k--) {
      const x0 = 27 + hw - ((2 * hw) / n) * (n - k);
      pts.lineTo(x0, base + (k % 2 ? 1.6 : 0));
    }
    pts.quadTo(27 - hw * 0.45, base - 8, 27, apex - 9).close();
    cv.fill(pts.close(), "#24493a", { opacity: 0.6 });
    cv.fill(pts, linear(27 - hw, 0, 27 + hw, 0, [[0, i === 3 ? "#cfe38a" : "#a6cf6a"], [0.45, "#5f9a52"], [1, "#2c5c45"]]));
  });
  overlay(c, (x, y) => {
    const w = worley(x * 0.5, y * 0.8, 91);
    return [20, 60, 45, (1 - sstep(0.04, 0.2, w.f2 - w.f1)) * 0.3];
  });
  c.bevel({ size: 2, strength: 0.4, highlight: "#f6ffd0", shadow: "#16302a" });
  p.composite(c);
});

defineSprite("bush", { w: 32, h: 22, origin: [0.5, 0.9], density: D }, (p, { rng }) => {
  foliage(p, rng, [[16, 13, 11, 7.5], [10, 13.5, 6.5, 5], [22, 13, 7, 5.5], [14.5, 9, 6.5, 5.5], [19.5, 9.5, 5.5, 4.5]]);
  const v = pen(p);
  for (let i = 0; i < 6; i++) {
    const x = rng.range(7, 25), y = rng.range(7, 15);
    v.circle(x, y, 1.1, "#fff4f0"), v.circle(x, y, 0.45, "#ffc356");
  }
});

defineSprite("flowers", { w: 24, h: 16, origin: [0.5, 0.86], density: D }, (p, { rng }) => {
  const v = pen(p);
  const heads: [number, number, string, string][] = [[5, 7.5, "#ff9a7a", "#ffd56a"], [11.5, 4.5, "#fff3d6", "#ffbf47"], [18.5, 8, "#c8a0f2", "#fff1b8"], [14.5, 10, "#ffd25e", "#e2742f"], [8, 11, "#fff3d6", "#ffbf47"]];
  for (const [x, y] of heads) {
    v.stroke(path().moveTo(x, y).quadTo(x - 0.6, (y + 14) / 2, x - 0.4, 14), 0.6, "#4f8a3e");
    v.fill(path().moveTo(x - 0.4, 12.4).quadTo(x - 3, 11, x - 3.4, 12.6).quadTo(x - 2, 13.6, x - 0.4, 12.8).close(), "#6aa04a");
  }
  for (const [x, y, petal, eye] of heads) {
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + rng.range(0, 0.4);
      v.ellipse(x + Math.cos(a) * 1.25, y + Math.sin(a) * 0.95, 1.05, 0.85, petal);
    }
    v.circle(x, y, 0.65, eye);
  }
  p.dropShadow({ dx: 0.4, dy: 0.6, blur: 0.6, color: "#1d3a28", opacity: 0.35 });
});

defineSprite("grass.tuft", { w: 22, h: 15, origin: [0.5, 0.86], density: D }, (p, { rng }) => {
  const v = pen(p);
  v.ellipse(11, 12.6, 8, 1.8, radial(11, 12.6, 8, [[0, "#2e553a40"], [1, "#2e553a00"]], 1.8));
  for (let i = 0; i < 9; i++) {
    const bx = 5 + i * 1.5 + rng.range(-0.5, 0.5), lean = rng.range(-5, 5), h = rng.range(6, 11);
    const tipX = bx + lean, tipY = 13 - h;
    const blade = path().moveTo(bx - 0.75, 13).quadTo(bx + lean * 0.2, 13 - h * 0.6, tipX, tipY).quadTo(bx + lean * 0.4 + 0.4, 13 - h * 0.5, bx + 0.75, 13).close();
    v.fill(blade, linear(0, 13, 0, tipY, [[0, "#4a7d3a"], [0.6, i % 3 ? "#8cbf52" : "#a9cf5f"], [1, "#d8ea8a"]]));
  }
});

defineSprite("rock", { w: 26, h: 18, origin: [0.5, 0.85], density: D }, (p, { rng }) => {
  const v = pen(p);
  const shape = path().smoothPolygon([[3, 14], [3.6, 9], [7.4, 4.6], [13, 3.2], [18.6, 4.4], [22.6, 8.6], [23.2, 13.6], [18, 15.6], [9, 15.8]]);
  v.fill(shape, radial(9, 5.5, 18, [[0, "#e9e2d2"], [0.4, "#b4ab9c"], [1, "#5f5a5e"]], 13));
  overlay(p, (x, y) => {
    const m = sstep(0.05, 0.3, fbm(x * 0.25, y * 0.4, { seed: 5, octaves: 3 })) * (1 - sstep(4, 8.5, y));
    return [128, 164, 80, m * 0.85];
  });
  v.stroke(path().moveTo(14, 7).quadTo(15.6, 10, 15, 13.4), 0.5, "#6f6558", { opacity: 0.6 });
  p.bevel({ size: 2, strength: 0.45, highlight: "#fffbe8", shadow: "#3b3540" });
  v.ellipse(23.6, 15.2, 2.2, 1.4, radial(23, 14.6, 2.6, [[0, "#e8dcc4"], [1, "#8a7f72"]], 1.8));
  p.dropShadow({ dx: 0.8, dy: 0.8, blur: 1, color: "#14304a", opacity: 0.35 });
  void rng;
});

// A stone lantern for the high plazas.
defineSprite("lamp", { w: 16, h: 36, origin: [0.5, 0.95], density: D }, (p) => {
  const v = pen(p);
  v.roundRect(3.6, 30.4, 8.8, 3.6, 1, linear(3.6, 0, 12.4, 0, [[0, "#f2e6cc"], [1, "#a8977b"]]));
  v.roundRect(6.4, 17, 3.2, 14, 0.8, linear(6.4, 0, 9.6, 0, [[0, "#ece0c4"], [1, "#9c8a6e"]]));
  v.roundRect(4, 15.6, 8, 2, 0.8, linear(4, 0, 12, 0, [[0, "#f5ead0"], [1, "#a8977b"]]));
  v.roundRect(4.8, 8.2, 6.4, 7.6, 1, linear(4.8, 0, 11.2, 0, [[0, "#ece0c4"], [1, "#988670"]]));
  v.roundRect(6.2, 9.6, 3.6, 4.8, 0.6, radial(8, 12, 3.4, [[0, "#fffbe0"], [0.6, "#ffd67a"], [1, "#f0a44a"]]));
  v.fill(path().moveTo(2.4, 8.6).quadTo(8, 2.4, 13.6, 8.6).quadTo(8, 7.4, 2.4, 8.6).close(), linear(2, 0, 14, 0, [[0, "#f5ead0"], [1, "#9c8a6e"]]));
  v.circle(8, 3.6, 1.1, "#d8caa8");
  p.dropShadow({ dx: 0.6, dy: 0.6, blur: 0.8, color: "#14304a", opacity: 0.35 });
  const g = p.blank();
  pen(g).circle(8, 12, 5, radial(8, 12, 5, [[0, "#ffd88066"], [1, "#ffd88000"]]));
  p.composite(g, { mode: "behind" });
});

// Short split-rail fences along a cell edge that meets the sea: `x` runs along the ground's
// +x direction (down-right on screen), `y` along +y (down-left).
for (const axis of ["x", "y"] as const) {
  defineSprite(`fence.${axis}`, { w: 36, h: 26, origin: [0.5, 22 / 26], density: D }, (p) => {
    const v = pen(p);
    if (axis === "y") v.translate(36, 0).scale(-1, 1);
    const at = (s: number, h: number): [number, number] => [18 + s * 15, 22 + s * 7.5 - h];
    const wood = (x0: number) => linear(x0 - 1, 0, x0 + 1.4, 0, axis === "x" ? [[0, "#e1b17a"], [1, "#8a5d38"]] : [[0, "#8a5d38"], [1, "#c99a66"]]);
    for (const h of [4.2, 8.2]) {
      const [x0, y0] = at(-1, h), [x1, y1] = at(1, h);
      v.fill(path().polygon([[x0, y0 - 0.8], [x1, y1 - 0.8], [x1, y1 + 0.8], [x0, y0 + 0.8]]), linear(0, y0 - 1, 0, y0 + 1, [[0, "#e6b986"], [1, "#94653d"]]));
    }
    for (const s of [-1, 0, 1]) {
      const [x, y] = at(s, 0);
      v.roundRect(x - 1.2, y - 11, 2.4, 11.4, [1.2, 1.2, 0.4, 0.4], wood(x));
    }
    p.dropShadow({ dx: 0.8, dy: 0.6, blur: 0.8, color: "#14304a", opacity: 0.35 });
  });
}

// ------------------------------------------------------------------------------- crate

defineSprite("crate", { w: 32, h: 32, origin: [0.5, 0.75], density: D }, (p) => {
  const v = pen(p);
  const cx = 16, cy = 8.4, hw = 15.2, hh = 7.6, rise = 15.6;
  const L = (s: number, t: number): [number, number] => [cx - hw + s * hw, cy + s * hh + t * rise];
  const R = (s: number, t: number): [number, number] => [cx + s * hw, cy + hh - s * hh + t * rise];
  const T = (a: number, b: number): [number, number] => [cx + (a - b) * hw, cy - hh + (a + b) * hh];
  const quad = (f: (s: number, t: number) => [number, number], s0: number, t0: number, s1: number, t1: number, paint: Paint) => v.fill(path().polygon([f(s0, t0), f(s1, t0), f(s1, t1), f(s0, t1)]), paint);
  // Faces: planks, then a darker frame and a diagonal brace.
  quad(L, 0, 0, 1, 1, linear(0, 8, 0, 32, [[0, "#d9a467"], [1, "#a8723f"]]));
  quad(R, 0, 0, 1, 1, linear(0, 8, 0, 32, [[0, "#a87140"], [1, "#7b4f2b"]]));
  quad(T, 0, 0, 1, 1, linear(8, 0, 24, 16, [[0, "#f6d39a"], [1, "#d9a467"]]));
  for (const f of [L, R]) for (const t of [0.34, 0.67]) v.line(...f(0.04, t), ...f(0.96, t), 0.35, "#6b4423", { opacity: 0.5 });
  for (const a of [0.34, 0.67]) v.line(...T(a, 0.04), ...T(a, 0.96), 0.35, "#a8723f", { opacity: 0.6 });
  const frame = (f: (s: number, t: number) => [number, number], col: string) => {
    quad(f, 0, 0, 1, 0.12, col); quad(f, 0, 0.88, 1, 1, col);
    quad(f, 0, 0, 0.12, 1, col); quad(f, 0.88, 0, 1, 1, col);
    v.line(...f(0.1, 0.9), ...f(0.9, 0.1), 1.6, col);
  };
  frame(L, "#b9803f"), frame(R, "#8a5a30");
  quad(T, 0, 0, 1, 0.1, "#ffe3b0"), quad(T, 0, 0, 0.1, 1, "#ffe3b0");
  quad(T, 0.9, 0, 1, 1, "#e0ad6c"), quad(T, 0, 0.9, 1, 1, "#e0ad6c");
  for (const f of [L, R]) for (const [s, t] of [[0.06, 0.06], [0.94, 0.06], [0.06, 0.94], [0.94, 0.94]]) v.circle(...f(s, t), 0.55, "#4a3a33");
  v.line(...L(1, 0), ...L(1, 1), 0.5, "#fff0cf", { opacity: 0.55 });
  p.dropShadow({ dx: 0, dy: 0, blur: 0.2, spread: 0.45, color: "#4a2c18", opacity: 0.9 });
});

// ------------------------------------------------------------------------------- coins and sparks

defineSprite("coin", { w: 12, h: 12, origin: [0.5, 0.5], density: 5 }, (p) => {
  const v = pen(p);
  v.circle(6, 6, 5.5, radial(4.4, 4, 7.5, [[0, "#fff4b8"], [0.45, "#ffd257"], [1, "#d98a1c"]]));
  v.ring(6, 6, 5.1, 0.55, "#b86a12", { opacity: 0.7 });
  v.circle(6, 6, 3.9, radial(6.8, 7, 5, [[0, "#ffd65a"], [1, "#eaa22c"]]));
  v.fill(path().star(6, 6, 3.2, 1.5, 8), linear(3, 3, 9, 9, [[0, "#fff7cf"], [1, "#ffcb4a"]]));
  v.circle(6, 6, 1.35, "#ffe58a");
  v.ellipse(4, 3.6, 1.7, 0.9, "#ffffff", { opacity: 0.75 });
  p.bevel({ size: 0.9, strength: 0.5, highlight: "#fffbe0", shadow: "#8a4a0a" });
});

defineSprite("coin.halo", { w: 30, h: 30, origin: [0.5, 0.5], density: 2 }, (p) => {
  const v = pen(p);
  v.circle(15, 15, 15, radial(15, 15, 15, [[0, "#ffe7a0aa"], [0.35, "#ffcf6a44"], [1, "#ffcf6a00"]]));
  v.fill(path().star(15, 15, 11, 1, 4, Math.PI / 4), "#fff6d0", { opacity: 0.3 });
});

defineSprite("spark", { w: 6, h: 6, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).circle(3, 3, 3, radial(3, 3, 3, [[0, "#fffbe6"], [0.35, "#ffe08a"], [1, "#ffc85a00"]]));
});

defineSprite("glint", { w: 12, h: 12, origin: [0.5, 0.5], density: D }, (p) => {
  const v = pen(p);
  v.circle(6, 6, 4, radial(6, 6, 4, [[0, "#ffffffaa"], [1, "#d8fff700"]]));
  v.fill(path().star(6, 6, 6, 0.7, 4, 0), "#ffffff");
});

defineSprite("marker", { w: TW, h: TH, origin: [0.5, 0.5], density: D }, (p) => {
  const v = pen(p);
  v.fill(diamond(-2.5), radial(TW / 2, TH / 2, 30, [[0, "#ffffff00"], [1, "#fff6d444"]], 15));
  v.stroke(diamond(-2.5), 1, "#fffaf0", { opacity: 0.9 });
  p.glowOutside("#fff0c0", 1.2, 0.6);
});

// ------------------------------------------------------------------------------- HUD kit

/** Panel: rounded, glassy ink with a fine light border and a soft outer shadow (8 units of pad). */
defineSprite("ui.panel", { w: 64, h: 64, origin: [0, 0], density: 4, edge: "clear" }, (p) => {
  const v = pen(p);
  v.roundRect(8, 9.5, 48, 48, 12, "#04121a", { opacity: 0.55 });
  p.blur(3);
  v.roundRect(8, 8, 48, 48, 12, "#000000", { blend: "erase" });
  v.roundRect(8, 8, 48, 48, 12, linear(0, 8, 0, 56, [[0, "#173c46f2"], [1, "#0f2c35f2"]]));
  v.stroke(path().roundRect(8.6, 8.6, 46.8, 46.8, 11.4), 1.1, linear(0, 8, 0, 56, [[0, "#9fd2c4aa"], [0.4, "#6ea89a55"], [1, "#6ea89a33"]]));
  v.stroke(path().roundRect(9.8, 9.8, 44.4, 44.4, 10.2), 0.6, "#ffffff", { opacity: 0.06 });
});

function button(name: string, top: string, bottom: string, border: string) {
  defineSprite(name, { w: 40, h: 40, origin: [0, 0], density: 4, edge: "clear" }, (p) => {
    const v = pen(p);
    v.roundRect(2, 3.2, 36, 35, 9, "#04121a", { opacity: 0.5 });
    p.blur(1.4);
    v.roundRect(2, 2, 36, 35, 9, "#000000", { blend: "erase" });
    v.roundRect(2, 2, 36, 35, 9, linear(0, 2, 0, 37, [[0, top], [1, bottom]]));
    v.stroke(path().roundRect(2.5, 2.5, 35, 34, 8.5), 1, border);
    v.stroke(path().moveTo(9, 3.6).lineTo(31, 3.6), 0.8, "#ffffff", { opacity: 0.18 });
  });
}
button("ui.btn", "#21505a", "#163c45", "#7fb8a8aa");
button("ui.btn.hover", "#2c6670", "#1d4c55", "#c9e6c4");
button("ui.btn.pressed", "#123139", "#0f2a32", "#7fb8a8aa");
button("ui.btn.gold", "#ffe08a", "#f0b445", "#fff3c8");
button("ui.btn.gold.hover", "#fff0b4", "#ffc65a", "#ffffff");

defineSprite("ui.bar.track", { w: 12, h: 8, origin: [0, 0], density: 4, edge: "clear" }, (p) => {
  const v = pen(p);
  v.roundRect(0, 0, 12, 8, 4, linear(0, 0, 0, 8, [[0, "#06171d"], [1, "#1d4650"]]));
  v.stroke(path().roundRect(0.4, 0.4, 11.2, 7.2, 3.6), 0.6, "#6ea89a", { opacity: 0.45 });
});
defineSprite("ui.bar.fill", { w: 12, h: 8, origin: [0, 0], density: 4, edge: "clear" }, (p) => {
  const v = pen(p);
  v.roundRect(0, 0, 12, 8, 4, linear(0, 0, 0, 8, [[0, "#fff1b0"], [0.5, "#ffd257"], [1, "#e99a2a"]]));
  v.roundRect(1.5, 1, 9, 2.2, 1.1, "#ffffff", { opacity: 0.4 });
});

defineSprite("ui.key", { w: 20, h: 20, origin: [0, 0], density: 4, edge: "clear" }, (p) => {
  const v = pen(p);
  v.roundRect(1, 2.2, 18, 17, 4.5, "#071a20");
  v.roundRect(1, 1, 18, 16.4, 4.5, linear(0, 1, 0, 17, [[0, "#2f6670"], [1, "#1f4a53"]]));
  v.stroke(path().roundRect(1.4, 1.4, 17.2, 15.6, 4.1), 0.7, "#9fd2c4", { opacity: 0.55 });
});

// The sun emblem for the title and the finish card.
defineSprite("ui.sun", { w: 48, h: 48, origin: [0.5, 0.5], density: 4 }, (p) => {
  const v = pen(p);
  v.circle(24, 24, 24, radial(24, 24, 24, [[0, "#ffe9a066"], [0.5, "#ffcf6a22"], [1, "#ffcf6a00"]]));
  for (let i = 0; i < 12; i++) {
    v.with(() => {
      v.translate(24, 24).rotate((i / 12) * Math.PI * 2);
      v.fill(path().moveTo(-2.2, -12).lineTo(0, i % 2 ? -19 : -21.5).lineTo(2.2, -12).close(), linear(0, -12, 0, -21, [[0, "#ffc94e"], [1, "#fff1b8"]]));
    });
  }
  v.circle(24, 24, 11, radial(21, 20, 14, [[0, "#fff6c8"], [0.5, "#ffd257"], [1, "#e9962a"]]));
  v.ring(24, 24, 8.4, 0.8, "#fff3c0", { opacity: 0.6 });
  p.bevel({ size: 1.6, strength: 0.4, highlight: "#ffffff", shadow: "#8a4a0a" });
});

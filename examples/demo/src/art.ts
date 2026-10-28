// Every sprite in Wisp Hollow is painted in code at boot as smooth, high-resolution vector
// illustration: one moon light from the top left, cool blue-green night tones, warm lantern
// and ember accents. This module only defines art, so `blackiron atlas` can import it
// headlessly to export PNGs.

import { BUTTON_SKINS, GROUND_GRID, GROUND_TILE } from "./look.ts";
import { defineAnimation, defineRig, defineSprite, defineSpriteSet, defineVariants, linear, noise, path, pen, radial, type Painter, type Path, type Pen } from "@blackiron-studio/engine/art";

type RGB = [number, number, number];
const TAU = Math.PI * 2;
const rgb = (hex: string): RGB => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const h01 = noise.hash01;
const ss = noise.smoothstep;

/** A lumpy closed blob: leaves, clumps, stones. */
function lumpy(cx: number, cy: number, rx: number, ry: number, n: number, seed: number, amount = 0.18): Path {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (h01(i, seed, 3) - 0.5) * 0.4;
    const k = 1 + (h01(i, seed, 5) - 0.5) * 2 * amount;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return path().smoothPolygon(pts);
}

/** Run `fn` on texels that already have paint, in logical units; return [r,g,b,a] or null. */
function shadeInside(p: Painter, fn: (x: number, y: number) => readonly [number, number, number, number] | null, mode: "normal" | "multiply" | "screen" | "overlay" | "soft-light" = "normal"): void {
  const d = p.data;
  const k = 1 / p.density;
  p.shade((x, y) => (d[(y * p.width + x) * 4 + 3] === 0 ? null : fn((x + 0.5) * k, (y + 0.5) * k)), { mode });
}

/** A small leaf, a dab of paint, rotated. */
function leaf(v: Pen, x: number, y: number, len: number, wid: number, a: number, paint: string, opacity = 1): void {
  v.save().translate(x, y).rotate(a);
  v.fill(path().moveTo(-len, 0).quadTo(0, -wid * 1.6, len, 0).quadTo(0, wid * 1.6, -len, 0).close(), paint, { opacity });
  v.restore();
}

// --- Palette --------------------------------------------------------------------------

const GROUND_DEEP = rgb("#24463e");
const GROUND_MOSS = rgb("#3d6a4e");
const GROUND_LIGHT = rgb("#6a9a62");
const GROUND_SOIL = rgb("#4a4434");
const GROUND_LITTER = rgb("#6e5a3a");

interface Foliage {
  deep: string;
  dark: string;
  mid: string;
  light: string;
  tip: string;
  rim: string;
}

const FOLIAGE: Foliage[] = [
  { deep: "#0b1f22", dark: "#143633", mid: "#23574a", light: "#3f8462", tip: "#7cbf8a", rim: "#b8f0c8" },
  { deep: "#0b1f24", dark: "#15363a", mid: "#245a52", light: "#3e8a6c", tip: "#7cc4a0", rim: "#b8f0e0" },
  { deep: "#0d2020", dark: "#173a2f", mid: "#2b5e40", light: "#4c8a52", tip: "#8fc282", rim: "#d0f0b0" },
  { deep: "#0c1d22", dark: "#173638", mid: "#2a544c", light: "#47806a", tip: "#8cbca0", rim: "#c8eee0" },
];

// --- Ground -------------------------------------------------------------------------------

const GROUND_PERIOD = GROUND_TILE * GROUND_GRID;

function groundAt(wx: number, wy: number): RGB {
  const u = wx / GROUND_PERIOD;
  const v = wy / GROUND_PERIOD;
  const big = noise.fbm(u * 4, v * 4, { seed: 3, octaves: 3, period: 4 });
  const mid = noise.fbm(u * 16, v * 16, { seed: 9, octaves: 3, period: 16 });
  const soil = noise.fbm(u * 6, v * 6, { seed: 21, octaves: 2, period: 6 });
  const clump = noise.perlin(u * 40, v * 40, 5, 40);
  const fine = noise.perlin(u * 96, v * 96, 7, 96);
  let c = mix(GROUND_DEEP, GROUND_MOSS, ss(-0.55, 0.5, big * 0.8 + mid * 0.45));
  c = mix(c, GROUND_LIGHT, ss(0.3, 0.85, mid + big * 0.35) * 0.55);
  const s = ss(0.18, 0.5, soil - big * 0.25);
  c = mix(c, mix(GROUND_SOIL, GROUND_LITTER, ss(-0.2, 0.4, mid)), s * 0.7);
  // Grass clumps and a little streaky blade grain.
  const k = 0.95 + clump * 0.1 + fine * 0.035;
  return [c[0] * k, c[1] * k, c[2] * k];
}

export const GROUND = defineVariants("wh.ground", GROUND_GRID * GROUND_GRID, { w: GROUND_TILE, h: GROUND_TILE, origin: [0, 0], density: 0.8, smooth: true, edge: "extrude" }, (p, { index }) => {
  const ox = (index % GROUND_GRID) * GROUND_TILE;
  const oy = Math.floor(index / GROUND_GRID) * GROUND_TILE;
  p.shade((x, y) => {
    const c = groundAt(ox + (x + 0.5) / p.density, oy + (y + 0.5) / p.density);
    return [c[0], c[1], c[2], 255];
  });
});

/** Soft ground patches that break up the tiling: dark moss hollows, lit moss, leaf litter. */
export const PATCHES = defineVariants("wh.patch", 6, { w: 200, h: 130, density: 0.5 }, (p, { index }) => {
  const tones = ["#0f2526", "#0f2526", "#3f6e50", "#3f6e50", "#3e3426", "#2a3a2c"];
  const c = rgb(tones[index]);
  const alpha = [0.55, 0.55, 0.3, 0.3, 0.45, 0.4][index];
  p.shade((x, y, u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const n = noise.fbm(u * 3 + index * 7, v * 2, { seed: 40 + index, octaves: 4 });
    const r = Math.hypot(dx, dy) + n * 0.45;
    const a = ss(1, 0.45, r) * alpha;
    if (a <= 0.004) return null;
    const g = 1 + noise.perlin(u * 18, v * 12, 3 + index) * 0.12;
    return [c[0] * g, c[1] * g, c[2] * g, a * 255];
  });
});

/** Path stamps laid along the trail: a worn, darker edge, then packed earth on top. */
export const PATH_EDGE = defineVariants("wh.path.edge", 3, { w: 84, h: 64, density: 0.75 }, (p, { index }) => {
  p.shade((x, y, u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const n = noise.fbm(u * 4, v * 3, { seed: 60 + index, octaves: 4 });
    const r = Math.hypot(dx, dy) + n * 0.35;
    const a = ss(1, 0.55, r) * 0.6;
    if (a <= 0.004) return null;
    return [36, 40, 34, a * 255];
  });
});

export const PATH_DIRT = defineVariants("wh.path.dirt", 4, { w: 64, h: 50, density: 1.25 }, (p, { index }) => {
  const dark = rgb("#776650");
  const lite = rgb("#b09a76");
  const pale = rgb("#d4c29c");
  p.shade((x, y, u, v) => {
    const lx = u * 64;
    const ly = v * 50;
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const n = noise.fbm(u * 3.5, v * 3, { seed: 80 + index, octaves: 4 });
    const r = Math.hypot(dx, dy) + n * 0.4;
    const a = ss(0.95, 0.4, r);
    if (a <= 0.004) return null;
    const t = noise.fbm(lx / 9, ly / 9, { seed: 90 + index, octaves: 3 });
    const grit = noise.worley(lx / 2.2, ly / 2.2, 95 + index);
    let c = mix(dark, lite, ss(-0.5, 0.45, t));
    c = mix(c, pale, ss(0.25, 0.7, t) * 0.5);
    const g = 0.88 + (1 - Math.min(1, grit.f1)) * 0.16 + (grit.id - 0.5) * 0.06;
    return [c[0] * g, c[1] * g, c[2] * g, a * 0.9 * 255];
  });
});

export const PEBBLES = defineVariants("wh.pebbles", 3, { w: 26, h: 16, density: 2 }, (p, { rng }) => {
  const v = pen(p);
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const x = rng.range(5, 21);
    const y = rng.range(5, 12);
    const r = rng.range(1.6, 3.4);
    v.ellipse(x + 0.6, y + 1, r * 1.05, r * 0.7, "#10161a", { opacity: 0.5 });
    v.fill(lumpy(x, y, r, r * 0.72, 7, i * 13 + 1, 0.15), radial(x - r * 0.4, y - r * 0.5, r * 1.6, [[0, "#b9bdb2"], [0.5, "#7f857f"], [1, "#454b4c"]]));
  }
});

/** Contact and canopy shadows: soft, cool, never black. */
export const SHADOW = defineSprite("wh.shadow.soft", { w: 64, h: 32, density: 0.75 }, (p) => {
  pen(p).ellipse(32, 16, 31, 15, radial(32, 16, 31, [[0, "#06121acc"], [0.55, "#06121a88"], [1, "#06121a00"]], 15));
});

export const CANOPY = defineVariants("wh.shadow.canopy", 2, { w: 220, h: 120, density: 0.4 }, (p, { index }) => {
  p.shade((x, y, u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const n = noise.fbm(u * 4, v * 3, { seed: 120 + index, octaves: 4 });
    const r = Math.hypot(dx, dy) + n * 0.3;
    const a = ss(1, 0.35, r) * 0.62;
    // Dapples of moonlight through the leaves.
    const hole = noise.worley(u * 9, v * 5, 130 + index);
    const dapple = ss(0.18, 0.05, hole.f1) * 0.5;
    if (a <= 0.004) return null;
    return [5, 16, 24, a * (1 - dapple) * 255];
  });
});

// --- Undergrowth ---------------------------------------------------------------------------

function blade(v: Pen, x: number, y: number, h: number, lean: number, w: number, base: string, tip: string): void {
  const tx = x + lean;
  const ty = y - h;
  v.fill(
    path()
      .moveTo(x - w, y)
      .quadTo(x - w * 0.5 + lean * 0.4, y - h * 0.55, tx, ty)
      .quadTo(x + w * 0.6 + lean * 0.45, y - h * 0.5, x + w, y)
      .close(),
    linear(x, y, tx, ty, [[0, base], [1, tip]]),
  );
}

export const TUFTS = defineVariants("tuft", 5, { w: 34, h: 26, origin: [0.5, 0.9], density: 2 }, (p, { rng, index }) => {
  const v = pen(p);
  const pal = FOLIAGE[index % 3];
  v.ellipse(17, 23.4, 11, 2.6, radial(17, 23.4, 11, [[0, "#06121a99"], [1, "#06121a00"]], 2.6));
  const n = 12 + rng.int(0, 6);
  const blades: [number, number, number, number][] = [];
  for (let i = 0; i < n; i++) blades.push([rng.range(7, 27), rng.range(10, 21) * (index === 4 ? 0.7 : 1), rng.range(-7, 7), rng.range(0.7, 1.3)]);
  blades.sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]));
  for (const [x, h, lean, w] of blades) {
    const lit = lean < 0 ? pal.tip : pal.light;
    blade(v, x, 23.5, h, lean, w, pal.deep, lit);
  }
  if (index === 3 || index === 4) {
    // Small night flowers: pale bells catching moonlight.
    const colors = index === 3 ? ["#e8f0ff", "#c9dcff"] : ["#d9c8ff", "#b6a2ff"];
    for (let i = 0; i < 4; i++) {
      const x = rng.range(8, 26);
      const y = rng.range(6, 14);
      v.line(x, y, x + rng.range(-1, 1), 23, 0.5, pal.dark);
      v.circle(x, y, 1.6, radial(x - 0.5, y - 0.6, 2, [[0, "#ffffff"], [0.5, colors[0]], [1, colors[1]]]));
    }
  }
  p.dropShadow({ dx: 0.6, dy: 0.8, blur: 0.8, color: "#030a0e", opacity: 0.45 });
});

export const FERNS = defineVariants("fern", 2, { w: 56, h: 38, origin: [0.5, 0.88], density: 2 }, (p, { rng, index }) => {
  const v = pen(p);
  const pal = FOLIAGE[index === 0 ? 0 : 2];
  v.ellipse(28, 33, 20, 4, radial(28, 33, 20, [[0, "#06121aaa"], [1, "#06121a00"]], 4));
  const fronds = 7;
  for (let f = 0; f < fronds; f++) {
    const a = -Math.PI / 2 + (f / (fronds - 1) - 0.5) * 2.5 + rng.range(-0.1, 0.1);
    const len = rng.range(17, 24) * (1 - Math.abs(f / (fronds - 1) - 0.5) * 0.5);
    const bend = (f / (fronds - 1) - 0.5) * 0.6;
    const pts: [number, number][] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const aa = a + bend * t * t;
      pts.push([28 + Math.cos(aa) * len * t, 33 + Math.sin(aa) * len * t * 0.8]);
    }
    const sideLit = Math.cos(a) < 0;
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = pts[i];
      const [px, py] = pts[i - 1];
      const dir = Math.atan2(y - py, x - px);
      const s = (1 - i / pts.length) * 4 + 1.2;
      const col = i > 6 ? pal.tip : sideLit ? pal.light : pal.mid;
      leaf(v, x + Math.cos(dir - 1.2) * s * 0.7, y + Math.sin(dir - 1.2) * s * 0.7, s * 0.75, s * 0.24, dir - 1.0, col);
      leaf(v, x + Math.cos(dir + 1.2) * s * 0.7, y + Math.sin(dir + 1.2) * s * 0.7, s * 0.75, s * 0.24, dir + 1.0, sideLit ? pal.mid : pal.dark);
    }
    v.stroke(polyline(pts), 0.6, pal.dark);
  }
  p.bevel({ size: 1, strength: 0.35, highlight: pal.rim, shadow: "#020a10" });
  p.dropShadow({ dx: 0.6, dy: 1, blur: 1, color: "#030a0e", opacity: 0.5 });
});

function polyline(pts: ReadonlyArray<readonly [number, number]>): Path {
  const pa = path();
  pts.forEach(([x, y], i) => (i === 0 ? pa.moveTo(x, y) : pa.lineTo(x, y)));
  return pa;
}

// --- Foliage masses: trees and bushes ---------------------------------------------------------

interface CrownSpec {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  clumps: number;
  seed: number;
  pal: Foliage;
  leaves?: number;
}

/** A volumetric crown: a dark mass, overlapping lit clumps, painted leaves, rim light. */
function crown(p: Painter, s: CrownSpec): void {
  const { cx, cy, rx, ry, pal } = s;
  p.layer((l) => {
    const v = pen(l);
    v.fill(lumpy(cx, cy + ry * 0.05, rx * 0.8, ry * 0.8, 16, s.seed, 0.1), pal.deep);
    const clumps: { x: number; y: number; r: number; k: number }[] = [];
    for (let i = 0; i < s.clumps; i++) {
      const a = h01(i, s.seed, 11) * TAU;
      const rf = 0.34 + h01(i, s.seed, 13) * 0.14;
      const d = Math.sqrt(h01(i, s.seed, 12)) * (0.9 - rf);
      const r = rx * rf;
      clumps.push({ x: cx + Math.cos(a) * rx * d, y: cy + Math.sin(a) * ry * d * 0.95, r, k: i });
    }
    // A ring of clumps around the rim so the whole silhouette reads as foliage.
    const ring = 9;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * TAU + h01(i, s.seed, 14) * 0.4;
      const rr = rx * (0.3 + h01(i, s.seed, 15) * 0.08);
      clumps.push({ x: cx + Math.cos(a) * (rx - rr * 1.15), y: cy + Math.sin(a) * (ry - rr * 1.05), r: rr, k: 100 + i });
    }
    clumps.sort((a, b) => a.y - b.y);
    for (const c of clumps) {
      const sh = lumpy(c.x + c.r * 0.08, c.y + c.r * 0.22, c.r * 1.02, c.r * 0.86, 10, s.seed + c.k * 7, 0.16);
      v.fill(sh, pal.deep, { opacity: 0.7 });
      const body = lumpy(c.x, c.y, c.r, c.r * 0.84, 10, s.seed + c.k * 7, 0.16);
      v.fill(body, radial(c.x - c.r * 0.42, c.y - c.r * 0.5, c.r * 1.55, [[0, pal.tip], [0.22, pal.light], [0.5, pal.mid], [0.8, pal.dark], [1, pal.deep]]));
      // Painted leaves: brighter dabs toward the light, darker toward the shade.
      const n = s.leaves ?? 9;
      for (let j = 0; j < n; j++) {
        const a = h01(j, c.k, s.seed + 1) * TAU;
        const d = Math.sqrt(h01(j, c.k, s.seed + 2)) * c.r * 0.85;
        const x = c.x + Math.cos(a) * d;
        const y = c.y + Math.sin(a) * d * 0.84;
        const lit = (x - c.x) * -0.6 + (y - c.y) * -0.8;
        if (lit < -c.r * 0.15) continue;
        const col = lit > c.r * 0.3 ? pal.tip : pal.light;
        leaf(v, x, y, c.r * 0.17, c.r * 0.085, a + 0.6, col, lit > c.r * 0.3 ? 0.7 : 0.4);
      }
    }
    // Overall light falloff: brighter top left, cool shadow bottom right.
    shadeInside(l, (x, y) => {
      const t = ((x - cx) * 0.62 + (y - cy) * 0.78) / rx;
      if (t > 0) return [18, 40, 70, Math.min(1, t) * 0.55 * 255];
      return null;
    }, "multiply");
    l.innerShadow({ dx: -2, dy: -3, blur: 5, color: "#020b12", opacity: 0.5 });
    l.bevel({ size: 3, lx: -0.62, ly: -0.78, highlight: pal.rim, shadow: "#020a10", strength: 0.7 });
    // Moonlit glints on the outer upper-left leaves.
    for (let j = 0; j < 26; j++) {
      const a = Math.PI * (1.0 + h01(j, s.seed, 31) * 0.75);
      const d = 0.72 + h01(j, s.seed, 32) * 0.22;
      const x = cx + Math.cos(a) * rx * d;
      const y = cy + Math.sin(a) * ry * d;
      if (l.get(Math.floor(x * l.density), Math.floor(y * l.density))?.a) leaf(v, x, y, 1.8, 0.7, a + 1.3, pal.rim, 0.55);
    }
  });
}

const TREE_W = 168;
const TREE_H = 206;
const TREE_BASE = 194;

export const TREES = defineVariants("tree", 4, { w: TREE_W, h: TREE_H, origin: [0.5, TREE_BASE / TREE_H], density: 2, normal: "bevel" }, (p, { index, rng }) => {
  const pal = FOLIAGE[index];
  const cx = TREE_W / 2;
  const v = pen(p);
  // Contact shadow where roots meet the ground.
  v.ellipse(cx + 3, TREE_BASE - 1, 26, 7, radial(cx + 3, TREE_BASE - 1, 26, [[0, "#040c12dd"], [0.6, "#040c1277"], [1, "#040c1200"]], 7));
  // Trunk with root flare, bark grooves and moonlit left edge.
  const tw = index === 3 ? 10 : 12.5;
  const top = 110;
  p.layer((l) => {
    const t = pen(l);
    const lean = rng.range(-4, 4);
    const tr = path()
      .moveTo(cx - tw * 0.55 + lean, top)
      .cubicTo(cx - tw * 0.5 + lean * 0.5, top + 50, cx - tw * 0.7, TREE_BASE - 14, cx - tw * 2.1, TREE_BASE)
      .quadTo(cx - tw * 0.9, TREE_BASE - 3.5, cx - tw * 0.3, TREE_BASE + 1)
      .quadTo(cx + tw * 0.1, TREE_BASE - 4, cx + tw * 0.5, TREE_BASE + 1.5)
      .quadTo(cx + tw * 1.0, TREE_BASE - 2, cx + tw * 2.0, TREE_BASE)
      .cubicTo(cx + tw * 0.75, TREE_BASE - 14, cx + tw * 0.5 + lean * 0.5, top + 50, cx + tw * 0.55 + lean, top)
      .close();
    const bark = index === 3 ? ["#8d8a8e", "#5d5966", "#2a2632"] : ["#6e5a58", "#45363c", "#1d1720"];
    t.fill(tr, linear(cx - tw * 1.2, 0, cx + tw * 1.2, 0, [[0, bark[0]], [0.42, bark[1]], [1, bark[2]]]));
    // Branches reaching into the crown.
    t.stroke(path().moveTo(cx + lean * 0.6, top + 24).quadTo(cx - 14, top + 6, cx - 30, top - 14), 4, bark[1]);
    t.stroke(path().moveTo(cx + lean * 0.6, top + 16).quadTo(cx + 16, top + 4, cx + 26, top - 18), 3.4, bark[2]);
    shadeInside(l, (x, y) => {
      const g = noise.perlin(x * 0.7, y * 0.06, 300 + index);
      const groove = ss(0.25, 0.55, Math.abs(g));
      const k = 0.72 + groove * 0.34;
      return [255 * k, 255 * k, 255 * k, 255];
    }, "multiply");
    if (index === 3) {
      // Birch-like dark marks on the pale trunk.
      for (let i = 0; i < 9; i++) t.ellipse(cx + rng.range(-tw * 0.6, tw * 0.5), rng.range(top + 30, TREE_BASE - 8), rng.range(1.5, 3.2), 0.7, "#2a2530", { opacity: 0.8 });
    }
    // Occlusion under the crown.
    shadeInside(l, (_x, y) => (y < top + 40 ? [6, 14, 24, ss(top + 40, top + 6, y) * 0.85 * 255] : null));
    l.bevel({ size: 2, lx: -0.7, ly: -0.5, highlight: "#a9d2d6", shadow: "#05080e", strength: 0.5 });
  });
  // Moss collar around the root flare.
  for (let i = 0; i < 10; i++) leaf(v, cx + rng.range(-tw * 1.6, tw * 1.6), TREE_BASE - rng.range(0, 3), rng.range(1.6, 3), 0.8, rng.range(-0.4, 0.4), i % 2 ? pal.mid : pal.light, 0.9);
  const crownSpec: CrownSpec[] = [
    { cx, cy: 84, rx: 70, ry: 64, clumps: 10, seed: 11, pal },
    { cx, cy: 82, rx: 64, ry: 68, clumps: 9, seed: 23, pal },
    { cx, cy: 88, rx: 74, ry: 60, clumps: 11, seed: 37, pal },
    { cx, cy: 84, rx: 58, ry: 66, clumps: 9, seed: 53, pal },
  ];
  crown(p, crownSpec[index]);
});

export const BUSHES = defineVariants("bush", 3, { w: 76, h: 56, origin: [0.5, 0.9], density: 2, normal: "bevel" }, (p, { index, rng }) => {
  const pal = FOLIAGE[[0, 2, 1][index]];
  const v = pen(p);
  v.ellipse(38, 49, 30, 6, radial(38, 49, 30, [[0, "#040c12cc"], [0.6, "#040c1266"], [1, "#040c1200"]], 6));
  crown(p, { cx: 38, cy: 31, rx: 32, ry: 20, clumps: 8, seed: 70 + index * 9, pal, leaves: 12 });
  if (index !== 1) {
    // Berries or star flowers nestled in the leaves.
    const col = index === 0 ? ["#ff8aa0", "#b0324e"] : ["#f2f6ff", "#9fb4ff"];
    for (let i = 0; i < 7; i++) {
      const x = rng.range(16, 60);
      const y = rng.range(20, 40);
      if (!p.get(Math.floor(x * 2), Math.floor(y * 2))?.a) continue;
      v.circle(x + 0.3, y + 0.5, 1.6, "#03080c", { opacity: 0.5 });
      v.circle(x, y, 1.4, radial(x - 0.5, y - 0.5, 1.8, [[0, "#ffffff"], [0.35, col[0]], [1, col[1]]]));
    }
  }
});

// --- Stones --------------------------------------------------------------------------------

export const ROCKS = defineVariants("rock", 3, { w: 52, h: 40, origin: [0.5, 0.86], density: 2, normal: "bevel" }, (p, { index, rng }) => {
  const v = pen(p);
  v.ellipse(27, 34, 22, 5.5, radial(27, 34, 22, [[0, "#040c12dd"], [0.6, "#040c1266"], [1, "#040c1200"]], 5.5));
  const rx = 15 + index * 2.5;
  const ry = 11 + index * 1.2;
  const cy = 34 - ry * 0.95;
  p.layer((l) => {
    const r = pen(l);
    const pts: [number, number][] = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rng.range(-0.15, 0.15);
      const k = rng.range(0.82, 1.08);
      const y = cy + Math.sin(a) * ry * k;
      pts.push([26 + Math.cos(a) * rx * k, Math.min(34, y)]);
    }
    const shape = path().smoothPolygon(pts, 0.7);
    r.fill(shape, radial(26 - rx * 0.45, cy - ry * 0.6, rx * 1.9, [[0, "#a9b4b4"], [0.35, "#6f7c82"], [0.75, "#3a4651"], [1, "#222b35"]]));
    // A flatter top face catching the moon.
    r.fill(lumpy(24 - index, cy - ry * 0.35, rx * 0.62, ry * 0.42, 8, 900 + index, 0.15), radial(20, cy - ry * 0.6, rx, [[0, "#c3cbc4"], [1, "#7d8a8c"]]), { opacity: 0.55, blend: "inside" });
    shadeInside(l, (x, y) => {
      const g = noise.fbm(x / 5, y / 5, { seed: 500 + index, octaves: 3 });
      const k = 0.86 + g * 0.22;
      return [255 * Math.min(1, k), 255 * Math.min(1, k), 255 * Math.min(1, k), 255];
    }, "multiply");
    // Moss and lichen settle on the top.
    shadeInside(l, (x, y) => {
      const m = noise.fbm(x / 6, y / 6, { seed: 520 + index, octaves: 4 }) + (cy - y) / ry * 0.9 - 0.15;
      const a = ss(0.05, 0.35, m);
      if (a <= 0) return null;
      const lit = ss(0.6, -0.4, ((x - 26) * 0.6 + (y - cy) * 0.8) / rx);
      const c = mix(rgb("#244a38"), rgb("#6e9e63"), lit);
      return [c[0], c[1], c[2], a * 0.92 * 255];
    });
    // A crack.
    r.stroke(path().moveTo(26 + rx * 0.2, cy - ry * 0.3).lineTo(26 + rx * 0.05, cy + ry * 0.1).lineTo(26 + rx * 0.3, cy + ry * 0.6), 0.6, "#151c24", { opacity: 0.7 });
    l.innerShadow({ dx: -1.5, dy: -2.5, blur: 3, color: "#03070c", opacity: 0.55 });
    l.bevel({ size: 1.6, highlight: "#d8eef0", shadow: "#04070c", strength: 0.5 });
  });
});

// --- Glowing mushrooms -------------------------------------------------------------------

function mushroomCap(v: Pen, x: number, y: number, r: number, tilt: number, glow: boolean): void {
  // Stem.
  v.fill(path().moveTo(x - r * 0.22, y).quadTo(x - r * 0.3 + tilt, y + r * 0.9, x - r * 0.2, y + r * 1.5).lineTo(x + r * 0.22, y + r * 1.5).quadTo(x + r * 0.2 + tilt, y + r * 0.9, x + r * 0.2, y).close(), linear(x - r * 0.3, 0, x + r * 0.3, 0, [[0, "#e8f2f0"], [1, "#8ea6b4"]]));
  // Cap underside and dome.
  v.ellipse(x, y + r * 0.08, r * 1.02, r * 0.3, "#3a3f78");
  const cap = path().moveTo(x - r, y + r * 0.1).cubicTo(x - r, y - r * 0.9, x + r, y - r * 0.9, x + r, y + r * 0.1).quadTo(x, y + r * 0.35, x - r, y + r * 0.1).close();
  v.fill(cap, glow ? radial(x - r * 0.3, y - r * 0.4, r * 1.4, [[0, "#f4fbff"], [0.3, "#a8e4ff"], [0.75, "#5aa0ec"], [1, "#4a4fb0"]]) : radial(x - r * 0.3, y - r * 0.4, r * 1.4, [[0, "#cfe2ff"], [0.5, "#7c94d8"], [1, "#3c3f88"]]));
  // Spots.
  v.circle(x - r * 0.35, y - r * 0.3, r * 0.13, "#ffffff", { opacity: 0.85 });
  v.circle(x + r * 0.3, y - r * 0.4, r * 0.1, "#ffffff", { opacity: 0.75 });
  v.circle(x + r * 0.05, y - r * 0.05, r * 0.08, "#ffffff", { opacity: 0.6 });
}

export const MUSHROOMS = defineVariants("shroom", 3, { w: 30, h: 28, origin: [0.5, 0.88], density: 3 }, (p, { index }) => {
  const v = pen(p);
  v.ellipse(15, 24.5, 11, 2.6, radial(15, 24.5, 11, [[0, "#040c12cc"], [1, "#040c1200"]], 2.6));
  const caps: [number, number, number, number][] = [
    [[12, 12, 6.5, -0.6], [20.5, 16.5, 4, 0.6], [7, 18.5, 3, -0.4]],
    [[16, 10, 7.5, 0.4], [8, 17, 4.2, -0.5]],
    [[10, 14, 5, -0.3], [18, 11, 5.6, 0.5], [22.5, 18, 3, 0.4], [14, 19, 2.6, 0]],
  ][index] as [number, number, number, number][];
  for (const [x, y, r, t] of caps) mushroomCap(v, x, y, r, t, true);
  p.dropShadow({ dx: 0.4, dy: 0.6, blur: 0.8, color: "#030812", opacity: 0.5 });
});

/** The bright caps alone, drawn emissive over the mushroom so they glow in the dark. */
export const MUSHROOM_GLOW = defineVariants("shroom.glow", 3, { w: 30, h: 28, origin: [0.5, 0.88], density: 2 }, (p, { index }) => {
  const v = pen(p);
  const caps = [
    [[12, 12, 6.5], [20.5, 16.5, 4], [7, 18.5, 3]],
    [[16, 10, 7.5], [8, 17, 4.2]],
    [[10, 14, 5], [18, 11, 5.6], [22.5, 18, 3], [14, 19, 2.6]],
  ][index];
  for (const [x, y, r] of caps) {
    v.fill(path().moveTo(x - r, y + r * 0.1).cubicTo(x - r, y - r * 0.9, x + r, y - r * 0.9, x + r, y + r * 0.1).quadTo(x, y + r * 0.35, x - r, y + r * 0.1).close(), radial(x - r * 0.3, y - r * 0.4, r * 1.3, [[0, "#ffffffee"], [0.4, "#9fdcffaa"], [1, "#5a8cf020"]]));
  }
});

// --- The moon shrine -----------------------------------------------------------------------

export const SHRINE_DAIS = defineSprite("shrine.dais", { w: 240, h: 120, density: 1.5 }, (p) => {
  const v = pen(p);
  const cx = 120;
  const cy = 56;
  v.ellipse(cx + 6, cy + 10, 116, 50, radial(cx + 6, cy + 10, 116, [[0, "#030a10cc"], [0.8, "#030a1066"], [1, "#030a1000"]], 50));
  // Side wall of the raised platform.
  v.ellipse(cx, cy + 6, 104, 42, linear(0, cy - 20, 0, cy + 48, [[0, "#4a5a60"], [1, "#1e2830"]]));
  p.layer((l) => {
    const t = pen(l);
    t.ellipse(cx, cy, 104, 40, "#7f8f8c");
    // Flagstones in rings around the centre.
    shadeInside(l, (x, y) => {
      const dx = (x - cx) / 104;
      const dy = (y - cy) / 40;
      const r = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const ringW = 0.2;
      const ring = Math.floor(r / ringW);
      const seg = (a / TAU + 0.5) * (8 + ring * 6);
      const fr = (r % ringW) / ringW;
      const fs = seg - Math.floor(seg);
      const groove = Math.min(ss(0, 0.08, fr), ss(1, 0.92, fr), ss(0, 0.05, fs), ss(1, 0.95, fs));
      const id = h01(ring, Math.floor(seg), 8);
      const g = noise.fbm(x / 7, y / 5, { seed: 610, octaves: 3 });
      const lit = 1 - ((x - cx) * 0.6 / 104 + (y - cy) * 0.8 / 40) * 0.25;
      const k = (0.62 + id * 0.18 + g * 0.12) * (0.45 + groove * 0.55) * lit;
      return [150 * k, 166 * k, 160 * k, 255];
    });
    // Inlaid moon ring and centre basin.
    t.save().translate(cx, cy).scale(1, 40 / 104);
    t.ring(0, 0, 58, 3, "#283b44", { opacity: 0.9 });
    t.restore();
    t.ellipse(cx, cy, 44, 17, radial(cx, cy - 4, 44, [[0, "#1d3440"], [1, "#0f1e28"]], 17));
    t.ellipse(cx, cy + 1.5, 40, 14.5, radial(cx - 8, cy - 2, 40, [[0, "#3a6a7a"], [0.6, "#1a3a4c"], [1, "#0e2232"]], 14.5));
    // Moss creeping over the rim.
    shadeInside(l, (x, y) => {
      const dx = (x - cx) / 104;
      const dy = (y - cy) / 40;
      const r = Math.hypot(dx, dy);
      const m = noise.fbm(x / 9, y / 6, { seed: 620, octaves: 4 }) + (r - 0.82) * 3;
      const a = ss(0.2, 0.55, m);
      if (a <= 0) return null;
      return [44, 86, 62, a * 0.9 * 255];
    });
    l.bevel({ size: 2, highlight: "#d6f0ea", shadow: "#03070c", strength: 0.45 });
  });
  p.layer((l) => {
    // The flat ring scaled into an ellipse on the dais.
    const t = pen(l);
    t.save().translate(cx, cy).scale(1, 40 / 104);
    t.ring(0, 0, 80, 1.6, "#c6e9e2", { opacity: 0.35 });
    t.ring(0, 0, 70, 1, "#c6e9e2", { opacity: 0.25 });
    t.restore();
  });
});

/** Runes carved around the dais, drawn emissive and pulsing. */
export const SHRINE_RUNES = defineSprite("shrine.runes", { w: 240, h: 120, density: 1 }, (p) => {
  const v = pen(p);
  const cx = 120;
  const cy = 56;
  v.save().translate(cx, cy).scale(1, 40 / 104);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    const x = Math.cos(a) * 75;
    const y = Math.sin(a) * 75;
    v.save().translate(x, y).rotate(a + Math.PI / 2);
    const k = i % 4;
    if (k === 0) v.ring(0, 0, 3.2, 1.3, "#bff6ff");
    else if (k === 1) v.fill(path().moveTo(0, -4).lineTo(3, 0).lineTo(0, 4).lineTo(-3, 0).close(), "#bff6ff");
    else if (k === 2) v.stroke(path().moveTo(-3, 3).lineTo(0, -4).lineTo(3, 3), 1.2, "#bff6ff");
    else v.fill(path().arc(0, 0, 3.6, Math.PI * 0.6, Math.PI * 1.9).arc(1.2, -0.4, 2.6, Math.PI * 1.9, Math.PI * 0.6).close(), "#bff6ff");
    v.restore();
  }
  v.restore();
  p.glowOutside("#6fe4ff", 2.5, 0.9);
});

export const SHRINE_STONE = defineSprite("shrine.stone", { w: 84, h: 136, origin: [0.5, 0.94], density: 2, normal: "bevel" }, (p, { rng }) => {
  const v = pen(p);
  const base = 128;
  v.ellipse(44, base, 32, 8, radial(44, base, 32, [[0, "#030a10dd"], [1, "#030a1000"]], 8));
  p.layer((l) => {
    const s = pen(l);
    const stone = path()
      .moveTo(20, base)
      .lineTo(22, 52)
      .quadTo(23, 22, 34, 12)
      .lineTo(42, 8)
      .lineTo(48, 10)
      .quadTo(60, 18, 62, 48)
      .lineTo(64, base)
      .quadTo(42, base + 4, 20, base)
      .close();
    s.fill(stone, linear(18, 0, 66, 0, [[0, "#b4c2bc"], [0.38, "#7e8f8d"], [0.7, "#4b5b61"], [1, "#27323b"]]));
    // A chipped facet on the lit side.
    s.fill(path().moveTo(22, 52).quadTo(23, 22, 34, 12).lineTo(36, 40).lineTo(30, 120).lineTo(21, 124).close(), "#d8e6df", { opacity: 0.18, blend: "inside" });
    shadeInside(l, (x, y) => {
      const g = noise.fbm(x / 6, y / 9, { seed: 700, octaves: 4 });
      const c = noise.worley(x / 9, y / 9, 701);
      const k = 0.8 + g * 0.2 + ss(0.08, 0, c.f2 - c.f1) * -0.18;
      return [255 * Math.min(1, k), 255 * Math.min(1, k), 255 * Math.min(1, k), 255];
    }, "multiply");
    // Lichen.
    shadeInside(l, (x, y) => {
      const m = noise.fbm(x / 5, y / 5, { seed: 710, octaves: 4 }) + (y - 90) / 60;
      const a = ss(0.25, 0.6, m) * 0.9;
      return a > 0 ? [52, 92, 66, a * 255] : null;
    });
    // The carved crescent recess.
    s.fill(path().circle(43, 48, 13), "#132630");
    s.fill(path().circle(48, 44, 11.5), "#4d5f66", { blend: "inside" });
    s.ring(43, 48, 13.5, 1.2, "#22323b", { opacity: 0.8 });
    // Ivy climbing the right face.
    let x = 60;
    let y = base - 2;
    for (let i = 0; i < 22; i++) {
      x += rng.range(-2.2, 1.6);
      y -= rng.range(2.5, 4.2);
      leaf(s, x + rng.range(-2, 2), y, rng.range(2.2, 3.2), 1.1, rng.range(-1, 1), i % 3 ? "#2b5a45" : "#4c8a62");
    }
    l.innerShadow({ dx: -2, dy: -2, blur: 4, color: "#03070c", opacity: 0.5 });
    l.bevel({ size: 2, highlight: "#e0f4f0", shadow: "#03070c", strength: 0.55 });
  });
});

/** The moonstone inlay and carved crescent, emissive. */
export const SHRINE_GLOW = defineSprite("shrine.glow", { w: 84, h: 136, origin: [0.5, 0.94], density: 2 }, (p) => {
  const v = pen(p);
  v.circle(43, 48, 12, radial(38, 52, 14, [[0, "#ffffff"], [0.45, "#d6fbff"], [1, "#6fd3f6"]]));
  v.circle(48.5, 44, 10.5, "#000000", { blend: "erase" });
  // Glowing seams running down the stone.
  v.stroke(path().moveTo(43, 62).quadTo(41, 80, 44, 96).quadTo(46, 110, 42, 124), 1.1, "#9ff0ff", { opacity: 0.85 });
  v.stroke(path().moveTo(43, 34).lineTo(43, 24).lineTo(39, 18), 0.9, "#9ff0ff", { opacity: 0.7 });
  p.glowOutside("#7fe6ff", 3, 0.85);
});

export const MENHIRS = defineVariants("menhir", 2, { w: 30, h: 50, origin: [0.5, 0.92], density: 2, normal: "bevel" }, (p, { index }) => {
  const v = pen(p);
  v.ellipse(16, 46, 12, 3.4, radial(16, 46, 12, [[0, "#030a10cc"], [1, "#030a1000"]], 3.4));
  p.layer((l) => {
    const s = pen(l);
    const pts: [number, number][] = index === 0 ? [[7, 46], [8, 14], [13, 5], [20, 7], [23, 20], [24, 46]] : [[6, 46], [9, 18], [16, 10], [22, 16], [25, 46]];
    s.fill(path().smoothPolygon(pts, 0.5), linear(6, 0, 25, 0, [[0, "#aab8b2"], [0.45, "#6c7b7c"], [1, "#2a343d"]]));
    shadeInside(l, (x, y) => {
      const m = noise.fbm(x / 4, y / 4, { seed: 740 + index, octaves: 4 }) + (y - 30) / 25;
      const a = ss(0.25, 0.6, m) * 0.9;
      return a > 0 ? [48, 88, 62, a * 255] : null;
    });
    l.bevel({ size: 1.5, highlight: "#e0f4f0", shadow: "#03070c", strength: 0.5 });
  });
});

export const MENHIR_GLOW = defineSprite("menhir.glow", { w: 30, h: 50, origin: [0.5, 0.92], density: 2 }, (p) => {
  const v = pen(p);
  v.stroke(path().moveTo(13, 22).lineTo(16, 18).lineTo(19, 22).moveTo(16, 18).lineTo(16, 30), 1, "#bff6ff");
  p.glowOutside("#6fe4ff", 1.5, 0.9);
});

// --- The lantern keeper -------------------------------------------------------------------

const KEEPER_W = 48;
const KEEPER_H = 62;
const KEEPER_FEET = 60;

/** Hooded cloak, scarf and face. Faces right; the scene mirrors it. */
function paintKeeperBody(p: Painter, ox = 0, oy = 0): void {
  p.layer((l) => {
    const v = pen(l);
    v.translate(ox, oy);
    // Scarf tail streaming behind.
    v.fill(path().moveTo(20, 30).cubicTo(12, 32, 8, 38, 5, 44).quadTo(9, 44, 11, 41).quadTo(10, 46, 13, 47).cubicTo(15, 40, 19, 36, 24, 33).close(), linear(6, 30, 20, 46, [[0, "#f08a4a"], [1, "#9e3424"]]));
    // Cloak: a bell that flares at the hem.
    const cloak = path()
      .moveTo(16, 28)
      .cubicTo(12, 36, 9, 46, 7, 56)
      .quadTo(12, 58.5, 17, 56.5)
      .quadTo(22, 59, 27, 56.8)
      .quadTo(33, 59, 39, 56)
      .cubicTo(37, 46, 35, 36, 33, 28)
      .close();
    v.fill(cloak, linear(9, 28, 38, 56, [[0, "#4d6aa0"], [0.45, "#2c3f6c"], [1, "#151d3c"]]));
    // Folds.
    v.stroke(path().moveTo(20, 36).quadTo(18, 46, 17, 56), 1.1, "#121a36", { opacity: 0.55 });
    v.stroke(path().moveTo(28, 36).quadTo(29, 46, 27, 56), 1.1, "#121a36", { opacity: 0.45 });
    v.stroke(path().moveTo(13, 44).quadTo(12, 50, 11, 55), 0.8, "#8aa6d8", { opacity: 0.35 });
    // Hem trim.
    v.stroke(path().moveTo(7.5, 55.5).quadTo(12, 58, 17, 56).quadTo(22, 58.5, 27, 56.3).quadTo(33, 58.5, 38.6, 55.5), 1.2, "#c99a52", { opacity: 0.85 });
    // Arm reaching forward to hold the lantern.
    v.fill(path().moveTo(29, 33).quadTo(36, 34, 40, 40).quadTo(39, 43.5, 36.5, 42.5).quadTo(33, 39, 28, 39).close(), linear(28, 33, 40, 43, [[0, "#3f5a8e"], [1, "#1c2648"]]));
    v.circle(39.6, 41.6, 2.2, radial(39, 41, 2.6, [[0, "#f6d2ae"], [1, "#c88a66"]]));
    // Scarf wrap at the neck.
    v.fill(path().moveTo(14.5, 27).quadTo(24, 32.5, 34, 27).quadTo(34.5, 31, 33, 33).quadTo(24, 37, 15.5, 32.5).quadTo(14, 30, 14.5, 27).close(), linear(14, 27, 34, 34, [[0, "#ffa060"], [0.5, "#e0603a"], [1, "#9e3424"]]));
    v.circle(30, 32, 1.4, radial(29.6, 31.5, 1.6, [[0, "#fff2c0"], [1, "#c89030"]]));
    // Hood with a long tip falling back.
    const hood = path()
      .moveTo(13, 28)
      .cubicTo(9, 20, 11, 9, 20, 5.5)
      .cubicTo(16, 4, 9, 6, 3, 13)
      .cubicTo(9, 8, 15, 6.5, 20, 6)
      .cubicTo(29, 3, 37, 9, 37.5, 18)
      .cubicTo(38, 23, 36, 27, 34, 29)
      .quadTo(24, 32, 13, 28)
      .close();
    v.fill(hood, radial(17, 9, 30, [[0, "#6f8fc4"], [0.4, "#3d5690"], [1, "#1a2448"]]));
    // Face opening.
    v.ellipse(28, 19.5, 8.4, 8, radial(29, 21, 9, [[0, "#121830"], [1, "#070a18"]]));
    // Face: warm skin lit by the lantern from below.
    v.ellipse(29, 21, 6.4, 6, linear(29, 15, 31, 27, [[0, "#c79072"], [0.55, "#f2c6a0"], [1, "#ffd8ae"]]));
    // Hood brim shadow over the brow.
    v.fill(path().ellipse(28, 14.2, 8.6, 4.2), "#0a0e20", { opacity: 0.75, blend: "inside" });
    // Eyes and cheeks.
    v.ellipse(27, 21.2, 1.25, 1.75, "#1a1424");
    v.ellipse(32.2, 21.2, 1.15, 1.65, "#1a1424");
    v.circle(27.4, 20.5, 0.5, "#ffffff");
    v.circle(32.6, 20.5, 0.45, "#ffffff");
    v.ellipse(25.5, 24, 1.5, 0.9, "#ff8c80", { opacity: 0.5 });
    v.ellipse(33.8, 24, 1.2, 0.8, "#ff8c80", { opacity: 0.45 });
    // Hood seam and stitched trim.
    v.stroke(path().moveTo(19.5, 11).cubicTo(20.5, 14, 19.5, 22, 18.5, 27), 0.8, "#1a2448", { opacity: 0.6 });
    v.stroke(path().ellipseArc(28, 19.5, 8.6, 8.2, Math.PI * 0.95, Math.PI * 2.05), 0.9, "#c99a52", { opacity: 0.7 });
    l.bevel({ size: 1.4, lx: -0.6, ly: -0.8, highlight: "#c4dcff", shadow: "#05081a", strength: 0.45 });
    l.bevel({ size: 1.2, lx: 0.9, ly: 0.4, highlight: "#ffb36a", shadow: "#000000", strength: 0.3 });
  });
}

function paintBoots(v: Pen, lx: number, ly: number, rx: number, ry: number): void {
  for (const [x, y, back] of [[lx, ly, true], [rx, ry, false]] as const) {
    v.fill(path().roundRect(x - 3, y - 6, 6, 6.5, [2, 2, 1.2, 1.2]), linear(x - 3, 0, x + 3, 0, back ? [[0, "#3a2c2c"], [1, "#1a1216"]] : [[0, "#5a4038"], [1, "#24181a"]]));
    v.fill(path().roundRect(x - 3.2, y - 1.2, 8, 2.2, 1), back ? "#1a1216" : "#2c1e1c");
  }
}

export const KEEPER_BODY = defineSprite("keeper.body", { w: KEEPER_W, h: KEEPER_H, origin: [0.5, KEEPER_FEET / KEEPER_H], density: 3 }, (p) => {
  paintKeeperBody(p);
  p.glowOutside("#04060e", 0.8, 0.6, 0.2);
});

export const KEEPER_BOOT = defineSprite("keeper.boot", { w: 12, h: 10, origin: [0.4, 0.8], density: 3 }, (p) => {
  const v = pen(p);
  v.fill(path().roundRect(2, 1, 6, 7, [2, 2, 1.2, 1.2]), linear(2, 0, 8, 0, [[0, "#5a4038"], [1, "#24181a"]]));
  v.fill(path().roundRect(1.8, 6, 8.5, 2.4, 1.1), linear(0, 6, 0, 8.4, [[0, "#3a2a26"], [1, "#160e10"]]));
  p.bevel({ size: 0.8, highlight: "#c8b0a0", strength: 0.4 });
});

function paintLantern(v: Pen, x: number, y: number): void {
  // Handle ring.
  v.stroke(path().ellipseArc(x, y + 2.2, 2.6, 2.4, Math.PI, TAU), 0.8, "#3a2a1c");
  // Cap.
  v.fill(path().moveTo(x - 4.6, y + 5.6).lineTo(x - 2.4, y + 2.4).lineTo(x + 2.4, y + 2.4).lineTo(x + 4.6, y + 5.6).close(), linear(x - 4, 0, x + 4, 0, [[0, "#b98a4a"], [1, "#4a3018"]]));
  // Glass.
  v.fill(path().roundRect(x - 3.8, y + 5.6, 7.6, 9, 1.6), radial(x, y + 10.5, 6, [[0, "#ffffff"], [0.3, "#fff1b8"], [0.7, "#ffbe5a"], [1, "#e07a28"]]));
  v.circle(x, y + 10.8, 1.5, "#ffffff");
  // Frame bars.
  v.line(x - 3.8, y + 5.8, x - 3.8, y + 14.4, 0.8, "#4a3018");
  v.line(x + 3.8, y + 5.8, x + 3.8, y + 14.4, 0.8, "#2a1a10");
  v.line(x, y + 5.8, x, y + 14.4, 0.45, "#6a4020", { opacity: 0.6 });
  // Base.
  v.fill(path().roundRect(x - 4.8, y + 14.2, 9.6, 2.4, 0.9), linear(x - 4, 0, x + 4, 0, [[0, "#c8964e"], [1, "#4a3018"]]));
}

export const KEEPER_LANTERN = defineSprite("keeper.lantern", { w: 14, h: 20, origin: [0.5, 0.1], density: 4 }, (p) => {
  paintLantern(pen(p), 7, 0);
});

/** Composite poses of the keeper for the "painted" hero mode (K cycles heroes). */
function paintKeeper(p: Painter, lift: number, step: number, bob: number): void {
  const v = pen(p);
  v.ellipse(24, 60, 13, 3.2, radial(24, 60, 13, [[0, "#040c12aa"], [1, "#040c1200"]], 3.2));
  paintBoots(v, 19, 60 - lift, 29 + step, 60 - (lift ? 0 : 1.2));
  paintKeeperBody(p, 0, bob);
  paintLantern(pen(p), 40, 41 + bob);
}

export const HERO_IDLE = defineSprite("hero.idle", { w: KEEPER_W, h: KEEPER_H, origin: [0.5, KEEPER_FEET / KEEPER_H], density: 3 }, (p) => paintKeeper(p, 0, 0, 0));
export const HERO_WALK = defineVariants("hero.walk", 4, { w: KEEPER_W, h: KEEPER_H, origin: [0.5, KEEPER_FEET / KEEPER_H], density: 3 }, (p, { index }) => {
  const poses = [
    [1.6, -1.5, 0],
    [0, 0, 1],
    [0, 1.5, 0],
    [1.2, 0, 1],
  ][index];
  paintKeeper(p, poses[0], poses[1], poses[2]);
});
defineAnimation("hero.idle", [HERO_IDLE], 1);
defineAnimation("hero.walk", HERO_WALK, 9);

// The same role from a generated sheet: sixteen poses of a knight an image model drew, run
// through `blackiron art import` into assets/knight.png. Press K in the game to swap heroes and
// judge imported art against the painted one on the same ground, under the same light.
// The sprite set carries facings ("knight.idle" and "knight.walk" pick a side), a mirrored
// attack and a held hurt pose; the rig is the same knight as seven parts on the humanoid
// template, posed by the engine's clips.
defineSpriteSet("knight", "assets/knight.json", { origin: [0.5, 0.97], normal: "bevel" });
defineRig("knight-rig", "assets/knight-rig.json", { normal: "bevel" });

// --- Embers and wisps --------------------------------------------------------------------

export const EMBER = defineVariants("ember", 2, { w: 24, h: 26, origin: [0.5, 0.55], density: 3 }, (p, { index }) => {
  const v = pen(p);
  const cx = 12;
  const cy = 15;
  v.circle(cx, cy, 10, radial(cx, cy, 10, [[0, "#ffb34a99"], [0.5, "#ff6a2a33"], [1, "#ff4a1a00"]]));
  // A flame tongue licking upward.
  const sway = index === 0 ? -1 : 1.2;
  v.fill(path().moveTo(cx - 5, cy + 1).cubicTo(cx - 5.5, cy - 5, cx + sway - 1, cy - 8, cx + sway, cy - 12).cubicTo(cx + sway + 1.5, cy - 7, cx + 5.5, cy - 4, cx + 5, cy + 1).cubicTo(cx + 4, cy + 6, cx - 4, cy + 6, cx - 5, cy + 1).close(), linear(cx, cy - 12, cx, cy + 5, [[0, "#ff6a2a00"], [0.35, "#ff8a30"], [1, "#ffb347"]]));
  v.circle(cx, cy, 4.6, radial(cx - 0.8, cy - 0.8, 5, [[0, "#ffffff"], [0.4, "#fff2b0"], [0.8, "#ffb347"], [1, "#ff7a2a"]]));
  v.circle(cx + (index ? 3 : -3.5), cy - 6 - index, 0.8, "#ffe9a0");
  v.circle(cx + (index ? -2.5 : 2.8), cy - 9, 0.55, "#ffd36b");
});
defineAnimation("ember", EMBER, 4);

export const WISP = defineVariants("wisp", 2, { w: 34, h: 46, origin: [0.5, 0.37], density: 3 }, (p, { index }) => {
  const cx = 17;
  const cy = 16;
  const tail = index === 0 ? -5 : 5;
  p.layer((l) => {
    const w = pen(l);
    const body = path()
      .moveTo(cx - 10, cy)
      .cubicTo(cx - 10, cy - 13, cx + 10, cy - 13, cx + 10, cy)
      .cubicTo(cx + 10, cy + 8, cx + 6 + tail * 0.4, cy + 12, cx + tail * 0.6 + 2, cy + 17)
      .quadTo(cx + tail, cy + 22, cx + tail * 1.2, cy + 23)
      .quadTo(cx + tail * 0.2 - 1, cy + 18, cx - 3 + tail * 0.3, cy + 16)
      .quadTo(cx - 5 + tail * 0.5, cy + 19, cx - 6 + tail * 0.8, cy + 20)
      .cubicTo(cx - 9, cy + 12, cx - 10, cy + 7, cx - 10, cy)
      .close();
    w.fill(body, radial(cx - 2, cy - 3, 20, [[0, "#f4fffd"], [0.3, "#b8fff0"], [0.65, "#58e0cc"], [1, "#1a8a90"]]));
    l.layer((g) => {
      const s = pen(g);
      s.stroke(path().moveTo(cx - 6, cy + 4).quadTo(cx - 3, cy + 12, cx + tail * 0.5, cy + 16), 1.1, "#ffffff", { opacity: 0.5 });
    });
    // Hollow eyes and a small mouth.
    w.ellipse(cx - 3.6, cy - 1.5, 2, 2.8, "#0b2c36");
    w.ellipse(cx + 3.6, cy - 1.5, 2, 2.8, "#0b2c36");
    w.circle(cx - 3.1, cy - 2.6, 0.6, "#d8fff8");
    w.circle(cx + 4.1, cy - 2.6, 0.6, "#d8fff8");
    w.ellipse(cx, cy + 3.6, 1.4, 0.9 + index * 0.4, "#0b2c36", { opacity: 0.85 });
  });
  // Translucent tail end.
  p.shade((x, y) => {
    const ly = y / p.density;
    if (ly < cy + 8) return null;
    return [0, 0, 0, ss(cy + 8, cy + 24, ly) * 255];
  }, { mode: "erase" });
  p.glowOutside("#4ff0d8", 3.5, 0.75);
});
defineAnimation("wisp", WISP, 3);

export const SPARK = defineSprite("spark", { w: 9, h: 9, density: 3 }, (p) => {
  const v = pen(p);
  v.fill(path().star(4.5, 4.5, 4.4, 1.1, 4), radial(4.5, 4.5, 4.4, [[0, "#ffffff"], [0.4, "#fff2b0"], [1, "#ffb34a00"]]));
});

// --- HUD -------------------------------------------------------------------------------------

function heartPath(x: number, y: number, s: number): Path {
  return path()
    .moveTo(x, y + s * 0.3)
    .cubicTo(x, y - s * 0.12, x - s * 0.62, y - s * 0.12, x - s * 0.62, y + s * 0.3)
    .cubicTo(x - s * 0.62, y + s * 0.62, x - s * 0.2, y + s * 0.82, x, y + s)
    .cubicTo(x + s * 0.2, y + s * 0.82, x + s * 0.62, y + s * 0.62, x + s * 0.62, y + s * 0.3)
    .cubicTo(x + s * 0.62, y - s * 0.12, x, y - s * 0.12, x, y + s * 0.3)
    .close();
}

export const HEART = defineSprite("heart", { w: 30, h: 28, origin: [0, 0], density: 4 }, (p) => {
  const v = pen(p);
  const h = heartPath(15, 5, 20);
  v.fill(h, radial(10, 8, 20, [[0, "#ff9a8a"], [0.35, "#f04a52"], [0.8, "#b01c3c"], [1, "#7a1030"]]));
  v.ellipse(10, 10, 3.6, 2.4, "#ffffff", { opacity: 0.55 });
  v.circle(8.6, 9.6, 1, "#ffffff", { opacity: 0.9 });
  p.innerShadow({ dx: -0.6, dy: -1, blur: 1.4, color: "#4a0820", opacity: 0.6 });
  v.stroke(h, 1.1, "#3a0816", { opacity: 0.9 });
  p.dropShadow({ dx: 0, dy: 1.2, blur: 1.6, color: "#02060c", opacity: 0.6 });
});

export const HEART_EMPTY = defineSprite("heart.empty", { w: 30, h: 28, origin: [0, 0], density: 4 }, (p) => {
  const v = pen(p);
  const h = heartPath(15, 5, 20);
  v.fill(h, "#0a1420", { opacity: 0.7 });
  v.stroke(h, 1.4, "#5d7480", { opacity: 0.85 });
  p.dropShadow({ dx: 0, dy: 1, blur: 1.2, color: "#02060c", opacity: 0.4 });
});

export const UI_EMBER = defineSprite("wh.ui.ember", { w: 26, h: 26, origin: [0.5, 0.5], density: 4 }, (p) => {
  const v = pen(p);
  v.circle(13, 13, 12, radial(13, 13, 12, [[0, "#ffb34a88"], [1, "#ff6a2a00"]]));
  v.fill(path().moveTo(13, 3).cubicTo(15, 8, 20, 10, 19.5, 15.5).cubicTo(19, 20, 16, 22, 13, 22).cubicTo(10, 22, 6.5, 20, 6.5, 15.5).cubicTo(6.5, 12, 9, 10.5, 9.5, 7.5).cubicTo(11, 9.5, 11.5, 11, 11.2, 12.5).cubicTo(12.8, 10, 13.5, 6.5, 13, 3).close(), linear(13, 3, 13, 22, [[0, "#ffe08a"], [0.5, "#ff9a3a"], [1, "#e0521f"]]));
  v.fill(path().moveTo(13, 12).cubicTo(15.5, 14.5, 16.5, 16.5, 16, 18.5).cubicTo(15.5, 20.5, 10.5, 20.5, 10, 18.5).cubicTo(9.6, 16.5, 11.5, 15, 13, 12).close(), linear(13, 12, 13, 20.5, [[0, "#fff8d8"], [1, "#ffd36b"]]));
});

/** A dark glass plate for HUD panels; nine-sliced with a 16-unit inset. */
export const UI_PLATE = defineSprite("wh.ui.plate", { w: 48, h: 48, origin: [0, 0], density: 3 }, (p) => {
  const v = pen(p);
  v.roundRect(4, 4, 40, 40, 12, linear(0, 4, 0, 44, [[0, "#1a3040e6"], [1, "#0c1824f0"]]));
  v.fill(path().roundRect(4.5, 4.5, 39, 39, 11.5).roundRect(5.6, 5.6, 36.8, 36.8, 10.4), linear(0, 4, 0, 44, [[0, "#a8d4cc66"], [0.5, "#a8d4cc22"], [1, "#a8d4cc10"]]), { rule: "evenodd" });
  p.dropShadow({ dx: 0, dy: 1.5, blur: 2.5, color: "#02060c", opacity: 0.55 });
});

/** A soft-edged pill for small captions. */
export const UI_PILL = defineSprite("wh.ui.pill", { w: 40, h: 28, origin: [0, 0], density: 3 }, (p) => {
  const v = pen(p);
  v.roundRect(3, 3, 34, 22, 11, "#0b1722", { opacity: 0.72 });
  v.fill(path().roundRect(3.5, 3.5, 33, 21, 10.5).roundRect(4.4, 4.4, 31.2, 19.2, 9.6), "#a8d4cc", { rule: "evenodd", opacity: 0.18 });
});

/** A keycap for control hints. */
export const UI_KEY = defineSprite("wh.ui.key", { w: 32, h: 32, origin: [0, 0], density: 3 }, (p) => {
  const v = pen(p);
  v.roundRect(3, 4, 26, 25, 6, "#05090e", { opacity: 0.7 });
  v.roundRect(3, 3, 26, 24, 6, linear(0, 3, 0, 27, [[0, "#2d4352"], [1, "#1a2a36"]]));
  v.fill(path().roundRect(3.4, 3.4, 25.2, 23.2, 5.6).roundRect(4.4, 4.4, 23.2, 21.2, 4.8), linear(0, 3, 0, 27, [[0, "#b8dcd466"], [1, "#b8dcd411"]]), { rule: "evenodd" });
});

function buttonSkin(name: string, top: string, bottom: string, edge: string, glow: string | null): string {
  return defineSprite(name, { w: 48, h: 48, origin: [0, 0], density: 3 }, (p) => {
    const v = pen(p);
    if (glow) v.roundRect(2, 2, 44, 44, 13, glow, { opacity: 0.5 });
    if (glow) p.blur(2);
    v.roundRect(5, 6, 38, 38, 11, "#02060c", { opacity: 0.55 });
    v.roundRect(5, 4.5, 38, 38, 11, linear(0, 4.5, 0, 42.5, [[0, top], [1, bottom]]));
    v.fill(path().roundRect(5.5, 5, 37, 37, 10.5).roundRect(6.6, 6.2, 34.8, 34.8, 9.6), linear(0, 5, 0, 42, [[0, edge], [1, "#ffffff00"]]), { rule: "evenodd" });
    v.roundRect(9, 6.5, 30, 10, 6, "#ffffff", { opacity: 0.08 });
  });
}

const P = BUTTON_SKINS.primary;
const Q = BUTTON_SKINS.quiet;
buttonSkin(P.normal, "#ffd98a", "#d88a34", "#fff6d8cc", null);
buttonSkin(P.hover, "#ffe7a8", "#eaa045", "#ffffffee", "#ffc870");
buttonSkin(P.pressed, "#e2a854", "#b86e24", "#ffe4b066", null);
buttonSkin(Q.normal, "#1f3746", "#13232f", "#9fd0c866", null);
buttonSkin(Q.hover, "#2a4a5a", "#183040", "#c8f0e8aa", "#6fd0c0");
buttonSkin(Q.pressed, "#142630", "#0e1a24", "#9fd0c833", null);

/** A thin golden rule with a diamond, under titles. */
export const UI_RULE = defineSprite("wh.ui.rule", { w: 260, h: 14, origin: [0.5, 0.5], density: 3 }, (p) => {
  const v = pen(p);
  v.rect(10, 6.6, 240, 0.9, linear(10, 0, 250, 0, [[0, "#ffd67a00"], [0.4, "#ffd67acc"], [0.6, "#ffd67acc"], [1, "#ffd67a00"]]));
  v.fill(path().moveTo(130, 2).lineTo(135, 7).lineTo(130, 12).lineTo(125, 7).close(), linear(125, 2, 135, 12, [[0, "#fff0c0"], [1, "#d89a3c"]]));
  v.circle(117, 7, 1.2, "#ffd67a");
  v.circle(143, 7, 1.2, "#ffd67a");
});

/** Compass ring and needle for the ember finder. */
export const UI_COMPASS = defineSprite("wh.ui.compass", { w: 72, h: 72, origin: [0.5, 0.5], density: 3 }, (p) => {
  const v = pen(p);
  v.circle(36, 36, 30, radial(36, 36, 30, [[0, "#0b1722cc"], [0.8, "#0b172299"], [1, "#0b172200"]]));
  v.ring(36, 36, 25, 1.2, "#ffd67a", { opacity: 0.45 });
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    const r0 = i % 6 === 0 ? 20 : 22;
    v.line(36 + Math.cos(a) * r0, 36 + Math.sin(a) * r0, 36 + Math.cos(a) * 23.5, 36 + Math.sin(a) * 23.5, i % 6 === 0 ? 1 : 0.6, "#ffd67a", { opacity: i % 6 === 0 ? 0.7 : 0.35 });
  }
});

export const UI_NEEDLE = defineSprite("wh.ui.needle", { w: 64, h: 20, origin: [0.5, 0.5], density: 3 }, (p) => {
  const v = pen(p);
  // Points along +x from the centre.
  v.fill(path().moveTo(60, 10).lineTo(44, 4).lineTo(47.5, 10).lineTo(44, 16).close(), linear(44, 0, 60, 0, [[0, "#ffb347"], [1, "#fff2c0"]]));
  v.fill(path().moveTo(60, 10).lineTo(44, 4).lineTo(47.5, 10).close(), "#ffffff", { opacity: 0.35 });
  p.glowOutside("#ff9a3a", 2, 0.7);
});

/** A dark radial scrim that keeps title text readable over the scene. */
export const UI_SCRIM = defineSprite("wh.ui.scrim", { w: 200, h: 100, origin: [0.5, 0.5], density: 0.5 }, (p) => {
  pen(p).ellipse(100, 50, 99, 49, radial(100, 50, 99, [[0, "#050b12f2"], [0.6, "#050b12b8"], [1, "#050b1200"]], 49));
});

// --- Atmosphere ------------------------------------------------------------------------------

export const FOG = defineVariants("wh.fog", 2, { w: 320, h: 140, density: 0.25 }, (p, { index }) => {
  p.shade((x, y, u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const n = noise.fbm(u * 3 + index * 5, v * 2, { seed: 800 + index, octaves: 4 });
    const a = ss(1, 0.2, Math.hypot(dx, dy) + n * 0.5);
    return a > 0.004 ? [170, 210, 220, a * 255] : null;
  });
});

export const MOONBEAM = defineSprite("wh.moonbeam", { w: 120, h: 520, origin: [0.5, 0], density: 0.25 }, (p) => {
  p.shade((x, y, u, v) => {
    const edge = ss(0, 0.35, u) * ss(1, 0.65, u);
    const fall = ss(0, 0.15, v) * ss(1, 0.45, v);
    const streak = 0.75 + noise.perlin(u * 6, v * 0.8, 820) * 0.35;
    const a = edge * fall * streak;
    return a > 0.004 ? [200, 230, 255, a * 255] : null;
  });
});

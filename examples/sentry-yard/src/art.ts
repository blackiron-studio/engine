// Sentry Yard's art, painted in code at three texels per unit: a concrete yard at dusk with
// painted lines, grates and oil stains; concrete barriers, brick walls and timber crates as
// raised isometric blocks with damage stages; red barrels; eight-way sentry turrets; an
// eight-way operative with stride poses; and the combat effects. No image files.
//
// One light: low sun from the upper left of the screen. Tops are brightest, faces turned to
// the lower left are mid-tone, faces turned to the lower right are darkest.

import { type Painter, defineSprite, linear, noise, path, pen, radial } from "@blackiron-studio/engine/art";

import { TILE } from "./units.ts";

export { CELL, TILE } from "./units.ts";

const D = 3;
const M = 1;
const TW = TILE.w + M * 2;
const TH = TILE.h + M * 2;

type RGB = readonly [number, number, number];
const rgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const { fbm, worley, smoothstep: sstep, hash01 } = noise;

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

function groundUV(x: number, y: number): [number, number] {
  const a = (x - TW / 2) / (TILE.w / 2), b = (y - TH / 2) / (TILE.h / 2);
  return [(a + b) / 2 + 0.5, (b - a) / 2 + 0.5];
}

function diamond(grow = 0.7) {
  const cx = TW / 2, cy = TH / 2, hw = TILE.w / 2 + grow * 2, hh = TILE.h / 2 + grow;
  return path().polygon([[cx, cy - hh], [cx + hw, cy], [cx, cy + hh], [cx - hw, cy]]);
}

function floorTile(name: string, shader: (u: number, v: number) => RGB): void {
  defineSprite(name, { w: TW, h: TH, origin: [0.5, 0.5], density: D }, (p) => {
    pen(p).fill(diamond(), "#808080");
    texture(p, (x, y) => {
      const [u0, v0] = groundUV(x, y);
      const u = clamp01(u0), v = clamp01(v0);
      // Brighter toward the far corner, a rim of light on the sun-facing edge.
      const light = 1.03 - (u + v) * 0.03 + (1 - sstep(0, 0.05, u)) * 0.04 - sstep(0.95, 1, v) * 0.05;
      return mul(shader(u, v), light);
    });
  });
}

// ------------------------------------------------------------------------------- floors

const CONCRETE = rgb("#8d949a"), CONCRETE_LIGHT = rgb("#a9afb2"), CONCRETE_DARK = rgb("#6f777e"), JOINT = rgb("#4f565d");
const PAINT = rgb("#e2ae3c"), OIL = rgb("#3a3f45");

function concrete(u: number, v: number, seed: number): RGB {
  const broad = fbm(u * 2, v * 2, { period: 2, octaves: 3, seed });
  const fine = fbm(u * 14, v * 14, { period: 14, octaves: 2, seed: seed + 1 });
  let c = mixc(CONCRETE_DARK, CONCRETE, clamp01(0.75 + broad * 0.6));
  c = mixc(c, CONCRETE_LIGHT, clamp01(broad * 0.5 + 0.2) * 0.35);
  c = mul(c, 1 + fine * 0.07);
  const pit = hash01(Math.floor(u * 90), Math.floor(v * 90), seed + 2);
  if (pit > 0.96) c = mul(c, 0.84);
  // Expansion joints along the cell edges.
  const edge = Math.min(u, v, 1 - u, 1 - v);
  return mixc(c, JOINT, (1 - sstep(0.008, 0.025, edge)) * 0.7);
}

floorTile("slab", (u, v) => concrete(u, v, 11));
floorTile("slab.line", (u, v) => {
  // A worn safety line across the slab.
  const c = concrete(u, v, 13);
  const wear = fbm(u * 9, v * 3, { period: 9, octaves: 3, seed: 14 });
  const line = (1 - sstep(0.035, 0.05, Math.abs(v - 0.5))) * clamp01(0.75 + wear * 1.6);
  return mixc(c, PAINT, line * 0.85);
});
floorTile("slab.oil", (u, v) => {
  const c = concrete(u, v, 17);
  const stain = sstep(0.05, 0.4, fbm(u * 2.5, v * 2.5, { period: 2.5, octaves: 4, seed: 18 }) - Math.hypot(u - 0.5, v - 0.5) * 0.7 + 0.25);
  return mixc(c, OIL, stain * 0.55);
});
floorTile("grate", (u, v) => {
  const frame = Math.min(u, v, 1 - u, 1 - v);
  if (frame < 0.07) return mul(rgb("#7c848b"), 1 - sstep(0.05, 0.07, frame) * 0.15);
  const bar = Math.abs(((u * 8) % 1) - 0.5);
  const lit = bar < 0.2 ? 1.12 - bar : 0.55;
  return mul(rgb("#5e676f"), lit * (1 + fbm(u * 8, v * 8, { period: 8, octaves: 2, seed: 21 }) * 0.1));
});
floorTile("rubble", (u, v) => {
  let c = mul(concrete(u, v, 23), 0.86);
  const w = worley(u * 6, v * 6, 24, 6);
  const chunk = 1 - sstep(0.18, 0.3, w.f1);
  c = mixc(c, mixc(rgb("#b9a48a"), CONCRETE_LIGHT, w.id), chunk * 0.75);
  c = mul(c, 1 - (sstep(0.26, 0.34, w.f1) - sstep(0.34, 0.4, w.f1)) * 0.25);
  return c;
});
floorTile("pad", (u, v) => {
  // Platform tops: hazard stripes round a steel plate.
  const edge = Math.min(u, v, 1 - u, 1 - v);
  if (edge < 0.12) {
    const stripe = Math.floor((u + v) * 7) % 2 === 0;
    return stripe ? rgb("#e3b23c") : rgb("#2c2f33");
  }
  const tread = Math.abs(((u * 6 + v * 6) % 1) - 0.5) < 0.08 && Math.abs(((u * 6 - v * 6 + 10) % 1) - 0.5) < 0.3 ? 1.12 : 1;
  return mul(rgb("#7d868d"), tread * (1 + fbm(u * 5, v * 5, { period: 5, octaves: 2, seed: 27 }) * 0.08));
});

const BRICK = rgb("#a2563f"), BRICK_DARK = rgb("#7d3f2f"), MORTAR = rgb("#c9b8a2");
function brickTop(cracked: boolean) {
  return (u: number, v: number): RGB => {
    const row = Math.floor(v * 4), off = row % 2 ? 0.25 : 0;
    const bu = (u + off) * 2, bi = Math.floor(bu), fu = bu - bi, fv = v * 4 - row;
    let c = mixc(BRICK, BRICK_DARK, hash01(bi, row, 31) * 0.6);
    c = mul(c, 1 + fbm(u * 10, v * 10, { period: 10, octaves: 2, seed: 32 }) * 0.1);
    if (fu < 0.05 || fv < 0.08) c = MORTAR;
    if (cracked) {
      const crack = noise.ridged(u * 4, v * 4, { period: 4, octaves: 3, seed: 33 });
      if (crack > 0.78) c = mul(c, 0.45);
      c = mul(c, 0.9);
    }
    return c;
  };
}
floorTile("brick.top", brickTop(false));
floorTile("brick.cracked.top", brickTop(true));
floorTile("wall.top", (u, v) => {
  const c = mixc(rgb("#b6bcc0"), rgb("#9aa1a6"), clamp01(0.5 + fbm(u * 3, v * 3, { period: 3, octaves: 3, seed: 41 })));
  const edge = Math.min(u, v, 1 - u, 1 - v);
  return mul(c, 1 + (1 - sstep(0.02, 0.08, edge)) * 0.1);
});
function crateTop(split: boolean) {
  return (u: number, v: number): RGB => {
    const plank = Math.floor(u * 4), fu = u * 4 - plank;
    let c = mixc(rgb("#d8a465"), rgb("#b9824a"), hash01(plank, 0, 51));
    c = mul(c, 1 + fbm(u * 2, v * 18, { period: 2, octaves: 3, seed: 52 }) * 0.14);
    if (fu < 0.06) c = rgb("#6d4426");
    const edge = Math.min(u, v, 1 - u, 1 - v);
    if (edge < 0.08) c = rgb("#8a5a31");
    if (split && Math.abs(u - 0.55 - Math.sin(v * 9) * 0.04) < 0.04 && v > 0.15) c = rgb("#2b1a10");
    return c;
  };
}
floorTile("crate.top", crateTop(false));
floorTile("crate.split.top", crateTop(true));

// ------------------------------------------------------------------------------- block faces

const RIM = 1, UNDER = 1;
const FACE_H = TILE.rise + TILE.h / 2 + RIM + UNDER;
type FaceShader = (s: number, t: number, side: "left" | "right") => RGB | null;

/** A face under a raised edge: `s` runs 0..1 along it, `t` is units below the rim. */
function face(name: string, side: "left" | "right", shader: FaceShader): void {
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
      const c = shader((((x / w) % 1) + 1) % 1, y - RIM - top(x), side);
      return c ? mul(c, side === "left" ? 0.92 : 0.66) : null;
    });
  });
}
function faces(name: string, shader: FaceShader): void {
  face(`${name}.left`, "left", shader);
  face(`${name}.right`, "right", shader);
}

faces("wall", (s, t) => {
  if (t < 0.6) return rgb("#d9dee1");
  let c = mixc(rgb("#a4abb0"), rgb("#868e94"), clamp01(t / 16));
  c = mul(c, 1 + fbm(s * 6, t * 0.4, { period: 6, octaves: 3, seed: 61 }) * 0.1);
  if (Math.abs(((s * 2) % 1) - 0.5) > 0.48) c = mul(c, 0.7); // panel seams
  const bolt = Math.hypot(((s * 2) % 1) - 0.5, t - 3) < 0.7;
  if (bolt) c = mul(c, 1.25);
  return mul(c, 1 - sstep(10, 17, t) * 0.2);
});
function brickFace(cracked: boolean): FaceShader {
  return (s, t) => {
    if (t < 0.5) return rgb("#d8c4ad");
    const course = Math.floor(t / 4), ft = t - course * 4;
    const bs = (s * 4 + (course % 2 ? 0.5 : 0)), bi = Math.floor(bs), fs = bs - bi;
    let c = mixc(BRICK, BRICK_DARK, hash01(bi, course, 71) * 0.7);
    c = mul(c, 1 + fbm(s * 9, t * 0.6, { period: 9, octaves: 2, seed: 72 }) * 0.12);
    if (ft < 0.6 || fs < 0.06) c = mul(MORTAR, 0.85);
    if (cracked) {
      const crack = noise.ridged(s * 3, t * 0.25, { period: 3, octaves: 3, seed: 73 });
      if (crack > 0.8) c = mul(c, 0.35);
      if (hash01(bi, course, 74) < 0.12) c = mul(c, 0.55); // missing bricks
    }
    return mul(c, 1 - sstep(10, 17, t) * 0.18);
  };
}
faces("brick", brickFace(false));
faces("brick.cracked", brickFace(true));
function crateFace(split: boolean): FaceShader {
  return (s, t) => {
    if (t < 0.5) return rgb("#f0c88a");
    const frame = Math.min(s, 1 - s) < 0.09 || t < 2 || t > 14.5;
    let c = frame ? rgb("#9a6638") : mixc(rgb("#d39c5c"), rgb("#b47b42"), hash01(Math.floor(t / 4), 0, 81));
    c = mul(c, 1 + fbm(s * 12, t * 0.2, { period: 12, octaves: 3, seed: 82 }) * 0.12);
    if (!frame && Math.abs(t - 2 - s * 12.5) < 0.9) c = rgb("#8e5c31"); // brace
    if (!frame && (t % 4) < 0.35) c = mul(c, 0.7);
    if (split && Math.abs(s - 0.45 - Math.sin(t * 0.7) * 0.05) < 0.035 && t > 1) c = rgb("#24160d");
    return c;
  };
}
faces("crate", crateFace(false));
faces("crate.split", crateFace(true));

// ------------------------------------------------------------------------------- shadows, decals

defineSprite("shadow", { w: 28, h: 14, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).ellipse(14, 7, 13, 6, radial(14, 7, 13, [[0, "#0d1218cc"], [0.6, "#0d121866"], [1, "#0d121800"]], 6));
});
defineSprite("contact", { w: 38, h: 18, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).ellipse(19, 9, 18, 8.5, radial(19, 9, 18, [[0, "#0d1218b0"], [0.45, "#0d121870"], [1, "#0d121800"]], 8.5));
});
defineSprite("scorch", { w: 70, h: 36, origin: [0.5, 0.5], density: D }, (p) => {
  const v = pen(p);
  v.ellipse(35, 18, 34, 17, radial(35, 18, 34, [[0, "#14100ddd"], [0.5, "#1d1611a0"], [1, "#1d161100"]], 17));
  texture(p, (x, y, c) => mul(c, 0.85 + hash01(Math.floor(x * 2), Math.floor(y * 2), 91) * 0.3));
});
defineSprite("reticle", { w: 40, h: 20, origin: [0.5, 0.5], density: D }, (p) => {
  const v = pen(p);
  v.stroke(path().ellipse(20, 10, 16, 8), 1.4, "#ffe9b0");
  for (const [x, y] of [[20, 1.5], [20, 18.5], [3, 10], [37, 10]] as const) v.circle(x, y, 1.3, "#ffe9b0");
  p.glowOutside("#ffb84a", 1.5, 0.7);
});
defineSprite("lock", { w: 48, h: 24, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).stroke(path().ellipse(24, 12, 20, 10), 1.6, "#ff6a4a");
  p.glowOutside("#ff3a2a", 2, 0.8);
});
// A ground circle of radius 48 units, projected: 2*sqrt(2)*48 wide.
defineSprite("blast.ring", { w: 140, h: 72, origin: [0.5, 0.5], density: 2 }, (p) => {
  const v = pen(p);
  v.ellipse(70, 36, 67.9, 33.9, radial(70, 36, 68, [[0, "#ff8a3a00"], [0.75, "#ff8a3a22"], [1, "#ffb05a55"]], 34));
  v.stroke(path().ellipse(70, 36, 67.9, 33.9), 1.2, "#ffc070", { opacity: 0.9 });
});
defineSprite("dot", { w: 6, h: 6, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).circle(3, 3, 2.2, radial(3, 3, 2.2, [[0, "#fff6dc"], [1, "#ffd48a"]]));
});

// ------------------------------------------------------------------------------- props

defineSprite("barrel", { w: 26, h: 36, origin: [0.5, 0.86], density: D }, (p) => {
  const v = pen(p);
  const body = linear(2, 0, 24, 0, [[0, "#7a1712"], [0.28, "#e0503a"], [0.5, "#c8382c"], [1, "#5e110d"]]);
  v.fill(path().moveTo(2, 8).lineTo(2, 28).ellipseArc(13, 28, 11, 5, Math.PI, 0).lineTo(24, 8).close(), body);
  for (const y of [13, 22]) v.stroke(path().moveTo(2, y).ellipseArc(13, y, 11, 5, Math.PI, 0), 1.2, "#4a0d0a", { opacity: 0.8 });
  // Hazard band.
  v.fill(path().moveTo(24, 16).ellipseArc(13, 16, 11, 5, 0, Math.PI).lineTo(2, 19.5).ellipseArc(13, 19.5, 11, 5, Math.PI, 0).close(), "#e8b53c", { opacity: 0.95 });
  v.ellipse(13, 8, 11, 5, linear(2, 4, 24, 12, [[0, "#f07a62"], [1, "#a4291f"]]));
  v.ellipse(17, 8, 2.2, 1.2, "#3a0a08");
  v.stroke(path().ellipse(13, 8, 11, 5), 0.8, "#ff9a80", { opacity: 0.6 });
});

/** Ground direction k (0..7, +x first, a quarter turn at k = 2) as a unit vector on the screen. */
function screenDir(k: number): [number, number] {
  const a = (k * Math.PI) / 4;
  const sx = Math.cos(a) - Math.sin(a), sy = (Math.cos(a) + Math.sin(a)) / 2;
  const l = Math.hypot(sx, sy);
  return [sx / l, sy / l];
}

// Sentry turrets: a tripod base, a cowled head with a red eye, a twin barrel aimed along k.
for (let k = 0; k < 8; k++) {
  defineSprite(`sentry.${k}`, { w: 52, h: 52, origin: [0.5, 0.82], density: D }, (p) => {
    const v = pen(p);
    const cx = 26, base = 42;
    const [dx, dy] = screenDir(k);
    const away = dy < -0.2;
    // Tripod legs.
    for (const [lx, ly] of [[-12, 4], [12, 4], [0, 8]] as const) v.line(cx, base - 10, cx + lx, base + ly - 4, 2.4, "#3b4148");
    v.ellipse(cx, base - 10, 8, 4, "#4d555d");
    const barrel = () => {
      const bx = cx + dx * 4, by = base - 21 + dy * 2;
      for (const off of [-1.6, 1.6]) {
        const ox = -dy * off, oy = dx * off * 0.5;
        v.line(bx + ox, by + oy, bx + ox + dx * 17, by + oy + dy * 9, 2.2, "#2a2f35");
      }
      v.circle(bx + dx * 17, by + dy * 9, 1.6, "#ff6a3a", { opacity: 0.6 });
    };
    if (away) barrel();
    // Head: a rounded cowl lit from the upper left.
    v.roundRect(cx - 11, base - 30, 22, 16, 6, linear(cx - 11, base - 30, cx + 11, base - 14, [[0, "#e9edf0"], [0.5, "#b9c1c7"], [1, "#6d767e"]]));
    v.rect(cx - 11, base - 20, 22, 2.2, "#e2a93a");
    if (!away) {
      v.circle(cx + dx * 6, base - 24 + dy * 3, 3.2, radial(cx + dx * 6, base - 24 + dy * 3, 3.2, [[0, "#fff1e0"], [0.4, "#ff4a32"], [1, "#a01810"]]));
      barrel();
    }
  });
}
defineSprite("sentry.wreck", { w: 52, h: 40, origin: [0.5, 0.85], density: D }, (p) => {
  const v = pen(p);
  for (const [lx, ly] of [[-13, 2], [10, 6], [2, 7]] as const) v.line(26, 26, 26 + lx, 32 + ly, 2.2, "#25292e");
  v.roundRect(13, 20, 22, 11, 5, linear(13, 20, 35, 31, [[0, "#6b7076"], [1, "#2c3034"]]));
  v.line(20, 24, 36, 30, 2, "#1c1f22");
  v.circle(24, 24, 2.4, "#ff7a3a", { opacity: 0.7 });
});

// The operative: helmet, olive armour, tan trousers, a rifle held along the aim (eight ways)
// with two stride poses each.
const SKIN = "#e8b48c", HELMET = "#4f6044", HELMET_LIGHT = "#71865f", ARMOUR = "#5c7349", ARMOUR_DARK = "#3c4d31", PANTS = "#8f7c5c", BOOT = "#2d2a26", GUN = "#24282c", VISOR = "#7ee0ff";
function operative(name: string, k: number, stride: number): void {
  defineSprite(name, { w: 40, h: 56, origin: [0.5, 0.9], density: D }, (p) => {
    const v = pen(p);
    const cx = 20, foot = 50;
    const [dx, dy] = screenDir(k);
    const away = dy < -0.2;
    const side = Math.abs(dx) > 0.7;
    // Legs.
    const swing = stride * 3.2;
    v.roundRect(cx - 6 + (side ? swing * 0.5 : 0), foot - 15 - Math.max(0, swing), 5, 14, 2, PANTS);
    v.roundRect(cx + 1 - (side ? swing * 0.5 : 0), foot - 15 + Math.min(0, swing), 5, 14, 2, PANTS);
    v.roundRect(cx - 7 + (side ? swing * 0.5 : 0), foot - 3 - Math.max(0, swing), 7, 3.5, 1.5, BOOT);
    v.roundRect(cx + 0 - (side ? swing * 0.5 : 0), foot - 3 + Math.min(0, swing), 7, 3.5, 1.5, BOOT);
    const gun = () => {
      const gx = cx + dx * 3, gy = foot - 24 + dy * 2;
      v.line(gx - dx * 4, gy - dy * 2, gx + dx * 15, gy + dy * 8, 3, GUN);
      v.line(gx + dx * 15, gy + dy * 8, gx + dx * 19, gy + dy * 10, 1.6, GUN);
    };
    if (away) gun();
    // Torso and armour plate.
    v.roundRect(cx - 8, foot - 30, 16, 17, 5, linear(cx - 8, 0, cx + 8, 0, [[0, ARMOUR], [1, ARMOUR_DARK]]));
    v.roundRect(cx - 6, foot - 28, 12, 7, 3, "#6f8a58", { opacity: away ? 0.35 : 0.9 });
    // Head and helmet.
    v.circle(cx, foot - 35, 6, SKIN);
    v.fill(path().ellipseArc(cx, foot - 36, 7.4, 6.4, Math.PI, Math.PI * 2).close(), linear(cx - 7, 0, cx + 7, 0, [[0, HELMET_LIGHT], [1, HELMET]]));
    if (!away) v.roundRect(cx - 4 + dx * 2.5, foot - 36.5, 8, 2.6, 1.2, VISOR, { opacity: 0.95 });
    // Arms toward the gun.
    const hx = cx + dx * 9, hy = foot - 23 + dy * 4;
    v.line(cx - 6, foot - 27, hx, hy, 3, ARMOUR_DARK);
    v.line(cx + 6, foot - 27, hx + dx * 4, hy + dy * 2, 3, ARMOUR);
    if (!away) gun();
  });
}
for (let k = 0; k < 8; k++) {
  operative(`op.${k}`, k, 0);
  operative(`op.${k}.a`, k, 1);
  operative(`op.${k}.b`, k, -1);
}
defineSprite("op.down", { w: 48, h: 30, origin: [0.5, 0.7], density: D }, (p) => {
  const v = pen(p);
  v.roundRect(8, 12, 30, 9, 4, ARMOUR_DARK);
  v.circle(39, 16, 5, SKIN);
  v.roundRect(4, 14, 8, 5, 2, PANTS);
});

// ------------------------------------------------------------------------------- effects

defineSprite("spark", { w: 6, h: 6, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).circle(3, 3, 3, radial(3, 3, 3, [[0, "#fffbe6"], [0.35, "#ffd27a"], [1, "#ffb34a00"]]));
});
defineSprite("tracer", { w: 5, h: 5, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).circle(2.5, 2.5, 2.5, radial(2.5, 2.5, 2.5, [[0, "#fffef0"], [0.4, "#ffe7a0cc"], [1, "#ffcf6000"]]));
});
defineSprite("bolt", { w: 14, h: 14, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).circle(7, 7, 7, radial(7, 7, 7, [[0, "#ffffff"], [0.25, "#ff9a86"], [0.6, "#ff3a2a88"], [1, "#ff201000"]]));
});
defineSprite("flame", { w: 22, h: 22, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).circle(11, 11, 11, radial(11, 11, 11, [[0, "#fff4d0"], [0.3, "#ffc04a"], [0.65, "#ff5a1e99"], [1, "#c0200000"]]));
});
defineSprite("smoke", { w: 26, h: 26, origin: [0.5, 0.5], density: 2 }, (p) => {
  pen(p).circle(13, 13, 13, radial(13, 13, 13, [[0, "#5b5e63aa"], [0.6, "#4a4d5255"], [1, "#3a3d4200"]]));
});
defineSprite("chip", { w: 4, h: 4, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).rect(0.5, 0.5, 3, 3, "#b9a48a");
});
defineSprite("splinter", { w: 5, h: 3, origin: [0.5, 0.5], density: D }, (p) => {
  pen(p).rect(0, 0.5, 5, 2, "#c48c4e");
});
defineSprite("grenade", { w: 9, h: 9, origin: [0.5, 0.5], density: D }, (p) => {
  const v = pen(p);
  v.circle(4.5, 4.8, 3.8, radial(3.4, 3.6, 4.5, [[0, "#9db07c"], [0.6, "#4e5e3c"], [1, "#2a3320"]]));
  v.rect(3.5, 0.4, 2, 1.6, "#c9c9c9");
});
defineSprite("muzzle", { w: 18, h: 18, origin: [0.5, 0.5], density: D }, (p) => {
  const v = pen(p);
  v.circle(9, 9, 9, radial(9, 9, 9, [[0, "#ffffff"], [0.3, "#ffe08acc"], [1, "#ff9a3a00"]]));
  v.fill(path().star(9, 9, 9, 0.35, 5, 0.3), "#fff2c0", { opacity: 0.8 });
});

// Lowline's art, painted in code at boot: high-resolution vector sprites with one light
// direction (top left), soft shadows toward the bottom right and tileable noise textures.
// This module only defines sprites, so `blackiron atlas` can import it headlessly.

import {
  defineSprite as registerSprite,
  defineVariants as registerVariants,
  pen,
  path,
  linear,
  radial,
  conic,
  noise,
  type Painter,
  type Pen,
  type PaintFn,
  type SpriteSpec,
} from "@blackiron-studio/engine/art";

// Painting the city takes about two seconds, so each sprite keeps its texels after the first
// bake: later bakes in the same process (scene restarts, test apps) copy them back instantly.
const baked = new Map<string, Uint8ClampedArray>();
const cached =
  (paint: PaintFn): PaintFn =>
  (p, ctx) => {
    const hit = baked.get(ctx.name);
    if (hit && hit.length === p.data.length) {
      p.data.set(hit);
      return;
    }
    paint(p, ctx);
    baked.set(ctx.name, p.data.slice());
  };
const defineSprite = (name: string, spec: SpriteSpec, paint: PaintFn) => registerSprite(name, spec, cached(paint));
const defineVariants = (name: string, count: number, spec: SpriteSpec, paint: PaintFn) => registerVariants(name, count, spec, cached(paint));

// --- Shared helpers ---------------------------------------------------------------------

type RGB = [number, number, number];
const OUT: [number, number, number, number] = [0, 0, 0, 255];
const clamp = (v: number, a = 0, b = 255) => (v < a ? a : v > b ? b : v);
const hex = (c: string): RGB => {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const css = (c: RGB, a = 1) =>
  "#" +
  c.map((v) => Math.round(clamp(v)).toString(16).padStart(2, "0")).join("") +
  (a < 1 ? Math.round(a * 255).toString(16).padStart(2, "0") : "");
const shadeRGB = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** A tileable noise field sampled bilinearly; built lazily and shared between sprites. */
class Grid {
  constructor(
    readonly n: number,
    readonly d: Float32Array,
  ) {}
  at(x: number, y: number): number {
    const n = this.n;
    x = ((x % n) + n) % n;
    y = ((y % n) + n) % n;
    const x0 = x | 0,
      y0 = y | 0,
      fx = x - x0,
      fy = y - y0,
      x1 = (x0 + 1) % n,
      y1 = (y0 + 1) % n,
      d = this.d;
    const a = d[y0 * n + x0],
      b = d[y0 * n + x1],
      c = d[y1 * n + x0],
      e = d[y1 * n + x1];
    return a + (b - a) * fx + (c - a + (e - c - b + a) * fx) * fy;
  }
}
const grids = new Map<string, Grid>();
function grid(key: string, n: number, make: (x: number, y: number) => number): Grid {
  let g = grids.get(key);
  if (!g) {
    const d = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) d[y * n + x] = make(x, y);
    g = new Grid(n, d);
    grids.set(key, g);
  }
  return g;
}
/** fbm in [-1, 1] that tiles every 128 samples, `cells` features across. */
const fbmG = (cells: number, seed: number, octaves = 4) =>
  grid(`f${cells}:${seed}:${octaves}`, 128, (x, y) =>
    noise.fbm((x / 128) * cells, (y / 128) * cells, { period: cells, seed, octaves }),
  );
const hash = (x: number, y: number, s = 0) => noise.hash01(Math.floor(x), Math.floor(y), s);

/** Fill every texel of a painter opaquely from a function of logical coordinates. */
function fillTex(p: Painter, fn: (x: number, y: number, out: number[]) => void) {
  const d = p.data,
    k = 1 / p.density;
  for (let ty = 0; ty < p.height; ty++)
    for (let tx = 0; tx < p.width; tx++) {
      fn((tx + 0.5) * k, (ty + 0.5) * k, OUT);
      const i = (ty * p.width + tx) * 4;
      d[i] = OUT[0];
      d[i + 1] = OUT[1];
      d[i + 2] = OUT[2];
      d[i + 3] = 255;
    }
}
/** A shader paint over logical coordinates that returns an opaque colour. */
const tex =
  (fn: (x: number, y: number, out: number[]) => void, alpha = 255) =>
  (x: number, y: number) => {
    OUT[3] = alpha;
    fn(x, y, OUT);
    return OUT;
  };
function setRGB(out: number[], c: RGB, k: number) {
  out[0] = clamp(c[0] * k);
  out[1] = clamp(c[1] * k);
  out[2] = clamp(c[2] * k);
}
/** Paint into a fresh layer, give it a soft drop shadow toward the bottom right, composite. */
// Alpha-only versions of the painter's shadow effects: one channel instead of four, which
// keeps the full-roof passes cheap enough to paint the whole city in about a second.
function boxBlur(a: Float32Array, w: number, h: number, r: number) {
  if (r < 1) return;
  const tmp = new Float32Array(Math.max(w, h)),
    inv = 1 / (2 * r + 1);
  const line = (start: number, step: number, n: number) => {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += a[start + Math.min(n - 1, Math.max(0, i)) * step];
    for (let i = 0; i < n; i++) {
      tmp[i] = acc * inv;
      acc += a[start + Math.min(n - 1, i + r + 1) * step] - a[start + Math.max(0, i - r) * step];
    }
    for (let i = 0; i < n; i++) a[start + i * step] = tmp[i];
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) line(y * w, 1, w);
    for (let x = 0; x < w; x++) line(x, w, h);
  }
}
function alphaOf(p: Painter, invert = false) {
  const n = p.width * p.height,
    a = new Float32Array(n),
    d = p.data;
  for (let i = 0; i < n; i++) a[i] = invert ? 1 - d[i * 4 + 3] / 255 : d[i * 4 + 3] / 255;
  return a;
}
/** A soft shadow of the painter's shape, offset by (dx, dy) units, drawn behind it. */
function shadowBehind(p: Painter, dx: number, dy: number, blur: number, opacity: number, c: RGB = [7, 11, 24]) {
  const w = p.width,
    h = p.height,
    k = p.density,
    a = alphaOf(p);
  boxBlur(a, w, h, Math.max(1, Math.round((blur * k) / 1.73)));
  const ox = Math.round(dx * k),
    oy = Math.round(dy * k),
    d = p.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = x - ox,
        sy = y - oy;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const sa = a[sy * w + sx] * opacity;
      if (sa <= 0.002) continue;
      const i = (y * w + x) * 4,
        da = d[i + 3] / 255,
        oa = da + sa * (1 - da);
      d[i] = (d[i] * da + c[0] * sa * (1 - da)) / oa;
      d[i + 1] = (d[i + 1] * da + c[1] * sa * (1 - da)) / oa;
      d[i + 2] = (d[i + 2] * da + c[2] * sa * (1 - da)) / oa;
      d[i + 3] = oa * 255;
    }
}
/** A shadow cast inward from the shape's edges, offset by (dx, dy) units. */
function shadowInside(p: Painter, dx: number, dy: number, blur: number, opacity: number, c: RGB = [10, 14, 26]) {
  const w = p.width,
    h = p.height,
    k = p.density,
    a = alphaOf(p, true);
  boxBlur(a, w, h, Math.max(1, Math.round((blur * k) / 1.73)));
  const ox = Math.round(dx * k),
    oy = Math.round(dy * k),
    d = p.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      const sx = x - ox,
        sy = y - oy,
        s = (sx < 0 || sy < 0 || sx >= w || sy >= h ? 1 : a[sy * w + sx]) * opacity;
      d[i] += (c[0] - d[i]) * s;
      d[i + 1] += (c[1] - d[i + 1]) * s;
      d[i + 2] += (c[2] - d[i + 2]) * s;
    }
}
/** Light and shade along the shape's edges, light from the top left. */
function edgeLight(p: Painter, size: number, strength: number) {
  const w = p.width,
    h = p.height,
    k = p.density,
    a = alphaOf(p),
    d = p.data,
    rad = Math.max(1, size * k);
  boxBlur(a, w, h, Math.max(1, Math.round(rad / 1.73)));
  const lx = -0.6,
    ly = -0.8;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      const j = y * w + x,
        gx = a[j + 1] - a[j - 1],
        gy = a[j + w] - a[j - w];
      const v = Math.max(-1, Math.min(1, -(gx * lx + gy * ly) * rad * 0.5)) * strength;
      if (v > 0) {
        d[i] += (255 - d[i]) * v;
        d[i + 1] += (255 - d[i + 1]) * v;
        d[i + 2] += (255 - d[i + 2]) * v;
      } else {
        d[i] *= 1 + v;
        d[i + 1] *= 1 + v;
        d[i + 2] *= 1 + v;
      }
    }
}
function raised(p: Painter, fn: (v: Pen) => void, dx = 2.2, dy = 1.8, blur = 1.6, opacity = 0.55) {
  const l = p.blank();
  fn(pen(l));
  shadowBehind(l, dx, dy, blur, opacity);
  p.composite(l);
}

export const LIGHT = { x: 0.8, y: 0.6 }; // shadow direction (light from the top left)

// --- FX and lights ----------------------------------------------------------------------

defineSprite("ll.fx.glow", { w: 64, h: 64, density: 1, smooth: true }, (p) => {
  const v = pen(p);
  v.circle(32, 32, 32, radial(32, 32, 32, [[0, "#ffffff"], [0.18, "#ffffffc8"], [0.45, "#ffffff50"], [0.75, "#ffffff12"], [1, "#ffffff00"]]));
});
defineSprite("ll.fx.dot", { w: 12, h: 12, density: 4 }, (p) => {
  const v = pen(p);
  v.circle(6, 6, 6, radial(6, 6, 6, [[0, "#ffffff"], [0.45, "#ffffffee"], [0.7, "#ffffff60"], [1, "#ffffff00"]]));
});
defineSprite("ll.fx.shadow", { w: 32, h: 32, density: 1, smooth: true }, (p) => {
  pen(p).circle(16, 16, 16, radial(16, 16, 16, [[0, "#000000"], [0.45, "#000000d0"], [1, "#00000000"]]));
});
defineSprite("ll.fx.softbox", { w: 48, h: 48, density: 1, smooth: true }, (p) => {
  pen(p).roundRect(8, 8, 32, 32, 6, "#ffffff");
  p.blur(4.5);
});
defineSprite("ll.fx.skid", { w: 22, h: 4, density: 2 }, (p) => {
  const v = pen(p);
  v.roundRect(1, 0.6, 20, 2.8, 1.4, "#0b0d12");
  p.blur(0.5);
});
defineSprite("ll.fx.ring", { w: 64, h: 64, density: 2 }, (p) => {
  const v = pen(p);
  v.ring(32, 32, 27, 3, "#ffffff");
  v.ring(32, 32, 27, 9, "#ffffff", { opacity: 0.18 });
  p.bleed(2);
});
defineSprite("ll.fx.chevron", { w: 22, h: 18, density: 3, origin: [0.5, 0.9] }, (p) => {
  const v = pen(p);
  v.fill(path().polygon([[2, 3], [20, 3], [11, 16]]), linear(0, 3, 0, 16, [[0, "#fff6dc"], [1, "#ffcf7a"]]));
  p.dropShadow({ dx: 0, dy: 1, blur: 1.4, opacity: 0.5 });
});

// --- Ground: asphalt, paving, boards, kerbs, water --------------------------------------

const ASPHALT = hex("#353a4a");
export const ASPHALT_TILES = defineVariants("ll.ground.asphalt", 4, { w: 128, h: 128, density: 2, edge: "extrude" }, (p, { index }) => {
  const a = fbmG(4, 11),
    b = fbmG(16, 12, 3),
    c = fbmG(8, 13 + index, 3),
    off = index * 37;
  fillTex(p, (x, y, out) => {
    const u = x + off,
      w = y + off * 0.5;
    let l = 1 + a.at(u, w) * 0.09 + b.at(u * 2, w * 2) * 0.07 + (hash(x * 4, y * 4, 3 + index) - 0.5) * 0.14;
    const stain = c.at(u, w);
    if (stain > 0.32) l *= 0.9;
    const s = hash(x * 3, y * 3, 9 + index);
    if (s > 0.985) l += 0.22;
    else if (s < 0.01) l -= 0.18;
    setRGB(out, ASPHALT, l);
  });
});

const SLAB = hex("#87837f");
export const PAVING_TILES = defineVariants("ll.ground.paving", 4, { w: 64, h: 64, density: 2, edge: "extrude" }, (p, { index }) => {
  const g = fbmG(4, 21),
    f = fbmG(16, 22, 3);
  fillTex(p, (x, y, out) => {
    const sx = Math.floor(x / 16),
      sy = Math.floor(y / 16),
      fx = x - sx * 16,
      fy = y - sy * 16;
    const tone = 0.9 + hash(sx, sy, 31 + index) * 0.14;
    let l = tone + g.at(x * 2 + index * 40, y * 2) * 0.06 + f.at(x * 2, y * 2) * 0.05 + (hash(x * 5, y * 5, index) - 0.5) * 0.08;
    const e = Math.min(fx, fy, 16 - fx, 16 - fy);
    if (e < 0.55) l *= 0.76;
    else if (fx < 1.4 || fy < 1.4) l *= 1.07;
    else if (16 - fx < 1.4 || 16 - fy < 1.4) l *= 0.92;
    setRGB(out, SLAB, l);
    out[2] = clamp(out[2] + 4);
  });
});

const WOOD = hex("#7c5a44");
defineVariants("ll.ground.boards", 2, { w: 64, h: 64, density: 2, edge: "extrude" }, (p, { index }) => {
  const g = fbmG(8, 41, 3);
  fillTex(p, (x, y, out) => {
    const row = Math.floor(y / 6.4),
      fy = y - row * 6.4,
      seam = (hash(row, 0, 51 + index) * 64) | 0,
      fx = (x - seam + 64) % 64;
    let l = 0.82 + hash(row, Math.floor((x - seam + 64) / 32), 5 + index) * 0.26;
    l += g.at(x * 0.5, y * 6) * 0.12;
    if (fy < 0.6) l *= 0.45;
    else if (fy < 1.3) l *= 1.12;
    if (fx < 0.5) l *= 0.5;
    if ((fx > 2 && fx < 2.9 && (fy > 1.6 && fy < 2.5)) || (fx > 2 && fx < 2.9 && fy > 4.1 && fy < 5)) l *= 0.6;
    setRGB(out, WOOD, l);
  });
});

/** A kerb strip, 64 long: stone on the sidewalk side (top), gutter grime toward the road. */
defineSprite("ll.kerb", { w: 64, h: 10, density: 2, origin: [0, 0], edge: "extrude" }, (p) => {
  const g = fbmG(8, 61, 3);
  const d = p.data;
  for (let ty = 0; ty < p.height; ty++)
    for (let tx = 0; tx < p.width; tx++) {
      const x = (tx + 0.5) / 2,
        y = (ty + 0.5) / 2,
        i = (ty * p.width + tx) * 4;
      let c: RGB, a = 255;
      if (y < 5) {
        let l = 1.05 + g.at(x * 2, y * 2) * 0.07;
        if (y < 1) l *= 0.8;
        else if (y < 2) l *= 1.12;
        else if (y > 4.2) l *= 0.72;
        if (x % 16 < 0.5) l *= 0.6;
        c = shadeRGB(hex("#b3aea6"), l);
      } else {
        c = [14, 16, 24];
        a = 170 * Math.pow(1 - (y - 5) / 5, 1.6) * (0.75 + g.at(x * 3, 9) * 0.3);
      }
      d[i] = clamp(c[0]);
      d[i + 1] = clamp(c[1]);
      d[i + 2] = clamp(c[2]);
      d[i + 3] = clamp(a);
    }
});

const WATER = hex("#163b52");
defineVariants("ll.water.base", 2, { w: 128, h: 128, density: 1, smooth: true, edge: "extrude" }, (p, { index }) => {
  const a = fbmG(4, 71 + index),
    b = fbmG(8, 72, 3);
  fillTex(p, (x, y, out) => {
    const n = a.at(x, y),
      m = b.at(x + n * 20, y * 2);
    const l = 0.92 + n * 0.12 + m * 0.08;
    setRGB(out, WATER, l);
    out[1] = clamp(out[1] + m * 6);
  });
});
defineVariants("ll.water.glint", 2, { w: 128, h: 128, density: 1.5, smooth: true, edge: "extrude" }, (p, { index }) => {
  const warp = fbmG(4, 81 + index, 3);
  const d = p.data,
    k = 1 / p.density;
  for (let ty = 0; ty < p.height; ty++)
    for (let tx = 0; tx < p.width; tx++) {
      const x = (tx + 0.5) * k,
        y = (ty + 0.5) * k,
        wx = x + warp.at(x, y) * 10,
        wy = y + warp.at(y, x) * 10;
      const c = noise.worley((wx / 128) * 6, (wy / 128) * 9, 91 + index, 0, 0.9);
      const e = c.f2 - c.f1;
      const a = e < 0.06 ? (1 - e / 0.06) * (0.5 + warp.at(x * 2, y * 2) * 0.5) : 0;
      const i = (ty * p.width + tx) * 4;
      d[i] = 190;
      d[i + 1] = 228;
      d[i + 2] = 255;
      d[i + 3] = clamp(a * 255);
    }
});

/** The sea wall, 64 long: quay stone on top, a dark wet wall face, foam at the waterline. */
defineSprite("ll.seawall", { w: 64, h: 16, density: 2, origin: [0, 0], edge: "extrude" }, (p) => {
  const g = fbmG(8, 101, 3);
  const d = p.data;
  for (let ty = 0; ty < p.height; ty++)
    for (let tx = 0; tx < p.width; tx++) {
      const x = (tx + 0.5) / 2,
        y = (ty + 0.5) / 2,
        i = (ty * p.width + tx) * 4;
      let c: RGB,
        a = 255;
      if (y < 7) {
        const bx = Math.floor((x + (Math.floor(y / 7) % 2) * 8) / 16);
        let l = 0.95 + hash(bx, 0, 3) * 0.12 + g.at(x * 2, y * 2) * 0.08;
        if ((x + 0) % 16 < 0.5) l *= 0.6;
        if (y < 1.2) l *= 1.15;
        if (y > 6) l *= 0.7;
        c = shadeRGB(hex("#a49e94"), l);
      } else if (y < 11) {
        const l = 0.55 - (y - 7) * 0.06 + g.at(x * 3, y * 3) * 0.08;
        c = shadeRGB(hex("#4a5560"), l);
      } else {
        const t = (y - 11) / 5;
        c = [200, 230, 240];
        a = (1 - t) * 150 * (0.6 + g.at(x * 2, 30) * 0.6);
      }
      d[i] = clamp(c[0]);
      d[i + 1] = clamp(c[1]);
      d[i + 2] = clamp(c[2]);
      d[i + 3] = clamp(a);
    }
});

// --- Road markings and decals -----------------------------------------------------------

/** Worn road paint: a solid colour whose alpha is eaten by noise. */
const worn = (c: RGB, k = 1) => {
  const g = fbmG(16, 111, 3);
  return tex((x, y, out) => {
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = clamp((0.86 + g.at(x * 3, y * 3) * 0.5 - (hash(x * 3, y * 3, 7) > 0.97 ? 0.4 : 0)) * 255 * k);
  });
};
const PAINT_W = hex("#e6e2d4"),
  PAINT_Y = hex("#f0b44c");
defineSprite("ll.mark.edge", { w: 64, h: 2, density: 2, origin: [0, 0.5], edge: "extrude" }, (p) => {
  pen(p).rect(0, 0.2, 64, 1.6, worn(PAINT_W, 0.75));
});
defineSprite("ll.mark.center", { w: 64, h: 6, density: 2, origin: [0, 0.5], edge: "extrude" }, (p) => {
  const v = pen(p);
  v.rect(0, 0.6, 64, 1.6, worn(PAINT_Y, 0.9));
  v.rect(0, 3.8, 64, 1.6, worn(PAINT_Y, 0.9));
});
defineSprite("ll.mark.dash", { w: 24, h: 2, density: 2 }, (p) => {
  pen(p).roundRect(0, 0.2, 24, 1.6, 0.4, worn(PAINT_W, 0.8));
});
defineSprite("ll.mark.zebra", { w: 100, h: 20, density: 2 }, (p) => {
  const v = pen(p);
  for (let x = 2; x < 98; x += 10.6) v.rect(x, 0, 6.2, 20, worn(PAINT_W, 0.82));
});
defineSprite("ll.mark.stop", { w: 50, h: 3, density: 2 }, (p) => {
  pen(p).rect(0, 0, 50, 3, worn(PAINT_W, 0.85));
});
defineSprite("ll.mark.arrow", { w: 10, h: 28, density: 2 }, (p) => {
  const v = pen(p);
  v.fill(path().polygon([[5, 0], [10, 9], [6.6, 9], [6.6, 28], [3.4, 28], [3.4, 9], [0, 9]]), worn(PAINT_W, 0.7));
});
defineSprite("ll.decal.manhole", { w: 18, h: 18, density: 3 }, (p) => {
  const v = pen(p);
  v.circle(9, 9, 8.6, "#1b1e26");
  v.circle(9, 9, 7.6, radial(7, 7, 9, [[0, "#4c4f57"], [1, "#30333b"]]));
  for (let r = 2.2; r < 7; r += 1.6) v.ring(9, 9, r, 0.45, "#22252c");
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    v.line(9 + Math.cos(a) * 1.5, 9 + Math.sin(a) * 1.5, 9 + Math.cos(a) * 7.2, 9 + Math.sin(a) * 7.2, 0.45, "#22252c");
  }
  v.ring(9, 9, 8.1, 0.6, "#6a6c72", { opacity: 0.6 });
  p.bevel({ size: 1.2, strength: 0.4 });
});
defineSprite("ll.decal.grate", { w: 16, h: 7, density: 3 }, (p) => {
  const v = pen(p);
  v.roundRect(0, 0, 16, 7, 1, "#3a3d44");
  for (let x = 1.6; x < 15; x += 2) v.roundRect(x, 1.2, 1, 4.6, 0.4, "#07080b");
  p.bevel({ size: 0.8, strength: 0.5 });
});
defineVariants("ll.decal.crack", 4, { w: 64, h: 64, density: 2 }, (p, { rng }) => {
  const v = pen(p);
  const walk = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
    const pts: [number, number][] = [[x, y]];
    for (let i = 0; i < len; i++) {
      a += rng.range(-0.6, 0.6);
      x += Math.cos(a) * 3;
      y += Math.sin(a) * 3;
      pts.push([x, y]);
      if (depth > 0 && rng.chance(0.12)) walk(x, y, a + rng.range(-1.4, 1.4), (len - i) >> 1, w * 0.7, depth - 1);
    }
    const pa = path();
    pts.forEach(([px, py], i) => (i ? pa.lineTo(px, py) : pa.moveTo(px, py)));
    v.stroke(pa, w + 1.2, "#5d6272", { opacity: 0.25 });
    v.stroke(pa, w, "#0d0f15", { opacity: 0.7 });
  };
  walk(rng.range(8, 20), rng.range(10, 54), rng.range(-0.4, 0.4), 15, 0.7, 2);
});
defineVariants("ll.decal.patch", 3, { w: 46, h: 30, density: 2 }, (p, { index }) => {
  const v = pen(p);
  const g = fbmG(8, 121 + index, 3);
  const shape = index === 2 ? path().polygon([[3, 4], [40, 2], [44, 26], [6, 28]]) : path().roundRect(2, 2, 42, 26, 2);
  v.fill(shape, tex((x, y, out) => setRGB(out, hex("#2c303e"), 0.95 + g.at(x * 2, y * 2) * 0.12 + (hash(x * 4, y * 4, 2) - 0.5) * 0.1)));
  v.stroke(shape, 0.8, "#15171d", { opacity: 0.5 });
});
defineVariants("ll.decal.oil", 3, { w: 30, h: 22, density: 2 }, (p, { rng }) => {
  const v = pen(p);
  const pts: [number, number][] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2,
      r = rng.range(5, 9);
    pts.push([15 + Math.cos(a) * r * 1.3, 11 + Math.sin(a) * r * 0.9]);
  }
  v.fill(path().smoothPolygon(pts), "#07080c", { opacity: 0.55 });
  v.ring(14, 10, 4, 1.2, "#5a4a8a", { opacity: 0.12 });
  p.blur(1.4);
});

// --- Street furniture -------------------------------------------------------------------

/** A street lamp seen from above: base at the origin, arm reaching toward -x. */
defineSprite("ll.lamp", { w: 34, h: 10, density: 3, origin: [30 / 34, 0.5] }, (p) => {
  raised(p, (v) => {
    v.circle(30, 5, 2.6, radial(29, 4, 3, [[0, "#6c7480"], [1, "#2a2f38"]]));
    v.line(29, 5, 6, 5, 1.3, "#3a404b");
    v.line(29, 4.6, 6, 4.6, 0.4, "#8a929e");
    v.roundRect(1, 2.5, 8, 5, 2, linear(0, 2.5, 0, 7.5, [[0, "#525a66"], [1, "#2b3039"]]));
    v.roundRect(2.3, 3.4, 5.4, 3.2, 1.4, "#fff1c8");
  }, 5, 3.8, 1.4, 0.5);
});
defineSprite("ll.hydrant", { w: 8, h: 8, density: 4 }, (p) => {
  raised(p, (v) => {
    v.circle(4, 4, 2.8, radial(3.2, 3.2, 3, [[0, "#ff7b62"], [1, "#a8261d"]]));
    v.circle(4, 4, 1.1, "#d9d2c4");
  });
});
defineSprite("ll.bin", { w: 9, h: 9, density: 4 }, (p) => {
  raised(p, (v) => {
    v.circle(4.5, 4.5, 3.6, radial(3.5, 3.5, 4, [[0, "#5c7464"], [1, "#24342c"]]));
    v.circle(4.5, 4.5, 2.3, "#141a17");
  });
});
defineSprite("ll.bench", { w: 22, h: 8, density: 3 }, (p) => {
  raised(p, (v) => {
    v.roundRect(1, 1, 20, 6, 1, "#2b2f36");
    for (let i = 0; i < 4; i++) v.roundRect(1.5, 1.5 + i * 1.35, 19, 1.05, 0.4, i % 2 ? "#946646" : "#a8744f");
  });
});
defineVariants("ll.awning", 4, { w: 64, h: 12, density: 2, origin: [0.5, 0] }, (p, { index }) => {
  const cols = [["#d2485b", "#f1e6d4"], ["#2d8c86", "#f1e6d4"], ["#e1a43a", "#2b2f3c"], ["#3d4f8a", "#e9e3d6"]][index];
  raised(p, (v) => {
    for (let i = 0; i < 8; i++) v.rect(1 + i * 7.75, 0, 7.75, 9, i % 2 ? cols[1] : cols[0]);
    v.rect(1, 0, 62, 9, linear(0, 0, 0, 9, [[0, "#00000000"], [0.7, "#00000020"], [1, "#00000066"]]));
    for (let i = 0; i < 8; i++) v.ellipse(4.9 + i * 7.75, 9, 3.9, 1.4, i % 2 ? cols[1] : cols[0]);
  }, 0.8, 2.4, 1.2, 0.6);
});

// --- Trees and planting -----------------------------------------------------------------

function palm(p: Painter, seed: number, rng: { range(a: number, b: number): number }) {
  const v = pen(p);
  const n = 9;
  const cx = 32,
    cy = 32;
  const fronds: { a: number; len: number; bend: number }[] = [];
  for (let i = 0; i < n; i++) fronds.push({ a: (i / n) * Math.PI * 2 + rng.range(-0.18, 0.18) + seed, len: rng.range(23, 29), bend: rng.range(-5, 5) });
  // Lower (darker) fronds first so the lit top layer sits over them.
  fronds.sort((a, b) => Math.cos(a.a + 2.4) - Math.cos(b.a + 2.4));
  for (const f of fronds) {
    const dx = Math.cos(f.a),
      dy = Math.sin(f.a),
      px = -dy,
      py = dx;
    const lit = 0.7 + 0.45 * Math.max(0, -(dx * 0.7 + dy * 0.7));
    const left: [number, number][] = [],
      right: [number, number][] = [],
      spine = path();
    const steps = 14;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps,
        bx = cx + dx * f.len * t + px * f.bend * t * t,
        by = cy + dy * f.len * t + py * f.bend * t * t,
        w = 5.4 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.75) * (s % 2 ? 0.55 : 1);
      left.push([bx + px * w, by + py * w]);
      right.unshift([bx - px * w, by - py * w]);
      s ? spine.lineTo(bx, by) : spine.moveTo(bx, by);
    }
    const shape = path().polygon([...left, ...right]);
    const tip = [cx + dx * f.len, cy + dy * f.len];
    v.fill(shape, linear(cx, cy, tip[0], tip[1], [[0, css(shadeRGB(hex("#2a5e44"), lit))], [0.5, css(shadeRGB(hex("#4f9a58"), lit))], [1, css(shadeRGB(hex("#a9d07a"), lit))]]));
    v.stroke(spine, 0.55, css(shadeRGB(hex("#b8cf8a"), lit)), { opacity: 0.55 });
  }
  v.circle(cx, cy, 4.2, radial(cx - 1, cy - 1, 4.5, [[0, "#9a7a4e"], [1, "#4b3424"]]));
  for (let i = 0; i < 4; i++) v.circle(cx + Math.cos(i * 1.7) * 2.3, cy + Math.sin(i * 1.7) * 2.3, 1.2, "#6b4a2a");
  p.bevel({ size: 1.4, strength: 0.35 });
}
export const PALMS = defineVariants("ll.tree.palm", 3, { w: 64, h: 64, density: 3 }, (p, { rng, index }) => palm(p, index * 0.4, rng));

function canopy(p: Painter, rng: { range(a: number, b: number): number }, base: RGB, light: RGB) {
  const v = pen(p);
  const blobs: [number, number, number][] = [[30, 30, 15]];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rng.range(-0.3, 0.3),
      d = rng.range(9, 14);
    blobs.push([30 + Math.cos(a) * d, 30 + Math.sin(a) * d, rng.range(9, 13)]);
  }
  blobs.sort((a, b) => b[0] + b[1] - (a[0] + a[1]));
  for (const [x, y, r] of blobs) {
    const pts: [number, number][] = [];
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2,
        rr = r * rng.range(0.86, 1.06);
      pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
    }
    v.fill(path().smoothPolygon(pts), radial(x - r * 0.45, y - r * 0.45, r * 1.5, [[0, css(light)], [0.55, css(base)], [1, css(shadeRGB(base, 0.55))]]));
  }
  const g = fbmG(16, 141, 3);
  v.flood(
    tex((x, y, out) => {
      const n = g.at(x * 3, y * 3);
      out[0] = out[1] = out[2] = n > 0 ? 255 : 0;
      out[3] = Math.abs(n) * 120;
    }),
    { blend: "inside" },
  );
  p.innerShadow({ dx: -1.5, dy: -1.5, blur: 2.5, opacity: 0.35, color: "#0a1420" });
  p.bevel({ size: 2, strength: 0.4 });
}
export const TREES = defineVariants("ll.tree.round", 3, { w: 60, h: 60, density: 2.5 }, (p, { rng, index }) => {
  const [base, light] = index === 2 ? [hex("#7a5aa0"), hex("#c7a5e6")] : index === 1 ? [hex("#3c6b4a"), hex("#8fbf6e")] : [hex("#2f5d4c"), hex("#79ab72")];
  canopy(p, rng, base, light);
});
defineSprite("ll.shrub", { w: 20, h: 20, density: 3 }, (p, { rng }) => {
  const v = pen(p);
  for (let i = 0; i < 5; i++) {
    const x = 10 + rng.range(-4, 4),
      y = 10 + rng.range(-4, 4),
      r = rng.range(3.5, 5.5);
    v.circle(x, y, r, radial(x - 1.5, y - 1.5, r * 1.4, [[0, "#7fae6a"], [0.6, "#3f6c4a"], [1, "#24432f"]]));
  }
  p.bevel({ size: 1, strength: 0.3 });
});
defineSprite("ll.planter", { w: 26, h: 26, density: 3 }, (p) => {
  raised(p, (v) => {
    v.roundRect(1, 1, 24, 24, 2.5, linear(0, 0, 24, 24, [[0, "#b9b2a5"], [1, "#7c776f"]]));
    v.roundRect(3, 3, 20, 20, 1.6, "#3b2c22");
  }, 1.6, 1.3, 1, 0.5);
});

// --- The park -----------------------------------------------------------------------------

defineSprite("ll.park", { w: 336, h: 336, density: 2, origin: [0, 0] }, (p) => {
  const v = pen(p);
  const g = fbmG(4, 151),
    f = fbmG(16, 152, 3);
  const grass = hex("#3c6a4c");
  v.roundRect(0, 0, 336, 336, 16, tex((x, y, out) => {
    const stripe = Math.floor((x + y * 0.0) / 21) % 2 ? 1.04 : 0.97;
    const l = stripe + g.at(x, y) * 0.1 + f.at(x * 2, y * 2) * 0.08 + (hash(x * 4, y * 4, 1) - 0.5) * 0.12;
    setRGB(out, grass, l);
  }));
  // Gravel paths: the cross and the plaza around the fountain.
  const gravel = tex((x, y, out) => setRGB(out, hex("#b9ad91"), 0.93 + f.at(x * 3, y * 3) * 0.06 + (hash(x * 5, y * 5, 2) - 0.5) * 0.16));
  const paths = path().rect(151, 0, 34, 336).rect(0, 151, 336, 34);
  v.fill(paths, gravel);
  v.circle(168, 168, 66, gravel);
  // Path edging.
  for (const [x0, y0, x1, y1] of [[151, 0, 151, 104], [185, 0, 185, 104], [151, 232, 151, 336], [185, 232, 185, 336], [0, 151, 104, 151], [0, 185, 104, 185], [232, 151, 336, 151], [232, 185, 336, 185]])
    v.line(x0, y0, x1, y1, 1.6, "#d6cdb6");
  v.ring(168, 168, 66, 1.6, "#d6cdb6");
  // Plaza paving rings.
  for (let r = 58; r > 46; r -= 6) v.ring(168, 168, r, 0.5, "#8f8470", { opacity: 0.6 });
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    v.line(168 + Math.cos(a) * 46, 168 + Math.sin(a) * 46, 168 + Math.cos(a) * 64, 168 + Math.sin(a) * 64, 0.5, "#8f8470", { opacity: 0.5 });
  }
  // Hedges around the lawns and flower beds in the corners.
  raised(p, (h) => {
    const hedge = (x: number, y: number, w: number, hh: number) => h.roundRect(x, y, w, hh, 3, linear(x, y, x + w, y + hh, [[0, "#5d9161"], [1, "#2a4d36"]]));
    hedge(8, 8, 130, 7);
    hedge(8, 8, 7, 130);
    hedge(198, 8, 130, 7);
    hedge(321, 8, 7, 130);
    hedge(8, 321, 130, 7);
    hedge(8, 198, 7, 130);
    hedge(198, 321, 130, 7);
    hedge(321, 198, 7, 130);
    for (const [bx, by] of [[40, 40], [256, 40], [40, 256], [256, 256]]) {
      h.circle(bx + 20, by + 20, 17, radial(bx + 14, by + 14, 22, [[0, "#6b4a3a"], [1, "#3a281f"]]));
    }
    // Benches along the paths.
    for (const [bx, by, r] of [[120, 140, 0], [196, 190, 0], [140, 214, 1], [190, 110, 1]]) {
      h.save().translate(bx, by);
      if (r) h.rotate(Math.PI / 2);
      h.roundRect(-10, -3, 20, 6, 1, "#2b2f36");
      for (let i = 0; i < 3; i++) h.roundRect(-9.5, -2.5 + i * 1.7, 19, 1.2, 0.4, "#a8744f");
      h.restore();
    }
  }, 2.4, 1.9, 1.8, 0.5);
  // Flowers.
  const rngF = { s: 7, next() { this.s = (this.s * 16807) % 2147483647; return this.s / 2147483647; } };
  for (const [bx, by] of [[40, 40], [256, 40], [40, 256], [256, 256]])
    for (let i = 0; i < 70; i++) {
      const a = rngF.next() * Math.PI * 2,
        r = Math.sqrt(rngF.next()) * 15;
      const col = ["#ff7aa8", "#ffd36b", "#f4f0ff", "#ff9a5c"][(rngF.next() * 4) | 0];
      v.circle(bx + 20 + Math.cos(a) * r, by + 20 + Math.sin(a) * r, 1.1, col);
    }
  // Fountain: stone rim, deep water, a lit pedestal.
  raised(p, (h) => {
    h.circle(168, 168, 44, linear(130, 130, 210, 210, [[0, "#e4dccb"], [1, "#8d8577"]]));
    h.circle(168, 168, 39.5, radial(160, 160, 44, [[0, "#3c8ea0"], [0.7, "#205a6e"], [1, "#163f52"]]));
  }, 2, 1.6, 2, 0.5);
  for (let r = 12; r < 38; r += 6) v.ring(168, 168, r, 0.7, "#a6e3ee", { opacity: 0.22 });
  raised(p, (h) => {
    h.circle(168, 168, 10, linear(158, 158, 178, 178, [[0, "#ece5d6"], [1, "#9a9284"]]));
    h.circle(168, 168, 6, radial(166, 166, 7, [[0, "#d9f6ff"], [1, "#5ab1c4"]]));
  }, 2, 1.6, 1.5, 0.5);
  shadowInside(p, 2, 2, 3, 0.35, [0, 0, 0]);
});

// --- Buildings: rooftops and their shadows -------------------------------------------------

export interface RoofLight {
  x: number;
  y: number;
  w: number;
  h: number;
  color: number;
  kind: "panel" | "dot" | "blink" | "neon";
}
interface RoofDesign {
  w: number;
  h: number;
  parapet: string;
  surface: "gravel" | "membrane" | "concrete" | "metal" | "deck";
  tint: string;
  draw: (v: Pen, p: Painter, lights: RoofLight[]) => void;
}

function acUnit(v: Pen, x: number, y: number, w: number, h: number) {
  v.roundRect(x, y, w, h, 1.2, linear(x, y, x + w, y + h, [[0, "#d7dbe0"], [1, "#8a9099"]]));
  const r = Math.min(w, h) * 0.36,
    cx = x + w - r - 2,
    cy = y + h / 2;
  v.circle(cx, cy, r + 0.6, "#5d636c");
  v.circle(cx, cy, r, radial(cx, cy, r, [[0, "#3b4048"], [1, "#1c2027"]]));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    v.line(cx, cy, cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9, 0.5, "#6f7680");
  }
  v.circle(cx, cy, r * 0.25, "#8d949e");
  for (let gx = x + 1.5; gx < cx - r - 1.5; gx += 1.5) v.line(gx, y + 1.5, gx, y + h - 1.5, 0.4, "#6b717a", { opacity: 0.8 });
}
function vent(v: Pen, x: number, y: number, r: number) {
  v.circle(x, y, r, radial(x - r * 0.4, y - r * 0.4, r * 1.4, [[0, "#d5d9de"], [1, "#6e747d"]]));
  v.circle(x, y, r * 0.55, "#2a2e35");
  v.circle(x - r * 0.15, y - r * 0.15, r * 0.25, "#4d535b");
}
function skylight(v: Pen, x: number, y: number, w: number, h: number, lit: boolean) {
  v.roundRect(x, y, w, h, 1, "#c3c7cc");
  const glass = lit
    ? linear(x, y, x + w, y + h, [[0, "#ffe6a8"], [0.5, "#f2b765"], [1, "#c77d3e"]])
    : linear(x, y, x + w, y + h, [[0, "#5d7896"], [0.5, "#24344c"], [1, "#151d2c"]]);
  v.roundRect(x + 1.2, y + 1.2, w - 2.4, h - 2.4, 0.6, glass);
  const n = Math.max(1, Math.round(h / 9));
  for (let i = 1; i < n; i++) v.line(x + 1, y + (h * i) / n, x + w - 1, y + (h * i) / n, 0.6, "#a9aeb5");
  if (w > 14) v.line(x + w / 2, y + 1, x + w / 2, y + h - 1, 0.6, "#a9aeb5");
  v.fill(path().polygon([[x + 1.2, y + h * 0.65], [x + w * 0.55, y + 1.2], [x + w * 0.75, y + 1.2], [x + 1.2, y + h * 0.95]]), "#ffffff", { opacity: lit ? 0.12 : 0.18 });
}
function waterTower(v: Pen, x: number, y: number, r: number) {
  v.circle(x, y, r, "#4a3528");
  v.fill(path().circle(x, y, r - 1), conic(x, y, -2.3, [[0, "#c9945e"], [0.25, "#9b6b44"], [0.5, "#5e3f2b"], [0.75, "#8a5f3e"], [1, "#c9945e"]]));
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    v.line(x, y, x + Math.cos(a) * (r - 1), y + Math.sin(a) * (r - 1), 0.35, "#3a281e", { opacity: 0.6 });
  }
  v.ring(x, y, r - 0.6, 1, "#2b2f36");
  v.circle(x, y, 2.2, "#7a5a3c");
}
function bulkhead(v: Pen, x: number, y: number, w: number, h: number, color: string) {
  v.roundRect(x, y, w, h, 1.5, color);
  v.roundRect(x + 2, y + 2, w - 4, h - 4, 1, linear(x, y, x + w, y + h, [[0, "#ffffff22"], [1, "#00000022"]]));
}
function solar(v: Pen, x: number, y: number, cols: number, rows: number, cw: number, ch: number) {
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const px = x + c * (cw + 2),
        py = y + r * (ch + 3);
      v.roundRect(px, py, cw, ch, 0.6, "#9aa2ad");
      v.rect(px + 0.7, py + 0.7, cw - 1.4, ch - 1.4, linear(px, py, px + cw, py + ch, [[0, "#3c5d92"], [0.45, "#1d2f55"], [1, "#121c36"]]));
      for (let k = 1; k < 4; k++) v.line(px + (cw * k) / 4, py + 0.7, px + (cw * k) / 4, py + ch - 0.7, 0.3, "#6f8cc0", { opacity: 0.5 });
      v.line(px + 0.7, py + ch / 2, px + cw - 0.7, py + ch / 2, 0.3, "#6f8cc0", { opacity: 0.5 });
    }
}
function pipe(v: Pen, pts: [number, number][]) {
  const pa = path();
  pts.forEach(([x, y], i) => (i ? pa.lineTo(x, y) : pa.moveTo(x, y)));
  v.stroke(pa, 2.2, "#5b616a");
  v.stroke(pa, 0.7, "#b3b9c1", { opacity: 0.8 });
}
function garden(v: Pen, x: number, y: number, w: number, h: number) {
  v.roundRect(x, y, w, h, 2, "#8a8378");
  v.roundRect(x + 1.5, y + 1.5, w - 3, h - 3, 1.5, "#3a2b20");
  for (let i = 0; i < (w * h) / 40; i++) {
    const bx = x + 3 + hash(i, x, 7) * (w - 6),
      by = y + 3 + hash(i, y, 8) * (h - 6),
      r = 2 + hash(i, 3, 9) * 2.6;
    v.circle(bx, by, r, radial(bx - 1, by - 1, r * 1.4, [[0, "#86b56c"], [1, "#2e5536"]]));
  }
}

const ROOFS: Record<string, RoofDesign> = {
  // Warm gravel roof: water tower, AC stack, skylights.
  "ll.roof.a": {
    w: 190, h: 280, parapet: "#9b6a5c", surface: "gravel", tint: "#686460",
    draw: (v, p, L) => {
      raised(p, (s) => {
        acUnit(s, 22, 26, 30, 20);
        acUnit(s, 22, 52, 30, 20);
        acUnit(s, 58, 26, 30, 20);
        for (const [x, y] of [[30, 214], [46, 226], [30, 240], [160, 120], [160, 140]]) vent(s, x, y, 4);
        pipe(s, [[52, 36], [100, 36], [100, 96]]);
        for (let i = 0; i < 3; i++) skylight(s, 32 + i * 34, 104, 24, 46, i !== 1);
        skylight(s, 32, 162, 92, 18, false);
      });
      for (let i = 0; i < 3; i++) if (i !== 1) L.push({ x: 33 + i * 34, y: 105, w: 22, h: 44, color: 0xffc070, kind: "panel" });
      raised(p, (s) => {
        bulkhead(s, 120, 196, 46, 56, "#a69c90");
        s.roundRect(126, 246, 14, 4, 1, "#3a3f47");
      }, 6, 4.6, 3, 0.5);
      raised(p, (s) => waterTower(s, 146, 58, 22), 11, 8, 4, 0.5);
      L.push({ x: 140, y: 234, w: 4, h: 4, color: 0xff4040, kind: "blink" });
    },
  },
  // Slate membrane roof: solar field, garden, long lit skylight.
  "ll.roof.b": {
    w: 190, h: 280, parapet: "#8a94a8", surface: "membrane", tint: "#676a74",
    draw: (v, p, L) => {
      raised(p, (s) => {
        solar(s, 22, 22, 5, 4, 27, 16);
        skylight(s, 24, 112, 142, 22, true);
        garden(s, 22, 196, 70, 58);
        for (const [x, y] of [[112, 200], [112, 226], [142, 200], [142, 226]]) acUnit(s, x, y, 26, 20);
        vent(s, 104, 158, 4.5);
        vent(s, 160, 158, 4.5);
        pipe(s, [[104, 166], [104, 186], [125, 186]]);
      });
      L.push({ x: 25, y: 113, w: 140, h: 20, color: 0xffd090, kind: "panel" });
    },
  },
  // Concrete deck with a raised tower and a helipad.
  "ll.roof.c": {
    w: 190, h: 280, parapet: "#a59a8a", surface: "concrete", tint: "#7d7a76",
    draw: (v, p, L) => {
      raised(p, (s) => {
        for (let i = 0; i < 4; i++) acUnit(s, 22 + i * 38, 236, 30, 22);
        for (const [x, y] of [[26, 210], [168, 210]]) vent(s, x, y, 4);
      });
      raised(p, (s) => {
        s.roundRect(26, 24, 138, 170, 3, "#b7ac9c");
        s.roundRect(31, 29, 128, 160, 2, tex((x, y, out) => setRGB(out, hex("#6e6c6c"), 0.95 + fbmG(8, 161, 3).at(x * 2, y * 2) * 0.1 + (hash(x * 4, y * 4) - 0.5) * 0.1)));
        s.circle(95, 102, 44, "#3a3e46");
        s.ring(95, 102, 40, 2.2, "#f0c45a");
        s.fill(path().rect(80, 84, 6, 36).rect(104, 84, 6, 36).rect(86, 99, 18, 6), "#eae6dc");
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          s.circle(95 + Math.cos(a) * 47, 102 + Math.sin(a) * 47, 1.4, "#ffe08a");
        }
        skylight(s, 40, 160, 26, 22, true);
        skylight(s, 124, 160, 26, 22, false);
      }, 12, 9, 5, 0.55);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        L.push({ x: 95 + Math.cos(a) * 47 - 2, y: 102 + Math.sin(a) * 47 - 2, w: 4, h: 4, color: 0xffd27a, kind: "dot" });
      }
      L.push({ x: 41, y: 161, w: 24, h: 20, color: 0xffc070, kind: "panel" });
    },
  },
  // Teal standing-seam metal: neon billboard on the roof, exhaust fans, skylight grid.
  "ll.roof.d": {
    w: 190, h: 280, parapet: "#4f7d82", surface: "metal", tint: "#5f8a8c",
    draw: (v, p, L) => {
      raised(p, (s) => {
        for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) skylight(s, 30 + c * 74, 110 + r * 40, 56, 28, (r + c) % 2 === 0);
        for (const [x, y] of [[40, 240], [80, 240], [120, 240]]) {
          s.circle(x, y, 11, "#3b4048");
          s.circle(x, y, 9, radial(x, y, 9, [[0, "#272b31"], [1, "#4a5058"]]));
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            s.line(x, y, x + Math.cos(a) * 8, y + Math.sin(a) * 8, 1.2, "#7d848e");
          }
        }
        vent(s, 160, 244, 5);
      });
      for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) if ((r + c) % 2 === 0) L.push({ x: 31 + c * 74, y: 111 + r * 40, w: 54, h: 26, color: 0xffc887, kind: "panel" });
      // The billboard: a dark steel frame on legs, lit from inside at night.
      raised(p, (s) => {
        s.roundRect(18, 26, 154, 30, 2, "#1d2028");
        s.roundRect(21, 29, 148, 24, 1.5, linear(21, 29, 169, 53, [[0, "#ff5aa5"], [1, "#b2307a"]]));
        for (let i = 0; i < 6; i++) s.roundRect(28 + i * 24, 34, 14, 14, 3, "#ffd6ea", { opacity: 0.8 });
      }, 9, 7, 3.5, 0.55);
      L.push({ x: 21, y: 29, w: 148, h: 24, color: 0xff4fa0, kind: "neon" });
    },
  },
  "ll.roof.s0": {
    w: 90, h: 244, parapet: "#8a7a72", surface: "gravel", tint: "#6a6662",
    draw: (v, p, L) => {
      raised(p, (s) => {
        acUnit(s, 16, 20, 30, 20);
        acUnit(s, 16, 46, 30, 20);
        for (const [x, y] of [[62, 30], [62, 50], [30, 200], [50, 214]]) vent(s, x, y, 3.6);
        skylight(s, 20, 90, 50, 30, true);
        skylight(s, 20, 128, 50, 30, false);
        pipe(s, [[46, 30], [70, 30], [70, 80]]);
      });
      L.push({ x: 21, y: 91, w: 48, h: 28, color: 0xffbf6e, kind: "panel" });
      raised(p, (s) => bulkhead(s, 22, 168, 40, 22, "#9b9184"), 5, 4, 2.5, 0.5);
    },
  },
  "ll.roof.s1": {
    w: 90, h: 244, parapet: "#8790a6", surface: "membrane", tint: "#6a6c74",
    draw: (v, p, L) => {
      raised(p, (s) => {
        skylight(s, 32, 20, 26, 150, true);
        for (const [x, y] of [[18, 30], [72, 30], [18, 70], [72, 70]]) vent(s, x, y, 3.5);
        acUnit(s, 16, 186, 28, 20);
        acUnit(s, 48, 186, 28, 20);
        solar(s, 18, 212, 3, 1, 17, 14);
      });
      L.push({ x: 33, y: 21, w: 24, h: 148, color: 0xffd3a0, kind: "panel" });
      L.push({ x: 70, y: 214, w: 3, h: 3, color: 0xff4040, kind: "blink" });
    },
  },
  "ll.roof.s2": {
    w: 90, h: 244, parapet: "#8f8a7c", surface: "deck", tint: "#7b5a42",
    draw: (v, p, L) => {
      raised(p, (s) => {
        garden(s, 14, 14, 62, 18);
        garden(s, 14, 210, 62, 18);
        garden(s, 14, 40, 14, 150);
        // Lounge chairs and tables.
        for (let i = 0; i < 4; i++) {
          s.roundRect(44, 52 + i * 34, 12, 22, 2, "#e8e2d4");
          s.roundRect(45, 53 + i * 34, 10, 6, 2, "#cfc6b2");
          s.circle(66, 62 + i * 34, 4.5, "#3b3f48");
          s.circle(66, 62 + i * 34, 3.2, "#d7d1c3");
        }
        s.roundRect(62, 190, 16, 14, 2, "#2b2f36");
      }, 1.6, 1.3, 1.2, 0.5);
      // Festoon lights strung across the deck.
      for (let k = 0; k < 4; k++) {
        const y0 = 48 + k * 40;
        for (let i = 0; i <= 6; i++) {
          const x = 30 + i * 7.5,
            y = y0 + Math.sin((i / 6) * Math.PI) * 6;
          v.circle(x, y, 1.1, "#fff0c0");
          L.push({ x: x - 1.6, y: y - 1.6, w: 3.2, h: 3.2, color: 0xffd78a, kind: "dot" });
        }
      }
    },
  },
};
export const ROOF_LIGHTS: Record<string, RoofLight[]> = {};

for (const [name, d] of Object.entries(ROOFS)) {
  ROOF_LIGHTS[name] = [];
  defineSprite(name, { w: d.w, h: d.h, density: 2, origin: [0, 0] }, (p) => {
    const v = pen(p);
    const lights: RoofLight[] = [];
    const g = fbmG(4, 171),
      f = fbmG(16, 172, 3);
    // Parapet: a raised lip around the whole roof.
    v.roundRect(0, 0, d.w, d.h, 2.5, linear(0, 0, d.w, d.h, [[0, css(shadeRGB(hex(d.parapet), 1.25))], [1, css(shadeRGB(hex(d.parapet), 0.8))]]));
    const base = hex(d.tint);
    const surface = tex((x, y, out) => {
      let l = 1 + g.at(x, y) * 0.07 + f.at(x * 2, y * 2) * 0.05;
      switch (d.surface) {
        case "gravel":
          l += (hash(x * 3, y * 3, 5) - 0.5) * 0.3;
          break;
        case "membrane":
          l += (hash(x * 4, y * 4, 6) - 0.5) * 0.08;
          if (y % 22 < 0.8) l *= 0.82;
          else if (y % 22 < 1.6) l *= 1.06;
          break;
        case "concrete": {
          l += (hash(x * 4, y * 4, 7) - 0.5) * 0.12;
          const fx = x % 30,
            fy = y % 30;
          if (fx < 0.6 || fy < 0.6) l *= 0.8;
          break;
        }
        case "metal": {
          const fx = x % 9;
          l *= fx < 1 ? 1.22 : fx < 1.8 ? 0.8 : 1 - fx * 0.012;
          l += (hash(x * 4, y * 4, 8) - 0.5) * 0.05;
          break;
        }
        case "deck": {
          const fx = x % 6;
          l *= fx < 0.6 ? 0.55 : 0.92 + hash(Math.floor(x / 6), Math.floor(y / 40), 9) * 0.18;
          l += f.at(x * 0.5, y * 4) * 0.08;
          break;
        }
      }
      setRGB(out, base, l);
    });
    const inner = p.blank();
    pen(inner).roundRect(5, 5, d.w - 10, d.h - 10, 1.5, surface);
    // The parapet shades the roof along its top and left inner edges, light from the top left.
    shadowInside(inner, 3.2, 2.6, 2.4, 0.6);
    shadowInside(inner, 0, 0, 1.2, 0.4);
    p.composite(inner);
    // Coping stones on the parapet.
    v.stroke(path().roundRect(2.2, 2.2, d.w - 4.4, d.h - 4.4, 1.5), 0.6, "#ffffff", { opacity: 0.22 });
    for (let x = 12; x < d.w - 6; x += 12) {
      v.line(x, 0.4, x, 4.6, 0.35, "#000000", { opacity: 0.25 });
      v.line(x, d.h - 4.6, x, d.h - 0.4, 0.35, "#000000", { opacity: 0.25 });
    }
    for (let y = 12; y < d.h - 6; y += 12) {
      v.line(0.4, y, 4.6, y, 0.35, "#000000", { opacity: 0.25 });
      v.line(d.w - 4.6, y, d.w - 0.4, y, 0.35, "#000000", { opacity: 0.25 });
    }
    // Stains and water marks across the roof.
    v.roundRect(5, 5, d.w - 10, d.h - 10, 1.5, tex((x, y, out) => {
      const n = g.at(x * 0.7 + 50, y * 0.7);
      out[0] = 10;
      out[1] = 12;
      out[2] = 20;
      out[3] = n > 0.25 ? (n - 0.25) * 140 : 0;
    }));
    d.draw(v, p, lights);
    edgeLight(p, 1.6, 0.45);
    if (ROOF_LIGHTS[name].length === 0) ROOF_LIGHTS[name].push(...lights);
  });
}
export const BIG_ROOFS = ["ll.roof.a", "ll.roof.b", "ll.roof.c", "ll.roof.d"],
  SMALL_ROOFS = ["ll.roof.s0", "ll.roof.s1", "ll.roof.s2"];

/** Long soft building shadows, cast toward the bottom right, at half resolution. */
export function shadowName(w: number, h: number, len: number) {
  return `ll.shadow.${w}x${h}x${len}`;
}
const SHADOW_PAD = 14;
export function defineShadow(w: number, h: number, len: number) {
  const dx = LIGHT.x * len,
    dy = LIGHT.y * len,
    W = w + dx + SHADOW_PAD * 2,
    H = h + dy + SHADOW_PAD * 2;
  defineSprite(shadowName(w, h, len), { w: W, h: H, density: 0.5, smooth: true, origin: [SHADOW_PAD / W, SHADOW_PAD / H] }, (p) => {
    const v = pen(p);
    v.translate(SHADOW_PAD, SHADOW_PAD);
    v.fill(path().polygon([[0, 0], [w, 0], [w + dx, dy], [w + dx, h + dy], [dx, h + dy], [0, h]]), "#000000");
    p.blur(5);
  });
}
export const SHADOWS = [
  [190, 280, 70],
  [190, 280, 105],
  [190, 280, 140],
  [90, 244, 50],
  [90, 244, 80],
] as const;
for (const [w, h, l] of SHADOWS) defineShadow(w, h, l);

// --- Vehicles -----------------------------------------------------------------------------

/** Car bodies are 58 x 30, facing +x. `paint` is greyscale and tinted with the car colour. */
interface CarShape {
  body: [number, number, number, number]; // half length, half width, front radius, rear radius
  roof: [number, number, number, number]; // x0, x1, half width, radius
  shield: [number, number]; // windshield x0, x1
  rear: [number, number]; // rear window x0, x1
}
const SHAPES: Record<string, CarShape> = {
  sedan: { body: [29, 14.5, 8, 6], roof: [-13, 7, 11, 4], shield: [7, 15], rear: [-19, -13] },
  coupe: { body: [29, 14, 9, 7], roof: [-10, 5, 10.5, 5], shield: [5, 14], rear: [-17, -10] },
  van: { body: [29, 14.8, 5, 2.5], roof: [-27, 15, 12.8, 2.5], shield: [15, 21], rear: [-28.4, -27.2] },
};
function bodyPath(s: CarShape) {
  const [hl, hw, fr, rr] = s.body;
  return path().roundRect(-hl, -hw, hl * 2, hw * 2, [rr, fr, fr, rr]);
}
function paintBody(p: Painter, s: CarShape, police = false) {
  const v = pen(p);
  v.translate(32, 18);
  const [hl, hw] = s.body;
  const body = bodyPath(s);
  v.fill(body, linear(0, -hw, 0, hw, [[0, "#9c9c9c"], [0.18, "#f4f4f4"], [0.5, "#e2e2e2"], [0.82, "#bdbdbd"], [1, "#6c6c6c"]]));
  // Hood and trunk shading: the panels slope away from the cabin.
  v.fill(body, linear(-hl, 0, hl, 0, [[0, "#00000055"], [0.12, "#00000000"], [0.85, "#00000000"], [1, "#00000040"]]));
  const [r0, r1, rw, rr] = s.roof;
  v.roundRect(r0, -rw, r1 - r0, rw * 2, rr, linear(r0, -rw, r1, rw, [[0, "#ffffff"], [1, "#d0d0d0"]]));
  if (police) {
    v.fill(body, "#1a1d24", { blend: "inside" });
    v.fill(path().rect(-12, -hw - 1, 22, hw * 2 + 2), "#eef0f2", { blend: "inside" });
    v.roundRect(r0, -rw, r1 - r0, rw * 2, rr, linear(r0, -rw, r1, rw, [[0, "#ffffff"], [1, "#cfd3d8"]]));
  }
  p.bevel({ size: 2.6, strength: 0.65 });
}
function paintTrim(p: Painter, s: CarShape, kind: string) {
  const v = pen(p);
  v.translate(32, 18);
  const [hl, hw] = s.body;
  const [r0, r1, rw] = s.roof;
  const glass = (x0: number, x1: number, wn: number, wf: number, front: boolean) => {
    const pts: [number, number][] = front
      ? [[x0, -wn], [x1, -wf], [x1, wf], [x0, wn]]
      : [[x0, -wf], [x1, -wn], [x1, wn], [x0, wf]];
    v.fill(path().smoothPolygon(pts, 0.25), linear(x0, -wn, x1, wn, [[0, "#3c5878"], [0.45, "#141d2c"], [1, "#0a0f18"]]));
    v.fill(path().polygon([[x0 + (x1 - x0) * 0.15, -wn * 0.9], [x0 + (x1 - x0) * 0.55, -wn * 0.9], [x0 + (x1 - x0) * 0.2, wn * 0.4], [x0 + (x1 - x0) * 0.05, wn * 0.4]]), "#cfe4ff", { opacity: 0.22 });
  };
  glass(s.shield[0], s.shield[1], rw - 0.5, rw - 2.6, true);
  glass(s.rear[0], s.rear[1], rw - 2.2, rw - 0.6, false);
  // Side windows along the cabin.
  v.roundRect(r0 + 1, -rw - 1.4, r1 - r0 - 2, 1.5, 0.7, "#121a26");
  v.roundRect(r0 + 1, rw - 0.1, r1 - r0 - 2, 1.5, 0.7, "#121a26");
  // Panel gaps.
  v.line(s.shield[1] + 0.6, -hw + 2, s.shield[1] + 0.6, hw - 2, 0.35, "#000000", { opacity: 0.35 });
  v.line(s.rear[0] - 0.6, -hw + 2, s.rear[0] - 0.6, hw - 2, 0.35, "#000000", { opacity: 0.35 });
  // Lamps.
  v.roundRect(hl - 3.2, -hw + 2, 2.8, 5, 1.2, "#fff6d6");
  v.roundRect(hl - 3.2, hw - 7, 2.8, 5, 1.2, "#fff6d6");
  v.roundRect(-hl + 0.3, -hw + 1.6, 2.2, 5.5, 0.9, "#c4202f");
  v.roundRect(-hl + 0.3, hw - 7.1, 2.2, 5.5, 0.9, "#c4202f");
  // Mirrors.
  v.roundRect(s.shield[0] - 1.5, -hw - 1.6, 3, 2.2, 0.8, "#1c2129");
  v.roundRect(s.shield[0] - 1.5, hw - 0.6, 3, 2.2, 0.8, "#1c2129");
  // Specular sweep: the clear coat catching the light from the top left.
  v.stroke(path().moveTo(-hl + 5, -hw + 2.6).lineTo(hl - 6, -hw + 2.6), 1.1, "#ffffff", { opacity: 0.55 });
  v.stroke(path().moveTo(r0 + 2, -rw + 2).lineTo(r1 - 3, -rw + 2), 1.4, "#ffffff", { opacity: 0.45 });
  v.ellipse(hl - 9, -4, 4, 1.2, "#ffffff", { opacity: 0.25 });
  if (kind === "coupe") {
    for (const y of [-2.6, 1.2]) {
      v.rect(s.shield[1] + 1, y, hl - s.shield[1] - 2, 1.4, "#111318", { opacity: 0.75 });
      v.rect(r0 + 1, y, r1 - r0 - 2, 1.4, "#111318", { opacity: 0.75 });
      v.rect(-hl + 2, y, s.rear[0] + hl - 2, 1.4, "#111318", { opacity: 0.75 });
    }
  }
  if (kind === "van") {
    for (let x = r0 + 6; x < r1 - 2; x += 7) v.line(x, -rw + 1.5, x, rw - 1.5, 0.6, "#000000", { opacity: 0.18 });
    v.line(r0 + 3, -rw + 1, r1 - 3, -rw + 1, 0.8, "#2a2e36");
    v.line(r0 + 3, rw - 1, r1 - 3, rw - 1, 0.8, "#2a2e36");
  }
  if (kind === "police") {
    v.roundRect(-4.5, -11, 5, 22, 1.4, "#1b1e25");
    v.roundRect(-4, -10.4, 4, 10, 1, linear(-4, -10, 0, 0, [[0, "#ff6b6b"], [1, "#b3141e"]]));
    v.roundRect(-4, 0.4, 4, 10, 1, linear(-4, 0, 0, 10, [[0, "#6bb6ff"], [1, "#1440b3"]]));
    v.line(-12, -hw + 0.8, 10, -hw + 0.8, 0.8, "#2c6be0");
    v.line(-12, hw - 0.8, 10, hw - 0.8, 0.8, "#2c6be0");
  }
}
export const CAR_MODELS = ["sedan", "coupe", "van", "police"] as const;
for (const m of CAR_MODELS) {
  const shape = SHAPES[m === "police" ? "sedan" : m];
  defineSprite(`ll.car.${m}.paint`, { w: 64, h: 36, density: 4 }, (p) => paintBody(p, shape, m === "police"));
  defineSprite(`ll.car.${m}.trim`, { w: 64, h: 36, density: 4 }, (p) => paintTrim(p, shape, m));
}
defineSprite("ll.car.shadow", { w: 80, h: 52, density: 1, smooth: true }, (p) => {
  pen(p).roundRect(10, 10, 60, 32, 9, "#000000");
  p.blur(4);
});
defineSprite("ll.car.wheels", { w: 64, h: 36, density: 2 }, (p) => {
  const v = pen(p);
  v.translate(32, 18);
  for (const x of [-18, 17]) for (const y of [-13.6, 13.6]) v.roundRect(x - 4.2, y - 1.7, 8.4, 3.4, 1.4, "#0d0f13");
});

// --- People -------------------------------------------------------------------------------

/** Top-down pedestrians facing +x: tinted shoulders, a head with hair, swinging arms and feet. */
defineSprite("ll.ped.body", { w: 16, h: 16, density: 4 }, (p) => {
  const v = pen(p);
  v.translate(8, 8);
  v.fill(path().roundRect(-3.6, -5.8, 7.2, 11.6, [3, 3.4, 3.4, 3]), linear(0, -6, 0, 6, [[0, "#ffffff"], [0.5, "#e6e6e6"], [1, "#9a9a9a"]]));
  v.line(-2.8, -4, -2.8, 4, 0.5, "#000000", { opacity: 0.15 });
  p.bevel({ size: 1, strength: 0.5 });
});
defineSprite("ll.ped.arm", { w: 8, h: 4, density: 4 }, (p) => {
  const v = pen(p);
  v.roundRect(0.5, 0.6, 6.5, 2.8, 1.4, linear(0, 0, 0, 4, [[0, "#f2f2f2"], [1, "#9a9a9a"]]));
  v.circle(6.2, 2, 1.1, "#c99a78");
});
defineSprite("ll.ped.foot", { w: 6, h: 4, density: 4 }, (p) => {
  pen(p).roundRect(0.5, 0.8, 5, 2.4, 1.2, "#1a1c22");
});
export const HEADS = defineVariants("ll.ped.head", 5, { w: 10, h: 10, density: 4 }, (p, { index }) => {
  const v = pen(p);
  const hair = ["#1b1714", "#5a3a26", "#c9a15e", "#9a9aa0", "#c23a3a"][index];
  v.circle(5, 5, 3.2, "#d5a582");
  if (index === 4) {
    v.circle(4.6, 5, 3.3, radial(3.6, 4, 4, [[0, "#ff6b5e"], [1, "#9a1e1e"]]));
    v.ellipse(8, 5, 1.6, 2.6, "#7a1515");
  } else v.fill(path().ellipse(4.3, 5, 3.3, 3.3), radial(3.4, 3.8, 4.2, [[0, css(shadeRGB(hex(hair), 1.6))], [1, hair]]));
  p.bevel({ size: 0.8, strength: 0.4 });
});

// --- Boats and the pier -------------------------------------------------------------------

defineVariants("ll.boat", 2, { w: 60, h: 24, density: 2.5 }, (p, { index }) => {
  const v = pen(p);
  const hull = path().moveTo(4, 12).cubicTo(4, 3, 20, 2, 40, 2.5).cubicTo(50, 3, 58, 8, 59, 12).cubicTo(58, 16, 50, 21, 40, 21.5).cubicTo(20, 22, 4, 21, 4, 12).close();
  v.fill(hull, linear(0, 2, 0, 22, [[0, "#f2f0ea"], [0.5, "#d9d6cc"], [1, "#8d8a84"]]));
  v.stroke(hull, 1, index ? "#2b5f8a" : "#b03a3a");
  v.fill(path().moveTo(9, 12).cubicTo(9, 6, 22, 5, 38, 5.5).cubicTo(46, 6, 52, 9, 53, 12).cubicTo(52, 15, 46, 18, 38, 18.5).cubicTo(22, 19, 9, 18, 9, 12).close(), index ? "#a5784e" : "#9b7350");
  for (let x = 12; x < 50; x += 3) v.line(x, 6.5, x, 17.5, 0.3, "#5a3e28", { opacity: 0.5 });
  v.roundRect(22, 7, 16, 10, 2, linear(22, 7, 38, 17, [[0, "#ffffff"], [1, "#b9bcc2"]]));
  v.roundRect(34, 8, 3, 8, 1, "#1d2a3a");
  p.bevel({ size: 1.5, strength: 0.5 });
});
defineSprite("ll.pier", { w: 196, h: 46, density: 2, origin: [0, 0] }, (p) => {
  const v = pen(p);
  const g = fbmG(8, 191, 3);
  v.rect(0, 2, 196, 42, tex((x, y, out) => {
    const fx = x % 7;
    let l = fx < 0.6 ? 0.5 : 0.85 + hash(Math.floor(x / 7), Math.floor(y / 46), 3) * 0.25;
    l += g.at(x * 4, y * 0.6) * 0.1;
    setRGB(out, hex("#8a6a50"), l);
  }));
  v.rect(0, 2, 196, 2.5, "#5d4636");
  v.rect(0, 41.5, 196, 2.5, "#5d4636");
  for (let x = 6; x < 196; x += 28)
    for (const y of [3.2, 42.8]) v.circle(x, y, 2.6, radial(x - 0.8, y - 0.8, 3, [[0, "#9a8070"], [1, "#3a2a20"]]));
  p.bevel({ size: 1.2, strength: 0.4 });
  p.dropShadow({ dx: 3, dy: 3, blur: 2.5, opacity: 0.6, color: "#04121c" });
});
defineSprite("ll.kiosk", { w: 49, h: 127, density: 2, origin: [0, 0] }, (p) => {
  raised(p, (v) => {
    v.roundRect(0, 0, 49, 127, 2, "#2d3442");
    for (let i = 0; i < 9; i++) v.rect(3 + i * 4.9, 3, 4.9, 121, i % 2 ? "#d9d0c0" : "#b0484a");
    v.rect(3, 3, 44, 121, linear(3, 0, 47, 0, [[0, "#ffffff30"], [0.5, "#00000000"], [1, "#00000050"]]));
    v.roundRect(10, 50, 29, 27, 3, "#20252f");
  }, 6, 4.5, 3, 0.55);
});
defineSprite("ll.buoy", { w: 10, h: 10, density: 3 }, (p) => {
  raised(p, (v) => {
    v.circle(5, 5, 3.4, radial(4, 4, 4, [[0, "#ff8a6a"], [1, "#a8261d"]]));
    v.circle(5, 5, 1.2, "#f4efe4");
  }, 1.5, 1.2, 1, 0.5);
});

// --- Interface ----------------------------------------------------------------------------

defineSprite("ll.ui.star", { w: 18, h: 18, density: 4 }, (p) => {
  const v = pen(p);
  v.fill(path().star(9, 9.6, 8.4, 3.7, 5), "#ffffff");
});
defineSprite("ll.ui.starline", { w: 18, h: 18, density: 4 }, (p) => {
  const v = pen(p);
  v.stroke(path().star(9, 9.6, 7.8, 3.4, 5).close(), 1.1, "#ffffff");
});
defineSprite("ll.ui.shadow", { w: 64, h: 64, density: 1, smooth: true }, (p) => {
  pen(p).rect(14, 14, 36, 36, "#000000");
  p.blur(7);
});
defineSprite("ll.ui.fadeH", { w: 64, h: 8, density: 1, smooth: true, edge: "extrude" }, (p) => {
  pen(p).flood(linear(0, 0, 64, 0, [[0, "#ffffff"], [1, "#ffffff00"]]));
});
defineSprite("ll.ui.fadeV", { w: 8, h: 64, density: 1, smooth: true, edge: "extrude" }, (p) => {
  pen(p).flood(linear(0, 0, 0, 64, [[0, "#ffffff"], [1, "#ffffff00"]]));
});
defineSprite("ll.ui.arrow", { w: 16, h: 16, density: 4 }, (p) => {
  const v = pen(p);
  v.fill(path().polygon([[15, 8], [2, 2], [5, 8], [2, 14]]), "#ffffff");
  p.dropShadow({ dx: 0, dy: 0.6, blur: 1, opacity: 0.6 });
});
defineSprite("ll.ui.gauge", { w: 132, h: 132, density: 2.5 }, (p) => {
  const v = pen(p);
  const c = 66,
    a0 = Math.PI * 0.75,
    a1 = Math.PI * 2.25;
  v.stroke(path().arc(c, c, 56, a0, a1), 6, "#ffffff", { opacity: 0.08 });
  for (let i = 0; i <= 40; i++) {
    const a = a0 + ((a1 - a0) * i) / 40,
      major = i % 5 === 0,
      r0 = major ? 45 : 49;
    v.line(c + Math.cos(a) * r0, c + Math.sin(a) * r0, c + Math.cos(a) * 52, c + Math.sin(a) * 52, major ? 1.6 : 0.8, "#ffffff", { opacity: major ? 0.75 : 0.35 });
  }
});
defineSprite("ll.ui.arc", { w: 132, h: 132, density: 2.5 }, (p) => {
  // A full lit arc; the HUD reveals it in steps by drawing segments of `ll.ui.seg`.
  const v = pen(p);
  v.stroke(path().arc(66, 66, 56, Math.PI * 0.75, Math.PI * 2.25), 4, "#ffffff");
});
defineSprite("ll.ui.seg", { w: 10, h: 6, density: 3 }, (p) => {
  pen(p).roundRect(0.5, 0.5, 9, 5, 1.5, "#ffffff");
});
defineSprite("ll.ui.needle", { w: 60, h: 8, density: 3, origin: [6 / 60, 0.5] }, (p) => {
  const v = pen(p);
  v.fill(path().polygon([[2, 4], [6, 1.6], [58, 3.6], [58, 4.4], [6, 6.4]]), "#ffffff");
  v.circle(6, 4, 3.6, "#ffffff");
});

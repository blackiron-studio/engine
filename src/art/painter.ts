// A software raster surface for procedural pixel art. It writes into a plain RGBA
// buffer, so it runs identically in the browser, in `bun test`, and in the CLI's
// headless atlas export. One painted pixel is one texel.

import type { Rng } from "../core/rng.ts";
import { type ColorInput, type RGBA, type Ramp, parseColor, toHex } from "./color.ts";

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Ordered-dither tone index for a value in [0, 1] across `count` tones. */
export function toneAt(t: number, x: number, y: number, count = 5, strength = 0.9): number {
  const v = t * (count - 1) + (BAYER4[y & 3][x & 3] / 16 - 0.5) * strength;
  return Math.min(count - 1, Math.max(0, Math.round(v)));
}

export interface BallOptions {
  /** Light direction; negative x lights from the left, negative y from the top. */
  lx?: number;
  ly?: number;
  /** Dither strength at tone boundaries, 0 for hard bands. */
  dither?: number;
}

export interface BoxOptions {
  /** Paint a one-pixel highlight along the top edge. */
  topLight?: boolean;
  /** Vertical falloff amount in [0, 1]. */
  vert?: number;
  /** Horizontal light-to-dark amount in [0, 1]. */
  horiz?: number;
}

export interface EdgeSides {
  top?: boolean;
  bottom?: boolean;
  left?: boolean;
  right?: boolean;
}

export class Painter {
  readonly data: Uint8ClampedArray;
  private maskData: Uint8ClampedArray | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    data?: Uint8ClampedArray,
  ) {
    this.data = data ?? new Uint8ClampedArray(width * height * 4);
  }

  clear(color?: ColorInput): void {
    if (color === undefined) {
      this.data.fill(0);
      return;
    }
    const { r, g, b, a } = parseColor(color);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = a;
    }
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Restrict painting to where `mask` is opaque; null clears the mask. */
  mask(mask: Painter | null): void {
    if (mask && (mask.width !== this.width || mask.height !== this.height)) throw new Error("Mask must match the painter's size");
    this.maskData = mask ? mask.data : null;
  }

  /** Paint with a mask applied, then restore. */
  withMask(mask: Painter, fn: () => void): void {
    const prev = this.maskData;
    this.mask(mask);
    try {
      fn();
    } finally {
      this.maskData = prev;
    }
  }

  /** A mask painter of this size with the current opaque silhouette. */
  silhouette(): Painter {
    const m = new Painter(this.width, this.height);
    for (let i = 3; i < this.data.length; i += 4) if (this.data[i] > 0) m.data[i] = 255;
    return m;
  }

  /** Plot one pixel with source-over blending. Out-of-bounds writes are ignored. */
  px(x: number, y: number, color: ColorInput): void {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const c = parseColor(color);
    this.blend((y * this.width + x) * 4, c);
  }

  private blend(i: number, c: RGBA): void {
    if (this.maskData && this.maskData[i + 3] === 0) return;
    const d = this.data;
    if (c.a >= 255) {
      d[i] = c.r;
      d[i + 1] = c.g;
      d[i + 2] = c.b;
      d[i + 3] = 255;
      return;
    }
    if (c.a <= 0) return;
    const sa = c.a / 255;
    const da = d[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    d[i] = (c.r * sa + d[i] * da * (1 - sa)) / oa;
    d[i + 1] = (c.g * sa + d[i + 1] * da * (1 - sa)) / oa;
    d[i + 2] = (c.b * sa + d[i + 2] * da * (1 - sa)) / oa;
    d[i + 3] = oa * 255;
  }

  get(x: number, y: number): RGBA | null {
    if (!this.inBounds(x, y)) return null;
    const i = (y * this.width + x) * 4;
    return { r: this.data[i], g: this.data[i + 1], b: this.data[i + 2], a: this.data[i + 3] };
  }

  opaque(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.data[(y * this.width + x) * 4 + 3] > 0;
  }

  rect(x: number, y: number, w: number, h: number, color: ColorInput): void {
    const c = parseColor(color);
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.width, (x + w) | 0);
    const y1 = Math.min(this.height, (y + h) | 0);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend((yy * this.width + xx) * 4, c);
  }

  hline(x: number, y: number, w: number, color: ColorInput): void {
    this.rect(x, y, w, 1, color);
  }

  vline(x: number, y: number, h: number, color: ColorInput): void {
    this.rect(x, y, 1, h, color);
  }

  /** Bresenham line, inclusive of both ends. */
  line(x0: number, y0: number, x1: number, y1: number, color: ColorInput): void {
    x0 |= 0;
    y0 |= 0;
    x1 |= 0;
    y1 |= 0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /** Filled ellipse centred on (cx, cy). Half-pixel centres give symmetric shapes. */
  ellipse(cx: number, cy: number, rx: number, ry: number, color: ColorInput): void {
    const c = parseColor(color);
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) / ry;
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        if (dx * dx + dy * dy <= 1) this.blend((y * this.width + x) * 4, c);
      }
    }
  }

  circle(cx: number, cy: number, r: number, color: ColorInput): void {
    this.ellipse(cx, cy, r, r, color);
  }

  /** One-pixel ring. */
  ring(cx: number, cy: number, r: number, color: ColorInput): void {
    const steps = Math.max(8, Math.ceil(r * 8));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      this.px(Math.floor(cx + Math.cos(a) * r), Math.floor(cy + Math.sin(a) * r), color);
    }
  }

  /** Scanline-filled polygon. */
  polygon(points: ReadonlyArray<readonly [number, number]>, color: ColorInput): void {
    if (points.length < 3) return;
    const c = parseColor(color);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of points) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.height - 1, Math.ceil(maxY));
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5;
      xs.length = 0;
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.round(xs[i]));
        const xb = Math.min(this.width, Math.round(xs[i + 1]));
        for (let x = xa; x < xb; x++) this.blend((y * this.width + x) * 4, c);
      }
    }
  }

  /** A 2:1 isometric diamond with its top vertex at (cx, top): `w` wide, `h` tall. */
  isoDiamond(cx: number, top: number, w: number, h: number, color: ColorInput): void {
    this.polygon([[cx, top], [cx + w / 2, top + h / 2], [cx, top + h], [cx - w / 2, top + h / 2]], color);
  }

  /** The face below a diamond's left edge (towards +y in ground space), `rise` pixels tall. */
  isoFaceLeft(cx: number, top: number, w: number, h: number, rise: number, color: ColorInput): void {
    this.polygon([[cx - w / 2, top + h / 2], [cx, top + h], [cx, top + h + rise], [cx - w / 2, top + h / 2 + rise]], color);
  }

  /** The face below a diamond's right edge (towards +x in ground space), `rise` pixels tall. */
  isoFaceRight(cx: number, top: number, w: number, h: number, rise: number, color: ColorInput): void {
    this.polygon([[cx, top + h], [cx + w / 2, top + h / 2], [cx + w / 2, top + h / 2 + rise], [cx, top + h + rise]], color);
  }

  /** A whole block: lit top, mid-tone left face, dark right face, from a ramp (dark to light). */
  isoBlock(cx: number, top: number, w: number, h: number, rise: number, ramp: readonly string[]): void {
    const n = ramp.length;
    this.isoFaceLeft(cx, top, w, h, rise, ramp[Math.floor(n / 2)]);
    this.isoFaceRight(cx, top, w, h, rise, ramp[Math.max(0, Math.floor(n / 3) - 1)]);
    this.isoDiamond(cx, top, w, h, ramp[n - 2] ?? ramp[n - 1]);
  }

  /**
   * Dither-shaded sphere: the workhorse for heads, bodies, canopies, boulders.
   * Lighting is Lambert against a light vector, mapped onto the ramp with ordered dither.
   */
  ball(cx: number, cy: number, rx: number, ry: number, ramp: readonly string[], opts: BallOptions = {}): void {
    const lx = opts.lx ?? -0.5;
    const ly = opts.ly ?? -0.65;
    const dither = opts.dither ?? 0.9;
    const len = Math.hypot(lx, ly, 0.6);
    const lxn = lx / len;
    const lyn = ly / len;
    const lz = 0.6 / len;
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + ry));
    const tones = ramp.map(parseColor);
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) / ry;
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1) continue;
        const z = Math.sqrt(1 - d2);
        const ndl = -(dx * lxn + dy * lyn) + z * lz;
        const t = Math.min(1, Math.max(0, (ndl + 0.55) / 1.7));
        this.blend((y * this.width + x) * 4, tones[toneAt(t, x, y, tones.length, dither)]);
      }
    }
  }

  /** Shaded box: lit along the top, light on the left, dark toward bottom-right. */
  box(x: number, y: number, w: number, h: number, ramp: readonly string[], opts: BoxOptions = {}): void {
    const vert = opts.vert ?? 0.7;
    const horiz = opts.horiz ?? 0.22;
    const tones = ramp.map(parseColor);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const t = 0.62 - (yy / h) * vert * 0.62 + (1 - xx / w) * horiz;
        const px = x + xx;
        const py = y + yy;
        if (!this.inBounds(px, py)) continue;
        this.blend((py * this.width + px) * 4, tones[toneAt(Math.min(1, Math.max(0, t)), px, py, tones.length)]);
      }
    }
    if ((opts.topLight ?? true) && h > 2) this.hline(x, y, w, ramp[ramp.length - 1]);
  }

  /** Vertical cylinder shading across the width (trunks, columns, barrels). */
  cylinder(x: number, y: number, w: number, h: number, ramp: readonly string[], lightX = 0.35): void {
    const tones = ramp.map(parseColor);
    for (let xx = 0; xx < w; xx++) {
      const u = (xx + 0.5) / w;
      const t = 1 - Math.min(1, (Math.abs(u - lightX) / (1 - lightX)) * 1.15);
      for (let yy = 0; yy < h; yy++) {
        const px = x + xx;
        const py = y + yy;
        if (!this.inBounds(px, py)) continue;
        this.blend((py * this.width + px) * 4, tones[toneAt(t, px, py, tones.length)]);
      }
    }
  }

  /** Thick shaded line for limbs, hafts and branches. */
  stroke(x0: number, y0: number, x1: number, y1: number, thickness: number, ramp: Ramp): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1;
    const horizontal = Math.abs(x1 - x0) > Math.abs(y1 - y0);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t);
      for (let k = 0; k < thickness; k++) {
        const tone = k === 0 ? 3 : k === thickness - 1 ? 1 : 2;
        if (horizontal) this.px(x, y + k, ramp[tone]);
        else this.px(x + k, y, ramp[tone]);
      }
    }
  }

  /** Vertical ramp gradient with ordered dither, top tone first. */
  gradientV(x: number, y: number, w: number, h: number, ramp: readonly string[], flip = false): void {
    const tones = ramp.map(parseColor);
    for (let yy = 0; yy < h; yy++) {
      let t = h <= 1 ? 0 : yy / (h - 1);
      if (flip) t = 1 - t;
      for (let xx = 0; xx < w; xx++) {
        const px = x + xx;
        const py = y + yy;
        if (!this.inBounds(px, py)) continue;
        this.blend((py * this.width + px) * 4, tones[toneAt(t, px, py, tones.length)]);
      }
    }
  }

  /** Radial ramp gradient, inner tone first, dithered. */
  radial(cx: number, cy: number, r: number, ramp: readonly string[]): void {
    const tones = ramp.map(parseColor);
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d > 1) continue;
        this.blend((y * this.width + x) * 4, tones[toneAt(d, x, y, tones.length)]);
      }
    }
  }

  /** Ordered-dither blend of two colours over a rect; `t` is the share of `b`. */
  dither(x: number, y: number, w: number, h: number, a: ColorInput, b: ColorInput, t: number): void {
    const A = parseColor(a);
    const B = parseColor(b);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const px = x + xx;
        const py = y + yy;
        if (!this.inBounds(px, py)) continue;
        const thresh = (BAYER4[py & 3][px & 3] + 0.5) / 16;
        this.blend((py * this.width + px) * 4, t > thresh ? B : A);
      }
    }
  }

  /** Random single pixels inside a rect; deterministic given the rng. */
  speckle(x: number, y: number, w: number, h: number, color: ColorInput, count: number, rng: Rng): void {
    for (let i = 0; i < count; i++) this.px(x + rng.int(0, w - 1), y + rng.int(0, h - 1), color);
  }

  /** Random pixels from a palette across a rect; `density` is the share of pixels touched. */
  noise(x: number, y: number, w: number, h: number, colors: readonly ColorInput[], rng: Rng, density = 0.3): void {
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (rng.chance(density)) this.px(x + xx, y + yy, rng.pick(colors));
  }

  /** Short vertical ticks over a painted body, for fur, grass and thatch. */
  ticks(x: number, y: number, w: number, h: number, colors: readonly ColorInput[], count: number, rng: Rng, length = 2): void {
    for (let i = 0; i < count; i++) {
      const px = x + rng.int(0, Math.max(0, w - 1));
      const py = y + rng.int(0, Math.max(0, h - length));
      this.vline(px, py, length, rng.pick(colors));
    }
  }

  /** Hatching lines across a rect, diagonal or vertical, every `step` pixels. */
  hatch(x: number, y: number, w: number, h: number, color: ColorInput, step = 3, diagonal = true): void {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const k = diagonal ? xx + yy : xx;
        if (k % step === 0) this.px(x + xx, y + yy, color);
      }
    }
  }

  /** Radial glow: alpha falls from 1 at the centre to 0 at radius `r`, shaped by `power`. */
  glow(cx: number, cy: number, r: number, color: ColorInput, power = 2): void {
    const c = parseColor(color);
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d >= 1) continue;
        const a = (1 - d) ** power * (c.a / 255);
        this.blend((y * this.width + x) * 4, { r: c.r, g: c.g, b: c.b, a: a * 255 });
      }
    }
  }

  /** One-pixel outline around everything opaque. Diagonal neighbours optional. */
  outline(color: ColorInput, diagonal = false): void {
    const src = new Uint8ClampedArray(this.data);
    const w = this.width;
    const h = this.height;
    const dirs = diagonal
      ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
      : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const c = parseColor(color);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (src[(y * w + x) * 4 + 3] > 0) continue;
        for (const [dx, dy] of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (src[(ny * w + nx) * 4 + 3] > 0) {
            this.blend((y * w + x) * 4, c);
            break;
          }
        }
      }
    }
  }

  /**
   * Selective edge shading: recolour opaque pixels that border transparency on the given
   * sides. Bottom and right for a shadow edge, top and left for a rim light.
   */
  edges(color: ColorInput, sides: EdgeSides = { top: true, bottom: true, left: true, right: true }): void {
    const src = new Uint8ClampedArray(this.data);
    const w = this.width;
    const h = this.height;
    const c = parseColor(color);
    const clear = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || src[(y * w + x) * 4 + 3] === 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (src[(y * w + x) * 4 + 3] === 0) continue;
        if ((sides.top && clear(x, y - 1)) || (sides.bottom && clear(x, y + 1)) || (sides.left && clear(x - 1, y)) || (sides.right && clear(x + 1, y))) {
          this.blend((y * w + x) * 4, c);
        }
      }
    }
  }

  /** Drop shadow: copies the opaque silhouette offset by (dx, dy) underneath. */
  shadow(dx: number, dy: number, color: ColorInput): void {
    const src = new Uint8ClampedArray(this.data);
    const w = this.width;
    const h = this.height;
    const c = parseColor(color);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = x - dx;
        const sy = y - dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        if (src[(sy * w + sx) * 4 + 3] === 0) continue;
        if (src[(y * w + x) * 4 + 3] > 0) continue;
        this.blend((y * w + x) * 4, c);
      }
    }
  }

  /**
   * Relight opaque pixels from a point: brighter near (lx, ly), darker beyond `radius`.
   * Quantised to steps so the result still reads as pixel art.
   */
  lightFrom(lx: number, ly: number, radius: number, strength = 0.35, steps = 4): void {
    const d = this.data;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = (y * this.width + x) * 4;
        if (d[i + 3] === 0) continue;
        if (this.maskData && this.maskData[i + 3] === 0) continue;
        const dist = Math.hypot(x + 0.5 - lx, y + 0.5 - ly) / radius;
        const k = Math.round(((1 - Math.min(1, dist)) * 2 - 1) * steps) / steps;
        const f = 1 + k * strength;
        d[i] = Math.max(0, Math.min(255, d[i] * f));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] * f));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] * f));
      }
    }
  }

  /** Swap exact colours: every pixel equal to a `from` becomes its `to`. */
  remap(pairs: ReadonlyArray<readonly [ColorInput, ColorInput]>): void {
    const table = pairs.map(([a, b]) => [parseColor(a), parseColor(b)] as const);
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      for (const [from, to] of table) {
        if (d[i] === from.r && d[i + 1] === from.g && d[i + 2] === from.b) {
          d[i] = to.r;
          d[i + 1] = to.g;
          d[i + 2] = to.b;
          break;
        }
      }
    }
  }

  /** Copy another painter onto this one. */
  blit(src: Painter, x: number, y: number, flipX = false): void {
    for (let sy = 0; sy < src.height; sy++) {
      for (let sx = 0; sx < src.width; sx++) {
        const i = (sy * src.width + sx) * 4;
        const a = src.data[i + 3];
        if (a === 0) continue;
        const tx = x + (flipX ? src.width - 1 - sx : sx);
        const ty = y + sy;
        if (!this.inBounds(tx, ty)) continue;
        this.blend((ty * this.width + tx) * 4, { r: src.data[i], g: src.data[i + 1], b: src.data[i + 2], a });
      }
    }
  }

  flipX(): Painter {
    const out = new Painter(this.width, this.height);
    out.blit(this, 0, 0, true);
    return out;
  }

  /** Nearest-neighbour upscale by an integer factor. */
  scaled(k: number): Painter {
    k = Math.max(1, Math.floor(k));
    const out = new Painter(this.width * k, this.height * k);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = (y * this.width + x) * 4;
        if (this.data[i + 3] === 0) continue;
        const c = { r: this.data[i], g: this.data[i + 1], b: this.data[i + 2], a: this.data[i + 3] };
        for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) out.blend(((y * k + yy) * out.width + x * k + xx) * 4, c);
      }
    }
    return out;
  }

  /** Multiply every pixel's colour by a tint, keeping alpha. */
  tint(color: ColorInput, amount = 1): void {
    const c = parseColor(color);
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      d[i] = d[i] * (1 - amount) + ((d[i] * c.r) / 255) * amount;
      d[i + 1] = d[i + 1] * (1 - amount) + ((d[i + 1] * c.g) / 255) * amount;
      d[i + 2] = d[i + 2] * (1 - amount) + ((d[i + 2] * c.b) / 255) * amount;
    }
  }

  /** Bounding box of opaque pixels, or null when empty. */
  bounds(): { x: number; y: number; w: number; h: number } | null {
    let x0 = this.width;
    let y0 = this.height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.data[(y * this.width + x) * 4 + 3] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** Count of opaque pixels; handy in tests. */
  opaqueCount(): number {
    let n = 0;
    for (let i = 3; i < this.data.length; i += 4) if (this.data[i] > 0) n++;
    return n;
  }

  /** ASCII dump for debugging and snapshot tests: '#' opaque, '.' transparent. */
  ascii(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = "";
      for (let x = 0; x < this.width; x++) row += this.data[(y * this.width + x) * 4 + 3] > 0 ? "#" : ".";
      rows.push(row);
    }
    return rows.join("\n");
  }

  static fromAscii(rows: string[], color: ColorInput = "#ffffff"): Painter {
    const p = new Painter(rows[0]?.length ?? 0, rows.length);
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] !== "." && row[x] !== " ") p.px(x, y, color);
    });
    return p;
  }
}

export { toHex };

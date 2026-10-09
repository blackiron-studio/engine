// Materials: reusable surface treatments built from painter primitives, so detailed
// 32 px art is a few calls rather than a few hundred pixels placed by hand.

import type { Rng } from "../core/rng.ts";
import type { Ramp } from "./color.ts";
import type { Painter } from "./painter.ts";

export interface BarkOptions {
  streaks?: number;
  knots?: number;
  /** Where the light hits across the width, 0..1. */
  light?: number;
}

/** A tree trunk or wooden post: cylinder shading, vertical streaks, a knot or two. */
export function bark(p: Painter, x: number, y: number, w: number, h: number, ramp: Ramp, rng: Rng, o: BarkOptions = {}): void {
  p.cylinder(x, y, w, h, ramp, o.light ?? 0.35);
  const streaks = o.streaks ?? Math.round(w * h * 0.02);
  for (let i = 0; i < streaks; i++) {
    const sx = x + rng.int(0, w - 1);
    const sy = y + rng.int(0, Math.max(0, h - 4));
    const len = rng.int(3, Math.max(4, Math.round(h / 4)));
    p.vline(sx, sy, len, ramp[0]);
    if (sx + 1 < x + w && rng.chance(0.6)) p.vline(sx + 1, sy + 1, Math.max(1, len - 2), ramp[3]);
  }
  for (let i = 0; i < (o.knots ?? 1); i++) {
    const kx = x + rng.int(2, Math.max(2, w - 3));
    const ky = y + rng.int(3, Math.max(3, h - 4));
    p.ellipse(kx, ky, 2, 1.4, ramp[0]);
    p.px(kx, ky, ramp[1]);
  }
}

export interface StoneOptions {
  cracks?: number;
  speckles?: number;
}

/** Rock or masonry: box shading, speckled grain, a couple of cracks, a lit top edge. */
export function stone(p: Painter, x: number, y: number, w: number, h: number, ramp: Ramp, rng: Rng, o: StoneOptions = {}): void {
  p.box(x, y, w, h, ramp, { vert: 0.5, horiz: 0.25 });
  p.speckle(x, y, w, h, ramp[1], o.speckles ?? Math.round(w * h * 0.05), rng);
  p.speckle(x, y, w, h, ramp[3], Math.round((o.speckles ?? w * h * 0.05) * 0.6), rng);
  for (let i = 0; i < (o.cracks ?? 2); i++) {
    let cx = x + rng.int(1, w - 2);
    let cy = y + rng.int(1, h - 2);
    const len = rng.int(3, Math.max(3, Math.round(Math.min(w, h) / 2)));
    for (let k = 0; k < len; k++) {
      p.px(cx, cy, ramp[0]);
      cx += rng.int(-1, 1);
      cy += rng.int(0, 1);
    }
  }
}

export interface ClothOptions {
  folds?: number;
  hem?: boolean;
}

/** Cloaks and tunics: box shading with vertical folds and a hem shadow. */
export function cloth(p: Painter, x: number, y: number, w: number, h: number, ramp: Ramp, rng: Rng, o: ClothOptions = {}): void {
  p.box(x, y, w, h, ramp, { vert: 0.55, horiz: 0.3, topLight: false });
  const folds = o.folds ?? Math.max(1, Math.round(w / 6));
  for (let i = 0; i < folds; i++) {
    const fx = x + Math.round(((i + 0.7) / (folds + 0.4)) * w);
    const top = y + rng.int(1, 3);
    for (let yy = top; yy < y + h - 1; yy++) {
      if ((yy + i) % 5 === 0) continue;
      p.px(fx, yy, ramp[1]);
    }
    if (fx + 1 < x + w) p.vline(fx + 1, top + 1, Math.max(1, Math.round(h / 3)), ramp[3]);
  }
  if (o.hem ?? true) {
    p.hline(x, y + h - 1, w, ramp[0]);
    p.hline(x, y + h - 2, w, ramp[1]);
  }
}

export interface MetalOptions {
  sheen?: boolean;
  rivets?: number;
}

/** Armour plates, blades, lantern frames: hard vertical falloff and a specular streak. */
export function metal(p: Painter, x: number, y: number, w: number, h: number, ramp: Ramp, rng: Rng, o: MetalOptions = {}): void {
  p.box(x, y, w, h, ramp, { vert: 0.9, horiz: 0.15 });
  if (o.sheen ?? true) {
    const len = Math.min(w, h);
    for (let i = 0; i < len; i++) {
      const px = x + w - 2 - i;
      const py = y + 1 + i;
      if ((i & 1) === 0) p.px(px, py, ramp[4]);
    }
  }
  for (let i = 0; i < (o.rivets ?? 0); i++) {
    const rx = x + rng.int(1, w - 2);
    const ry = y + rng.int(1, h - 2);
    p.px(rx, ry, ramp[0]);
    p.px(rx, ry - 1, ramp[4]);
  }
}

export interface FoliageOptions {
  clumps?: number;
  light?: [number, number];
  /** Extra tick strokes for leaf texture. */
  leaves?: number;
}

/** A canopy or bush: a large volume, smaller clumps, dark undersides, lit speckles, leaf strokes. */
export function foliage(p: Painter, cx: number, cy: number, rx: number, ry: number, ramp: Ramp, rng: Rng, o: FoliageOptions = {}): void {
  const [lx, ly] = o.light ?? [-0.45, -0.75];
  const deep: Ramp = [ramp[0], ramp[0], ramp[1], ramp[2], ramp[3]];
  p.ball(cx, cy + ry * 0.15, rx, ry * 0.95, deep, { lx, ly });
  const clumps = o.clumps ?? 5;
  for (let i = 0; i < clumps; i++) {
    const a = (i / clumps) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const dx = Math.cos(a) * rx * rng.range(0.35, 0.6);
    const dy = Math.sin(a) * ry * rng.range(0.3, 0.55);
    const r = rng.range(0.42, 0.6);
    p.ball(cx + dx, cy + dy, rx * r, ry * r, ramp, { lx, ly });
  }
  p.ball(cx, cy - ry * 0.25, rx * 0.62, ry * 0.5, ramp, { lx: lx * 0.8, ly: ly * 1.1 });
  const area = rx * ry;
  p.speckle(cx - rx, cy - ry, rx * 2, ry * 2, ramp[4], Math.round(area * 0.06), rng);
  p.speckle(cx - rx, cy - ry * 0.4, rx * 2, ry * 1.4, ramp[0], Math.round(area * 0.05), rng);
  const leaves = o.leaves ?? Math.round(area * 0.05);
  for (let i = 0; i < leaves; i++) {
    const x = Math.round(cx - rx + rng.range(0, rx * 2));
    const y = Math.round(cy - ry + rng.range(0, ry * 2));
    if (!p.opaque(x, y)) continue;
    p.hline(x, y, 2, rng.chance(0.5) ? ramp[3] : ramp[1]);
  }
}

export interface GrassOptions {
  blades?: number;
  flowers?: number;
  flowerColors?: string[];
}

/** A ground tile: dithered base, blades in clumps, occasional flowers. */
export function grass(p: Painter, x: number, y: number, w: number, h: number, ramp: Ramp, rng: Rng, o: GrassOptions = {}): void {
  p.rect(x, y, w, h, ramp[2]);
  p.dither(x, y, w, h, ramp[2], ramp[1], 0.25 + rng.range(0, 0.1));
  p.dither(x, y, w, Math.round(h * 0.4), ramp[2], ramp[3], 0.15);
  p.speckle(x, y, w, h, ramp[3], Math.round(w * h * 0.025), rng);
  p.speckle(x, y, w, h, ramp[0], Math.round(w * h * 0.015), rng);
  const blades = o.blades ?? Math.round(w * h * 0.014);
  for (let i = 0; i < blades; i++) {
    const bx = x + rng.int(1, w - 2);
    const by = y + rng.int(3, h - 1);
    const bh = rng.int(2, 4);
    p.vline(bx, by - bh, bh, ramp[1]);
    p.vline(bx + 1, by - bh + 1, bh - 1, ramp[3]);
  }
  const colors = o.flowerColors ?? ["#f2a9c4", "#fff3c2", "#f7d35e"];
  for (let i = 0; i < (o.flowers ?? 0); i++) {
    const fx = x + rng.int(2, w - 3);
    const fy = y + rng.int(3, h - 3);
    p.px(fx, fy + 1, ramp[0]);
    p.rect(fx, fy, 2, 1, rng.pick(colors));
  }
}

export interface PlankOptions {
  plankH?: number;
  nails?: boolean;
}

/** Wooden planks: horizontal boards with grain and gaps. */
export function planks(p: Painter, x: number, y: number, w: number, h: number, ramp: Ramp, rng: Rng, o: PlankOptions = {}): void {
  const ph = o.plankH ?? 6;
  for (let py = 0; py < h; py += ph) {
    const bh = Math.min(ph, h - py);
    p.box(x, y + py, w, bh, ramp, { vert: 0.5, horiz: 0.1 });
    for (let i = 0; i < Math.round(w / 6); i++) {
      const gx = x + rng.int(0, w - 3);
      p.hline(gx, y + py + rng.int(1, Math.max(1, bh - 2)), rng.int(2, 4), ramp[1]);
    }
    p.hline(x, y + py + bh - 1, w, ramp[0]);
    if (o.nails ?? true) {
      p.px(x + 1, y + py + 1, ramp[0]);
      p.px(x + w - 2, y + py + 1, ramp[0]);
    }
  }
}

export interface WaterOptions {
  waves?: number;
}

/** Still water: dithered depth with light wave lines. */
export function water(p: Painter, x: number, y: number, w: number, h: number, ramp: Ramp, rng: Rng, o: WaterOptions = {}): void {
  p.rect(x, y, w, h, ramp[2]);
  p.dither(x, y, w, h, ramp[2], ramp[1], 0.35);
  for (let i = 0; i < (o.waves ?? Math.round(w / 6)); i++) {
    const wx = x + rng.int(0, Math.max(0, w - 6));
    const wy = y + rng.int(1, h - 2);
    p.hline(wx, wy, rng.int(3, 7), ramp[4]);
    p.px(wx + 1, wy + 1, ramp[3]);
  }
}

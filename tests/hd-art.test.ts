// High-resolution procedural art: anti-aliased vector shapes, gradients, effects, tileable
// noise, and sprites painted at a density above one texel per unit.

import { afterEach, describe, expect, test } from "bun:test";
import { bakeAtlas, sliceNine, texelSize } from "../src/art/atlas.ts";
import { fbm, perlin, worley } from "../src/art/noise.ts";
import { Painter } from "../src/art/painter.ts";
import { defineSprite, resetSpriteRegistry } from "../src/art/sprites.ts";
import { defineStyle } from "../src/art/style.ts";
import { linear, path, pen } from "../src/art/vector.ts";

const alphaAt = (p: Painter, x: number, y: number) => p.data[(y * p.width + x) * 4 + 3];

afterEach(() => resetSpriteRegistry());

describe("vector pen", () => {
  test("a circle is opaque inside, clear outside and anti-aliased at its edge", () => {
    const p = new Painter(64, 64);
    pen(p).circle(32, 32, 20, "#ffffff");
    expect(alphaAt(p, 32, 32)).toBe(255);
    expect(alphaAt(p, 2, 2)).toBe(0);
    let partial = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const a = alphaAt(p, x, y);
      if (a > 0 && a < 255) partial++;
    }
    expect(partial).toBeGreaterThan(40);
  });

  test("density scales drawing: a unit circle at density 4 covers four times the texels across", () => {
    const p = new Painter(64, 64);
    p.density = 4;
    pen(p).circle(8, 8, 6, "#ffffff");
    expect(alphaAt(p, 32, 32)).toBe(255);
    expect(alphaAt(p, 32, 54)).toBe(255);
    expect(alphaAt(p, 32, 60)).toBe(0);
  });

  test("even-odd rings have holes and gradients run between their stops", () => {
    const p = new Painter(64, 64);
    pen(p).ring(32, 32, 20, 6, "#ffffff");
    expect(alphaAt(p, 32, 32)).toBe(0);
    expect(alphaAt(p, 32, 12)).toBe(255);
    const g = new Painter(100, 4);
    pen(g).rect(0, 0, 100, 4, linear(0, 0, 100, 0, [[0, "#000000"], [1, "#ffffff"]]));
    expect(g.data[0]).toBeLessThan(10);
    expect(g.data[(99 * 4)]).toBeGreaterThan(245);
    expect(Math.abs(g.data[50 * 4] - 128)).toBeLessThan(8);
  });

  test("strokes cover their width with round caps", () => {
    const p = new Painter(64, 64);
    pen(p).stroke(path().moveTo(10, 32).lineTo(54, 32), 8, "#ffffff");
    expect(alphaAt(p, 32, 32)).toBe(255);
    expect(alphaAt(p, 32, 35)).toBe(255);
    expect(alphaAt(p, 32, 40)).toBe(0);
    expect(alphaAt(p, 7, 32)).toBeGreaterThan(0);
  });

  test("blur spreads alpha without darkening colour; drop shadows sit behind the shape", () => {
    const p = new Painter(48, 48);
    pen(p).rect(16, 16, 16, 16, "#ff0000");
    p.blur(3);
    const edge = (20 * 48 + 14) * 4;
    expect(p.data[edge + 3]).toBeGreaterThan(0);
    expect(p.data[edge]).toBeGreaterThan(250);
    const s = new Painter(48, 48);
    pen(s).rect(16, 16, 16, 16, "#ffffff");
    s.dropShadow({ dx: 0, dy: 4, blur: 2, opacity: 1 });
    expect(s.data[(24 * 48 + 24) * 4]).toBe(255);
    const below = (34 * 48 + 24) * 4;
    expect(s.data[below + 3]).toBeGreaterThan(0);
    expect(s.data[below]).toBeLessThan(40);
  });
});

describe("colours", () => {
  test("rgb() and rgba() parse alongside hex", async () => {
    const { parseColor } = await import("../src/art/color.ts");
    expect(parseColor("rgba(255, 128, 0, 0.5)")).toEqual({ r: 255, g: 128, b: 0, a: 128 });
    expect(parseColor("rgb(1,2,3)")).toEqual({ r: 1, g: 2, b: 3, a: 255 });
  });
});

describe("noise", () => {
  test("tileable gradient noise repeats with its period and stays in range", () => {
    for (const [x, y] of [[0.3, 0.7], [2.5, 1.25], [3.9, 0.1]]) {
      expect(perlin(x, y, 5, 4)).toBeCloseTo(perlin(x + 4, y + 4, 5, 4), 6);
      expect(Math.abs(fbm(x, y, { seed: 2 }))).toBeLessThanOrEqual(1.01);
    }
    const c = worley(1.5, 1.5, 3, 4);
    expect(c.f1).toBeLessThanOrEqual(c.f2);
    expect(worley(1.5, 1.5, 3, 4).id).toBe(worley(5.5, 5.5, 3, 4).id);
  });
});

describe("high-resolution sprites", () => {
  test("a density-2 sprite keeps its logical size, doubles its texels, samples smoothly and skips the palette", () => {
    defineStyle({ palette: ["#000000", "#ffffff"] });
    defineSprite("hd.gem", { w: 20, h: 10, density: 2, origin: [0.5, 1] }, (p) => pen(p).roundRect(1, 1, 18, 8, 3, "#ff8040"));
    const atlas = bakeAtlas({ font: false });
    const r = atlas.region("hd.gem");
    expect([r.w, r.h]).toEqual([20, 10]);
    expect(texelSize(r)).toEqual([40, 20]);
    expect(r.density).toBe(2);
    expect(r.smooth).toBe(true);
    expect([r.ox, r.oy]).toEqual([10, 10]);
    const px = ((r.y + 10) * atlas.width + r.x + 20) * 4;
    expect([atlas.data[px], atlas.data[px + 1], atlas.data[px + 2]]).toEqual([255, 128, 64]);
    const parts = sliceNine(r, 4, atlas.width, atlas.height);
    expect(parts[0].w).toBe(4);
    expect(parts.slice(0, 3).reduce((a, q) => a + q.w, 0)).toBeCloseTo(20, 6);
    expect(parts.every((q) => q.density === 2 && q.smooth)).toBe(true);
  });
});

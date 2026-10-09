import { beforeEach, describe, expect, test } from "bun:test";
import {
  FONT_CHARS,
  FONT_H,
  FONT_W,
  Painter,
  bakeAtlas,
  defineAnimation,
  defineSprite,
  defineVariants,
  getAnimation,
  getSpriteDef,
  glyphRows,
  measureText,
  paintSprite,
  parseColor,
  ramp,
  resetSpriteRegistry,
  rgbToHsl,
  shade,
  spriteDefs,
} from "../src/art/index.ts";

describe("colour", () => {
  test("parses short, long and alpha hex", () => {
    expect(parseColor("#f00")).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseColor("#00ff0080")).toEqual({ r: 0, g: 255, b: 0, a: 128 });
    expect(parseColor(0x123456)).toEqual({ r: 0x12, g: 0x34, b: 0x56, a: 255 });
  });

  test("shade clamps", () => {
    expect(shade("#f0f0f0", 40)).toBe("#ffffff");
    expect(shade("#101010", -40)).toBe("#000000");
  });

  test("ramp goes dark to light with cool shadows and warm highlights", () => {
    const r = ramp("#3f7345");
    expect(r).toHaveLength(5);
    const l = r.map((c) => {
      const { r: rr, g, b } = parseColor(c);
      return rgbToHsl(rr, g, b)[2];
    });
    for (let i = 1; i < 5; i++) expect(l[i]).toBeGreaterThan(l[i - 1]);
    expect(r[2]).toBe("#3f7345");
    const shadow = parseColor(r[0]);
    const light = parseColor(r[4]);
    expect(shadow.b / Math.max(1, shadow.r)).toBeGreaterThan(light.b / Math.max(1, light.r));
  });
});

describe("Painter", () => {
  test("px, rect and get", () => {
    const p = new Painter(4, 4);
    p.px(1, 1, "#ff0000");
    p.rect(2, 2, 2, 2, "#00ff00");
    expect(p.get(1, 1)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(p.get(3, 3)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(p.get(0, 0)?.a).toBe(0);
    expect(p.opaqueCount()).toBe(5);
    p.px(10, 10, "#fff");
    expect(p.opaqueCount()).toBe(5);
  });

  test("alpha blends source-over", () => {
    const p = new Painter(1, 1);
    p.px(0, 0, "#000000");
    p.px(0, 0, "#ffffff80");
    const c = p.get(0, 0) as { r: number; a: number };
    expect(c.r).toBeGreaterThan(120);
    expect(c.r).toBeLessThan(136);
    expect(c.a).toBe(255);
  });

  test("ellipse is symmetric and ball is shaded", () => {
    const p = new Painter(9, 9);
    p.ellipse(4.5, 4.5, 4, 4, "#fff");
    expect(p.ascii()).toBe(p.flipX().ascii());
    const b = new Painter(9, 9);
    b.ball(4.5, 4.5, 4, 4, ramp("#888888"));
    const tones = new Set<string>();
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      const c = b.get(x, y);
      if (c && c.a > 0) tones.add(`${c.r},${c.g},${c.b}`);
    }
    expect(tones.size).toBeGreaterThanOrEqual(3);
  });

  test("outline surrounds the shape", () => {
    const p = Painter.fromAscii(["...", ".#.", "..."]);
    p.outline("#ff0000");
    expect(p.ascii()).toBe([".#.", "###", ".#."].join("\n"));
    expect(p.get(0, 1)?.r).toBe(255);
    expect(p.get(0, 1)?.g).toBe(0);
    expect(p.get(1, 1)?.g).toBe(255);
    const d = Painter.fromAscii(["...", ".#.", "..."]);
    d.outline("#ff0000", true);
    expect(d.ascii()).toBe(["###", "###", "###"].join("\n"));
  });

  test("fromAscii and ascii round trip", () => {
    const rows = [".#.", "###", ".#."];
    expect(Painter.fromAscii(rows).ascii()).toBe(rows.join("\n"));
  });

  test("bounds finds the opaque box", () => {
    const p = new Painter(8, 8);
    p.rect(2, 3, 3, 2, "#fff");
    expect(p.bounds()).toEqual({ x: 2, y: 3, w: 3, h: 2 });
    expect(new Painter(2, 2).bounds()).toBeNull();
  });
});

describe("font", () => {
  test("every glyph is 5x7 and only uses # and .", () => {
    for (const ch of FONT_CHARS) {
      const rows = glyphRows(ch);
      expect(rows).toHaveLength(FONT_H);
      for (const r of rows) {
        expect(r).toHaveLength(FONT_W);
        expect(r).toMatch(/^[#.]+$/);
      }
    }
  });

  test("lowercase maps to uppercase and unknown to ?", () => {
    expect(glyphRows("a")).toEqual(glyphRows("A"));
    expect(glyphRows("ß")).toEqual(glyphRows("?"));
  });

  test("measureText", () => {
    expect(measureText("")).toBe(0);
    expect(measureText("AB")).toBe(11);
    expect(measureText("AB", 2)).toBe(22);
  });
});

describe("sprites and atlas", () => {
  beforeEach(() => resetSpriteRegistry());

  test("defineSprite registers with defaults and paints deterministically", () => {
    defineSprite("dot", { w: 4, h: 4 }, (p, { rng }) => p.px(rng.int(0, 3), rng.int(0, 3), "#fff"));
    const def = getSpriteDef("dot");
    expect(def?.origin).toEqual([0.5, 0.5]);
    expect(paintSprite(def!).data).toEqual(paintSprite(def!).data);
    expect(() => defineSprite("dot", { w: 1, h: 1 }, () => {})).toThrow();
  });

  test("variants get an index and their own seed", () => {
    const names = defineVariants("v", 3, { w: 2, h: 2 }, (p, { index }) => p.px(index % 2, 0, "#fff"));
    expect(names).toEqual(["v.0", "v.1", "v.2"]);
    expect(getSpriteDef("v.2")?.index).toBe(2);
    expect(getSpriteDef("v.0")?.seed).not.toBe(getSpriteDef("v.1")?.seed);
    expect(spriteDefs()).toHaveLength(3);
  });

  test("animations", () => {
    defineAnimation("walk", ["a", "b"], 12);
    expect(getAnimation("walk")).toEqual({ name: "walk", frames: ["a", "b"], fps: 12, loop: true });
  });

  test("bakeAtlas packs without overlap and keeps pixels", () => {
    defineSprite("solid", { w: 6, h: 3, origin: [0, 1] }, (p) => p.rect(0, 0, 6, 3, "#ff8800"));
    defineVariants("big", 3, { w: 40, h: 30 }, (p, { index }) => p.rect(0, 0, 40, 30, index ? "#00ff00" : "#0000ff"));
    const atlas = bakeAtlas({ maxWidth: 128 });
    const regions = atlas.all();
    expect(atlas.has("solid")).toBe(true);
    expect(atlas.has("__white")).toBe(true);
    expect(atlas.has("__g:A")).toBe(true);
    for (const a of regions) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x + a.w).toBeLessThanOrEqual(atlas.width);
      expect(a.y + a.h).toBeLessThanOrEqual(atlas.height);
      for (const b of regions) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap).toBe(false);
      }
    }
    const r = atlas.region("solid");
    expect(r.ox).toBe(0);
    expect(r.oy).toBe(3);
    const px = atlas.extract("solid").get(2, 1);
    expect(px).toEqual({ r: 255, g: 136, b: 0, a: 255 });
    expect(atlas.region("nope")).toBe(atlas.missing);
    const white = atlas.data[(Math.floor(atlas.whiteV * atlas.height) * atlas.width + Math.floor(atlas.whiteU * atlas.width)) * 4];
    expect(white).toBe(255);
  });

  test("a sprite wider than the atlas throws", () => {
    defineSprite("wide", { w: 300, h: 2 }, () => {});
    expect(() => bakeAtlas({ maxWidth: 128 })).toThrow();
  });
});

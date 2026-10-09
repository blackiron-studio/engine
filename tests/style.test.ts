// The style bible: palettes snap at bake time, "full" sprites get the outline and rim, and
// sprites drawn as rows come out the size and colours they say.

import { afterEach, describe, expect, test } from "bun:test";
import { Painter, applyStyle, bakeAtlas, defineRowAnimation, defineRowSprite, defineSprite, defineStyle, mirrorRows, paintRows, placeRows, resetSpriteRegistry, rowsSize, stackRows } from "../src/art/index.ts";
import { getAnimation } from "../src/art/sprites.ts";

afterEach(() => resetSpriteRegistry());

function pixel(p: Painter, x: number, y: number): [number, number, number, number] {
  const i = (y * p.width + x) * 4;
  return [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]];
}

describe("Style bible", () => {
  test("every opaque pixel snaps to the palette; faint pixels keep their colour", () => {
    const p = new Painter(4, 1);
    p.px(0, 0, "#a0a0a0");
    p.px(1, 0, "#ff1010");
    p.px(2, 0, "#10ff10");
    p.px(3, 0, "#80808010");
    applyStyle(p, "palette", { palette: ["#000000", "#ffffff", "#ff0000", "#00ff00"] });
    expect(pixel(p, 0, 0).slice(0, 3)).toEqual([255, 255, 255]);
    expect(pixel(p, 1, 0).slice(0, 3)).toEqual([255, 0, 0]);
    expect(pixel(p, 2, 0).slice(0, 3)).toEqual([0, 255, 0]);
    expect(pixel(p, 3, 0)[3]).toBe(16);
    expect(pixel(p, 3, 0)[0]).toBe(128);
  });

  test("full sprites get the outline and the rim, palette sprites only the colours", () => {
    defineStyle({ palette: ["#000000", "#ffffff", "#ff0000", "#8080ff"], outline: "#000000", rim: { color: "#8080ff" } });
    defineSprite("hero", { w: 5, h: 5, style: "full" }, (p) => p.rect(1, 1, 3, 3, "#f0f0f0"));
    defineSprite("tile", { w: 5, h: 5 }, (p) => p.rect(1, 1, 3, 3, "#f0f0f0"));
    const atlas = bakeAtlas({ builtins: false, font: false });
    const hero = atlas.region("hero");
    const tile = atlas.region("tile");
    const at = (r: { x: number; y: number }, x: number, y: number) => {
      const i = ((r.y + y) * atlas.width + (r.x + x)) * 4;
      return [atlas.data[i], atlas.data[i + 1], atlas.data[i + 2], atlas.data[i + 3]];
    };
    // Outline where there was nothing, rim on the top edge, white inside.
    expect(at(hero, 0, 2)).toEqual([0, 0, 0, 255]);
    expect(at(hero, 2, 1).slice(0, 3)).toEqual([128, 128, 255]);
    expect(at(hero, 2, 2).slice(0, 3)).toEqual([255, 255, 255]);
    // The tile keeps its silhouette; its grey snapped to white.
    expect(at(tile, 0, 2)[3]).toBe(0);
    expect(at(tile, 2, 2).slice(0, 3)).toEqual([255, 255, 255]);
  });

  test("rows paint what they say, mirror, stack and place", () => {
    const rows = mirrorRows(["ab", ".a"]);
    expect(rows).toEqual(["abba", ".aa."]);
    expect(rowsSize(rows)).toEqual({ w: 4, h: 2 });
    const stacked = stackRows(["xx"], rows);
    expect(stacked).toEqual(["xx..", "abba", ".aa."]);
    expect(placeRows(["ab"], 4, 3, 1, 1)).toEqual(["....", ".ab.", "...."]);
    const p = new Painter(4, 2);
    paintRows(p, rows, { a: "#ff0000", b: "#00ff00" });
    expect(pixel(p, 0, 0).slice(0, 3)).toEqual([255, 0, 0]);
    expect(pixel(p, 1, 0).slice(0, 3)).toEqual([0, 255, 0]);
    expect(pixel(p, 0, 1)[3]).toBe(0);
  });

  test("row sprites size themselves, sit at the bottom of a taller canvas, and animate", () => {
    const legend = { a: "#ff0000" };
    defineRowSprite("dot", ["a"], legend, { w: 3, h: 3 });
    defineRowAnimation("blink", [["a"], ["aa"]], legend, { fps: 4 });
    const atlas = bakeAtlas({ builtins: false, font: false });
    const dot = atlas.region("dot");
    expect([dot.w, dot.h]).toEqual([3, 3]);
    const i = ((dot.y + 2) * atlas.width + (dot.x + 1)) * 4;
    expect(atlas.data[i + 3]).toBe(255);
    const anim = getAnimation("blink");
    expect(anim?.frames).toEqual(["blink.0", "blink.1"]);
    expect(anim?.fps).toBe(4);
    const f0 = atlas.region("blink.0");
    const f1 = atlas.region("blink.1");
    expect([f0.w, f0.h]).toEqual([2, 1]);
    expect([f1.w, f1.h]).toEqual([2, 1]);
  });
});

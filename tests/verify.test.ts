// The visual harness's building blocks: the PNG codec round-trips, and the comparison
// counts differing pixels and draws a diff.

import { describe, expect, test } from "bun:test";
import { compareImages } from "../cli/commands/verify.ts";
import { decodePNG, encodePNG } from "../cli/png.ts";

function image(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) rgba.set(fill(x, y), (y * w + x) * 4);
  }
  return { width: w, height: h, rgba };
}

describe("verify", () => {
  test("PNG encode and decode round-trip every byte", () => {
    const src = image(37, 21, (x, y) => [x * 6, y * 11, (x * y) & 255, 255]);
    const png = encodePNG(src.width, src.height, src.rgba);
    const back = decodePNG(png);
    expect(back.width).toBe(37);
    expect(back.height).toBe(21);
    expect(Array.from(back.rgba)).toEqual(Array.from(src.rgba));
  });

  test("identical images differ nowhere; a changed patch is counted and highlighted", () => {
    const a = image(40, 30, () => [100, 120, 140, 255]);
    const same = compareImages(a, a);
    expect(same.differing).toBe(0);
    expect(same.total).toBe(1200);
    const b = image(40, 30, (x, y) => (x < 10 && y < 10 ? [250, 20, 20, 255] : [100, 120, 140, 255]));
    const cmp = compareImages(a, b);
    expect(cmp.differing).toBe(100);
    // The diff marks changed pixels red and keeps the rest as a grey ghost.
    expect(cmp.diff[0]).toBe(255);
    expect(cmp.diff[1]).toBe(40);
    const o = (29 * 40 + 39) * 4;
    expect(cmp.diff[o]).toBe(cmp.diff[o + 1]);
    expect(cmp.diff[o + 3]).toBe(255);
  });

  test("small noise below the channel threshold does not count", () => {
    const a = image(8, 8, () => [100, 100, 100, 255]);
    const b = image(8, 8, () => [110, 95, 120, 255]);
    expect(compareImages(a, b).differing).toBe(0);
  });

  test("a size mismatch fails outright", () => {
    const a = image(8, 8, () => [0, 0, 0, 255]);
    const b = image(9, 8, () => [0, 0, 0, 255]);
    const cmp = compareImages(a, b);
    expect(cmp.sizeMismatch).toBe("8x8 vs 9x8");
    expect(cmp.differing).toBe(cmp.total);
  });
});

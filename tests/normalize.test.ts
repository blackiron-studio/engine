// A generated-looking sheet (soft upscale, white ground, poses wherever) comes out as clean
// game pixels: keyed, found, resampled, snapped, trimmed and stood on one baseline.

import { describe, expect, test } from "bun:test";
import { Painter, type RawImage, cornerKey, detectPixelSize, downsample, findBlobs, keyBackground, normalizeSheet, paintRows, tagFrames } from "../src/art/index.ts";

const FIGURE = ["..rr..", ".rrrr.", "rrssrr", ".rrrr.", "..bb..", "..bb..", ".b..b."];
const LEGEND = { r: "#c03030", s: "#f0d0b0", b: "#303060" };

/** Upscale a painter by `k` with a soft edge, onto a white ground at (x, y). */
function stamp(ground: Painter, small: Painter, x: number, y: number, k: number): void {
  for (let sy = 0; sy < small.height; sy++) {
    for (let sx = 0; sx < small.width; sx++) {
      const i = (sy * small.width + sx) * 4;
      if (small.data[i + 3] === 0) continue;
      const hex = `#${[small.data[i], small.data[i + 1], small.data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      ground.rect(x + sx * k, y + sy * k, k, k, hex);
    }
  }
  // Soften edges like an upscaler would: blend the rim pixels toward white.
  const src = new Uint8ClampedArray(ground.data);
  for (let py = y - 1; py <= y + small.height * k; py++) {
    for (let px = x - 1; px <= x + small.width * k; px++) {
      const i = (py * ground.width + px) * 4;
      let opaqueNeighbours = 0;
      let white = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const j = ((py + dy) * ground.width + px + dx) * 4;
        if (src[j] === 255 && src[j + 1] === 255 && src[j + 2] === 255) white++;
        else opaqueNeighbours++;
      }
      if (white > 0 && opaqueNeighbours > 0) {
        ground.data[i] = Math.round((src[i] + 255) / 2);
        ground.data[i + 1] = Math.round((src[i + 1] + 255) / 2);
        ground.data[i + 2] = Math.round((src[i + 2] + 255) / 2);
      }
    }
  }
}

function sheet(): RawImage {
  const ground = new Painter(160, 100);
  ground.clear("#ffffff");
  const small = new Painter(6, 7);
  paintRows(small, FIGURE, LEGEND);
  stamp(ground, small, 11, 13, 5);
  stamp(ground, small, 73, 22, 5);
  stamp(ground, small, 121, 9, 5);
  return { width: ground.width, height: ground.height, data: ground.data };
}

describe("Sheet normaliser", () => {
  test("finds the white key, the three poses and the pixel size", () => {
    const img = sheet();
    expect(cornerKey(img)).toBe("#ffffff");
    keyBackground(img, "#ffffff", 40);
    const blobs = findBlobs(img, 20, 6);
    expect(blobs.length).toBe(3);
    expect(blobs[0].x).toBeLessThan(blobs[1].x);
    expect(blobs[1].x).toBeLessThan(blobs[2].x);
    expect(detectPixelSize(img)).toBe(5);
    const small = downsample(img, blobs[0], 5);
    expect([small.width, small.height]).toEqual([6, 7]);
  });

  test("normalises to clean frames on one baseline, snapped to the palette", () => {
    const result = normalizeSheet(sheet(), { palette: ["#c03030", "#f0d0b0", "#303060", "#ffffff"] });
    expect(result.pixel).toBe(5);
    expect(result.key).toBe("#ffffff");
    expect(result.frames.length).toBe(3);
    for (const f of result.frames) expect([f.w, f.h]).toEqual([6, 7]);
    expect(result.cell).toEqual({ w: 8, h: 9 });
    // The first frame's head pixel is the red of the palette, exactly, and it stands on the bottom.
    const s = result.sheet;
    const px = (x: number, y: number) => Array.from(s.data.slice((y * s.width + x) * 4, (y * s.width + x) * 4 + 4));
    expect(px(1 + 2, 1 + 0)).toEqual([192, 48, 48, 255]);
    expect(px(1 + 1, 1 + 6)).toEqual([48, 48, 96, 255]);
    expect(px(1 + 0, 1 + 0)[3]).toBe(0);
    expect(result.json.frames.length).toBe(3);
    expect(tagFrames(result.json, "walk", [1, 2], 6)).toBe(true);
    expect(tagFrames(result.json, "odd", [0, 2])).toBe(false);
    expect(result.json.meta.frameTags[0]).toEqual({ name: "walk", from: 1, to: 2, direction: "forward" });
  });

  test("shrink halves the frames for a smaller cast", () => {
    const result = normalizeSheet(sheet(), { palette: ["#c03030", "#f0d0b0", "#303060"], shrink: 2 });
    expect(result.frames.length).toBe(3);
    for (const f of result.frames) expect(f.w).toBeLessThanOrEqual(3);
    for (const f of result.frames) expect(f.h).toBeLessThanOrEqual(4);
  });

  test("a grid slices where the cells say", () => {
    const result = normalizeSheet(sheet(), { cell: { w: 80, h: 100 }, pixel: 5, key: "#ffffff" });
    expect(result.frames.length).toBe(2);
  });
});

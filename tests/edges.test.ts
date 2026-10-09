// Tiles are extruded into the atlas padding; props keep a clear gap for their outlines.

import { describe, expect, test } from "bun:test";
import { bakeAtlas, opaqueEdged } from "../src/art/atlas.ts";
import { defineSprite, getSpriteDef } from "../src/art/sprites.ts";

describe("atlas edges", () => {
  test("an opaque-edged sprite is extruded one texel, a prop is not, and edge overrides both", () => {
    defineSprite("edge.tile", { w: 4, h: 4, style: "none" }, (p) => p.rect(0, 0, 4, 4, "#ff0000"));
    defineSprite("edge.prop", { w: 4, h: 4, style: "none" }, (p) => p.rect(1, 1, 2, 2, "#00ff00"));
    defineSprite("edge.forced", { w: 4, h: 4, style: "none", edge: "extrude" }, (p) => p.rect(1, 1, 2, 2, "#0000ff"));
    defineSprite("edge.kept", { w: 4, h: 4, style: "none", edge: "clear" }, (p) => p.rect(0, 0, 4, 4, "#ffff00"));
    const defs = ["edge.tile", "edge.prop", "edge.forced", "edge.kept"].map((n) => getSpriteDef(n)!);
    const atlas = bakeAtlas({ defs, builtins: false, font: false });
    const texel = (x: number, y: number) => Array.from(atlas.data.subarray((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 4));
    const tile = atlas.region("edge.tile");
    expect(texel(tile.x - 1, tile.y)).toEqual([255, 0, 0, 255]);
    expect(texel(tile.x + tile.w, tile.y + tile.h)).toEqual([255, 0, 0, 255]);
    expect(texel(tile.x - 1, tile.y - 1)).toEqual([255, 0, 0, 255]);
    const prop = atlas.region("edge.prop");
    expect(texel(prop.x - 1, prop.y + 1)[3]).toBe(0);
    const forced = atlas.region("edge.forced");
    expect(texel(forced.x - 1, forced.y + 1)[3]).toBe(0);
    expect(texel(forced.x, forced.y - 1)[3]).toBe(0);
    const kept = atlas.region("edge.kept");
    expect(texel(kept.x - 1, kept.y)[3]).toBe(0);
    const solid = { width: 2, height: 2, data: new Uint8ClampedArray([1, 1, 1, 255, 1, 1, 1, 255, 1, 1, 1, 255, 1, 1, 1, 255]) };
    expect(opaqueEdged(solid as never)).toBe(true);
    solid.data[3] = 0;
    expect(opaqueEdged(solid as never)).toBe(false);
  });
});

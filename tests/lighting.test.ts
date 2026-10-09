// Lights and shadows: the procedural light op, normal maps baked from sprites, occluder
// segments from polygons and tile maps, and the scratch pass a shadowed light draws through.

import { beforeAll, describe, expect, test } from "bun:test";
import { Painter, bakeAtlas, bevelNormals, defineSprite, resetSpriteRegistry } from "../src/art/index.ts";
import { StreamWriter, TsKernel } from "../src/kernel/index.ts";
import { FLOATS_PER_VERT } from "../src/kernel/protocol.ts";
import { Light2D, LightLayer, LightOccluder2D, Scene, Sprite, TileMap } from "../src/scene/index.ts";
import { createTestApp, lastFrame, stepFrames } from "../src/testkit/index.ts";

const region = { name: "dot", x: 0, y: 0, w: 8, h: 6, u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.4, ox: 4, oy: 3 };

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("dot", { w: 4, h: 4 }, (p) => p.rect(0, 0, 4, 4, "#fff"));
  defineSprite("tile", { w: 16, h: 16 }, (p) => p.rect(0, 0, 16, 16, "#8a8"));
  defineSprite("lit", { w: 6, h: 6, normal: "bevel" }, (p) => p.circle(3, 3, 3, "#c84"));
  defineSprite("flat", { w: 6, h: 6 }, (p) => p.rect(0, 0, 6, 6, "#48c"));
});

describe("Render protocol", () => {
  test("a light is one quad with centred texture coordinates on the light slot", () => {
    const k = new TsKernel();
    const w = new StreamWriter(k);
    w.begin(0, 640, 360);
    w.pass(1, 0x202020);
    w.transform([1, 0, 0, 1, 0, 0]);
    w.light(100, 50, 40, 0xff8000, 0.5, 2, 0.6);
    w.end();
    k.run(w.length);
    const v = k.vertices;
    const S = FLOATS_PER_VERT;
    expect(k.stats[3]).toBe(1);
    expect([v[0], v[1]]).toEqual([60, 10]);
    expect([v[2 * S], v[2 * S + 1]]).toEqual([140, 90]);
    expect([v[2], v[3], v[2 * S + 2], v[2 * S + 3]]).toEqual([-1, -1, 1, 1]);
    // mode 1 (additive), slot 3, p0 height, p1 falloff, colour and intensity in the colour.
    expect([v[8], v[9], v[11]]).toEqual([1, 3, 2]);
    expect(v[10]).toBeCloseTo(0.6, 5);
    expect(v[4]).toBeCloseTo(1, 5);
    expect(v[5]).toBeCloseTo(0x80 / 255, 5);
    expect(v[7]).toBe(0.5);
  });

  test("an erase quad, a mesh of triangles and an outlined sprite expand as designed", () => {
    const k = new TsKernel();
    k.setWhite(0.9, 0.9);
    const w = new StreamWriter(k);
    w.begin(0, 640, 360);
    w.pass(3, 0);
    w.transform([2, 0, 0, 2, 0, 0]);
    w.quad([0, 0, 10, 0, 10, 10, 0, 10], 0x000000, 0.8, true);
    w.mesh([0, 0, 0.1, 0.1, 8, 0, 0.2, 0.1, 8, 8, 0.2, 0.2, 0, 0, 0.1, 0.1, 8, 8, 0.2, 0.2, 0, 8, 0.1, 0.2], 6, 0xffffff, 1);
    w.sprite({ region, x: 20, y: 20, material: { kind: "outline", p0: 1 / 256, p1: 1 / 128 }, tint: 0xff0000 });
    w.end();
    k.run(w.length);
    const v = k.vertices;
    const S = FLOATS_PER_VERT;
    expect(k.stats[3]).toBe(4);
    // The quad: transformed corners, white texel, erase mode.
    expect([v[0], v[1], v[2 * S], v[2 * S + 1]]).toEqual([0, 0, 20, 20]);
    expect(v[2]).toBeCloseTo(0.9, 5);
    expect(v[3]).toBeCloseTo(0.9, 5);
    expect(v[8]).toBe(2);
    // The mesh: two degenerate quads whose last vertex repeats the third.
    const q1 = 4 * S;
    expect([v[q1], v[q1 + 1], v[q1 + S], v[q1 + S + 1], v[q1 + 2 * S], v[q1 + 2 * S + 1]]).toEqual([0, 0, 16, 0, 16, 16]);
    expect([v[q1 + 3 * S], v[q1 + 3 * S + 1]]).toEqual([16, 16]);
    expect(v[q1 + 2]).toBeCloseTo(0.1, 5);
    expect(v[q1 + 3]).toBeCloseTo(0.1, 5);
    // The outline: one texel of room on every side, material 3 in the mode, texel size in p0/p1.
    const q3 = 12 * S;
    expect([v[q3], v[q3 + 1]]).toEqual([2 * (20 - 4 - 1), 2 * (20 - 3 - 1)]);
    expect([v[q3 + 2 * S], v[q3 + 2 * S + 1]]).toEqual([2 * (20 + 4 + 1), 2 * (20 + 3 + 1)]);
    expect(v[q3 + 8]).toBe(3 * 4);
    expect(v[q3 + 2]).toBeCloseTo(0.1 - 1 / 256, 6);
    expect(v[q3 + 10]).toBeCloseTo(1 / 256, 6);
  });
});

describe("Normal maps", () => {
  test("bevel normals slope at the silhouette and the atlas carries them beside the colour", () => {
    const p = new Painter(6, 6);
    p.circle(3, 3, 3, "#c84");
    const n = bevelNormals(p);
    const px = (x: number, y: number) => Array.from(n.data.slice((y * 6 + x) * 4, (y * 6 + x) * 4 + 4));
    // Outside the shape nothing; inside, alpha 255 and a normal that leans outward at the edge.
    expect(px(0, 0)[3]).toBe(0);
    const centre = px(3, 3);
    expect(centre[3]).toBe(255);
    expect(centre[2]).toBeGreaterThan(200);
    const left = px(0, 3);
    expect(left[3]).toBe(255);
    expect(left[0]).toBeLessThan(128);
    const right = px(5, 3);
    expect(right[0]).toBeGreaterThan(128);
    const atlas = bakeAtlas({ font: false });
    expect(atlas.normals).not.toBeNull();
    const lit = atlas.region("lit");
    const flat = atlas.region("flat");
    const at = (r: { x: number; y: number }, dx: number, dy: number) => atlas.normals![((r.y + dy) * atlas.width + r.x + dx) * 4 + 3];
    expect(at(lit, 3, 3)).toBe(255);
    expect(at(flat, 3, 3)).toBe(0);
  });

  test("an atlas without normal maps stays null", () => {
    const atlas = bakeAtlas({ font: false, defs: [] });
    expect(atlas.normals).toBeNull();
  });
});

describe("Shadows", () => {
  test("occluder polygons and solid tiles become merged segments in the layer's space", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const map = scene.world.add(new TileMap({ data: ["....", ".##.", ".##.", "...."], legend: { ".": 0, "#": 1 }, tileSize: 16, tiles: { 0: null, 1: "tile" }, solid: [1], occlude: true }));
    map.x = 100;
    const layer = scene.world.add(new LightLayer(0x202020));
    const light = layer.add(new Light2D({ radius: 200, shadows: true }, 132, 40));
    const box = scene.world.add(new LightOccluder2D({ w: 10, h: 20 }, 300, 300));
    expect(layer.occluders.has(map)).toBe(true);
    expect(layer.occluders.has(box)).toBe(true);
    stepFrames(app);
    // The 2x2 block has four outer edges, each one merged run; the box has four edges.
    const segs = layer.segments;
    expect(segs.length).toBe(8 * 4);
    const top = [];
    for (let i = 0; i < segs.length; i += 4) if (segs[i + 1] === 16 && segs[i + 3] === 16) top.push(segs.slice(i, i + 4));
    expect(top).toEqual([[116, 16, 148, 16]]);
    const quads = light.shadowQuads(layer);
    // Every edge of the block is within the radius; the box is not.
    expect(quads.length).toBe(4);
    for (const q of quads) expect(q.length).toBe(8);
    // Extruded corners sit far beyond the radius.
    expect(Math.hypot(q0(quads)[4], q0(quads)[5])).toBeGreaterThan(200);
  });

  test("a shadowed light draws through the scratch pass; a plain one straight into the light pass", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    scene.world.add(new Sprite("dot", 50, 50));
    const layer = scene.world.add(new LightLayer(0x202020));
    layer.add(new Light2D({ radius: 100 }, 50, 50));
    const shadowed = layer.add(new Light2D({ radius: 100, shadows: true }, 60, 60));
    scene.world.add(new LightOccluder2D({ w: 10, h: 10 }, 80, 60));
    stepFrames(app);
    const ops = lastFrame(app);
    const passes = ops.filter((o) => o.op === "pass").map((o) => (o as { pass: string }).pass);
    expect(passes).toEqual(["world", "light", "scratch", "light", "world", "overlay"]);
    const lights = ops.filter((o) => o.op === "light");
    expect(lights.length).toBe(2);
    expect(lights.map((o) => (o as { pass: string }).pass)).toEqual(["light", "scratch"]);
    expect(ops.filter((o) => o.op === "quad").every((o) => (o as { erase: boolean; pass: string }).erase && (o as { pass: string }).pass === "scratch")).toBe(true);
    expect(ops.filter((o) => o.op === "quad").length).toBeGreaterThan(0);
    expect(ops.filter((o) => o.op === "blit").length).toBe(1);
    // Turning shadows off drops the scratch pass.
    shadowed.shadows = false;
    stepFrames(app);
    expect(lastFrame(app).filter((o) => o.op === "pass").map((o) => (o as { pass: string }).pass)).toEqual(["world", "light", "world", "overlay"]);
  });

  test("a sprite's material reaches the renderer with its parameters filled in", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const s = scene.world.add(new Sprite("dot", 10, 10));
    s.material = { kind: "outline" };
    s.tint = 0xff0000;
    stepFrames(app);
    const op = lastFrame(app).find((o) => o.op === "sprite") as { material: { kind: string; p0: number; p1: number } };
    expect(op.material.kind).toBe("outline");
    expect(op.material.p0).toBeGreaterThan(0);
    s.material = { kind: "dissolve", p0: 0.4 };
    stepFrames(app);
    const op2 = lastFrame(app).find((o) => o.op === "sprite") as { material: { kind: string; p0: number; p1: number } };
    expect(op2.material).toEqual({ kind: "dissolve", p0: 0.4, p1: 0.08 });
  });
});

const q0 = (quads: number[][]): number[] => quads[0];

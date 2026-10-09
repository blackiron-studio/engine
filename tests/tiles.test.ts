// Tile maps beyond drawing: blob autotiles, A* paths, merged colliders for the physics world,
// and tile sets imported with a terrain.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePNG } from "../cli/png.ts";
import { Painter, autotileMode, defineAutotile, defineSprite, defineTileSet, resetImageRegistry, resetSpriteRegistry, resolveAssets, terrainTileCount } from "../src/art/index.ts";
import { BLOB_MASKS, TileMapData, autotileMask8, blobIndex, canonicalMask8, findPath, mergeRects } from "../src/core/tilemap.ts";
import { loadWasmPhysics } from "../src/physics/wasm.ts";
import { PhysicsWorld } from "../src/physics/world.ts";
import { HeadlessPlatform } from "../src/platform/headless.ts";
import { Scene, TileMap } from "../src/scene/index.ts";
import { createTestApp } from "../src/testkit/index.ts";

const WASM = await Bun.file(new URL("../src/kernel/physics.wasm", import.meta.url)).arrayBuffer();

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("wall", { w: 8, h: 8 }, (p) => p.rect(0, 0, 8, 8, "#888"));
  defineAutotile("grass", { w: 8, h: 8 }, (p, ctx) => {
    p.rect(0, 0, 8, 8, "#4a4");
    if (!ctx.north) p.hline(0, 0, 8, "#8c8");
    if (ctx.northEast) p.px(7, 0, "#fff");
  }, { mode: "blob" });
});

describe("Blob autotiles", () => {
  test("the 47 blob masks are exactly the masks whose corners have both edges", () => {
    expect(BLOB_MASKS.length).toBe(47);
    expect(BLOB_MASKS[0]).toBe(0);
    expect(BLOB_MASKS[46]).toBe(255);
    // A lone north-east corner without its edges canonicalises away.
    expect(canonicalMask8(2)).toBe(0);
    expect(canonicalMask8(1 | 4 | 2)).toBe(7);
    expect(blobIndex(255)).toBe(46);
    expect(blobIndex(2)).toBe(0);
  });

  test("a cell's eight-bit mask counts corners only when both edges beside them match", () => {
    const data = TileMapData.fromAscii(["###", "#..", "#.."], { "#": 1, ".": 0 });
    // Top-left cell: east and south are grass, the south-east corner is open.
    expect(autotileMask8(data, 0, 0)).toBe(4 | 16 | 1 | 64 | 128 | 2 | 32);
    // Middle of the top row: west and east match; south does not, so no south corners.
    const m = autotileMask8(data, 1, 0);
    expect(m & 16).toBe(0);
    expect(m & 4).toBe(4);
    expect(m & 64).toBe(64);
  });

  test("a blob set defines 47 tiles and the map names them by index", async () => {
    expect(autotileMode("grass")).toBe("blob");
    const scene = new Scene();
    await createTestApp({ scene });
    const map = scene.world.add(new TileMap({ data: ["....", ".##.", ".##.", "...."], legend: { ".": 0, "#": 1 }, tileSize: 8, tiles: { 0: null, 1: { autotile: "grass" } } }));
    // Top-left of the block: east and south match, the south-east corner too.
    expect(map.spriteAt(1, 1)).toBe(`grass.${blobIndex(4 | 16 | 8)}`);
    expect(map.spriteAt(2, 2)).toBe(`grass.${blobIndex(1 | 64 | 128)}`);
  });
});

describe("Paths and colliders", () => {
  test("A* goes around a wall, refuses blocked goals, and cuts no corners", () => {
    const rows = ["........", "..####..", "..#.....", "..#.....", "........"];
    const data = TileMapData.fromAscii(rows, { ".": 0, "#": 1 });
    const passable = (c: number, r: number) => data.get(c, r) === 0;
    const path = findPath(8, 5, passable, { x: 0, y: 2 }, { x: 4, y: 2 });
    expect(path).not.toBeNull();
    expect(path!.at(-1)).toEqual({ x: 4, y: 2 });
    expect(path!.every((c) => passable(c.x, c.y))).toBe(true);
    // Around the wall: at least one cell in row 0 or row 4.
    expect(path!.some((c) => c.y === 0 || c.y === 4)).toBe(true);
    expect(findPath(8, 5, passable, { x: 0, y: 0 }, { x: 2, y: 1 })).toBeNull();
    expect(findPath(8, 5, passable, { x: 0, y: 0 }, { x: 0, y: 0 })).toEqual([]);
    const diag = findPath(8, 5, passable, { x: 0, y: 0 }, { x: 7, y: 4 }, { diagonal: true });
    expect(diag).not.toBeNull();
    expect(diag!.length).toBeLessThan(11);
    for (let i = 1; i < diag!.length; i++) {
      const a = diag![i - 1];
      const b = diag![i];
      if (a.x !== b.x && a.y !== b.y) expect(passable(b.x, a.y) && passable(a.x, b.y)).toBe(true);
    }
  });

  test("solid runs merge into few rectangles and become static colliders", async () => {
    const rects = mergeRects(6, 4, (c, r) => (r === 3 && c < 6) || (r === 2 && c >= 1 && c <= 4) || (r === 1 && c >= 1 && c <= 4));
    expect(rects).toEqual([
      { x: 1, y: 1, w: 4, h: 2 },
      { x: 0, y: 3, w: 6, h: 1 },
    ]);
    const scene = new Scene();
    await createTestApp({ scene });
    const map = scene.world.add(new TileMap({ data: ["......", ".####.", ".####.", "######"], legend: { ".": 0, "#": 1, "=": 2 }, tileSize: 16, tiles: { 0: null, 1: "wall", 2: "wall" }, solid: [1], oneWay: [2] }));
    map.x = 100;
    const world = new PhysicsWorld(await loadWasmPhysics(WASM, 100), [0, 980]);
    const { colliders } = map.attachPhysics(world);
    expect(colliders.length).toBe(2);
    const hit = world.raycast(100 + 3 * 16, 0, 0, 1, 1000);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeCloseTo(16, 3);
    expect(map.pathfind({ x: 0, y: 0 }, { x: 5, y: 0 })!.length).toBe(5);
    expect(map.pathPoints([{ x: 1, y: 2 }])).toEqual([[24, 40]]);
    world.destroy();
  });
});

describe("Tile sets", () => {
  test("an imported blob tileset registers its tiles and the autotile mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kiln-tiles-"));
    const n = terrainTileCount("blob");
    const cols = 8;
    const rows = Math.ceil(n / cols);
    const p = new Painter(cols * 4, rows * 4);
    for (let i = 0; i < n; i++) p.rect((i % cols) * 4, Math.floor(i / cols) * 4, 4, 4, i % 2 ? "#0f0" : "#f00");
    await writeFile(join(dir, "ground.png"), encodePNG(p.width, p.height, p.data));
    const frames = [];
    for (let i = 0; i < n; i++) frames.push({ filename: String(i), frame: { x: (i % cols) * 4, y: Math.floor(i / cols) * 4, w: 4, h: 4 }, duration: 100 });
    await writeFile(join(dir, "ground.json"), JSON.stringify({ frames, meta: { image: "ground.png", tiles: { size: 4, cols, rows, terrain: "blob" } } }));
    resetImageRegistry();
    defineTileSet("ground", "ground.json");
    const items = await resolveAssets(new HeadlessPlatform({ root: dir }));
    expect(items.length).toBe(47);
    expect(items[0].name).toBe("ground.0");
    expect(items[1].origin).toEqual([0, 0]);
    expect(autotileMode("ground")).toBe("blob");
    resetImageRegistry();
  });
});

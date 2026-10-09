// Projected layers: the compiled and reference kernels agree on projected, depth-sorted
// frames; the camera projects and unprojects; the isometric map builds floors and cliff
// faces and reports heights; sprite pools arc and land; sorting puts what is behind first.

import { beforeAll, describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { defineSprite, resetSpriteRegistry } from "../src/art/index.ts";
import { BATCH3_STRIDE, type Kernel, NODE as N, NODE_FLAG as F, NODE_FLOOR, NODE_WORDS, STAT, StreamWriter, TsKernel, loadWasmKernel } from "../src/kernel/index.ts";
import type { FakeRenderer } from "../src/render/fake.ts";
import { Camera2D, IsoTileMap, Scene, Sprite, SpritePool } from "../src/scene/index.ts";

const region = { name: "dot", x: 0, y: 0, w: 8, h: 6, u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.4, ox: 4, oy: 3 };
/** 2:1 isometric with 64x32 tiles and 32-unit cells: sx = x - y, sy = (x + y) / 2 - z, depth = x + y. */
const ISO = [1, -1, 0, 0, 0.5, 0.5, -1, 0, 1, 1, 0, 0] as const;

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("shadow", { w: 8, h: 4, origin: [0.5, 0.5] }, (p) => p.ellipse(4, 2, 4, 2, "#000"));
  defineSprite("dot", { w: 4, h: 4, origin: [0.5, 1] }, (p) => p.rect(0, 0, 4, 4, "#fff"));
  defineSprite("top", { w: 16, h: 8, origin: [0.5, 0.5] }, (p) => p.isoDiamond(8, 0, 16, 8, "#4a4"));
  defineSprite("left", { w: 8, h: 12, origin: [1, 0] }, (p) => p.rect(0, 0, 8, 12, "#363"));
  defineSprite("right", { w: 8, h: 12, origin: [0, 0] }, (p) => p.rect(0, 0, 8, 12, "#252"));
});

function projectedFrame(k: Kernel, frames: number): { batch: number; table: number } {
  k.setWhite(0.9, 0.9);
  k.setShadow(8, 4, 4, 2, 0.5, 0.5, 0.6, 0.6);
  const batch = k.createBatch3(3);
  const d = k.batch3Data(batch);
  for (let n = 0; n < 3; n++) {
    d.set([n * 32 + 16, 16, n === 1 ? 16 : 0, 16, 8, 8, 4, 0.1, 0.1, 0.2, 0.2, 0xffffff, 1, -16], n * BATCH3_STRIDE);
  }
  k.setBatch3Count(batch, 3);
  const table = k.createNodes(4);
  k.configureNodes(table, 0, 0, 0, 0, 0, 0, 0, 0, -400, NODE_FLOOR.BOUNCE);
  const nd = k.nodesData(table);
  const a = k.allocNode(table) * NODE_WORDS;
  nd[a + N.X] = 40;
  nd[a + N.Y] = 20;
  nd[a + N.Z] = 30;
  nd[a + N.VZ] = 60;
  nd[a + N.FLAGS] = F.ALIVE | F.SHADOW;
  nd.set([8, 6, 4, 3, 0.1, 0.2, 0.3, 0.4], a + N.W);
  const w = new StreamWriter(k);
  for (let f = 0; f < frames; f++) {
    k.stepNodes(table, 1 / 60);
    w.begin(0x102030, 640, 360);
    w.pass(0, 0);
    w.projection([...ISO] as never, [2, 0, 0, 2, 320, 100], true);
    w.transform3(1, 0, 0, 1, 0, 0, 0, 0, false, 0);
    w.batch3(batch, 1, 0xffffff, false, false);
    w.transform3(1, 0, 0, 1, 48, 16, 24, 0, true, 0.5);
    w.sprite({ region, x: 0, y: 0 });
    w.transform3(1, 0, 0, 1, 16, 48, 0, -1, false, 0);
    w.sprite({ region, x: 0, y: 0, rot: 0.3 });
    w.transform3(1, 0, 0, 1, 0, 0, 0, 0, false, 0);
    w.nodes(table, 1, 0xffffff, false, false);
    w.projectionEnd();
    w.pass(2, 0);
    w.transform([1, 0, 0, 1, 0, 0]);
    w.rect(0, 0, 10, 10, 0xff0000, 1, false);
    w.end();
    k.run(w.length);
  }
  return { batch, table };
}

describe("projected kernel passes", () => {
  test("the compiled and reference kernels agree on a projected, depth-sorted frame", async () => {
    const wasm = (await loadWasmKernel({ maxQuads: 256, streamWords: 4096 })) as Kernel;
    const ts = new TsKernel({ maxQuads: 256, streamWords: 4096 });
    const a = projectedFrame(ts, 3);
    const b = projectedFrame(wasm, 3);
    const sa = Array.from(ts.stats);
    expect(Array.from(wasm.stats)).toEqual(sa);
    // 3 tiles + 2 sprites + node + 2 shadows (transform3 shadow and node shadow) + 1 rect.
    expect(sa[STAT.SPRITES]).toBe(9);
    const n = sa[STAT.VERTICES] * 10;
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(ts.vertices[i] - wasm.vertices[i]));
    expect(maxDiff).toBeLessThan(1e-3);
    const da = ts.nodesData(a.table);
    const db = wasm.nodesData(b.table);
    expect(db[N.Z]).toBeCloseTo(da[N.Z], 4);
    expect(db[N.VZ]).toBeCloseTo(da[N.VZ], 4);
    wasm.destroy();
  });

  test("quads come out ordered by depth, ties by stream order, and flat passes are untouched", () => {
    const k = new TsKernel({ maxQuads: 64, streamWords: 2048 });
    k.setWhite(0.9, 0.9);
    const w = new StreamWriter(k);
    w.begin(0, 640, 360);
    w.projection([...ISO] as never, [1, 0, 0, 1, 100, 100], true);
    // Drawn near-first, far-second, equal-third: the sort must reverse the first two.
    w.transform3(1, 0, 0, 1, 60, 60, 0, 0, false, 0);
    w.sprite({ region, x: 0, y: 0, tint: 0xff0000 });
    w.transform3(1, 0, 0, 1, 10, 10, 0, 0, false, 0);
    w.sprite({ region, x: 0, y: 0, tint: 0x00ff00 });
    w.transform3(1, 0, 0, 1, 60, 60, 0, 0, false, 0);
    w.sprite({ region, x: 0, y: 0, tint: 0x0000ff });
    w.projectionEnd();
    w.end();
    k.run(w.length);
    const colour = (q: number) => [k.vertices[q * 48 + 4], k.vertices[q * 48 + 5], k.vertices[q * 48 + 6]];
    expect(colour(0)).toEqual([0, 1, 0]);
    expect(colour(1)).toEqual([1, 0, 0]);
    expect(colour(2)).toEqual([0, 0, 1]);
    // The green sprite at ground (10, 10): sx = 0, sy = 10, plus the camera.
    expect(k.vertices[0]).toBeCloseTo(100 - 4, 4);
    expect(k.vertices[1]).toBeCloseTo(110 - 3, 4);
    // Height lifts a sprite straight up on screen.
    w.begin(0, 640, 360);
    w.projection([...ISO] as never, [1, 0, 0, 1, 100, 100], false);
    w.transform3(1, 0, 0, 1, 10, 10, 25, 0, false, 0);
    w.sprite({ region, x: 0, y: 0 });
    w.projectionEnd();
    w.end();
    k.run(w.length);
    expect(k.vertices[1]).toBeCloseTo(110 - 25 - 3, 4);
  });

  test("node tables arc under z gravity and bounce on the floor", () => {
    const k = new TsKernel({ maxQuads: 64, streamWords: 1024 });
    const id = k.createNodes(2);
    k.configureNodes(id, 0, 0, 0, 0, 0, 0, 0, 0, -100, NODE_FLOOR.BOUNCE);
    const d = k.nodesData(id);
    const n = k.allocNode(id) * NODE_WORDS;
    d[n + N.VZ] = 50;
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      k.stepNodes(id, 1 / 60);
      peak = Math.max(peak, d[n + N.Z]);
    }
    expect(peak).toBeGreaterThan(10);
    expect(d[n + N.Z]).toBeGreaterThanOrEqual(0);
    k.configureNodes(id, 0, 0, 0, 0, 0, 0, 0, 0, -100, NODE_FLOOR.STOP);
    d[n + N.Z] = 5;
    d[n + N.VZ] = -80;
    k.stepNodes(id, 0.5);
    expect(d[n + N.Z]).toBe(0);
    expect(d[n + N.VZ]).toBe(0);
  });
});

describe("Camera2D projections", () => {
  test("isometric projection and its inverse round-trip, with height", () => {
    const cam = new Camera2D(640, 360);
    cam.projection = { kind: "isometric", tile: { w: 64, h: 32 } };
    cam.x = 320;
    cam.y = 320;
    const m = cam.projectionMatrix() as number[];
    expect(m.slice(0, 2)).toEqual([1, -1]);
    const [sx, sy] = cam.worldToScreen(320, 320, 0);
    expect(sx).toBeCloseTo(320, 4);
    expect(sy).toBeCloseTo(180, 4);
    const [wx, wy] = cam.screenToWorld(400, 200, 0);
    const back = cam.worldToScreen(wx, wy, 0);
    expect(back[0]).toBeCloseTo(400, 4);
    expect(back[1]).toBeCloseTo(200, 4);
    // A point 40 units up projects 40 pixels higher, and unprojecting at that height finds it.
    const up = cam.worldToScreen(320, 320, 40);
    expect(up[1]).toBeCloseTo(140, 4);
    const [hx, hy] = cam.screenToWorld(up[0], up[1], 40);
    expect(hx).toBeCloseTo(320, 3);
    expect(hy).toBeCloseTo(320, 3);
    const rect = cam.visibleRect();
    expect(rect.w).toBeGreaterThan(640);
  });

  test("tilt and top-down projections lift height on screen", () => {
    const cam = new Camera2D(640, 360);
    cam.projection = { kind: "tilt", angle: Math.PI / 4 };
    cam.x = 0;
    cam.y = 0;
    const flat = cam.worldToScreen(0, 100, 0);
    const high = cam.worldToScreen(0, 100, 50);
    expect(flat[1] - high[1]).toBeCloseTo(50 * Math.sin(Math.PI / 4), 4);
    cam.projection = { kind: "topDown" };
    expect(cam.worldToScreen(10, 10, 5)[1]).toBeCloseTo(cam.worldToScreen(10, 10, 0)[1] - 5, 4);
  });
});

describe("IsoTileMap and pools in a projected scene", () => {
  async function appWith(scene: Scene): Promise<App> {
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 640, height: 360 }, fps: false } });
    app.scenes.change(scene);
    return app;
  }

  test("floors, cliff faces, heights and fog tints", async () => {
    const scene = new Scene();
    scene.camera.projection = { kind: "isometric", tile: { w: 16, h: 8 } };
    const map = scene.world.add(new IsoTileMap({ data: [[1, 1, 1], [1, 1, 1], [1, 1, 1]], elevation: [[0, 0, 0], [0, 2, 0], [0, 0, 1]], tile: { w: 16, h: 8, rise: 8 }, tiles: { 1: "top" }, faces: { left: "left", right: "right" } }));
    const app = await appWith(scene);
    scene.camera.x = 12;
    scene.camera.y = 12;
    app.frame(1 / 60);
    // 9 floors; the centre cell at level 2 has two faces of two levels each; the corner cell at
    // level 1 faces the outside on both sides.
    expect(map.instanceCount).toBe(9 + 4 + 2);
    expect(map.heightAt(12, 12)).toBe(16);
    expect(map.heightAt(4, 4)).toBe(0);
    expect(map.elevationAt(2, 2)).toBe(1);
    expect(map.cellAt(12, 12)).toEqual({ col: 1, row: 1 });
    expect(map.cellCenter(1, 1)).toEqual([12, 12]);
    const drawn = (app.renderer as FakeRenderer).ops.filter((o) => o.op === "sprite").length;
    expect(drawn).toBe(15);
    map.setTint(0, 0, 0x404040, 0.5);
    expect(map.tintAt(0, 0)).toBe(0x404040);
    app.frame(1 / 60);
    const first = (app.renderer as FakeRenderer).ops.find((o) => o.op === "sprite");
    expect(first && first.op === "sprite" ? first.tint : 0).toBe(0x404040);
    map.setElevation(0, 0, 3);
    app.frame(1 / 60);
    expect(map.instanceCount).toBe(9 + 4 + 2 + 6);
  });

  test("nodes with height and shadows draw projected, and pools arc in the kernel", async () => {
    const scene = new Scene();
    scene.camera.projection = { kind: "isometric", tile: { w: 64, h: 32 } };
    scene.camera.x = 0;
    scene.camera.y = 0;
    const hero = scene.world.add(new Sprite("dot", 0, 0));
    hero.z = 20;
    hero.castShadow = true;
    const pool = scene.world.add(new SpritePool({ capacity: 4, sprite: "dot", gravityZ: -300, floor: "stop", shadow: true }));
    const app = await appWith(scene);
    const h = pool.spawn({ x: 0, y: 0, z: 0, vz: 90 });
    app.frame(1 / 60);
    const ops = (app.renderer as FakeRenderer).ops.filter((o) => o.op === "sprite");
    // The hero, its shadow, the pool node and its shadow.
    expect(ops.length).toBe(4);
    const heroOp = ops.find((o) => o.op === "sprite" && o.name === "dot" && o.transform[5] < 180) as { transform: number[] } | undefined;
    expect(heroOp).toBeDefined();
    // Screen centre is (320, 180); a node 20 up sits 20 higher.
    expect(heroOp?.transform[5]).toBeCloseTo(160, 4);
    for (let i = 0; i < 12; i++) app.frame(1 / 60);
    expect(pool.get(h).z).toBeGreaterThan(5);
    for (let i = 0; i < 120; i++) app.frame(1 / 60);
    expect(pool.get(h).z).toBe(0);
    expect(hero.worldZ).toBe(20);
  });
});

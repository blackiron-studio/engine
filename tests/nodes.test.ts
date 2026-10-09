// Node tables: the compiled kernel and the reference kernel agree, the table moves, bounds,
// animates and expires nodes, and SpritePool drives it from a scene.

import { beforeAll, describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { defineSprite, resetSpriteRegistry } from "../src/art/index.ts";
import { type Kernel, NODE as N, NODE_BOUNDS, NODE_FLAG as F, NODE_WORDS, STAT, StreamWriter, TsKernel, loadWasmKernel } from "../src/kernel/index.ts";
import type { FakeRenderer } from "../src/render/fake.ts";
import { Scene, SpritePool } from "../src/scene/index.ts";

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("dot", { w: 4, h: 4, origin: [0.5, 0.5] }, (p) => p.rect(0, 0, 4, 4, "#fff"));
  defineSprite("dot2", { w: 6, h: 6 }, (p) => p.rect(0, 0, 6, 6, "#f80"));
});

/** A table with one of everything: a plain node, an animated one, an expiring one, churn. */
function setupTable(k: Kernel): number {
  k.setWhite(0.9, 0.9);
  const id = k.createNodes(8);
  k.configureNodes(id, 0, 50, 0.1, NODE_BOUNDS.BOUNCE, 0, 0, 200, 100);
  const s = k.scratch;
  s.set([8, 6, 4, 3, 0.1, 0.2, 0.3, 0.4], 0);
  s.set([8, 6, 4, 3, 0.5, 0.2, 0.7, 0.4], 8);
  k.setNodeFrames(id, 16);
  const d = k.nodesData(id);
  const a = k.allocNode(id);
  let o = a * NODE_WORDS;
  d[o + N.X] = 10;
  d[o + N.Y] = 20;
  d[o + N.VX] = 30;
  d[o + N.VY] = -10;
  d[o + N.ROT] = 0.7;
  d[o + N.SX] = 1.5;
  d.set([8, 6, 4, 3, 0.1, 0.2, 0.3, 0.4], o + N.W);
  d[o + N.TINT] = 0xff8000;
  d[o + N.ALPHA] = 0.5;
  d[o + N.FLAGS] = F.ALIVE | F.FLIP_X | F.ADDITIVE;
  const b = k.allocNode(id);
  o = b * NODE_WORDS;
  d[o + N.X] = 100;
  d[o + N.Y] = 50;
  d[o + N.VROT] = 2;
  d[o + N.FRAME_BASE] = 0;
  d[o + N.FRAME_COUNT] = 2;
  d[o + N.FPS] = 10;
  const c = k.allocNode(id);
  o = c * NODE_WORDS;
  d[o + N.X] = 150;
  d[o + N.Y] = 80;
  d[o + N.LIFE] = 0.05;
  d[o + N.FLAGS] = F.ALIVE | F.EXPIRES;
  d.set([4, 4, 2, 2, 0, 0, 0.1, 0.1], o + N.W);
  k.freeNode(id, k.allocNode(id));
  return id;
}

function drawFrames(k: Kernel, id: number, frames: number): void {
  const w = new StreamWriter(k);
  for (let f = 0; f < frames; f++) {
    k.stepNodes(id, 1 / 60);
    w.begin(0x102030, 640, 360);
    w.transform([2, 0, 0, 2, 10, 20]);
    w.nodes(id, 0.8, 0xffffff, false, false);
    w.nodes(id, 1, 0x80ff80, true, true);
    w.end();
    k.run(w.length);
  }
}

describe("node tables", () => {
  test("the compiled kernel and the reference kernel draw the same nodes", async () => {
    const wasm = (await loadWasmKernel({ maxQuads: 256, streamWords: 2048 })) as Kernel;
    expect(wasm).not.toBeNull();
    const ts = new TsKernel({ maxQuads: 256, streamWords: 2048 });
    const a = setupTable(ts);
    const b = setupTable(wasm);
    drawFrames(ts, a, 5);
    drawFrames(wasm, b, 5);
    const sa = Array.from(ts.stats);
    expect(Array.from(wasm.stats)).toEqual(sa);
    // Three nodes alive at first; the expiring one is gone after 0.05 s, so 2 nodes x 2 draws.
    expect(sa[STAT.SPRITES]).toBe(4);
    expect(ts.nodeCount(a)).toBe(2);
    expect(wasm.nodeCount(b)).toBe(2);
    const n = sa[STAT.VERTICES] * 10;
    const va = ts.vertices.subarray(0, n);
    const vb = wasm.vertices.subarray(0, n);
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(va[i] - vb[i]));
    expect(maxDiff).toBeLessThan(1e-3);
    const da = ts.nodesData(a);
    const db = wasm.nodesData(b);
    for (const w of [N.X, N.Y, N.VX, N.VY, N.ROT, N.FRAME]) {
      expect(db[w]).toBeCloseTo(da[w], 4);
      expect(db[NODE_WORDS + w]).toBeCloseTo(da[NODE_WORDS + w], 4);
    }
    // Both hosts agree on the free list: the next allocation reuses the expired slot.
    expect(ts.allocNode(a)).toBe(wasm.allocNode(b));
    wasm.destroy();
  });

  test("alloc, free, count and high water mark", () => {
    const k = new TsKernel({ maxQuads: 64, streamWords: 1024 });
    const id = k.createNodes(3);
    const a = k.allocNode(id);
    const b = k.allocNode(id);
    const c = k.allocNode(id);
    expect([a, b, c]).toEqual([0, 1, 2]);
    expect(k.allocNode(id)).toBe(-1);
    expect(k.nodeCount(id)).toBe(3);
    k.freeNode(id, b);
    k.freeNode(id, b);
    expect(k.nodeCount(id)).toBe(2);
    expect(k.allocNode(id)).toBe(1);
    expect(k.nodesHigh(id)).toBe(3);
    const d = k.nodesData(id);
    // A fresh slot has unit scale, white tint, full alpha and no body.
    expect(d[1 * NODE_WORDS + N.SX]).toBe(1);
    expect(d[1 * NODE_WORDS + N.TINT]).toBe(0xffffff);
    expect(d[1 * NODE_WORDS + N.ALPHA]).toBe(1);
    expect(d[1 * NODE_WORDS + N.BODY]).toBe(-1);
    k.clearNodes(id);
    expect(k.nodeCount(id)).toBe(0);
    expect(k.nodesHigh(id)).toBe(0);
    k.destroyNodes(id);
    expect(k.allocNode(id)).toBe(-1);
  });

  test("bounds: bounce, wrap and kill", () => {
    const k = new TsKernel({ maxQuads: 64, streamWords: 1024 });
    const id = k.createNodes(4);
    const d = k.nodesData(id);
    const n = k.allocNode(id);
    d[n * NODE_WORDS + N.X] = 99;
    d[n * NODE_WORDS + N.VX] = 120;
    k.configureNodes(id, 0, 0, 0, NODE_BOUNDS.BOUNCE, 0, 0, 100, 100);
    k.stepNodes(id, 0.1);
    expect(d[n * NODE_WORDS + N.X]).toBe(100);
    expect(d[n * NODE_WORDS + N.VX]).toBe(-120);
    k.configureNodes(id, 0, 0, 0, NODE_BOUNDS.WRAP, 0, 0, 100, 100);
    d[n * NODE_WORDS + N.X] = 5;
    k.stepNodes(id, 0.1);
    expect(d[n * NODE_WORDS + N.X]).toBeCloseTo(93, 4);
    k.configureNodes(id, 0, 0, 0, NODE_BOUNDS.KILL, 0, 0, 100, 100);
    d[n * NODE_WORDS + N.X] = 2;
    k.stepNodes(id, 0.1);
    expect(k.nodeCount(id)).toBe(0);
  });

  test("gravity, damping, spin, expiry and frame animation", () => {
    const k = new TsKernel({ maxQuads: 64, streamWords: 1024 });
    const id = k.createNodes(4);
    k.configureNodes(id, 0, 100, 0.5, NODE_BOUNDS.NONE, 0, 0, 0, 0);
    const d = k.nodesData(id);
    const n = k.allocNode(id);
    const o = n * NODE_WORDS;
    d[o + N.VX] = 10;
    d[o + N.VROT] = 1;
    d[o + N.FRAME_COUNT] = 4;
    d[o + N.FPS] = 30;
    k.stepNodes(id, 0.1);
    // vy: 0 + 100*0.1 = 10, damped by (1 - 0.05) = 9.5; vx: 10 * 0.95.
    expect(d[o + N.VY]).toBeCloseTo(9.5, 4);
    expect(d[o + N.VX]).toBeCloseTo(9.5, 4);
    expect(d[o + N.Y]).toBeCloseTo(0.95, 4);
    expect(d[o + N.ROT]).toBeCloseTo(0.1, 4);
    expect(d[o + N.FRAME]).toBeCloseTo(3, 4);
    k.stepNodes(id, 0.1);
    expect(d[o + N.FRAME]).toBeCloseTo(2, 4);
    const e = k.allocNode(id);
    d[e * NODE_WORDS + N.LIFE] = 0.15;
    d[e * NODE_WORDS + N.FLAGS] = F.ALIVE | F.EXPIRES;
    k.stepNodes(id, 0.1);
    expect(k.nodeCount(id)).toBe(2);
    k.stepNodes(id, 0.1);
    expect(k.nodeCount(id)).toBe(1);
  });

  test("physics transforms move the nodes bound to bodies", () => {
    const k = new TsKernel({ maxQuads: 64, streamWords: 1024 });
    const id = k.createNodes(4);
    const d = k.nodesData(id);
    const a = k.allocNode(id);
    const b = k.allocNode(id);
    d[a * NODE_WORDS + N.BODY] = 7;
    d[b * NODE_WORDS + N.BODY] = 2;
    const free = k.allocNode(id);
    k.scratch.set([2, 11, 22, 0.5, 1, 2, 3, 0, 7, 44, 55, -0.25, 0, 0, 0, 1], 0);
    expect(k.applyNodeTransforms(id, 16)).toBe(2);
    expect(d[a * NODE_WORDS + N.X]).toBe(44);
    expect(d[a * NODE_WORDS + N.Y]).toBe(55);
    expect(d[a * NODE_WORDS + N.ROT]).toBe(-0.25);
    expect(d[b * NODE_WORDS + N.X]).toBe(11);
    expect(d[b * NODE_WORDS + N.VY]).toBe(2);
    expect(d[free * NODE_WORDS + N.X]).toBe(0);
  });
});

describe("SpritePool", () => {
  async function appWith(scene: Scene): Promise<App> {
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 640, height: 360 }, fps: false } });
    app.scenes.change(scene);
    return app;
  }

  function sprites(app: App): number {
    return (app.renderer as FakeRenderer).ops.filter((o) => o.op === "sprite").length;
  }

  test("spawns draw, move under gravity, expire and can be read back", async () => {
    const scene = new Scene();
    // In the UI layer, so screen space is node space and nothing is culled by the camera.
    const pool = scene.ui.add(new SpritePool({ capacity: 100, sprite: "dot", gravity: [0, 600], bounds: { x: 0, y: 0, w: 640, h: 360 }, boundsMode: "bounce" }));
    // Spawns before the scene starts are queued and land once it does.
    const early = pool.spawn({ x: 50, y: 50 });
    expect(early).toBe(-1);
    const app = await appWith(scene);
    expect(pool.count).toBe(1);
    const handles: number[] = [];
    for (let i = 0; i < 49; i++) handles.push(pool.spawn({ x: 100 + i * 10, y: 100, vx: 20, tint: 0xff0000 }));
    expect(handles[0]).toBe(1);
    const short = pool.spawn({ x: 300, y: 200, life: 0.05 });
    app.frame(1 / 60);
    expect(sprites(app)).toBe(51);
    expect(pool.count).toBe(51);
    const y0 = pool.get(handles[0]).y;
    for (let i = 0; i < 10; i++) app.frame(1 / 60);
    const s = pool.get(handles[0]);
    expect(s.alive).toBe(true);
    expect(s.y).toBeGreaterThan(y0 + 1);
    expect(s.x).toBeGreaterThan(100);
    expect(s.tint).toBe(0xff0000);
    expect(pool.alive(short)).toBe(false);
    expect(pool.count).toBe(50);
    expect(sprites(app)).toBe(50);
    pool.set(handles[1], { hidden: true, vx: 0 });
    app.frame(1 / 60);
    expect(sprites(app)).toBe(49);
    pool.free(handles[2]);
    expect(pool.count).toBe(49);
    pool.freeAll();
    expect(pool.count).toBe(0);
  });

  test("animations play through the frame list and the pool tints as a whole", async () => {
    const scene = new Scene();
    const pool = scene.ui.add(new SpritePool({ capacity: 4, animations: { blink: ["dot", "dot2"] } }));
    const app = await appWith(scene);
    const h = pool.spawn({ x: 10, y: 10, animation: "blink", fps: 30 });
    pool.tint = 0x808080;
    app.frame(1 / 60);
    const first = (app.renderer as FakeRenderer).ops.find((o) => o.op === "sprite");
    expect(first && first.op === "sprite" ? first.tint : 0).toBe(0x808080);
    expect(pool.get(h).frame).toBeCloseTo(0.5, 4);
    app.frame(1 / 60);
    // Past frame 1 the second sprite (6x6, "dot2") is drawn.
    const second = (app.renderer as FakeRenderer).ops.find((o) => o.op === "sprite");
    expect(second && second.op === "sprite" ? second.name : "").toBe("dot2");
  });
});

describe("SpritePool with physics", () => {
  test("nodes bound to bodies follow them after every step", async () => {
    const wasm = await Bun.file(new URL("../src/kernel/physics.wasm", import.meta.url)).arrayBuffer();
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 640, height: 360 }, fps: false } });
    const world = await app.enablePhysics({ wasm, gravity: [0, 980] });
    const scene = new Scene();
    const pool = scene.world.add(new SpritePool({ capacity: 8, sprite: "dot" }));
    app.scenes.change(scene);
    pool.attachPhysics(world);
    const body = world.createBody({ kind: "dynamic", x: 100, y: 0 });
    world.createCollider(body, { shape: { circle: 4 } });
    const h = pool.spawn({ x: 0, y: 0, body });
    const loose = pool.spawn({ x: 5, y: 5 });
    for (let i = 0; i < 30; i++) app.frame(1 / 60);
    const s = pool.get(h);
    expect(s.x).toBeCloseTo(100, 3);
    expect(s.y).toBeGreaterThan(50);
    expect(s.vy).toBeGreaterThan(0);
    expect(pool.get(loose).y).toBe(5);
    world.setPosition(body, 200, 10);
    app.frame(1 / 60);
    expect(pool.get(h).x).toBeCloseTo(200, 3);
  });
});

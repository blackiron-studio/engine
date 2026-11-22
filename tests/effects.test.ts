// Shot effects: screen directions from the camera, pool nodes that turn along their velocity
// and stretch with speed (the same in the compiled and reference kernels), beams, trails,
// pooled lights, decals laid on the ground and on wall faces, and iso surfaces under a hit.

import { beforeAll, describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { defineSprite, resetSpriteRegistry } from "../src/art/index.ts";
import { type Kernel, NODE as N, NODE_FLAG as F, NODE_WORDS, StreamWriter, TsKernel, loadWasmKernel } from "../src/kernel/index.ts";
import { FLOATS_PER_VERT } from "../src/kernel/protocol.ts";
import type { FakeOp, FakeRenderer } from "../src/render/fake.ts";
import { Beams, Camera2D, Decals, IsoTileMap, LightLayer, LightPool, Scene, SpritePool, Trails } from "../src/scene/index.ts";

/** 2:1 isometric with 64x32 tiles and 32-unit cells: sx = x - y, sy = (x + y) / 2 - z, depth = x + y. */
const ISO = [1, -1, 0, 0, 0.5, 0.5, -1, 0, 1, 1, 0, 0] as const;

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("dot", { w: 4, h: 4, origin: [0.5, 0.5] }, (p) => p.rect(0, 0, 4, 4, "#fff"));
  defineSprite("hole", { w: 8, h: 8, origin: [0.5, 0.5] }, (p) => p.circle(4, 4, 3, "#000"));
  defineSprite("top", { w: 64, h: 32, origin: [0.5, 0.5] }, (p) => p.isoDiamond(32, 0, 64, 32, "#4a4"));
});

async function appWith(scene: Scene): Promise<App> {
  const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 640, height: 360 }, fps: false } });
  app.scenes.change(scene);
  return app;
}

function isoScene(): Scene {
  const scene = new Scene();
  scene.camera.projection = { kind: "isometric", tile: { w: 64, h: 32 } };
  scene.camera.x = 0;
  scene.camera.y = 0;
  return scene;
}

const ops = (app: App): FakeOp[] => (app.renderer as FakeRenderer).ops;
const sprites = (app: App, name: string) => ops(app).filter((o): o is Extract<FakeOp, { op: "sprite" }> => o.op === "sprite" && o.name === name);

describe("camera directions", () => {
  test("iso directions follow the projection and zoom; flat ones are as given", () => {
    const cam = new Camera2D(640, 360);
    cam.projection = { kind: "isometric", tile: { w: 64, h: 32 } };
    cam.zoom = 2;
    expect(cam.screenVector(1, 0)).toEqual([2, 1]);
    expect(cam.screenAngle(1, 0)).toBeCloseTo(Math.atan2(1, 2), 9);
    expect(cam.screenAngle(1, 1)).toBeCloseTo(Math.PI / 2, 9);
    expect(cam.screenAngle(0, 0, 1)).toBeCloseTo(-Math.PI / 2, 9);
    expect(cam.screenLength(0, 0, 3)).toBeCloseTo(6, 9);
    expect(cam.screenLength(1, -1)).toBeCloseTo(4, 9);
    // The same as the difference of two projected points.
    const [ax, ay] = cam.worldToScreen(10, 20, 5);
    const [bx, by] = cam.worldToScreen(13, 18, 9);
    const [vx, vy] = cam.screenVector(3, -2, 4);
    expect(vx).toBeCloseTo(bx - ax, 6);
    expect(vy).toBeCloseTo(by - ay, 6);
    const flat = new Camera2D(640, 360);
    expect(flat.screenAngle(0, 1, 50)).toBeCloseTo(Math.PI / 2, 9);
    expect(flat.screenLength(3, 4)).toBe(5);
  });
});

/** One node per row of `nodes` (vx, vy, vz, flags, stretch), drawn once; returns each quad's x-edge on screen. */
function alignedFrame(k: Kernel, nodes: [number, number, number, number, number][], projected: boolean): [number, number][] {
  k.setWhite(0.9, 0.9);
  const table = k.createNodes(nodes.length);
  const d = k.nodesData(table);
  for (const [vx, vy, vz, flags, stretch] of nodes) {
    const a = k.allocNode(table) * NODE_WORDS;
    d[a + N.X] = 40;
    d[a + N.Y] = 20;
    d[a + N.VX] = vx;
    d[a + N.VY] = vy;
    d[a + N.VZ] = vz;
    d[a + N.FLAGS] = F.ALIVE | flags;
    d[a + N.STRETCH] = stretch;
    d.set([8, 2, 4, 1, 0.1, 0.2, 0.3, 0.4], a + N.W);
  }
  const w = new StreamWriter(k);
  w.begin(0, 640, 360);
  w.pass(0, 0);
  if (projected) {
    w.projection([...ISO] as never, [1, 0, 0, 1, 320, 100], false);
    w.transform3(1, 0, 0, 1, 0, 0, 0, 0, false, 0);
  } else w.transform([1, 0, 0, 1, 0, 0]);
  w.nodes(table, 1, 0xffffff, false, false);
  if (projected) w.projectionEnd();
  w.end();
  k.run(w.length);
  const out: [number, number][] = [];
  for (let q = 0; q < nodes.length; q++) {
    const v = q * 4 * FLOATS_PER_VERT;
    out.push([k.vertices[v + FLOATS_PER_VERT] - k.vertices[v], k.vertices[v + FLOATS_PER_VERT + 1] - k.vertices[v + 1]]);
  }
  return out;
}

describe("aligned and stretched pool nodes", () => {
  const rows: [number, number, number, number, number][] = [
    [100, 0, 0, F.ALIGN, 0], // along +x: on an iso screen, right and down
    [0, 0, 80, F.ALIGN, 0], // straight up
    [100, 0, 0, F.ALIGN, 0.01], // and stretched by 1 + speed on screen * 0.01
    [100, 0, 0, 0, 0], // not aligned: unchanged
    [0, 0, 0, F.ALIGN, 0.5], // at rest: no turn, no stretch
  ];

  test("both kernels turn nodes along their projected velocity and stretch them with speed", async () => {
    const wasm = (await loadWasmKernel({ maxQuads: 64, streamWords: 2048 })) as Kernel;
    const ts = new TsKernel({ maxQuads: 64, streamWords: 2048 });
    const a = alignedFrame(ts, rows, true);
    const b = alignedFrame(wasm, rows, true);
    for (let i = 0; i < rows.length; i++) {
      expect(b[i][0]).toBeCloseTo(a[i][0], 3);
      expect(b[i][1]).toBeCloseTo(a[i][1], 3);
    }
    const angle = ([x, y]: [number, number]) => Math.atan2(y, x);
    const length = ([x, y]: [number, number]) => Math.hypot(x, y);
    expect(angle(a[0])).toBeCloseTo(Math.atan2(50, 100), 4);
    expect(length(a[0])).toBeCloseTo(8, 4);
    expect(angle(a[1])).toBeCloseTo(-Math.PI / 2, 4);
    expect(angle(a[2])).toBeCloseTo(Math.atan2(50, 100), 4);
    expect(length(a[2])).toBeCloseTo(8 * (1 + Math.hypot(100, 50) * 0.01), 3);
    expect(angle(a[3])).toBeCloseTo(0, 6);
    expect(angle(a[4])).toBeCloseTo(0, 6);
    expect(length(a[4])).toBeCloseTo(8, 4);
    wasm.destroy();
  });

  test("flat layers use the velocity as it is", () => {
    const [q] = alignedFrame(new TsKernel({ maxQuads: 8, streamWords: 512 }), [[0, 30, 999, F.ALIGN, 0]], false);
    expect(Math.atan2(q[1], q[0])).toBeCloseTo(Math.PI / 2, 5);
  });

  test("pools pass align and stretch through, from spawns or the pool's defaults", async () => {
    const scene = isoScene();
    const pool = scene.world.add(new SpritePool({ capacity: 4, sprite: "dot", align: "velocity", stretch: 0.02 }));
    const app = await appWith(scene);
    const a = pool.spawn({ vx: 10 });
    const b = pool.spawn({ vx: 10, align: "none", stretch: 0 });
    app.frame(1 / 60);
    pool.sync();
    const d = pool.records;
    expect(d[a * NODE_WORDS + N.FLAGS] & F.ALIGN).toBe(F.ALIGN);
    expect(d[a * NODE_WORDS + N.STRETCH]).toBeCloseTo(0.02, 6);
    expect(d[b * NODE_WORDS + N.FLAGS] & F.ALIGN).toBe(0);
    expect(d[b * NODE_WORDS + N.STRETCH]).toBe(0);
    app.destroy();
  });
});

describe("beams", () => {
  test("a beam draws glow and core strips along its projected direction, segment by segment, then fades", async () => {
    const scene = isoScene();
    const beams = scene.world.add(new Beams({ segment: 24 }));
    const app = await appWith(scene);
    beams.spawn(0, 0, 10, 96, 0, 10, { life: 0.1, color: 0xff8800 });
    app.frame(1 / 60);
    const strips = sprites(app, "__strip.soft");
    expect(strips.length).toBe(8);
    for (const s of strips) expect(s.rot).toBeCloseTo(Math.atan2(0.5, 1), 6);
    const cores = strips.filter((s) => s.tint === 0xff8800 && s.alpha > 0.5);
    expect(cores.length).toBe(4);
    // Segment centres march along the beam: right and down the screen.
    for (let i = 1; i < cores.length; i++) expect(cores[i].transform[4]).toBeGreaterThan(cores[i - 1].transform[4]);
    for (let i = 0; i < 8; i++) app.frame(1 / 60);
    expect(beams.count).toBe(0);
    expect(sprites(app, "__strip.soft").length).toBe(0);
    app.destroy();
  });

  test("a travelling section leaves A, reaches B and is gone; handles move and free", async () => {
    const scene = isoScene();
    const beams = scene.world.add(new Beams({ segment: 8 }));
    const app = await appWith(scene);
    beams.spawn(0, 0, 0, 120, 0, 0, { speed: 1200, head: 30, glow: null });
    app.frame(1 / 60);
    // 20 units travelled: one section from 0 to 20.
    expect(sprites(app, "__strip.soft").length).toBe(3);
    for (let i = 0; i < 9; i++) app.frame(1 / 60);
    expect(beams.count).toBe(0);
    const h = beams.spawn(0, 0, 0, 10, 0, 0, { life: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 30; i++) app.frame(1 / 60);
    expect(beams.alive(h)).toBe(true);
    beams.move(h, 0, 0, 0, 0, 40, 0);
    app.frame(1 / 60);
    expect(sprites(app, "__strip.soft")[0].rot).toBeCloseTo(Math.atan2(0.5, -1), 6);
    beams.free(h);
    expect(beams.alive(h)).toBe(false);
    app.destroy();
  });
});

describe("trails", () => {
  test("a pushed key leaves a tapering ribbon that retracts once the pushes stop", async () => {
    const scene = isoScene();
    const trails = scene.world.add(new Trails({ time: 0.2, minStep: 2 }));
    const app = await appWith(scene);
    for (let i = 0; i < 8; i++) {
      trails.push(7, i * 6, 0, 4, { color: 0x66ccff });
      app.frame(1 / 60);
    }
    const meshes = ops(app).filter((o): o is Extract<FakeOp, { op: "mesh" }> => o.op === "mesh");
    expect(meshes.length).toBe(7);
    for (const m of meshes) expect(m.count).toBe(6);
    // Brightest at the head (drawn last), dimmer toward the tail.
    expect(meshes[meshes.length - 1].alpha).toBeGreaterThan(meshes[0].alpha);
    expect(trails.count).toBe(1);
    for (let i = 0; i < 15; i++) app.frame(1 / 60);
    expect(trails.count).toBe(0);
    expect(ops(app).some((o) => o.op === "mesh")).toBe(false);
    app.destroy();
  });

  test("a length cap shortens a long trail; a new key past capacity replaces the stalest", async () => {
    const scene = isoScene();
    const trails = scene.world.add(new Trails({ capacity: 2, time: 10, length: 20, minStep: 1 }));
    const app = await appWith(scene);
    for (let i = 0; i < 10; i++) trails.push("a", i * 5, 0, 0);
    app.frame(1 / 60);
    // 45 units of history, 20 drawn: four segments of 5.
    expect(ops(app).filter((o) => o.op === "mesh").length).toBe(4);
    trails.push("b", 0, 0, 0);
    app.frame(1 / 60);
    trails.push("c", 0, 0, 0);
    expect(trails.has("a")).toBe(false);
    expect(trails.has("b") && trails.has("c")).toBe(true);
    app.destroy();
  });
});

describe("light pool", () => {
  test("flashes light the light pass and die; past capacity the dimmest gives way", async () => {
    const scene = isoScene();
    const layer = scene.world.add(new LightLayer(0x101010));
    const pool = layer.add(new LightPool({ capacity: 2 }));
    const app = await appWith(scene);
    expect(pool.flash(10, 10, 4, { intensity: 1, radius: 80, life: 0.1 })).toBe(true);
    expect(pool.flash(0, 0, 0, { intensity: 0.2, radius: 80, life: 0.1 })).toBe(true);
    expect(pool.flash(5, 5, 0, { intensity: 2, radius: 80, life: 0.1 })).toBe(true);
    expect(pool.flash(5, 5, 0, { intensity: 0.1, radius: 80, life: 0.1 })).toBe(false);
    app.frame(1 / 60);
    const lights = ops(app).filter((o): o is Extract<FakeOp, { op: "light" }> => o.op === "light");
    expect(lights.length).toBe(2);
    expect(lights.every((l) => l.pass === "light")).toBe(true);
    expect(Math.min(...lights.map((l) => l.intensity))).toBeGreaterThan(0.5);
    for (let i = 0; i < 8; i++) app.frame(1 / 60);
    expect(pool.count).toBe(0);
    app.destroy();
  });

  test("a tracked light follows its key and fades once the calls stop", async () => {
    const scene = isoScene();
    const layer = scene.world.add(new LightLayer(0x101010));
    const pool = layer.add(new LightPool());
    const app = await appWith(scene);
    for (let i = 0; i < 5; i++) {
      pool.track("bolt", i * 10, 0, 8, { color: 0x88ccff, fade: 0.1 });
      app.frame(1 / 60);
    }
    const lit = ops(app).filter((o): o is Extract<FakeOp, { op: "light" }> => o.op === "light");
    expect(lit.length).toBe(1);
    expect(lit[0].intensity).toBeCloseTo(1, 6);
    app.frame(1 / 60);
    app.frame(1 / 60);
    const dimmer = ops(app).find((o): o is Extract<FakeOp, { op: "light" }> => o.op === "light");
    expect(dimmer?.intensity ?? 0).toBeLessThan(1);
    for (let i = 0; i < 10; i++) app.frame(1 / 60);
    expect(pool.count).toBe(0);
    app.destroy();
  });
});

describe("decals", () => {
  test("ground marks lie flat through the projection, wall marks stand on their face, and they fade", async () => {
    const scene = isoScene();
    const decals = scene.world.add(new Decals({ capacity: 2 }));
    const app = await appWith(scene);
    decals.mark(16, 16, 0, { sprite: "hole", stay: 0.1, fade: 0.1 });
    decals.mark(32, 8, 12, { sprite: "hole", normal: [1, 0, 0], stay: 0.1, fade: 0.1 });
    app.frame(1 / 60);
    const [ground, wall] = sprites(app, "hole");
    // Ground: x maps to (1, 0.5) and y to (-1, 0.5) on screen.
    expect(ground.transform.slice(0, 4).map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 0.5, -1, 0.5]);
    // A face looking along +x: across it reads left to right (ground -y), and down is down.
    expect(wall.transform.slice(0, 4).map((v) => Math.round(v * 1000) / 1000)).toEqual([1, -0.5, 0, 1]);
    for (let i = 0; i < 9; i++) app.frame(1 / 60);
    const fading = sprites(app, "hole");
    expect(fading.length).toBe(2);
    expect(fading[0].alpha).toBeLessThan(1);
    expect(fading[0].alpha).toBeGreaterThan(0);
    for (let i = 0; i < 8; i++) app.frame(1 / 60);
    expect(decals.count).toBe(0);
    // The ring keeps the newest.
    for (let i = 0; i < 3; i++) decals.mark(i * 10, 0, 0, { sprite: "hole", stay: 5 });
    expect(decals.count).toBe(2);
    app.destroy();
  });

  test("random rotation and size come from the decals' seed", async () => {
    const pick = (seed: number) => {
      const d = new Decals({ seed });
      d.mark(0, 0, 0, { sprite: "hole", randomRot: true, scale: [0.5, 1.5] });
      return JSON.stringify((d as unknown as { ring: unknown[] }).ring[0]);
    };
    expect(pick(3)).toBe(pick(3));
    expect(pick(3)).not.toBe(pick(4));
  });
});

describe("iso surfaces", () => {
  // Centre cell two levels (32 units) up; cells are 32 units.
  const map = () => new IsoTileMap({ data: [[1, 1, 1], [1, 1, 1], [1, 1, 1]], elevation: [[0, 0, 0], [0, 2, 0], [0, 0, 0]], tile: { w: 64, h: 32, rise: 16 }, tiles: { 1: "top" } });

  test("a hit through a face snaps onto it and says whether the map draws it", () => {
    const m = map();
    const right = m.surfaceAt(64.004, 40, 10, 1, 0);
    expect(right).toMatchObject({ col: 1, row: 1, x: 64, y: 40, z: 10, normal: [1, 0, 0], top: false, visible: true });
    const front = m.surfaceAt(50, 64, 20, 0, 1);
    expect(front).toMatchObject({ col: 1, row: 1, y: 64, normal: [0, 1, 0], visible: true });
    // The back faces are not drawn in this view.
    expect(m.surfaceAt(32, 40, 10, -1, 0).visible).toBe(false);
    expect(m.surfaceAt(40, 32, 10, 0, -1).visible).toBe(false);
  });

  test("above the block a hit lands on its top; with no normal, on the ground under it", () => {
    const m = map();
    expect(m.surfaceAt(64, 40, 40, 1, 0)).toMatchObject({ col: 1, row: 1, z: 32, normal: [0, 0, 1], top: true });
    expect(m.surfaceAt(40, 40, 0)).toMatchObject({ col: 1, row: 1, z: 32, top: true });
    expect(m.surfaceAt(10, 10, 5)).toMatchObject({ col: 0, row: 0, z: 0, top: true, visible: true });
  });
});

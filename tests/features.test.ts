// Tests for the 0.2 additions: lighting, tile maps, layout, web-font text, overlay
// scenes, config, LUTs, imported art, gamepads and multi-touch.

import { beforeAll, describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/app/app.ts";
import { bakeAtlas, defineAutotile, defineImageSprite, defineSheet, defineSprite, getAnimation, resetImageRegistry, resetSpriteRegistry, resolveAssets } from "../src/art/index.ts";
import { TileMapData, autotileMask } from "../src/core/tilemap.ts";
import { ActionMap, GamepadInput, Pointer } from "../src/input/index.ts";
import { HeadlessPlatform } from "../src/platform/headless.ts";
import { buildLut, lutPreset, resolveLut } from "../src/render/lut.ts";
import { Anchor, Button, Column, FocusGroup, Label, Light2D, LightLayer, Row, Scene, Sprite, TileMap } from "../src/scene/index.ts";
import { createTestApp, drawnSprites, drawnText, lastFrame, stepFrames } from "../src/testkit/index.ts";

beforeAll(() => {
  resetSpriteRegistry();
  resetImageRegistry();
  defineSprite("dot", { w: 4, h: 4 }, (p) => p.rect(0, 0, 4, 4, "#fff"));
  defineSprite("solid", { w: 8, h: 8 }, (p) => p.rect(0, 0, 8, 8, "#888"));
  defineSprite("f0", { w: 2, h: 2 }, (p) => p.px(0, 0, "#fff"));
  defineSprite("f1", { w: 2, h: 2 }, (p) => p.px(1, 1, "#fff"));
  defineAutotile("ground", { w: 8, h: 8 }, (p, { north }) => {
    p.rect(0, 0, 8, 8, "#888");
    if (!north) p.hline(0, 0, 8, "#fff");
  });
});

describe("lighting", () => {
  test("a LightLayer switches to the light pass and marks the frame lit", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    scene.world.add(new Sprite("dot", 100, 100));
    const lights = scene.world.add(new LightLayer(0x202030));
    lights.add(new Light2D({ radius: 50 }, 100, 100));
    stepFrames(app);
    const ops = lastFrame(app);
    expect(ops.some((o) => o.op === "pass" && o.pass === "light" && o.clear === 0x202030)).toBe(true);
    expect(ops.some((o) => o.op === "light" && o.pass === "light")).toBe(true);
    const end = ops.find((o) => o.op === "end") as { lightUsed: boolean };
    expect(end.lightUsed).toBe(true);
  });

  test("without lights the frame is unlit and emissive sprites replay into the light pass when lit", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const s = scene.world.add(new Sprite("dot", 10, 10));
    s.emissive = true;
    stepFrames(app);
    expect((lastFrame(app).find((o) => o.op === "end") as { lightUsed: boolean }).lightUsed).toBe(false);
    scene.world.add(new LightLayer());
    stepFrames(app);
    expect(drawnSprites(app, "light")).toContain("dot");
    expect(drawnSprites(app, "world")).toContain("dot");
  });
});

describe("TileMap", () => {
  test("autotile masks follow same-id neighbours and treat the outside as matching", () => {
    const m = TileMapData.fromAscii(["###", "#.#", "###"], { "#": 1 });
    expect(autotileMask(m, 0, 0)).toBe(1 | 2 | 4 | 8);
    expect(autotileMask(m, 1, 0)).toBe(1 | 2 | 8);
    expect(autotileMask(m, 1, 2)).toBe(2 | 4 | 8);
  });

  test("draws autotile variants, animates frames and resolves collision", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const map = scene.world.add(
      new TileMap({
        data: ["...", ".#.", "GGG"],
        legend: { "#": 2, G: 1 },
        tileSize: 8,
        tiles: { 1: { autotile: "ground" }, 2: { frames: ["f0", "f1"], fps: 10 } },
        solid: [1, 2],
      }),
    );
    scene.camera.followRate = 0;
    scene.camera.x = 12;
    scene.camera.y = 12;
    stepFrames(app);
    const names = drawnSprites(app, "world");
    // The bottom row: nothing above, ground to each side, and the map edge below counts as ground.
    expect(names.filter((n) => n.startsWith("ground."))).toEqual(["ground.14", "ground.14", "ground.14"]);
    expect(names).toContain("f0");
    stepFrames(app, 7);
    expect(drawnSprites(app, "world")).toContain("f1");
    const r = map.moveBody({ x: 1, y: 0, w: 4, h: 6 }, 0, 40);
    expect(r.hitBottom).toBe(true);
    expect(r.y).toBe(16 - 6);
    expect(map.isSolid(1, 1)).toBe(true);
    expect(map.cellAt(9, 9)).toEqual({ x: 1, y: 1 });
  });
});

describe("layout", () => {
  test("anchors place groups from edges with size and safe area", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const br = scene.ui.add(new Anchor({ x: "right", y: "bottom", w: 100, h: 40, safe: 10, dx: -5 }));
    const c = scene.ui.add(new Anchor({ x: "center", y: "center", w: 200, h: 100 }));
    stepFrames(app);
    expect([br.x, br.y]).toEqual([640 - 10 - 100 - 5, 360 - 10 - 40]);
    expect([c.x, c.y]).toEqual([220, 130]);
  });

  test("rows and columns stack by child size", () => {
    const row = new Row({ gap: 4 });
    row.add(new Button("A", 0, 0, 30, 10));
    row.add(new Button("B", 0, 0, 50, 20));
    row.layout();
    expect(row.children.map((c) => (c as Button).x)).toEqual([0, 34]);
    expect([row.w, row.h]).toEqual([84, 20]);
    const col = new Column({ gap: 2, align: "center" });
    col.add(new Button("A", 0, 0, 30, 10));
    col.add(new Button("B", 0, 0, 50, 20));
    col.layout();
    expect(col.children.map((c) => [(c as Button).x, (c as Button).y])).toEqual([
      [10, 0],
      [0, 12],
    ]);
  });

  test("focus moves with wrap and confirms the current control", () => {
    let pressed = "";
    const a = new Button("A", 0, 0, 10, 10, { onPress: () => (pressed = "a") });
    const b = new Button("B", 0, 0, 10, 10, { onPress: () => (pressed = "b") });
    const f = new FocusGroup([a, b]);
    expect(f.onAction("down", true)).toBe(true);
    expect(f.current).toBe(a);
    f.onAction("up", true);
    expect(f.current).toBe(b);
    expect(b.focused).toBe(true);
    expect(a.focused).toBe(false);
    f.onAction("confirm", true);
    expect(pressed).toBe("b");
  });
});

describe("text and overlays", () => {
  test("labels with a web font go through the renderer's text path", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    scene.ui.add(new Label("Hello", 10, 10, { font: { family: "Instrument Sans", size: 20 } }));
    scene.ui.add(new Label("PIX", 10, 40));
    stepFrames(app);
    expect(drawnText(app)).toEqual(["Hello"]);
    expect(drawnSprites(app, "overlay").filter((n) => n.startsWith("__g:"))).toHaveLength(3);
  });

  test("overlay scenes draw over the scene below, which stops updating", async () => {
    let baseUpdates = 0;
    class Base extends Scene {
      override ready(): void {
        this.world.add(new Sprite("dot", 5, 5));
      }
      override update(): void {
        baseUpdates++;
      }
    }
    class Menu extends Scene {
      override ready(): void {
        this.ui.add(new Sprite("solid", 50, 50));
      }
    }
    const app = await createTestApp({ scene: new Base() });
    stepFrames(app);
    expect(baseUpdates).toBe(1);
    app.scenes.push(new Menu(), { overlay: true });
    stepFrames(app);
    expect(baseUpdates).toBe(1);
    const names = drawnSprites(app);
    expect(names).toContain("dot");
    expect(names).toContain("solid");
    app.scenes.pop();
    stepFrames(app);
    expect(baseUpdates).toBe(2);
    expect(drawnSprites(app)).not.toContain("solid");
  });
});

describe("fps counter", () => {
  test("is off by default, on through config, and draws on the overlay", async () => {
    const off = await createTestApp({ scene: new Scene() });
    stepFrames(off);
    expect(off.showFps).toBe(false);
    expect(drawnText(off)).toEqual([]);
    const on = await createTestApp({ scene: new Scene(), config: { fps: true } });
    stepFrames(on, 2);
    expect(on.showFps).toBe(true);
    const texts = drawnText(on);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/FPS/);
    const op = lastFrame(on).find((o) => o.op === "text") as { pass: string };
    expect(op.pass).toBe("overlay");
    on.showFps = false;
    stepFrames(on);
    expect(drawnText(on)).toEqual([]);
  });
});

describe("config", () => {
  test("render block merges and the legacy renderScale maps onto it", () => {
    expect(resolveConfig({}).render).toEqual({ scale: "native", snap: "world" });
    expect(resolveConfig({ render: { scale: 2, snap: "none" } }).render).toEqual({ scale: 2, snap: "none" });
    expect(resolveConfig({ renderScale: 3 }).render.scale).toBe(3);
    expect(resolveConfig({ viewport: { width: 320, height: 180 } }).viewport).toEqual({ width: 320, height: 180, scale: "fit" });
  });
});

describe("LUTs", () => {
  test("presets are 256 RGB entries and identity is identity", () => {
    const id = buildLut((t) => [t, t, t]);
    expect(id.length).toBe(768);
    expect(id[3 * 128]).toBe(128);
    expect(lutPreset("dusk")?.length).toBe(768);
    expect(lutPreset("nope")).toBeNull();
    expect(resolveLut(null)).toBeNull();
    expect(resolveLut(new Uint8Array(10))).toBeNull();
    expect(resolveLut("warm")).toBeInstanceOf(Uint8Array);
  });
});

describe("imported art", () => {
  test("image sprites and Aseprite sheets pack into the atlas with animations", async () => {
    const platform = new HeadlessPlatform();
    const px = (w: number, h: number, v: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = v;
        data[i * 4 + 3] = 255;
      }
      return { width: w, height: h, data };
    };
    platform.files.set("hero.png", px(4, 2, 200));
    platform.files.set("sheet.png", px(8, 4, 90));
    platform.files.set(
      "sheet.json",
      JSON.stringify({
        frames: { "run 0": { frame: { x: 0, y: 0, w: 4, h: 4 }, duration: 100 }, "run 1": { frame: { x: 4, y: 0, w: 4, h: 4 }, duration: 100 } },
        meta: { image: "sheet.png", frameTags: [{ name: "run", from: 0, to: 1 }] },
      }),
    );
    defineImageSprite("hero", "hero.png", { origin: [0, 1] });
    defineSheet("guy", "sheet.json");
    const images = await resolveAssets(platform);
    expect(images.map((i) => i.name).sort()).toEqual(["guy.run 0", "guy.run 1", "hero"]);
    const atlas = bakeAtlas({ images, defs: [] });
    expect(atlas.has("hero")).toBe(true);
    expect(atlas.region("hero").oy).toBe(2);
    expect(atlas.extract("hero").get(1, 1)?.r).toBe(200);
    expect(atlas.extract("guy.run 1").get(0, 0)?.r).toBe(90);
    expect(getAnimation("guy.run")?.frames).toEqual(["guy.run 0", "guy.run 1"]);
    expect(getAnimation("guy.run")?.fps).toBe(10);
  });
});

describe("gamepad and touch", () => {
  test("focus reset and failed polls release analog and digital gamepad state", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    let fail = false;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      getGamepads: () => {
        if (fail) throw new Error("Gamepad access lost");
        return [{ connected: true, buttons: [{ pressed: true, value: 1 }], axes: [-0.9, 0.4, 0.7, -0.5] }];
      },
    } });
    try {
      const actions = new ActionMap().map({ jump: "GamepadA", left: "GamepadLeftStickLeft" });
      const pad = new GamepadInput();
      pad.poll(actions); pad.reset(actions);
      expect(pad.connected).toBe(false);
      expect(pad.leftStick).toEqual({ x: 0, y: 0 });
      expect(pad.rightStick).toEqual({ x: 0, y: 0 });
      expect(actions.isDown("jump")).toBe(false);
      pad.poll(actions);
      expect(actions.isDown("left")).toBe(true);
      fail = true; pad.poll(actions);
      expect(pad.leftStick.x).toBe(0);
      expect(pad.rightStick.y).toBe(0);
      expect(actions.isDown("left")).toBe(false);
      expect(actions.isDown("jump")).toBe(false);
    } finally {
      if (saved) Object.defineProperty(globalThis, "navigator", saved);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
  test("gamepad buttons and sticks become key codes with edges", () => {
    const pads: (Gamepad | null)[] = [];
    const nav = globalThis as { navigator?: unknown };
    const saved = nav.navigator;
    Object.defineProperty(globalThis, "navigator", { value: { getGamepads: () => pads }, configurable: true });
    try {
      const actions = new ActionMap().map({ jump: "GamepadA", left: "GamepadLeftStickLeft" });
      const g = new GamepadInput();
      pads.push({ connected: true, buttons: [{ pressed: true, value: 1 }], axes: [-0.9, 0] } as unknown as Gamepad);
      g.poll(actions);
      expect(g.connected).toBe(true);
      expect(actions.isDown("jump")).toBe(true);
      expect(actions.isDown("left")).toBe(true);
      expect(g.leftStick.x).toBeCloseTo(-0.9);
      pads[0] = { connected: true, buttons: [{ pressed: false, value: 0 }], axes: [0, 0] } as unknown as Gamepad;
      g.poll(actions);
      expect(actions.isDown("jump")).toBe(false);
      expect(actions.justReleased("jump")).toBe(true);
      expect(actions.isDown("left")).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: saved, configurable: true });
    }
  });

  test("the pointer tracks every touch by id", () => {
    const p = new Pointer();
    p.handleDown(10, 10, 0, 1, "touch");
    p.handleDown(50, 50, 0, 2, "touch");
    expect(p.touches.size).toBe(2);
    p.handleMove(60, 60, "touch", 2);
    expect(p.touches.get(2)).toEqual({ x: 60, y: 60 });
    expect(p.x).toBe(10);
    p.handleUp(10, 10, 1);
    expect(p.touches.size).toBe(1);
    expect(p.down).toBe(false);
    p.cancel();
    expect(p.touches.size).toBe(0);
  });
});

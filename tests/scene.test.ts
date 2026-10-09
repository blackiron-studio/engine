import { beforeAll, describe, expect, test } from "bun:test";
import { defineAnimation, defineSprite, resetSpriteRegistry } from "../src/art/index.ts";
import {
  AnimatedSprite,
  Button,
  Camera2D,
  Label,
  Node2D,
  ParticleEmitter,
  Scene,
  Sprite,
  TileLayer,
} from "../src/scene/index.ts";
import { createTestApp, drawnSprites, lastFrame, stepFrames, tap } from "../src/testkit/index.ts";

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("dot", { w: 4, h: 4 }, (p) => p.rect(0, 0, 4, 4, "#fff"));
  defineSprite("tile", { w: 16, h: 16 }, (p) => p.rect(0, 0, 16, 16, "#0f0"));
  defineSprite("f0", { w: 2, h: 2 }, (p) => p.px(0, 0, "#fff"));
  defineSprite("f1", { w: 2, h: 2 }, (p) => p.px(1, 1, "#fff"));
  defineAnimation("blink", ["f0", "f1"], 10);
});

describe("Scene and nodes", () => {
  test("ready runs once, nodes added later are readied, exit runs on change", async () => {
    const log: string[] = [];
    class Probe extends Node2D {
      constructor(private readonly tag: string) {
        super();
      }
      override ready(): void {
        log.push(`ready:${this.tag}`);
      }
      override exit(): void {
        log.push(`exit:${this.tag}`);
      }
    }
    class S extends Scene {
      override ready(): void {
        this.world.add(new Probe("a"));
        log.push("scene");
      }
    }
    const app = await createTestApp({ scene: new S() });
    expect(log).toEqual(["scene", "ready:a"]);
    app.scene?.world.add(new Probe("b"));
    expect(log).toContain("ready:b");
    app.scenes.change(new Scene());
    expect(log.filter((l) => l.startsWith("exit")).sort()).toEqual(["exit:a", "exit:b"]);
  });

  test("draws sprites in tree order with zIndex and ySort", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const top = scene.world.add(new Sprite("dot", 10, 10));
    const bottom = scene.world.add(new Sprite("dot", 20, 20));
    top.zIndex = 5;
    stepFrames(app);
    // Positions travel in the transform (world plus the camera's centring offset);
    // the draw call itself is at the node origin.
    const xs = (lastFrame(app).filter((o) => o.op === "sprite") as Array<{ transform: number[] }>).map((o) => o.transform[4]);
    expect(xs).toEqual([320 + 20, 320 + 10]);
    top.zIndex = 0;
    scene.world.ySort = true;
    stepFrames(app);
    const ys = (lastFrame(app).filter((o) => o.op === "sprite") as Array<{ transform: number[] }>).map((o) => o.transform[5]);
    expect(ys).toEqual([180 + 10, 180 + 20]);
    expect(bottom.y).toBe(20);
  });

  test("camera transform reaches the renderer; culling drops offscreen sprites", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    scene.camera.followRate = 0;
    scene.camera.x = 320;
    scene.camera.y = 180;
    scene.world.add(new Sprite("dot", 320, 180));
    scene.world.add(new Sprite("dot", 5000, 5000));
    stepFrames(app);
    const ops = lastFrame(app).filter((o) => o.op === "sprite") as Array<{ x: number; transform: number[] }>;
    expect(ops).toHaveLength(1);
    // World (320,180) under a camera centred there lands at the screen centre.
    expect(ops[0].transform[4]).toBe(320);
    expect(ops[0].transform[5]).toBe(180);
    expect(scene.worldToScreen(320, 180)).toEqual([320, 180]);
    expect(scene.screenToWorld(0, 0)).toEqual([0, 0]);
  });

  test("Camera2D follows, clamps to bounds and shakes", () => {
    const cam = new Camera2D(100, 50);
    cam.bounds = { x: 0, y: 0, w: 400, h: 300 };
    const target = { x: 0, y: 0 };
    cam.follow(target, 0);
    expect(cam.x).toBe(50);
    expect(cam.y).toBe(25);
    target.x = 1000;
    cam.update(1 / 60);
    expect(cam.x).toBe(350);
    cam.shake(4, 0.2);
    cam.update(0.01);
    expect(Math.abs(cam.shakeX) + Math.abs(cam.shakeY)).toBeGreaterThan(0);
    cam.update(1);
    expect(cam.shakeX).toBe(0);
  });

  test("AnimatedSprite advances frames", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const a = scene.world.add(new AnimatedSprite("blink"));
    expect(a.sprite).toBe("f0");
    stepFrames(app, 7);
    expect(a.sprite).toBe("f1");
    stepFrames(app, 6);
    expect(a.sprite).toBe("f0");
  });

  test("TileLayer only draws visible tiles", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    scene.world.add(new TileLayer({ cols: 200, rows: 200, tileW: 16, tileH: 16, tileAt: () => "tile" }));
    scene.camera.followRate = 0;
    scene.camera.x = 1600;
    scene.camera.y = 1600;
    stepFrames(app);
    const n = drawnSprites(app).filter((s) => s === "tile").length;
    const visible = (Math.ceil(640 / 16) + 4) * (Math.ceil(360 / 16) + 4);
    expect(n).toBeGreaterThan(40 * 22);
    expect(n).toBeLessThanOrEqual(visible);
  });

  test("Label draws one glyph per non-space character", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    scene.ui.add(new Label("HI YOU", 10, 10));
    stepFrames(app);
    expect(drawnSprites(app).filter((s) => s.startsWith("__g:"))).toHaveLength(5);
  });

  test("Button reacts to a tap and forwards its action", async () => {
    const actions: string[] = [];
    class S extends Scene {
      override onAction(name: string): void {
        actions.push(name);
      }
    }
    const scene = new S();
    const app = await createTestApp({ scene });
    let pressed = 0;
    scene.ui.add(new Button("GO", 100, 100, 60, 20, { action: "go", onPress: () => pressed++ }));
    stepFrames(app);
    tap(app, 130, 110);
    expect(pressed).toBe(1);
    expect(actions).toEqual(["go"]);
    tap(app, 10, 10);
    expect(pressed).toBe(1);
  });

  test("ParticleEmitter bursts then fades", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const e = scene.world.add(new ParticleEmitter({ life: [0.1, 0.2], speed: [1, 2] }, 50, 50));
    stepFrames(app);
    e.burst(20);
    expect(e.count).toBe(20);
    stepFrames(app, 20);
    expect(e.count).toBe(0);
  });

  test("actions from the input map reach the scene", async () => {
    const seen: [string, boolean][] = [];
    class S extends Scene {
      override onAction(name: string, pressed: boolean): void {
        seen.push([name, pressed]);
      }
    }
    const app = await createTestApp({ scene: new S() });
    app.input.map({ jump: "Space" });
    app.input.keyDown("Space");
    stepFrames(app);
    expect(app.input.justPressed("jump")).toBe(false);
    app.input.keyUp("Space");
    stepFrames(app);
    expect(seen).toEqual([
      ["jump", true],
      ["jump", false],
    ]);
  });
});

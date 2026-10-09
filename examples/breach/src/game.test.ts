import { test, expect } from "bun:test";
import main, { BreachScene } from "./main.ts";
import { createTestApp, stepFrames, pressAction } from "@kiln/engine/testkit";
import { Vec3 } from "@kiln/engine/three";

test("Signal Breach owns controllers, targets and scenes across repeated restarts", async () => {
  const app = await createTestApp({
    config: { viewport: { width: 1280, height: 720 } },
  });
  await main(app);
  for (let i = 0; i < 15; i++) {
    const scene = app.scene as BreachScene;
    scene.start();
    stepFrames(app, 5);
    expect(scene.physicsWorld.stats.bodies).toBe(55);
    expect(scene.combat.targetCount).toBe(4);
    scene.pause();
    const time = scene.state.time;
    stepFrames(app, 5);
    expect(scene.state.time).toBe(time);
    scene.resume();
    await scene.restart();
    expect(scene.physicsWorld.stats.bodies).toBe(0);
    expect(scene.combat.targetCount).toBe(0);
  }
  app.destroy();
});
test("settings modal consumes Enter/Escape and rebinding without starting or resuming the game", async () => {
  const app = await createTestApp();
  await main(app);
  const scene = app.scene as BreachScene;
  pressAction(app, "settings");
  expect(scene.settingsOpen).toBe(true);
  pressAction(app, "confirm");
  expect(scene.settingsOpen).toBe(false);
  expect(scene.state.phase).toBe("title");
  scene.start();
  pressAction(app, "settings");
  expect(scene.state.phase).toBe("paused");
  scene.onPointerDown(520, 410);
  expect(scene.rebindAction).toBe("up");
  expect(scene.onKey("KeyT", true)).toBe(true);
  expect(app.input.bindingsOf("up")).toEqual(["KeyT"]);
  pressAction(app, "pause");
  expect(scene.state.phase).toBe("paused");
  app.destroy();
});
test("authored ramp supports continuous ascent with the shared capsule controller", async () => {
  const app = await createTestApp();
  await main(app);
  const scene = app.scene as BreachScene;
  scene.start();
  scene.player.teleport(new Vec3(-2.5, 0.05, 14));
  scene.look.yaw = 0;
  stepFrames(app, 5);
  app.input.press("up");
  let max = 0;
  for (let i = 0; i < 70; i++) {
    stepFrames(app);
    max = Math.max(max, scene.player.position.y);
  }
  app.input.release("up");
  expect(max).toBeGreaterThan(1);
  app.destroy();
});

test("brief fire taps survive between frames and do not replay after pausing", async () => {
  const app = await createTestApp();
  await main(app);
  const scene = app.scene as BreachScene;
  scene.start();
  const ammo = scene.weapons[0].ammo;
  app.input.press("fire");
  app.input.release("fire");
  stepFrames(app);
  expect(scene.weapons[0].ammo).toBe(ammo - 1);
  stepFrames(app, 15);
  expect(scene.weapons[0].ammo).toBe(ammo - 1);
  scene.onAction("fire", true);
  scene.pause();
  scene.resume();
  stepFrames(app);
  expect(scene.weapons[0].ammo).toBe(ammo - 1);
  app.destroy();
});

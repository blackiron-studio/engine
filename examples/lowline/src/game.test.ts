import { test, expect } from "bun:test";
import { CityRun } from "./game.ts";
import { PICKUP, DROP, world, makeCar } from "./city.ts";
import main, { LowlineScene } from "./main.ts";
import { createTestApp, stepFrames } from "@kiln/engine/testkit";
test("courier mission advances by proximity and actual vehicle interaction", () => {
  const r = new CityRun();
  r.start();
  r.player = { x: 740, y: 1260 };
  r.interact();
  expect(r.vehicle).not.toBeNull();
  expect(r.mission).toBe(1);
  r.interact();
  expect(r.vehicle).toBeNull();
  expect(world.free(r.player.x, r.player.y, 10)).toBe(true);
  r.player = { ...PICKUP };
  r.interact();
  expect(r.mission).toBe(2);
  expect(r.heat).toBe(2);
  expect(r.cars.filter((c) => c.kind === "police")).toHaveLength(3);
  for (const c of r.cars.filter((c) => c.kind === "police")) {
    c.motor.x = 2180;
    c.motor.y = 1700;
  }
  r.player = { x: 200, y: 200 };
  for (let i = 0; i < 500; i++) r.step(1 / 60, { x: 0, y: 0 });
  expect(r.heat).toBe(0);
  expect(r.mission).toBe(3);
  r.player = { ...DROP };
  r.interact();
  expect(r.phase).toBe("won");
  expect(r.cash).toBe(2400);
});
test("blocked doors never place the pedestrian inside a building", () => {
  const r = new CityRun();
  r.start();
  const c = makeCar(307, 460, 0, 0xffffff);
  r.cars = [c];
  r.vehicle = c;
  c.motor.stop();
  r.interact();
  expect(r.vehicle).toBeNull();
  expect(world.free(r.player.x, r.player.y, 10)).toBe(true);
});
test("pause freezes the city and scene replacement releases the old scene", async () => {
  const app = await createTestApp();
  await main(app);
  const s = app.scene as LowlineScene;
  s.onAction("confirm", true);
  stepFrames(app, 20);
  s.pause();
  const before = JSON.stringify(s.diagnostics);
  stepFrames(app, 30);
  expect(JSON.stringify(s.diagnostics)).toBe(before);
  s.resume();
  stepFrames(app);
  expect(s.run.time).toBeGreaterThan(JSON.parse(before).time);
  for (let i = 0; i < 5; i++) app.scenes.change(new LowlineScene());
  expect(s.attachedApp).toBeNull();
  app.destroy();
});
test("the starting sidewalk stays safe while the player learns the controls", () => {
  const r = new CityRun();
  r.start();
  for (let i = 0; i < 3600; i++) r.step(1 / 60, { x: 0, y: 0 });
  expect(r.phase).toBe("playing");
  expect(r.health).toBe(100);
});

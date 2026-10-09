import { expect, test } from "bun:test";
import {
  createTestApp,
  stepFrames,
  pressAction,
  holdAction,
} from "@kiln/engine/testkit";
import main, { SalvageScene } from "./main.ts";
import { CORES } from "./game.ts";
test("Lumen integrates 3D, movement, pause, victory and clean restart", async () => {
  const app = await createTestApp();
  await main(app);
  try {
    const scene = app.scenes.current as SalvageScene;
    stepFrames(app, 1);
    expect(scene.collectFrame3D().meshes.length).toBeGreaterThan(200);
    const z = scene.state.z;
    holdAction(app, "up", 10);
    expect(scene.state.z).toBe(z);
    pressAction(app, "confirm");
    pressAction(app, "view");
    expect(scene.camera3D.projection).toBe("orthographic");
    pressAction(app, "view");
    expect(scene.camera3D.projection).toBe("perspective");
    holdAction(app, "up", 10);
    expect(scene.state.z).toBeLessThan(z);
    pressAction(app, "dash");
    expect(scene.state.dashCooldown).toBeGreaterThan(1);
    const beforePause = scene.collectFrame3D().meshes.map(m => [m.x, m.y, m.z]);
    pressAction(app, "pause");
    const t = scene.state.time;
    holdAction(app, "right", 10);
    expect(scene.state.time).toBe(t);
    expect(scene.collectFrame3D().meshes.map(m => [m.x, m.y, m.z])).toEqual(beforePause);
    pressAction(app, "pause");
    stepFrames(app, 2);
    expect(scene.state.time).toBeGreaterThan(t);
    for (const [x, z] of CORES) {
      scene.state.x = x;
      scene.state.z = z;
      stepFrames(app, 1);
    }
    expect(scene.state.collected.every(Boolean)).toBe(true);
    scene.state.x = scene.state.z = 0;
    stepFrames(app, 1);
    expect(scene.state.won).toBe(true);
    pressAction(app, "confirm");
    expect(app.scenes.current).not.toBe(scene);
    expect(
      (app.scenes.current as SalvageScene).state.collected.some(Boolean),
    ).toBe(false);
  } finally {
    app.destroy();
  }
});

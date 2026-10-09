// A UI designed at one size fits any screen: scaled, centred, backed, and kept through resizes.

import { describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { Button, Scene } from "../src/scene/index.ts";

describe("Scene.fitUI", () => {
  test("a fit configured before attachment uses the app viewport on first frame", async () => {
    const scene = new Scene();
    scene.fitUI(720, 1280);
    expect(scene.ui.scale).toBe(0.28125);
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 1280, height: 800 }, fps: false } });
    app.scenes.change(scene);
    expect(scene.ui.scale).toBe(0.625);
    expect(scene.ui.x).toBe(415);
    app.destroy();
  });

  test("scales and centres the UI, keeps the fit on resize, and routes taps through the scale", async () => {
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 1280, height: 800 }, fps: false } });
    const scene = new Scene();
    let pressed = 0;
    scene.ui.add(new Button("Go", 100, 1000, 520, 60, { onPress: () => pressed++ }));
    app.scenes.change(scene);
    app.frame(1 / 60);
    expect(scene.wide).toBe(true);
    const k = scene.fitUI(720, 1280);
    expect(k).toBeCloseTo(0.625, 3);
    expect(scene.ui.x).toBe(Math.round((1280 - 720 * k) / 2));
    expect(scene.world.children.some((c) => c.name === "fit-backdrop")).toBe(true);
    app.frame(1 / 60);
    // A tap on the scaled button lands.
    const bx = scene.ui.x + (100 + 260) * k;
    const by = scene.ui.y + (1000 + 30) * k;
    app.bindHost().pointerLogical("down", 0, bx, by);
    app.frame(1 / 60);
    app.bindHost().pointerLogical("up", 0, bx, by);
    app.frame(1 / 60);
    expect(pressed).toBe(1);
    // A portrait resize brings the UI back to full scale.
    scene.resize(720, 1280);
    expect(scene.ui.scale).toBe(1);
    expect(scene.ui.x).toBe(0);
    expect(scene.orientation).toBe("portrait");
  });
});

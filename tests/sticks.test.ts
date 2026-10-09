// Two virtual sticks by zone: a finger on the left moves, a finger on the right aims.

import { describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { Scene, VirtualSticks } from "../src/scene/index.ts";

describe("VirtualSticks", () => {
  test("each zone owns its finger, vectors clamp to one, the base follows a long drag, lifting releases", async () => {
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 1280, height: 720 }, fps: false } });
    const scene = new Scene();
    const sticks = scene.ui.add(new VirtualSticks({ sticks: [{ zone: "left" }, { zone: "right" }], size: 50, always: true }));
    app.scenes.change(scene);
    app.frame(1 / 60);
    const host = app.bindHost();
    host.pointerLogical("down", 1, 200, 500);
    app.frame(1 / 60);
    host.pointerLogical("move", 1, 225, 500);
    app.frame(1 / 60);
    expect(sticks.held(0)).toBe(true);
    expect(sticks.held(1)).toBe(false);
    expect(sticks.vector(0).x).toBeCloseTo(0.5, 2);
    host.pointerLogical("down", 2, 1000, 500);
    app.frame(1 / 60);
    host.pointerLogical("move", 2, 1000, 380);
    app.frame(1 / 60);
    expect(sticks.held(1)).toBe(true);
    expect(sticks.vector(1).y).toBeCloseTo(-1, 2);
    expect(sticks.vector(1).x).toBeCloseTo(0, 2);
    // Dragging on keeps full deflection; the base moved with the finger.
    host.pointerLogical("move", 2, 1000, 200);
    app.frame(1 / 60);
    expect(sticks.vector(1).y).toBeCloseTo(-1, 2);
    host.pointerLogical("up", 2, 1000, 200);
    host.pointerLogical("up", 1, 225, 500);
    app.frame(1 / 60);
    expect(sticks.held(1)).toBe(false);
    expect(sticks.vector(0)).toEqual({ x: 0, y: 0 });
  });
});

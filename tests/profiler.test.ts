// The profiler: off by default and silent, on demand it attributes time to node classes and
// frame sections, averaged over recent frames.

import { describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { activeProfiler } from "../src/app/profiler.ts";
import { Node2D, Scene } from "../src/scene/index.ts";

class Busy extends Node2D {
  static spins = 0;
  override update(): void {
    // Enough work to register on a millisecond clock without being flaky.
    let x = 0;
    for (let i = 0; i < 20000; i++) x += Math.sqrt(i);
    Busy.spins += x > 0 ? 1 : 0;
  }
}

class Idle extends Node2D {}

describe("Profiler", () => {
  test("is off by default and free to leave off", async () => {
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 320, height: 180 }, fps: false } });
    expect(app.profiler.isEnabled).toBe(false);
    expect(activeProfiler).toBeNull();
    const scene = new Scene();
    app.scenes.change(scene);
    app.frame(1 / 60);
    expect(app.profiler.report().frames).toBe(0);
  });

  test("attributes update time to node classes and fills the frame sections", async () => {
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 320, height: 180 }, fps: false } });
    const scene = new Scene();
    for (let i = 0; i < 5; i++) scene.world.add(new Busy());
    for (let i = 0; i < 3; i++) scene.world.add(new Idle());
    const named = scene.ui.add(new Idle());
    named.name = "hud";
    app.scenes.change(scene);
    // The headless platform's clock does not advance; time with the real one.
    app.profiler.now = () => performance.now();
    app.profiler.enable();
    expect(activeProfiler).toBe(app.profiler);
    for (let i = 0; i < 10; i++) app.frame(1 / 60);
    const r = app.profiler.report();
    expect(r.frames).toBe(10);
    expect(r.frameMs).toBeGreaterThan(0);
    const names = r.sections.map((s) => s.name);
    expect(names).toEqual(["input", "update", "tweens", "draw", "present"]);
    const busy = r.nodes.find((n) => n.name === "Busy");
    expect(busy).toBeDefined();
    expect(busy?.count).toBe(5);
    expect(busy?.updateMs).toBeGreaterThan(0);
    // The heaviest class comes first, and named nodes report under their name.
    expect(r.nodes[0].name).toBe("Busy");
    expect(r.nodes.some((n) => n.name === "hud" && n.count === 1)).toBe(true);
    const update = r.sections.find((s) => s.name === "update");
    expect(update && update.ms >= (busy?.updateMs ?? 0)).toBe(true);
    // Lines render for the overlay and logs.
    const lines = app.profiler.lines(3);
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain("frame");
    app.profiler.disable();
    expect(activeProfiler).toBeNull();
    app.frame(1 / 60);
    expect(app.profiler.report().frames).toBe(10);
  });

  test("the window keeps the report about recent frames", async () => {
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 320, height: 180 }, fps: false } });
    app.scenes.change(new Scene());
    app.profiler.window = 5;
    app.profiler.enable();
    for (let i = 0; i < 25; i++) app.frame(1 / 60);
    expect(app.profiler.report().frames).toBeLessThan(10);
    expect(app.profiler.report().frames).toBeGreaterThan(0);
  });
});

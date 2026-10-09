// Game feel helpers: hit-stop freezes the world but not the UI, time scale slows it, floating
// text pools recycle, and moods accept a beat and a progression.

import { describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { Node2D, Scene, TextPops } from "../src/scene/index.ts";

class Counter extends Node2D {
  time = 0;
  override update(dt: number): void {
    this.time += dt;
  }
}

describe("Feel", () => {
  test("hit-stop freezes the world while the UI keeps time, then time scale slows it", async () => {
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 320, height: 180 }, fps: false } });
    const scene = new Scene();
    const world = scene.world.add(new Counter());
    const ui = scene.ui.add(new Counter());
    app.scenes.change(scene);
    app.frame(1 / 60);
    const w0 = world.time;
    const u0 = ui.time;
    scene.hitStop(0.1);
    for (let i = 0; i < 6; i++) app.frame(1 / 60);
    expect(world.time).toBe(w0);
    expect(ui.time).toBeGreaterThan(u0 + 0.09);
    // The freeze ends and the world moves at the scale.
    scene.timeScale = 0.5;
    const w1 = world.time;
    for (let i = 0; i < 6; i++) app.frame(1 / 60);
    expect(world.time - w1).toBeCloseTo(0.05, 3);
  });

  test("text pops rise, fade and recycle", async () => {
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 320, height: 180 }, fps: false } });
    const scene = new Scene();
    const pops = scene.world.add(new TextPops(4, { life: 0.5, font: { family: "Instrument Sans", size: 14, weight: 600 } }));
    app.scenes.change(scene);
    for (let i = 0; i < 6; i++) pops.pop(String(i), 10 * i, 50);
    expect(pops.count).toBe(4);
    for (let i = 0; i < 20; i++) app.frame(1 / 60);
    const ops = (app.renderer as unknown as { ops: { op: string; text?: string }[] }).ops;
    expect(ops.some((o) => o.op === "text" && o.text === "5")).toBe(true);
    for (let i = 0; i < 20; i++) app.frame(1 / 60);
    expect(pops.count).toBe(0);
  });

  test("moods take drums, a progression and an arpeggio", async () => {
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 320, height: 180 }, fps: false } });
    app.audio.defineMood("beat", { tempo: 120, root: 110, scale: [0, 2, 3, 5, 7, 8, 10], drums: true, arp: true, progression: [0, 3, 4, 3], drive: 0.8 });
    app.audio.setMood("beat");
    expect(app.audio.currentMood).toBe("beat");
    app.audio.setMood(null);
    expect(app.audio.currentMood).toBeNull();
  });
});

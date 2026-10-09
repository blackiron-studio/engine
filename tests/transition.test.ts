// Scene transitions: the overlay covers, swaps the scenes under it at the midpoint, then
// uncovers and removes itself. Driven through a headless App with the recording renderer.

import { describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import type { FakeRenderer } from "../src/render/fake.ts";
import { Scene } from "../src/scene/index.ts";
import type { TransitionKind } from "../src/scene/transition.ts";

async function appWith(name: string): Promise<{ app: App; scene: Scene }> {
  const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 320, height: 180 }, fps: false } });
  const scene = named(name);
  app.scenes.change(scene);
  app.frame(1 / 60);
  return { app, scene };
}

function named(name: string): Scene {
  const s = new Scene();
  s.name = name;
  return s;
}

function names(app: App): string[] {
  return app.scenes.all().map((s) => s.name);
}

function frames(app: App, n: number): void {
  for (let i = 0; i < n; i++) app.frame(1 / 60);
}

function coverRects(app: App): { alpha: number; w: number; h: number }[] {
  const ops = (app.renderer as FakeRenderer).ops;
  return ops.filter((o) => o.op === "rect" && o.pass === "overlay").map((o) => (o.op === "rect" ? { alpha: o.alpha, w: o.w, h: o.h } : { alpha: 0, w: 0, h: 0 }));
}

describe("scene transitions", () => {
  test("change keeps the old scene until the midpoint, then the new one is current", async () => {
    const { app, scene: a } = await appWith("a");
    const b = named("b");
    app.scenes.change(b, { transition: "fade", duration: 0.5 });
    // The overlay is on top; the old scene still lives under it.
    expect(app.scenes.current?.name).toBe("transition");
    expect(names(app)).toEqual(["a", "transition"]);
    expect(b.isStarted).toBe(false);
    // A quarter of the way in, the fade covers about half.
    frames(app, 7);
    const rects = coverRects(app);
    expect(rects.length).toBe(1);
    expect(rects[0].w).toBe(320);
    expect(rects[0].h).toBe(180);
    expect(rects[0].alpha).toBeGreaterThan(0.3);
    expect(rects[0].alpha).toBeLessThan(0.6);
    expect(a.isStarted).toBe(true);
    // Past the midpoint the swap has happened while the cover is still up.
    frames(app, 10);
    expect(names(app)).toEqual(["b", "transition"]);
    expect(b.isStarted).toBe(true);
    expect(a.isStarted).toBe(false);
    expect(coverRects(app)[0].alpha).toBeGreaterThan(0.8);
    // Done: only the new scene remains and nothing is drawn over it.
    frames(app, 20);
    expect(names(app)).toEqual(["b"]);
    expect(app.scenes.current).toBe(b);
    expect(coverRects(app).length).toBe(0);
  });

  test("push with a transition keeps the scene below and honours overlay", async () => {
    const { app } = await appWith("base");
    const pause = named("pause");
    app.scenes.push(pause, { transition: "wipe", duration: 0.2, overlay: true });
    expect(names(app)).toEqual(["base", "transition"]);
    frames(app, 8);
    expect(names(app)).toEqual(["base", "pause", "transition"]);
    frames(app, 8);
    expect(names(app)).toEqual(["base", "pause"]);
    expect(pause.overlay).toBe(true);
    // An overlay keeps the scene under it visible.
    expect(app.scenes.visible().map((s) => s.name)).toEqual(["base", "pause"]);
  });

  test("every kind fully covers the screen at the midpoint", async () => {
    for (const kind of ["fade", "wipe", "slide", "circle"] as TransitionKind[]) {
      const { app } = await appWith("a");
      app.scenes.change(named("b"), { transition: kind, duration: 0.5, color: 0x102030 });
      // 15 frames of 1/60 is t = 0.5 exactly: coverage 1.
      frames(app, 15);
      const rects = coverRects(app);
      expect(rects.length).toBeGreaterThan(0);
      const area = rects.reduce((sum, r) => sum + Math.max(0, r.w) * Math.max(0, r.h) * (kind === "fade" ? r.alpha : 1), 0);
      expect(area).toBeGreaterThanOrEqual(320 * 180 * 0.95);
      frames(app, 16);
      expect(names(app)).toEqual(["b"]);
    }
  });

  test("a transition that finishes in one long frame still swaps exactly once", async () => {
    const { app } = await appWith("a");
    const b = named("b");
    let readied = 0;
    b.ready = () => {
      readied++;
    };
    app.scenes.change(b, { transition: "slide", duration: 0.05 });
    frames(app, 6);
    expect(names(app)).toEqual(["b"]);
    expect(readied).toBe(1);
  });
});

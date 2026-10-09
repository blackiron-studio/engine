// Helpers for driving an App without a browser: a recording renderer, a headless
// platform, manual frames, synthetic input. Game logic tests should not need this;
// scene tests do.

import { App, type KilnConfig } from "../app/app.ts";
import { HeadlessPlatform } from "../platform/headless.ts";
import type { FakeOp } from "../render/fake.ts";
import { FakeRenderer } from "../render/fake.ts";
import type { Scene } from "../scene/scene.ts";
export { auditUILayout, type UILayoutIssue, type UILayoutAuditOptions } from "./ui-layout.ts";

export interface TestAppOptions {
  config?: Partial<KilnConfig>;
  seed?: number | string;
  scene?: Scene;
  platform?: HeadlessPlatform;
}

/** A headless App with a deterministic seed, a HeadlessPlatform and a FakeRenderer. */
export async function createTestApp(opts: TestAppOptions = {}): Promise<App> {
  const app = await App.create({
    headless: true,
    platform: opts.platform ?? new HeadlessPlatform(),
    config: { seed: opts.seed ?? 1, viewport: { width: 640, height: 360 }, ...opts.config },
  });
  if (opts.scene) app.scenes.change(opts.scene);
  return app;
}

/** Advance `n` frames of `dt` seconds each. */
export function stepFrames(app: App, n = 1, dt = 1 / 60): void {
  for (let i = 0; i < n; i++) app.frame(dt);
}

/** Press an action for one frame. */
export function pressAction(app: App, name: string, dt = 1 / 60): void {
  app.input.press(name);
  app.frame(dt);
  app.input.release(name);
}

/** Hold an action down across `frames` frames. */
export function holdAction(app: App, name: string, frames: number, dt = 1 / 60): void {
  app.input.press(name);
  stepFrames(app, frames, dt);
  app.input.release(name);
}

/** A press and release at logical coordinates across two frames. */
export function tap(app: App, x: number, y: number, dt = 1 / 60): void {
  app.pointer.handleDown(x, y, 0, 1);
  app.frame(dt);
  app.pointer.handleUp(x, y, 1);
  app.frame(dt);
}

/** The recording renderer's operations from the last frame. */
export function lastFrame(app: App): FakeOp[] {
  const r = app.renderer;
  if (!(r instanceof FakeRenderer)) throw new Error("lastFrame needs a FakeRenderer; create the app headless");
  return r.ops;
}

/** Names of sprites drawn in the last frame, in draw order. */
export function drawnSprites(app: App, pass?: "world" | "light" | "overlay"): string[] {
  return lastFrame(app)
    .filter((o): o is Extract<FakeOp, { op: "sprite" }> => o.op === "sprite" && (pass === undefined || o.pass === pass))
    .map((o) => o.name);
}

/** Text drawn in the last frame with web fonts. */
export function drawnText(app: App): string[] {
  return lastFrame(app)
    .filter((o): o is Extract<FakeOp, { op: "text" }> => o.op === "text")
    .map((o) => o.text);
}

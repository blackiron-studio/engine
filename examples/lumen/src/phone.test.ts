// Lumen Salvage on phones and tablets: every screen (the briefing, play in both views, pause
// and victory) reads at 11 points or more and every button and touch control is at least 44
// points, the courier is driven by the on-screen stick and buttons, and a laptop keeps the
// designed layout with its keyboard hints. Each device runs the game's own blackiron.json.

import { afterEach, describe, expect, test } from "bun:test";
import type { App } from "@blackiron-studio/engine/app";
import { type Anchor, Button } from "@blackiron-studio/engine/scene";
import { auditUILayout, createTestApp, pressAction, stepFrames } from "@blackiron-studio/engine/testkit";
import main, { SalvageScene } from "./main.ts";

const project = (await Bun.file(new URL("../blackiron.json", import.meta.url)).json()) as {
  name: string;
  viewport: { width: number; height: number; scale: "fit" };
  ui: { minPoints: number; tabletPoints: number };
};

const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.destroy();
});

async function start(device: string): Promise<{ app: App; scene: SalvageScene }> {
  const app = await createTestApp({ device, config: { name: project.name, viewport: project.viewport, ui: project.ui, fps: false } });
  apps.push(app);
  await main(app);
  stepFrames(app, 3);
  return { app, scene: app.scenes.current as unknown as SalvageScene };
}

/** What is too small on this frame, readable in a failure. */
function tooSmall(app: App): string[] {
  const a = app.auditScreen();
  return [
    ...a.smallText.map((t) => `text "${t.text}" ${t.points.toFixed(1)} pt`),
    ...a.smallTargets.map((t) => `target ${t.name ?? "?"} ${t.width.toFixed(0)}x${t.height.toFixed(0)} pt`),
  ];
}

/** Controls that leave the screen. */
function offScreen(scene: SalvageScene): string[] {
  return auditUILayout(scene).filter((i) => i.kind !== "overlap").map((i) => `${i.kind}: ${i.controls.map((c) => c.name || c.constructor.name).join(", ")}`);
}

const texts = (app: App): string[] => app.auditScreen().text.map((t) => t.text);
const targets = (app: App): string[] => app.auditScreen().targets.map((t) => t.name);

/** A UI-layer point as the logical point a finger lands on. */
const toLogical = (scene: SalvageScene, x: number, y: number): [number, number] => [scene.ui.x + x * scene.ui.scaleX, scene.ui.y + y * scene.ui.scaleY];

/** A finger down at a UI-layer point, held for `frames`, then lifted. */
function touch(app: App, scene: SalvageScene, x: number, y: number, frames = 2, dragX = 0, dragY = 0): void {
  const [lx, ly] = toLogical(scene, x, y);
  app.pointer.handleDown(lx, ly, 0, 5, "touch");
  stepFrames(app, 1);
  const [mx, my] = toLogical(scene, x + dragX, y + dragY);
  app.pointer.handleMove(mx, my, "touch", 5);
  stepFrames(app, frames);
  app.pointer.handleUp(mx, my, 5);
  stepFrames(app, 1);
}

/** The centre of touch button `i`, counted from the right, as `TouchControls` lays them out. */
const padButton = (scene: SalvageScene, i: number): [number, number] => [scene.uiWidth - 72 - i * 84, scene.uiHeight - 72];

for (const device of ["iphone-se", "iphone-15", "ipad"]) {
  describe(`Lumen Salvage on ${device}`, () => {
    test("every screen is readable and tappable, with touch wording", async () => {
      const { app, scene } = await start(device);
      expect(app.screen.touch).toBe(true);
      expect(app.screen.uiScale).toBeGreaterThan(1.2);
      expect(scene.uiHeight).toBeLessThan(640);

      // The briefing.
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(scene)).toEqual([]);
      expect(texts(app).some((t) => t.includes("ENTER TO BEGIN"))).toBe(false);
      expect(texts(app).some((t) => t.includes("DRAG ON THE LEFT"))).toBe(true);

      // Tapping the button starts the expedition.
      const begin = scene.ui.findAllInDrawOrder(Button).find((b) => b.text === "BEGIN SALVAGE")!;
      const panel = begin.parent as Anchor;
      touch(app, scene, panel.x + begin.x + begin.w / 2, panel.y + begin.y + begin.h / 2);
      stepFrames(app, 5);

      // Play, in both views: no keyboard hints, the controls are on screen and measured.
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(scene)).toEqual([]);
      expect(texts(app).some((t) => /WASD|SHIFT|V TO SWITCH/.test(t))).toBe(false);
      for (const name of ["UP", "DASH", "VIEW", "PAUSE"]) expect(targets(app)).toContain(name);

      // The stick walks the courier and the buttons dash, switch the view and pause.
      const x0 = scene.state.x;
      touch(app, scene, 90, scene.uiHeight - 90, 20, 50, 0);
      expect(scene.state.x).not.toBe(x0);
      touch(app, scene, ...padButton(scene, 1));
      expect(scene.state.dashCooldown).toBeGreaterThan(0);
      touch(app, scene, ...padButton(scene, 2));
      expect(scene.camera3D.projection).toBe("orthographic");
      expect(tooSmall(app)).toEqual([]);
      expect(texts(app)).toContain("ORTHOGRAPHIC VIEW");

      touch(app, scene, ...padButton(scene, 3));
      const t = scene.state.time;
      stepFrames(app, 5);
      expect(scene.state.time).toBe(t);
      expect(texts(app)).toContain("Taking a breather");
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(scene)).toEqual([]);
      pressAction(app, "pause");
      stepFrames(app, 2);
      expect(scene.state.time).toBeGreaterThan(t);

      // Victory.
      scene.state.collected.fill(true);
      scene.state.x = scene.state.z = 0;
      stepFrames(app, 3);
      expect(scene.state.won).toBe(true);
      expect(texts(app)).toContain("The light returns");
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(scene)).toEqual([]);
    }, 30_000);
  });
}

test("a laptop keeps the designed layout and its keyboard hints", async () => {
  const { app, scene } = await start("laptop");
  expect(app.screen.touch).toBe(false);
  expect(app.screen.uiScale).toBe(1);
  expect(scene.ui.scaleX).toBe(1);
  expect(scene.uiWidth).toBe(1280);
  expect(scene.uiHeight).toBe(720);
  expect(texts(app)).toContain("ENTER TO BEGIN / SPACE TO JUMP");
  pressAction(app, "confirm");
  stepFrames(app, 3);
  expect(texts(app)).toContain("PERSPECTIVE VIEW / V TO SWITCH");
  expect(texts(app)).toContain("SHIFT / DASH READY");
  expect(texts(app).some((t) => t.startsWith("WASD Move"))).toBe(true);
  expect(targets(app)).not.toContain("VIEW");
}, 30_000);

test("the interface rebuilds when the screen changes", async () => {
  const { app, scene } = await start("laptop");
  pressAction(app, "confirm");
  stepFrames(app, 2);
  app.emulateDevice("iphone-15");
  stepFrames(app, 3);
  expect(scene.uiWidth).toBeLessThan(1000);
  expect(tooSmall(app)).toEqual([]);
  expect(texts(app)).toContain("PERSPECTIVE VIEW");
  app.emulateDevice(null);
  stepFrames(app, 3);
  expect(scene.ui.scaleX).toBe(1);
}, 30_000);

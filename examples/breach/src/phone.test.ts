// On a phone or a tablet every screen of Signal Breach reads at 11 pt or more, every tap target
// is at least 44 pt and on screen, and the on-screen controls play the game. A laptop keeps the
// 1280 × 720 layout untouched.

import { afterEach, describe, expect, test } from "bun:test";
import type { App } from "@blackiron-studio/engine/app";
import { createTestApp, stepFrames } from "@blackiron-studio/engine/testkit";
import main, { BreachScene } from "./main.ts";
import { touchLayout, type Box } from "./touch.ts";

const project = (await Bun.file(new URL("../blackiron.json", import.meta.url)).json()) as {
  name: string;
  viewport: { width: number; height: number; scale: "fit" };
  ui: { minPoints: number; tabletPoints: number };
};

const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.destroy();
});

async function open(device: string): Promise<{ app: App; scene: BreachScene }> {
  const app = await createTestApp({ device, config: { name: project.name, viewport: project.viewport, ui: project.ui, fps: false } });
  apps.push(app);
  await main(app);
  stepFrames(app, 3);
  return { app, scene: app.scene as BreachScene };
}

/** What is too small or off screen on this frame, readable in a failure. */
function problems(app: App): string[] {
  const a = app.auditScreen(),
    scene = app.scene as BreachScene;
  return [
    ...a.smallText.map((t) => `text "${t.text}" ${t.points.toFixed(1)} pt`),
    ...a.smallTargets.map((t) => `target ${t.name ?? "?"} ${t.width.toFixed(0)}x${t.height.toFixed(0)} pt`),
    ...scene.reportedTargets
      .filter((t) => t.x < -0.5 || t.y < -0.5 || t.x + t.w > scene.uiWidth + 0.5 || t.y + t.h > scene.uiHeight + 0.5)
      .map((t) => `off screen: ${t.name}`),
  ];
}
const names = (app: App) => (app.scene as BreachScene).reportedTargets.map((t) => t.name);
/** The middle of a layout box, in the logical units the pointer uses. */
function middle(scene: BreachScene, b: Box): { x: number; y: number } {
  return { x: scene.ui.x + (b.x + b.w / 2) * scene.ui.scaleX, y: scene.ui.y + (b.y + b.h / 2) * scene.ui.scaleY };
}
function tap(app: App, scene: BreachScene, b: Box): void {
  const p = middle(scene, b);
  scene.onPointerDown(p.x, p.y);
  stepFrames(app, 30);
}

for (const device of ["iphone-se", "iphone-15", "ipad"]) {
  describe(`Signal Breach on ${device}`, () => {
    test("every screen is readable and tappable", async () => {
      const { app, scene } = await open(device);
      expect(app.screen.touch).toBe(true);
      expect(scene.touchUI).toBe(true);
      expect(app.screen.pointsPerUnit * app.screen.uiScale).toBeGreaterThanOrEqual(0.8 - 1e-6);
      // Title.
      expect(problems(app)).toEqual([]);
      expect(names(app)).toEqual(["Enter the station", "Control settings"]);
      // Settings from the title.
      tap(app, scene, touchLayout(scene).titleSettings);
      expect(scene.settingsOpen).toBe(true);
      expect(problems(app)).toEqual([]);
      expect(names(app)).toContain("Back");
      tap(app, scene, touchLayout(scene).back);
      expect(scene.settingsOpen).toBe(false);
      // Play.
      tap(app, scene, touchLayout(scene).start);
      expect(scene.state.phase).toBe("playing");
      expect(problems(app)).toEqual([]);
      expect(names(app)).toEqual(expect.arrayContaining(["Fire", "Jump", "Reload", "Swap weapon", "Pause"]));
      // At a relay: the prompt is a button.
      scene.player.teleport(scene.player.position.clone().set(0, 0.04, -23.5));
      stepFrames(app, 20);
      expect(scene.nearestRelay).toBe(2);
      expect(names(app)).toContain("Reboot relay");
      expect(problems(app)).toEqual([]);
      // Hurt, with a notice up.
      scene.state.damage(80);
      stepFrames(app, 2);
      expect(problems(app)).toEqual([]);
      // Pause and its settings.
      scene.pause();
      stepFrames(app, 2);
      expect(names(app)).toEqual(["Resume", "Control settings", "Restart"]);
      expect(problems(app)).toEqual([]);
      tap(app, scene, touchLayout(scene).pauseSettings);
      expect(scene.settingsOpen).toBe(true);
      expect(problems(app)).toEqual([]);
      tap(app, scene, touchLayout(scene).back);
      // The end of a run, both ways.
      for (const phase of ["lost", "won"] as const) {
        scene.state.phase = phase;
        stepFrames(app, 2);
        expect(names(app)).toEqual(["Deploy again"]);
        expect(problems(app)).toEqual([]);
      }
    });

    test("nothing sits under the notch or the home bar", async () => {
      const { app, scene } = await open(device);
      scene.start();
      stepFrames(app, 5);
      const safe = scene.safeRect;
      for (const t of scene.reportedTargets) {
        expect(t.x).toBeGreaterThanOrEqual(safe.x);
        expect(t.y).toBeGreaterThanOrEqual(safe.y);
        expect(t.x + t.w).toBeLessThanOrEqual(safe.x + safe.w + 1e-6);
        expect(t.y + t.h).toBeLessThanOrEqual(safe.y + safe.h + 1e-6);
      }
    });
  });
}

test("the sticks and buttons play the game on a phone", async () => {
  const { app, scene } = await open("iphone-15");
  tap(app, scene, touchLayout(scene).start);
  expect(scene.state.phase).toBe("playing");
  const l = touchLayout(scene);
  // Move stick: push up, walk forward (north is -z).
  const from = scene.player.position.z,
    stick = { x: scene.ui.scaleX * l.W * 0.15, y: scene.ui.scaleY * l.H * 0.75 };
  app.pointer.handleDown(stick.x, stick.y, 0, 1, "touch");
  stepFrames(app, 2);
  app.pointer.handleMove(stick.x, stick.y - 40 * scene.ui.scaleY, "touch", 1);
  stepFrames(app, 40);
  expect(scene.player.position.z).toBeLessThan(from - 1);
  // Look stick, with the second thumb: drag right, turn right.
  const yaw = scene.look.yaw,
    look = { x: scene.ui.scaleX * l.W * 0.62, y: scene.ui.scaleY * l.H * 0.5 };
  app.pointer.handleDown(look.x, look.y, 0, 2, "touch");
  stepFrames(app, 2);
  app.pointer.handleMove(look.x + 50 * scene.ui.scaleX, look.y, "touch", 2);
  stepFrames(app, 20);
  expect(scene.look.yaw).toBeGreaterThan(yaw + 0.2);
  app.pointer.handleUp(look.x, look.y, 2);
  app.pointer.handleUp(stick.x, stick.y, 1);
  stepFrames(app, 2);
  // Fire holds the trigger while the finger is down.
  const ammo = scene.weapons[0].ammo,
    fire = middle(scene, l.fire);
  app.pointer.handleDown(fire.x, fire.y, 0, 3, "touch");
  stepFrames(app, 20);
  expect(scene.touchFiring).toBe(true);
  expect(scene.weapons[0].ammo).toBeLessThan(ammo - 1);
  app.pointer.handleUp(fire.x, fire.y, 3);
  stepFrames(app, 2);
  expect(scene.touchFiring).toBe(false);
  // Swap, then pause.
  const swap = middle(scene, l.swap);
  app.pointer.handleDown(swap.x, swap.y, 0, 4, "touch");
  stepFrames(app, 2);
  app.pointer.handleUp(swap.x, swap.y, 4);
  expect(scene.weaponIndex).toBe(1);
  const pause = middle(scene, l.pause);
  app.pointer.handleDown(pause.x, pause.y, 0, 5, "touch");
  stepFrames(app, 2);
  app.pointer.handleUp(pause.x, pause.y, 5);
  expect(scene.state.phase).toBe("paused");
  stepFrames(app, 30);
  tap(app, scene, touchLayout(scene).resume);
  expect(scene.state.phase).toBe("playing");
});

test("a laptop keeps the desktop layout: UI scale 1, no touch controls", async () => {
  const { app, scene } = await open("laptop");
  expect(app.screen.touch).toBe(false);
  expect(app.screen.uiScale).toBe(1);
  expect(scene.ui.scaleX).toBe(1);
  expect(scene.uiWidth).toBe(1280);
  expect(scene.uiHeight).toBe(720);
  expect(scene.touchUI).toBe(false);
  scene.start();
  stepFrames(app, 5);
  expect(scene.reportedTargets).toEqual([]);
  expect(scene.ui.children.length).toBe(1);
});

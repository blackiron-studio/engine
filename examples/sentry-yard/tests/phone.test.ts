// Sentry Yard on phones and tablets: the title, settings, the HUD, pause and the end card read
// at 11 points or more with every button at least 44 points, the yard is played with two
// thumbs (move, aim and fire, grenade, reload, swap, pause), and a laptop keeps its HUD and
// keyboard hints. Each device runs the game's own blackiron.json.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { App } from "@blackiron-studio/engine/app";
import { type Atlas, bakeAtlas, resetSpriteRegistry } from "@blackiron-studio/engine/art";
import { PauseScene, SettingsScene } from "@blackiron-studio/engine/shell";
import { auditUILayout } from "@blackiron-studio/engine/testkit";
import type { PlayScene as PlaySceneType } from "../src/scenes/play.ts";

const project = (await Bun.file(new URL("../blackiron.json", import.meta.url)).json()) as {
  name: string;
  viewport: { width: number; height: number; scale: "fit" };
  ui: { minPoints: number; tabletPoints: number };
};

let PlayScene: typeof PlaySceneType;
let main: (app: App) => Promise<void>;
let atlas: Atlas;
beforeAll(async () => {
  // The art registers its sprites on import: clear what other tests left first.
  resetSpriteRegistry();
  PlayScene = (await import("../src/scenes/play.ts")).PlayScene;
  main = (await import("../src/main.ts")).default;
  atlas = bakeAtlas();
});

const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.destroy();
});

const frames = (app: App, n: number): void => {
  for (let i = 0; i < n; i++) app.frame(1 / 60);
};

async function start(device: string): Promise<App> {
  const app = await App.create({ headless: true, atlas, device, config: { name: project.name, viewport: project.viewport, ui: project.ui, fps: false, seed: 17 } });
  apps.push(app);
  await main(app);
  frames(app, 30);
  return app;
}

/** From the title into the yard. */
function play(app: App): PlaySceneType {
  const title = app.scenes.current as unknown as { focus: { set(i: number): void }; onAction(name: string, pressed: boolean): void };
  title.focus.set(0);
  title.onAction("confirm", true);
  frames(app, 60);
  expect(app.scenes.current).toBeInstanceOf(PlayScene);
  return app.scenes.current as PlaySceneType;
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
function offScreen(app: App): string[] {
  return auditUILayout(app.scenes.current!).filter((i) => i.kind !== "overlap").map((i) => `${i.kind}: ${i.controls.map((c) => c.name || c.constructor.name).join(", ")}`);
}

const texts = (app: App): string[] => app.auditScreen().text.map((t) => t.text);
const targets = (app: App): string[] => app.auditScreen().targets.map((t) => t.name);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Layout = { touch: boolean; W: number; H: number; pause: Box; weapon: Box; grenade: Box; reload: Box; vitals: Box; map: Box };
const layoutOf = (scene: PlaySceneType): Layout => (scene as unknown as { hud: { layout(): Layout } }).hud.layout();

/** A UI-layer point as the logical point a finger lands on. */
const toLogical = (scene: PlaySceneType, x: number, y: number): [number, number] => [scene.ui.x + x * scene.ui.scaleX, scene.ui.y + y * scene.ui.scaleY];
const down = (app: App, scene: PlaySceneType, id: number, x: number, y: number): void => app.pointer.handleDown(...toLogical(scene, x, y), 0, id, "touch");
const move = (app: App, scene: PlaySceneType, id: number, x: number, y: number): void => app.pointer.handleMove(...toLogical(scene, x, y), "touch", id);
const up = (app: App, scene: PlaySceneType, id: number, x: number, y: number): void => app.pointer.handleUp(...toLogical(scene, x, y), id);
const centre = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];
function tapBox(app: App, scene: PlaySceneType, b: Box): void {
  down(app, scene, 9, ...centre(b));
  frames(app, 2);
  up(app, scene, 9, ...centre(b));
  frames(app, 2);
}

for (const device of ["iphone-se", "iphone-15", "ipad"]) {
  describe(`Sentry Yard on ${device}`, () => {
    test("the title and settings are readable and tappable", async () => {
      const app = await start(device);
      expect(app.screen.touch).toBe(true);
      expect(app.screen.uiScale).toBeGreaterThan(1.2);
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(app)).toEqual([]);

      const title = app.scenes.current as unknown as { rows: { text: string }[]; focus: { set(i: number): void }; onAction(name: string, pressed: boolean): void };
      title.focus.set(title.rows.findIndex((r) => r.text === "Settings"));
      title.onAction("confirm", true);
      frames(app, 30);
      expect(app.scenes.current).toBeInstanceOf(SettingsScene);
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(app)).toEqual([]);
    });

    test("the HUD, pause and the end card are readable, with touch buttons in place of key hints", async () => {
      const app = await start(device);
      const scene = play(app);
      const L = layoutOf(scene);
      expect(L.touch).toBe(true);
      expect(tooSmall(app)).toEqual([]);
      for (const name of ["Pause", "Swap weapon", "Grenade", "Reload"]) expect(targets(app)).toContain(name);
      expect(texts(app).some((t) => /WASD|Right-click|Esc pause/.test(t))).toBe(false);
      expect(texts(app)).toContain("TAP TO SWAP");
      expect(texts(app)).toContain("MOVE");

      // Everything is on screen and nothing overlaps: the top row, the map, the buttons.
      const boxes = [L.vitals, L.weapon, L.pause, L.map, L.grenade, L.reload];
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(L.W);
        expect(b.y + b.h).toBeLessThanOrEqual(L.H);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
        }
      }

      // Pause from its button.
      tapBox(app, scene, L.pause);
      frames(app, 20);
      expect(app.scenes.current).toBeInstanceOf(PauseScene);
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(app)).toEqual([]);
      app.scenes.pop();
      frames(app, 5);

      // The end card.
      (scene as unknown as { finish(won: boolean): void }).finish(true);
      frames(app, 5);
      expect(texts(app)).toContain("YARD CLEAR");
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(app)).toEqual([]);
      expect(targets(app)).not.toContain("Grenade");
    });

    test("two thumbs play the yard: move, aim and fire, reload, swap, grenade", async () => {
      const app = await start(device);
      const scene = play(app);
      const y = scene.yard;
      const L = layoutOf(scene);
      expect(scene.aimDevice).toBe("stick");

      // The left thumb walks.
      const from = { x: y.player.x, y: y.player.y };
      down(app, scene, 1, L.W * 0.14, L.H * 0.8);
      frames(app, 1);
      move(app, scene, 1, L.W * 0.14 + 50, L.H * 0.8);
      frames(app, 20);
      expect(Math.hypot(y.player.x - from.x, y.player.y - from.y)).toBeGreaterThan(10);
      expect(scene.stickHeld(0)).toBe(true);

      // The right thumb aims with a light push and fires when pushed out, while the left still walks.
      const ammo = y.gun.ammo;
      down(app, scene, 2, L.W * 0.86, L.H * 0.8);
      frames(app, 1);
      move(app, scene, 2, L.W * 0.86, L.H * 0.8 - 24);
      frames(app, 10);
      expect(y.gun.ammo).toBe(ammo);
      const aimed = y.player.aim;
      move(app, scene, 2, L.W * 0.86 - 50, L.H * 0.8);
      frames(app, 20);
      expect(y.gun.ammo).toBeLessThan(ammo);
      expect(y.player.aim).not.toBe(aimed);
      up(app, scene, 2, L.W * 0.86 - 50, L.H * 0.8);
      up(app, scene, 1, L.W * 0.14 + 50, L.H * 0.8);
      frames(app, 2);
      const spent = y.gun.ammo;
      frames(app, 10);
      expect(y.gun.ammo).toBe(spent);

      // Reload, then swap weapons from the weapon panel.
      tapBox(app, scene, L.reload);
      expect(y.gun.reloading).toBe(true);
      const weapon = y.weapon;
      tapBox(app, scene, L.weapon);
      expect(y.weapon).not.toBe(weapon);

      // Hold the grenade button to see the arc; let go to throw.
      const grenades = y.grenades;
      down(app, scene, 3, ...centre(L.grenade));
      frames(app, 5);
      expect(scene.grenadeAiming).toBe(true);
      expect(texts(app)).toContain("RELEASE TO THROW");
      expect(tooSmall(app)).toEqual([]);
      up(app, scene, 3, ...centre(L.grenade));
      frames(app, 3);
      expect(scene.grenadeAiming).toBe(false);
      expect(y.grenades).toBe(grenades - 1);
    });
  });
}

test("a laptop keeps the designed HUD, its keyboard hints and the mouse", async () => {
  const app = await start("laptop");
  expect(app.screen.touch).toBe(false);
  expect(app.screen.uiScale).toBe(1);
  const scene = play(app);
  expect(scene.ui.scaleX).toBe(1);
  expect(scene.uiWidth).toBe(1280);
  expect(scene.uiHeight).toBe(720);
  const L = layoutOf(scene);
  expect(L.touch).toBe(false);
  expect(L.vitals).toEqual({ x: 20, y: 20, w: 270, h: 92 });
  expect(L.weapon).toEqual({ x: 1010, y: 608, w: 250, h: 92 });
  expect(scene.aimDevice).toBe("pointer");
  expect(texts(app)).toContain("WASD move · mouse aim · click fire");
  expect(texts(app)).toContain("1 · Q");
  expect(texts(app)).not.toContain("TAP TO SWAP");
  for (const name of ["Pause", "Swap weapon", "Grenade", "Reload"]) expect(targets(app)).not.toContain(name);
});

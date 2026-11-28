// Lowline on phones and tablets: the HUD grows (blackiron.json `ui.minPoints`), every HUD text
// reads at 11 points or more, every tap target is at least 44 points, and nothing runs off the
// screen or under the notch. Street signs are painted into the city and scale with it, so the
// checks hide the world.
import { test, expect } from "bun:test";
import { createTestApp, stepFrames } from "@blackiron-studio/engine/testkit";
import type { App } from "@blackiron-studio/engine/app";
import config from "../blackiron.json";
import main, { LowlineScene } from "./main.ts";

const project = { viewport: config.viewport as { width: number; height: number; scale: "expand" }, ui: config.ui };

/** Text and tap targets of the UI layer alone (HUD and drive pad), in points. */
function measure(app: App) {
  const s = app.scene as LowlineScene;
  s.world.visible = false;
  const audit = app.auditScreen();
  s.world.visible = true;
  const k = app.screen.pointsPerUnit * s.ui.scaleX;
  return {
    audit,
    targets: s.reportedTargets.map((h) => ({ id: h.name, w: h.w * k, h: h.h * k, x: h.x, y: h.y, right: h.x + h.w, bottom: h.y + h.h })),
  };
}
/** Tap a HUD target by id, through the same screen coordinates a finger would give. */
function tap(app: App, id: string) {
  const s = app.scene as LowlineScene,
    t = s.hud.targets.find((h) => h.id === id)!,
    k = s.ui.scaleX;
  s.onPointerDown(s.ui.x + (t.x + t.w / 2) * k, s.ui.y + (t.y + t.h / 2) * k);
}
/** Every HUD state the game has, in an order one run can reach. */
function states(s: LowlineScene): [string, () => void][] {
  const r = s.run;
  return [
    ["title", () => {}],
    ["on foot", () => s.onAction("confirm", true)],
    ["beside a car", () => void (r.player = { x: 740, y: 1260 })],
    ["driving", () => r.interact()],
    ["pursuit", () => {
      const m = r.vehicle!.motor;
      m.x = r.objective.x;
      m.y = r.objective.y + 60;
      r.interact();
    }],
    ["map", () => void (s.mapOpen = true)],
    ["paused", () => {
      s.mapOpen = false;
      s.pause();
    }],
    ["won", () => {
      s.resume();
      r.phase = "won";
    }],
    ["lost", () => void (r.phase = "lost")],
    ["free roam", () => {
      r.phase = "won";
      s.onAction("confirm", true);
    }],
  ];
}

for (const device of ["iphone-se", "iphone-15", "ipad"]) {
  test(`${device}: every HUD state reads and every tap target fits a finger`, async () => {
    const app = await createTestApp({ device, config: project });
    await main(app);
    const s = app.scene as LowlineScene;
    expect(app.screen.touch).toBe(true);
    // Touch controls and wording from the first frame, before any touch.
    expect(s.pad.active).toBe(true);
    if (app.screen.compact) expect(app.screen.pointsPerUnit * s.ui.scaleX).toBeCloseTo(0.8, 6);
    const [it, ir, ib, il] = s.uiInsets,
      seen = new Set<string>();
    for (const [name, enter] of states(s)) {
      enter();
      stepFrames(app, 2);
      const { audit, targets } = measure(app);
      expect(audit.text.length).toBeGreaterThan(3);
      expect(targets.length).toBeGreaterThan(0);
      expect({ name, small: audit.smallText.map((t) => `${t.text} ${t.points.toFixed(1)}pt`) }).toEqual({ name, small: [] });
      expect({ name, small: audit.smallTargets.map((t) => t.name) }).toEqual({ name, small: [] });
      for (const t of targets) {
        seen.add(t.id);
        expect({ name, id: t.id, short: Math.min(t.w, t.h) >= 44 - 1e-6 }).toEqual({ name, id: t.id, short: true });
        // Inside the screen, and clear of the notch and the home bar.
        const inside = t.x >= il - 1e-6 && t.y >= it - 1e-6 && t.right <= s.uiWidth - ir + 1e-6 && t.bottom <= s.uiHeight - ib + 1e-6;
        expect({ name, id: t.id, inside }).toEqual({ name, id: t.id, inside: true });
      }
    }
    // Every control was on screen at some point: HUD buttons and the drive pad.
    for (const id of ["start", "map", "pause", "main", "restart", "ENTER", "EXIT", "GAS", "BRAKE", "DRIFT"]) expect({ id, seen: seen.has(id) }).toEqual({ id, seen: true });
    // Taps land where the grown HUD draws: pause, back to the city, open and close the map.
    tap(app, "pause");
    expect(s.run.phase).toBe("paused");
    stepFrames(app, 2);
    tap(app, "main");
    expect(s.run.phase).toBe("playing");
    stepFrames(app, 2);
    tap(app, "map");
    expect(s.mapOpen).toBe(true);
    stepFrames(app, 2);
    expect(s.pad.visible).toBe(false);
    tap(app, "map");
    expect(s.mapOpen).toBe(false);
    app.destroy();
  });
}

test("a phone's thumbs drive: the stick steers, GAS accelerates, the action button gets out", async () => {
  const app = await createTestApp({ device: "iphone-15", config: project });
  await main(app);
  const s = app.scene as LowlineScene,
    r = s.run,
    k = s.ui.scaleX,
    screen = (x: number, y: number): [number, number] => [s.ui.x + x * k, s.ui.y + y * k];
  s.onAction("confirm", true);
  expect(r.notice).toContain("tap ENTER");
  r.player = { x: 740, y: 1260 };
  stepFrames(app, 2);
  expect(s.pad.action).toBe("ENTER");
  r.interact();
  stepFrames(app, 2);
  const gas = s.pad.buttons().find((b) => b.id === "gas")!;
  app.pointer.touches.set(1, { x: screen(gas.x, gas.y)[0], y: screen(gas.x, gas.y)[1] });
  stepFrames(app, 30);
  expect(s.pad.held.gas).toBe(true);
  expect(Math.abs(r.vehicle!.motor.speed)).toBeGreaterThan(20);
  app.pointer.touches.clear();
  // A thumb down on the left, dragged right: the stick follows in UI units.
  const [rx, ry] = s.pad.rest();
  app.pointer.touches.set(2, { x: screen(rx, ry)[0], y: screen(rx, ry)[1] });
  stepFrames(app, 1);
  app.pointer.touches.set(2, { x: screen(rx + 62, ry)[0], y: screen(rx + 62, ry)[1] });
  stepFrames(app, 1);
  expect(s.pad.sx).toBeCloseTo(1, 3);
  app.pointer.touches.clear();
  r.vehicle!.motor.stop();
  stepFrames(app, 2);
  expect(s.pad.action).toBe("EXIT");
  const act = s.pad.buttons().find((b) => b.id === "act")!;
  app.pointer.touches.set(3, { x: screen(act.x, act.y)[0], y: screen(act.x, act.y)[1] });
  stepFrames(app, 2);
  expect(r.vehicle).toBeNull();
  app.destroy();
});

test("a laptop keeps the 1280 x 720 HUD at full size, with key hints and no touch pad", async () => {
  const app = await createTestApp({ device: "laptop", config: project });
  await main(app);
  const s = app.scene as LowlineScene;
  stepFrames(app, 2);
  expect(s.ui.scaleX).toBe(1);
  expect(s.pad.active).toBe(false);
  expect(s.hud.adaptive).toBe(false);
  expect(s.textFloor).toBe(0);
  expect(s.tapSize).toBe(0);
  s.onAction("confirm", true);
  stepFrames(app, 2);
  expect(s.run.notice).toContain("WASD");
  const texts = app.auditScreen().text.map((t) => t.text);
  expect(texts).toContain("WASD");
  expect(texts).toContain("M EXPAND");
  expect(s.reportedTargets.length).toBe(0);
  app.destroy();
});

test("a small mouse window gets the compact layout with nothing off screen", async () => {
  const app = await createTestApp({ device: { name: "small-window", width: 760, height: 430, pixelRatio: 1, insets: [0, 0, 0, 0], touch: false }, config: project });
  await main(app);
  const s = app.scene as LowlineScene;
  for (const [name, enter] of states(s)) {
    enter();
    stepFrames(app, 2);
    expect(s.pad.active).toBe(false);
    expect(s.hud.adaptive).toBe(true);
    for (const t of s.reportedTargets) {
      const inside = t.x >= 0 && t.y >= 0 && t.x + t.w <= s.uiWidth + 1e-6 && t.y + t.h <= s.uiHeight + 1e-6;
      expect({ name, id: t.name, inside }).toEqual({ name, id: t.name, inside: true });
    }
  }
  app.destroy();
});

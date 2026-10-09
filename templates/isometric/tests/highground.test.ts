import { beforeAll, expect, test } from "bun:test";
import { App } from "@blackiron-studio/engine/app";
import { bakeAtlas, resetSpriteRegistry, type Atlas } from "@blackiron-studio/engine/art";
import type { Progress } from "../src/shell.ts";
import type { PlayScene as PlaySceneType } from "../src/scenes/play.ts";

let PlayScene: typeof PlaySceneType;
let atlas: Atlas;
beforeAll(async () => {
  resetSpriteRegistry();
  PlayScene = (await import("../src/scenes/play.ts")).PlayScene;
  atlas = bakeAtlas();
});

async function game(progress: Progress | null = null) {
  const app = await App.create({ headless: true, atlas, config: { viewport: { width: 1280, height: 720 }, fps: false, seed: 5 } });
  app.audio.defineMood("ridge", { tempo: 84, root: 196, scale: [0, 2, 4, 7, 9] });
  const scene = new PlayScene(progress);
  app.scenes.change(scene);
  return { app, scene, state: scene as any };
}

test("saving restores collected coins, placed crates, player position and island exactly", async () => {
  const first = await game();
  try {
    const s = first.state;
    expect(s.totalCoins).toBe(30);
    const handle = s.coinCells[0], coin = { ...s.coins.get(handle) }, collectedKey = s.coinKeys.get(handle);
    s.gx = coin.x; s.gy = coin.y; s.gz = coin.z - 10;
    first.app.frame(1 / 60);
    expect(s.score).toBe(1);
    expect(s.coinCells.length).toBe(29);
    const point = s.camera.worldToScreen(s.gx, s.gy, s.gz);
    first.scene.onPointerDown(point[0], point[1]);
    first.scene.onPointerDown(point[0], point[1]);
    expect(s.placed).toBe(1);
    const progress = s.progress();
    expect(progress.collectedCells).toContain(collectedKey);
    expect(progress.crateCells.length).toBe(1);
    const resumed = await game(progress);
    try {
      expect(resumed.state.score).toBe(1);
      expect(resumed.state.coinCells.length).toBe(29);
      expect([...resumed.state.coinKeys.values()]).not.toContain(collectedKey);
      expect([...resumed.state.crateCells]).toEqual(progress.crateCells);
      expect(resumed.state.gx).toBe(s.gx);
      expect(resumed.state.gy).toBe(s.gy);
      for (let r = 0; r < 26; r++) for (let c = 0; c < 26; c++) {
        expect(resumed.state.map.get(c, r)).toBe(s.map.get(c, r));
        expect(resumed.state.map.elevationAt(c, r)).toBe(s.map.elevationAt(c, r));
      }
    } finally { resumed.app.destroy(); }
  } finally { first.app.destroy(); }
});

test("standing still performs no redundant fog writes", async () => {
  const { app, state } = await game();
  try {
    const original = state.map.setTint.bind(state.map);
    let writes = 0;
    state.map.setTint = (...args: number[]) => { writes++; original(...args); };
    for (let i = 0; i < 60; i++) app.frame(1 / 60);
    expect(writes).toBe(0);
  } finally { app.destroy(); }
});

test("all reachable coins can be collected and finish opens once", async () => {
  const { app, state } = await game();
  try {
    while (state.coinCells.length) {
      const coin = { ...state.coins.get(state.coinCells[0]) };
      state.gx = coin.x; state.gy = coin.y; state.gz = coin.z - 10; state.vz = 0;
      app.frame(1 / 60);
    }
    expect(state.score).toBe(30);
    expect(state.completed).toBe(true);
    const children = state.ui.children.length;
    app.frame(1 / 60);
    expect(state.ui.children.length).toBe(children);
    state.onAction("reset", true);
    for (let i = 0; i < 40; i++) app.frame(1 / 60);
    expect(app.scene instanceof PlayScene).toBe(true);
    expect((app.scene as any).score).toBe(0);
  } finally { app.destroy(); }
});

test("legacy count-only saves retire collected coins instead of duplicating them", async () => {
  const { app, state } = await game({ coins: 7, crates: 3 });
  try {
    expect(state.score).toBe(7);
    expect(state.coinCells.length).toBe(23);
    expect(state.progress().collectedCells.length).toBe(7);
  } finally { app.destroy(); }
});

test("jumping keeps contact, selection ring and camera on the current terrace", async () => {
  const { app, state } = await game();
  try {
    const floor = state.map.heightAt(state.gx, state.gy);
    expect(floor).toBeGreaterThan(0);
    state.onAction("jump", true);
    for (let i = 0; i < 12; i++) app.frame(1 / 60);
    expect(state.hero.z).toBeGreaterThan(floor + 15);
    expect(state.contact.z).toBe(floor);
    expect(state.footRing.z).toBe(floor);
    expect(state.cameraGround.z).toBe(floor);
    expect(state.camera.z).toBe(floor);
    expect(state.hero.castShadow).toBe(false);
    expect(state.contact.scaleX).toBeLessThan(0.8);
  } finally { app.destroy(); }
});

test("a jump buffered just before landing fires exactly once", async () => {
  const { app, state } = await game();
  try {
    const floor = state.map.heightAt(state.gx, state.gy);
    state.gz = floor + 1; state.vz = -100; state.grounded = false; state.coyote = 0;
    state.onAction("jump", true);
    app.frame(1 / 60);
    expect(state.vz).toBeGreaterThan(150);
    expect(state.grounded).toBe(false);
    expect(state.jumpBuffer).toBe(0);
    for (let i = 0; i < 70; i++) app.frame(1 / 60);
    expect(state.grounded).toBe(true);
    expect(state.gz).toBe(floor);
    expect(state.vz).toBe(0);
  } finally { app.destroy(); }
});

test("coyote jumps work briefly after a ledge, but never become an airborne double jump", async () => {
  const { app, state } = await game();
  try {
    const floor = state.map.heightAt(state.gx, state.gy);
    state.gz = floor + 12; state.vz = -10; state.grounded = false; state.coyote = 0.08;
    state.onAction("jump", true);
    app.frame(1 / 60);
    expect(state.vz).toBeGreaterThan(150);
    expect(state.coyote).toBe(0);
    state.onAction("jump", true);
    app.frame(1 / 60);
    expect(state.vz).toBeLessThan(160);
    state.coyote = 0; state.jumpBuffer = 0; state.gz = floor + 25; state.vz = -5;
    state.onAction("jump", true);
    app.frame(1 / 60);
    expect(state.vz).toBeLessThan(0);
  } finally { app.destroy(); }
});

test("analog travel controls speed even when a digital stick direction is down", async () => {
  const { app, state } = await game();
  try {
    app.input.map({ right: "GamepadLeftStickRight" });
    app.input.keyDown("GamepadLeftStickRight");
    app.gamepad.connected = true;
    app.gamepad.leftStick.x = 0.625;
    const x = state.gx, y = state.gy;
    app.frame(1 / 60);
    const half = Math.hypot(state.gx - x, state.gy - y);
    expect(half).toBeCloseTo(118 / 120, 5);
    state.gx = x; state.gy = y;
    app.gamepad.leftStick.x = 1;
    app.frame(1 / 60);
    expect(Math.hypot(state.gx - x, state.gy - y)).toBeCloseTo(half * 2, 5);
    app.input.keyUp("GamepadLeftStickRight");
    app.gamepad.leftStick.x = 0.2;
    const stoppedX = state.gx, stoppedY = state.gy;
    app.frame(1 / 60);
    expect(state.gx).toBe(stoppedX);
    expect(state.gy).toBe(stoppedY);
  } finally { app.destroy(); }
});

test("only a foreground canopy covering the hero fades, and it restores when behind", async () => {
  const { app, state } = await game();
  try {
    const tree = state.trees[0], away = state.trees[1];
    tree.setPosition(state.gx + 15, state.gy + 15); tree.z = state.gz;
    tree.scaleX = tree.scaleY = 1;
    away.setPosition(state.gx + 200, state.gy - 200); away.alpha = 1;
    state.updateOcclusion(0.3);
    expect(tree.alpha).toBeLessThan(0.25);
    expect(away.alpha).toBe(1);
    tree.setPosition(state.gx - 15, state.gy - 15);
    state.updateOcclusion(0.3);
    expect(tree.alpha).toBeGreaterThan(0.98);
  } finally { app.destroy(); }
});

test("pickup feedback fires once, its shadow disappears and labels expire", async () => {
  const { app, state } = await game();
  try {
    const handle = state.coinCells[0], coin = { ...state.coins.get(handle) };
    state.gx = coin.x; state.gy = coin.y; state.gz = state.map.heightAt(coin.x, coin.y);
    app.frame(1 / 60);
    expect(state.score).toBe(1);
    expect(state.scorePulse).toBe(1);
    expect(state.pickupLabels.length).toBe(1);
    expect(state.coinShadows.has(handle)).toBe(false);
    for (let i = 0; i < 45; i++) app.frame(1 / 60);
    expect(state.score).toBe(1);
    expect(state.pickupLabels.length).toBe(0);
  } finally { app.destroy(); }
});

test("landing bursts expire above a raised terrace instead of bouncing at sea level", async () => {
  const { app, state } = await game();
  try {
    const floor = state.map.heightAt(state.gx, state.gy);
    state.gz = floor + 1; state.vz = -120; state.grounded = false; state.coyote = 0;
    app.frame(1 / 60);
    expect(state.landingPulse).toBe(1);
    expect(state.sparks.count).toBe(10);
    for (let frame = 0; frame < 25; frame++) {
      for (let i = 0; i < state.sparks.capacity; i++) {
        const spark = state.sparks.get(i);
        if (spark.alive) expect(spark.z).toBeGreaterThanOrEqual(floor);
      }
      app.frame(1 / 60);
    }
    expect(state.sparks.count).toBe(0);
  } finally { app.destroy(); }
});

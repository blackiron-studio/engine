// The scenes headless: the art bakes, the yard draws, shooting a barrel retiles and removes its
// sprite, a grenade shows its arc while held, fog tints only what changed, and the end card
// appears once every sentry is down.

import { beforeAll, expect, test } from "bun:test";
import { App } from "@blackiron-studio/engine/app";
import { type Atlas, bakeAtlas, resetSpriteRegistry } from "@blackiron-studio/engine/art";
import type { PlayScene as PlaySceneType } from "../src/scenes/play.ts";
import type { YardTitle as YardTitleType } from "../src/scenes/title.ts";

let PlayScene: typeof PlaySceneType;
let YardTitle: typeof YardTitleType;
let atlas: Atlas;
beforeAll(async () => {
  resetSpriteRegistry();
  PlayScene = (await import("../src/scenes/play.ts")).PlayScene;
  YardTitle = (await import("../src/scenes/title.ts")).YardTitle;
  atlas = bakeAtlas();
});

async function game() {
  const app = await App.create({ headless: true, atlas, config: { viewport: { width: 1280, height: 720 }, fps: false, seed: 17 } });
  app.audio.defineMood("yard", { tempo: 92, root: 110, scale: [0, 3, 5, 7, 10] });
  app.audio.defineMood("menu", { tempo: 70, root: 98, scale: [0, 3, 7, 10] });
  app.input.map({ fire: ["Space"], grenade: ["KeyG"], left: ["KeyA"], right: ["KeyD"], up: ["KeyW"], down: ["KeyS"] });
  const scene = new PlayScene();
  app.scenes.change(scene);
  return { app, scene, state: scene as any };
}

test("every sprite the yard names is painted", () => {
  for (const name of ["slab", "wall.left", "brick.cracked.right", "crate.split.top", "pad", "barrel", "sentry.0", "sentry.7", "sentry.wreck", "op.3.a", "op.down", "blast.ring", "scorch", "reticle", "lock"]) {
    expect(atlas.has(name)).toBe(true);
  }
});

test("the title draws the yard behind the menu", async () => {
  const app = await App.create({ headless: true, atlas, config: { viewport: { width: 1280, height: 720 }, fps: false, seed: 17 } });
  try {
    app.audio.defineMood("menu", { tempo: 70, root: 98, scale: [0, 3, 7, 10] });
    app.scenes.change(new YardTitle({ title: "Sentry Yard", entries: [{ label: "Play" }] }));
    for (let i = 0; i < 30; i++) app.frame(1 / 60);
    expect(app.scenes.current?.name).toBe("title");
  } finally {
    app.destroy();
  }
});

test("shooting a barrel blows it, retiles the cell and drops its sprite", async () => {
  const { app, state } = await game();
  try {
    const y = state.yard;
    // Barrel at (3, 13); shoot along the row from four cells away, outside its blast.
    y.player.x = 7.5 * 32;
    y.player.y = 13.5 * 32;
    const key = 13 * y.cols + 3;
    expect(state.barrels.has(key)).toBe(true);
    const aim = Math.atan2(13.5 * 32 - y.player.y, 3.5 * 32 - y.player.x);
    state.readControls = () => ({ moveX: 0, moveY: 0, aim, aimZ: 12, aimDist: 128, fire: true });
    for (let i = 0; i < 90; i++) app.frame(1 / 60);
    expect(y.map.get(3, 13)).toBe(3); // OIL
    expect(state.barrels.has(key)).toBe(false);
    expect(state.map.get(3, 13)).toBe(3);
  } finally {
    app.destroy();
  }
});

test("holding a grenade shows the arc and the blast ring; release throws", async () => {
  const { app, state, scene } = await game();
  try {
    scene.onAction("grenade", true);
    for (let i = 0; i < 3; i++) app.frame(1 / 60);
    expect(state.blastRing.visible).toBe(true);
    expect(state.arc.count).toBeGreaterThan(5);
    scene.onAction("grenade", false);
    app.frame(1 / 60);
    expect(state.yard.grenades).toBe(4);
    expect(state.yard.grenadesInFlight.length).toBe(1);
    expect(state.blastRing.visible).toBe(false);
  } finally {
    app.destroy();
  }
});

test("standing still writes no tints once the yard has settled", async () => {
  const { app, state } = await game();
  try {
    // Look away from every turret so no cone sweeps across visible floor.
    for (const s of state.yard.sentries) s.state = "dead";
    for (let i = 0; i < 5; i++) app.frame(1 / 60);
    const original = state.map.setTint.bind(state.map);
    let writes = 0;
    state.map.setTint = (...args: number[]) => {
      writes++;
      original(...args);
    };
    for (let i = 0; i < 30; i++) app.frame(1 / 60);
    expect(writes).toBe(0);
  } finally {
    app.destroy();
  }
});

test("the end card shows once every sentry is down", async () => {
  const { app, state } = await game();
  try {
    for (const s of state.yard.sentries) state.yard.world.damage(s, 1000, { team: "operative" });
    for (let i = 0; i < 40; i++) app.frame(1 / 60);
    expect(state.ended).toBe(true);
  } finally {
    app.destroy();
  }
});

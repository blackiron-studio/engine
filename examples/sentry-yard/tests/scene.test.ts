// The scenes headless: the art bakes, the yard draws, shooting a barrel retiles and removes its
// sprite, a grenade shows its arc while held, fog tints only what changed, shots send tracers
// and leave holes, bolts carry trails and lights, a broken tile takes its marks with it, the
// operative turns through its views with the flash at the painted barrel, and the end card
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
  for (const name of ["slab", "wall.left", "brick.cracked.right", "crate.split.top", "pad", "barrel", "sentry.0", "sentry.7", "sentry.wreck", "op.3.a", "op.down", "blast.ring", "scorch.flat", "hole", "spark.streak", "bolt.streak", "reticle", "lock"]) {
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

test("rifle fire sends travelling tracers and leaves holes on the wall it hits", async () => {
  const { app, state } = await game();
  try {
    const y = state.yard;
    y.player.health.hp = 1e6;
    y.player.x = 11.5 * 32;
    y.player.y = 19.5 * 32;
    const [ax, ay] = [12.5 * 32, 16 * 32 - 1];
    state.readControls = () => ({ moveX: 0, moveY: 0, aim: Math.atan2(ay - y.player.y, ax - y.player.x), aimZ: 18, aimDist: Math.hypot(ax - y.player.x, ay - y.player.y), fire: true });
    let tracers = 0;
    for (let i = 0; i < 40; i++) {
      app.frame(1 / 60);
      tracers = Math.max(tracers, state.beams.count);
    }
    expect(tracers).toBeGreaterThan(0);
    expect(state.decals.count).toBeGreaterThan(2);
    expect(state.lights.count + state.beams.count).toBeGreaterThan(0);
  } finally {
    app.destroy();
  }
});

test("the operative turns through its views and fires from the painted barrel", async () => {
  const { app, state } = await game();
  try {
    const y = state.yard;
    y.player.health.hp = 1e6;
    y.player.x = 11.5 * 32;
    y.player.y = 19.5 * 32;
    let aim = 0;
    state.readControls = () => ({ moveX: 0, moveY: 0, aim, fire: false });
    for (let i = 0; i < 20; i++) app.frame(1 / 60);
    const hero = state.hero;
    const start = hero.direction.view;
    // A half turn: the body passes through the views in between.
    aim = Math.PI;
    const views: string[] = [start];
    let blended = false;
    for (let i = 0; i < 30; i++) {
      app.frame(1 / 60);
      const v = hero.direction.view;
      if (v !== views[views.length - 1]) views.push(v);
      blended ||= hero.blending;
    }
    expect(views[views.length - 1]).toBe("4");
    // Never straight from front to back: it catches up fast while far behind, then steps.
    expect(views.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < views.length; i++) {
      const step = Math.abs(Number(views[i]) - Number(views[i - 1]));
      expect(Math.min(step, 8 - step)).toBeLessThanOrEqual(i === views.length - 1 ? 1 : 2);
    }
    expect(blended).toBe(true);
    // Firing: the flash spawns where the painting's barrel ends.
    const muzzle = hero.pointInWorld("muzzle", 4);
    state.readControls = () => ({ moveX: 0, moveY: 0, aim, fire: true });
    const spawned: { sprite?: string; x: number; y: number; z: number }[] = [];
    const spawn = state.fx.spawn.bind(state.fx);
    state.fx.spawn = (o: { sprite?: string; x: number; y: number; z: number }) => {
      spawned.push(o);
      return spawn(o);
    };
    for (let i = 0; i < 4 && !spawned.some((o) => o.sprite === "muzzle"); i++) app.frame(1 / 60);
    const flash = spawned.find((o) => o.sprite === "muzzle");
    expect(flash).toBeDefined();
    expect(flash!.x).toBeCloseTo(muzzle[0], 3);
    expect(flash!.y).toBeCloseTo(muzzle[1], 3);
    expect(flash!.z).toBeCloseTo(muzzle[2], 3);
  } finally {
    app.destroy();
  }
});

test("sentry bolts carry a trail and a light while they fly", async () => {
  const { app, state } = await game();
  try {
    const y = state.yard;
    const s = y.sentries.find((q: { col: number; row: number }) => q.col === 8 && q.row === 8);
    s.base = s.facing = Math.atan2(3, 2);
    y.player.health.hp = 1e6;
    y.player.x = 11.5 * 32;
    y.player.y = 12.5 * 32;
    let seen = false;
    for (let i = 0; i < 180 && !seen; i++) {
      app.frame(1 / 60);
      if (y.bolts.count > 0 && state.trails.count > 0 && state.lights.count > 0) seen = true;
    }
    expect(seen).toBe(true);
  } finally {
    app.destroy();
  }
});

test("a broken tile takes its own marks with it, not its neighbour's", async () => {
  const { app, state } = await game();
  try {
    // Crates at (7, 10) and (8, 10): a mark on (7, 10)'s +x face sits on their shared edge.
    state.decals.mark(8 * 32, 10.5 * 32, 8, { sprite: "hole", normal: [1, 0, 0] });
    state.decals.mark(8.5 * 32, 10.5 * 32, 16, { sprite: "hole" });
    expect(state.decals.count).toBe(2);
    state.yard.world.damageTile(8, 10, 1000, "explosive");
    for (let i = 0; i < 3; i++) app.frame(1 / 60);
    expect(state.decals.count).toBe(1);
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

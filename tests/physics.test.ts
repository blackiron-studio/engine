// Physics through the kernel's Wasm build, driven the way a game drives it: nodes in a
// headless App, plus the world API directly.

import { beforeAll, describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { defineSprite, resetSpriteRegistry } from "../src/art/index.ts";
import { loadWasmPhysics } from "../src/physics/wasm.ts";
import { PhysicsWorld } from "../src/physics/world.ts";
import { Area2D, CharacterBody2D, RigidBody2D, Scene, StaticBody2D } from "../src/scene/index.ts";

const WASM = await Bun.file(new URL("../src/kernel/physics.wasm", import.meta.url)).arrayBuffer();

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("dot", { w: 4, h: 4 }, (p) => p.rect(0, 0, 4, 4, "#fff"));
});

describe("PhysicsWorld", () => {
  test("bodies fall, rest on the ground, and rays find them", async () => {
    const world = new PhysicsWorld(await loadWasmPhysics(WASM, 100), [0, 980]);
    const ground = world.createBody({ kind: "static", x: 0, y: 400 });
    world.createCollider(ground, { shape: { rect: [2000, 40] } });
    const crate = world.createBody({ kind: "dynamic", x: 0, y: 0 });
    const crateCollider = world.createCollider(crate, { shape: { rect: [32, 32] } });
    let started = 0;
    world.onCollision((e) => {
      if (e.kind === "start") started++;
    });
    for (let i = 0; i < 240; i++) world.step(1 / 60);
    expect(started).toBe(1);
    const st = world.state(crate);
    expect(st).toBeDefined();
    expect(Math.abs((st?.y ?? 0) - 364)).toBeLessThan(2);
    const hit = world.raycast(0, 0, 0, 1, 1000);
    expect(hit?.collider).toBe(crateCollider);
    expect(hit?.body).toBe(crate);
    expect(Math.abs((hit?.y ?? 0) - 348)).toBeLessThan(2);
    expect(world.pointQuery(0, 364)).toContain(crateCollider);
    expect(world.aabbQuery(-50, 300, 100, 200).length).toBeGreaterThanOrEqual(1);
    world.impulse(crate, 0, -600);
    world.step(1 / 60);
    expect(world.state(crate)?.vy).toBeLessThan(-100);
    world.destroy();
  });

  test("shape casts find the first thing a swept box touches, and one-way platforms let a character through from below", async () => {
    const world = new PhysicsWorld(await loadWasmPhysics(WASM, 100), [0, 980]);
    const ground = world.createBody({ kind: "static", x: 0, y: 300 });
    world.createCollider(ground, { shape: { rect: [1000, 20] } });
    const hit = world.shapeCast({ rect: [10, 10] }, 0, 0, 0, 1, 1000);
    expect(hit).not.toBeNull();
    // The box's centre stops five pixels above the ground's top edge, and the surface normal points up.
    expect(hit!.y).toBeCloseTo(285, 0);
    expect(hit!.ny).toBeCloseTo(-1, 2);
    expect(hit!.body).toBe(ground);
    expect(world.shapeCast({ rect: [10, 10] }, 0, 0, 0, -1, 1000)).toBeNull();
    expect(world.shapeCast({ circle: 5 }, 0, 0, 0, 1, 100)).toBeNull();

    const platform = world.createBody({ kind: "static", x: 0, y: 200 });
    world.createCollider(platform, { shape: { rect: [200, 10] }, oneWay: true });
    const body = world.createBody({ kind: "kinematic", x: 0, y: 250 });
    const col = world.createCollider(body, { shape: { rect: [20, 40] } });
    // Up through the platform from below.
    let r = world.characterMove(body, col, 0, -120, 1 / 60, { snap: 0 });
    expect(r.y).toBeCloseTo(130, 0);
    // Down onto it: the feet stop on its top.
    r = world.characterMove(body, col, 0, 100, 1 / 60, { snap: 0 });
    // Feet on the platform's top, less the controller's half-pixel skin.
    expect(r.y).toBeCloseTo(174.5, 0);
    expect(r.grounded).toBe(true);
    world.destroy();
  });

  test("joints hold bodies together", async () => {
    const world = new PhysicsWorld(await loadWasmPhysics(WASM, 100), [0, 980]);
    const anchor = world.createBody({ kind: "static", x: 0, y: 0 });
    world.createCollider(anchor, { shape: { circle: 4 } });
    const bob = world.createBody({ kind: "dynamic", x: 100, y: 0 });
    world.createCollider(bob, { shape: { circle: 8 } });
    world.createJoint({ kind: "rope", a: anchor, b: bob, length: 100 });
    for (let i = 0; i < 180; i++) world.step(1 / 60);
    const st = world.state(bob) as { x: number; y: number };
    expect(Math.hypot(st.x, st.y)).toBeLessThan(104);
    expect(st.y).toBeGreaterThan(50);
    world.destroy();
  });
});

describe("physics nodes", () => {
  async function appWith(scene: Scene): Promise<App> {
    const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 640, height: 360 }, fps: false } });
    await app.enablePhysics({ wasm: WASM, gravity: [0, 980] });
    app.scenes.change(scene);
    return app;
  }

  test("a RigidBody2D lands on a StaticBody2D and an Area2D sees it pass", async () => {
    const scene = new Scene();
    const app = await appWith(scene);
    scene.world.add(new StaticBody2D({ shape: { rect: [2000, 40] } }, 0, 400));
    const box = scene.world.add(new RigidBody2D({ shape: { rect: [32, 32] } }, 0, 0));
    const zone = scene.world.add(new Area2D({ shape: { rect: [200, 40] } }, 0, 200));
    const seen: string[] = [];
    zone.onEnter = (other) => seen.push(`enter ${other === box ? "box" : "?"}`);
    zone.onExit = (other) => seen.push(`exit ${other === box ? "box" : "?"}`);
    let hits = 0;
    box.onCollide = (other) => {
      if (other instanceof StaticBody2D) hits++;
    };
    for (let i = 0; i < 240; i++) app.frame(1 / 60);
    expect(Math.abs(box.y - 364)).toBeLessThan(2);
    expect(hits).toBe(1);
    expect(seen).toEqual(["enter box", "exit box"]);
    expect(zone.overlapping).toHaveLength(0);
    box.destroy();
    app.frame(1 / 60);
    expect(app.physics?.nodes.size).toBe(2);
  });

  test("a CharacterBody2D walks along the floor with gravity applied by the game", async () => {
    const scene = new Scene();
    const app = await appWith(scene);
    scene.world.add(new StaticBody2D({ shape: { rect: [2000, 20] } }, 0, 100));
    const hero = scene.world.add(new CharacterBody2D({ shape: { capsule: [40, 10] }, snap: 4 }, 0, 60));
    for (let i = 0; i < 60; i++) {
      hero.velocity.x = 120;
      hero.velocity.y += 980 / 60;
      hero.moveAndSlide(1 / 60);
      app.frame(1 / 60);
    }
    expect(hero.grounded).toBe(true);
    expect(hero.x).toBeGreaterThan(100);
    expect(hero.y).toBeGreaterThan(50);
    expect(hero.y).toBeLessThan(100);
  });
});

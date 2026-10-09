import { test, expect } from "bun:test";
import {
  FirstPersonLook,
  Vec3,
  PhysicsWorld3D,
  CharacterController3D,
  Weapon3D,
  CombatWorld3D,
  Projectile3D,
  NavigationGrid3D,
  spatialAudio3D,
} from "../src/three/index.ts";

test("first-person look keeps camera aim and movement aligned; mouse edges are independent of dt", () => {
  const look = new FirstPersonLook();
  expect(look.forward().z).toBe(-1);
  look.turn(Math.PI / 2, 0);
  expect(look.forward().x).toBeCloseTo(1);
  expect(look.movement(0, 1).x).toBeCloseTo(1);
  expect(look.movement(1, 1).length).toBeCloseTo(1);
  look.mouse(0, -100000);
  expect(look.pitch).toBeLessThan(Math.PI / 2);
  look.invertY = true;
  look.mouse(0, -10);
  expect(look.pitch).toBeLessThan(look.maxPitch);
  expect(
    spatialAudio3D(new Vec3(), new Vec3(1, 0, 0), new Vec3(-3, 0, 0)).pan,
  ).toBe(-1);
});
test("different weapon definitions reuse fire cadence, semi-auto edge, reload and deterministic spread", () => {
  const rifle = new Weapon3D({
    id: "rifle",
    magazine: 2,
    reserve: 5,
    damage: 10,
    range: 20,
    interval: 0.1,
    reloadSeconds: 0.3,
    automatic: true,
  });
  const aim = new Vec3(0, 0, -1);
  expect(rifle.trigger(true, aim)).toHaveLength(1);
  expect(rifle.trigger(true, aim)).toHaveLength(0);
  rifle.update(0.1);
  expect(rifle.trigger(true, aim)).toHaveLength(1);
  expect(rifle.reload()).toBe(true);
  rifle.update(0.3);
  expect([rifle.ammo, rifle.reserve]).toEqual([2, 3]);
  const def = {
    id: "scatter",
    magazine: 4,
    reserve: 8,
    damage: 10,
    range: 20,
    interval: 0.5,
    reloadSeconds: 1,
    pellets: 7,
    spread: 0.2,
  };
  const a = new Weapon3D(def, 9),
    b = new Weapon3D(def, 9);
  expect(a.trigger(true, aim)).toEqual(b.trigger(true, aim));
  a.update(1);
  expect(a.trigger(true, aim)).toHaveLength(0);
  a.release();
  expect(a.trigger(true, aim)).toHaveLength(7);
});
test("capsule grounds, jumps, hits a ceiling, slides along walls, and disposes with its world", async () => {
  const p = await PhysicsWorld3D.create();
  p.createBody({
    type: "fixed",
    position: { x: 0, y: -0.5, z: 0 },
    shape: { kind: "box", halfExtents: [20, 0.5, 20] },
  });
  p.createBody({
    type: "fixed",
    position: { x: 2, y: 2, z: 0 },
    shape: { kind: "box", halfExtents: [0.1, 2, 10] },
  });
  p.createBody({
    type: "fixed",
    position: { x: 0, y: 2.5, z: 0 },
    shape: { kind: "box", halfExtents: [1, 0.1, 1] },
  });
  const c = new CharacterController3D(p, { position: new Vec3(0, 0.1, 0) });
  p.step(1 / 60);
  const step = (n: number, d = new Vec3(), jump = false) => {
    for (let i = 0; i < n; i++) {
      c.move(d, 1 / 60, { jump: jump && i === 0 });
      p.step(1 / 60);
    }
  };
  step(30);
  expect(c.grounded).toBe(true);
  step(12, new Vec3(), true);
  expect(c.position.y).toBeGreaterThan(0.05);
  expect(c.position.y + c.options.height).toBeLessThan(2.42);
  step(60);
  expect(c.grounded).toBe(true);
  step(120, new Vec3(1, 0, -1));
  expect(c.position.x).toBeLessThan(1.61);
  expect(c.position.z).toBeLessThan(-5);
  p.dispose();
  expect(() => c.dispose()).not.toThrow();
  expect(p.stats.bodies).toBe(0);
});
test("capsule climbs authored stairs without tunnelling through tall cover", async () => {
  const p = await PhysicsWorld3D.create();
  p.createBody({
    type: "fixed",
    position: { x: 0, y: -0.5, z: 0 },
    shape: { kind: "box", halfExtents: [10, 0.5, 10] },
  });
  for (let i = 0; i < 6; i++)
    p.createBody({
      type: "fixed",
      position: { x: 0, y: (i + 1) * 0.12, z: -1 - i * 0.7 },
      shape: { kind: "box", halfExtents: [2, (i + 1) * 0.12, 0.35] },
    });
  const c = new CharacterController3D(p, {
    position: new Vec3(0, 0.05, 1),
    speed: 3,
  });
  p.step(1 / 60);
  let max = 0;
  for (let i = 0; i < 130; i++) {
    c.move(new Vec3(0, 0, -1), 1 / 60);
    p.step(1 / 60);
    max = Math.max(max, c.position.y);
  }
  expect(max).toBeGreaterThan(1.2);
  c.dispose();
  p.dispose();
});
test("hitscan and swept projectiles stop at cover and ignore their shooter", async () => {
  const p = await PhysicsWorld3D.create(),
    world = new CombatWorld3D(p);
  let damage = 0;
  const shooter = p.createBody({
    type: "kinematic",
    position: { x: 0, y: 1, z: 0 },
    shape: { kind: "sphere", radius: 0.3 },
  });
  const target = p.createBody({
    type: "kinematic",
    position: { x: 0, y: 1, z: -6 },
    sensor: true,
    shape: { kind: "sphere", radius: 0.5 },
  });
  world.register(target.collider(0).handle, {
    takeDamage: (e) => (damage += e.amount),
  });
  const wall = p.createBody({
    type: "fixed",
    position: { x: 0, y: 1, z: -3 },
    shape: { kind: "box", halfExtents: [2, 2, 0.02] },
  });
  p.step(1 / 60);
  const origin = new Vec3(0, 1, 0),
    direction = new Vec3(0, 0, -1);
  world.hitscan(origin, direction, 20, 10, shooter.collider(0).handle);
  expect(damage).toBe(0);
  const bullet = new Projectile3D(
    origin,
    new Vec3(0, 0, -200),
    1,
    20,
    shooter.collider(0).handle,
  );
  expect(bullet.step(world, 0.1)?.collider).toBe(wall.collider(0).handle);
  expect(damage).toBe(0);
  p.removeBody(wall);
  p.step(1 / 60);
  world.hitscan(origin, direction, 20, 10, shooter.collider(0).handle);
  expect(damage).toBe(10);
  world.dispose();
  p.dispose();
});
test("navigation finds a route around cover and rejects excessive elevation changes", () => {
  const grid = new NavigationGrid3D(10, 10, 1, 0, 0, (x, z) =>
    x > 4 && x < 6 && z < 8 ? null : 0,
  );
  const path = grid.findPath(new Vec3(2, 0, 2), new Vec3(8, 0, 2));
  expect(path.length).toBeGreaterThan(12);
  expect(path.some((p) => p.z > 8)).toBe(true);
  const cliff = new NavigationGrid3D(4, 4, 1, 0, 0, (x) => (x < 2 ? 0 : 3));
  expect(cliff.findPath(new Vec3(0.5, 0, 1), new Vec3(3, 3, 1))).toEqual([]);
});

test("beveled cuboids have outward winding, unit normals and bounded UVs", async () => {
  const { Geometry3D } = await import("../src/three/geometry.ts");
  const g = Geometry3D.beveledBox(2, 3, 4, 0.1);
  expect(g.indices.length / 3).toBe(44);
  for (let i = 0; i < g.positions.length; i += 3) {
    const p = new Vec3(g.positions[i], g.positions[i + 1], g.positions[i + 2]),
      n = new Vec3(g.normals[i], g.normals[i + 1], g.normals[i + 2]);
    expect(n.length).toBeCloseTo(1);
    expect(n.dot(p)).toBeGreaterThan(0);
  }
  expect(Array.from(g.uvs).every((v) => v >= 0 && v <= 1)).toBe(true);
  expect(() => Geometry3D.beveledBox(1, 1, 1, 0.6)).toThrow();
});

test("pointer capture transitions drain relative movement, release held fire and remove listeners", async () => {
  const { PointerLockInput } = await import("../src/input/pointer-lock.ts");
  const { ActionMap } = await import("../src/input/actions.ts");
  class FakeDocument extends EventTarget {
    pointerLockElement: unknown = null;
    defaultView = new EventTarget();
    exitPointerLock() {
      this.pointerLockElement = null;
      this.dispatchEvent(new Event("pointerlockchange"));
    }
  }
  const document = new FakeDocument();
  let captured = true;
  class FakeElement extends EventTarget {
    ownerDocument = document;
    hasPointerCapture() {
      return captured;
    }
    releasePointerCapture() {
      captured = false;
    }
    async requestPointerLock() {
      expect(captured).toBe(false);
      document.pointerLockElement = this;
      document.dispatchEvent(new Event("pointerlockchange"));
    }
  }
  const element = new FakeElement(),
    actions = new ActionMap().map({ fire: "Mouse0" }),
    input = new PointerLockInput(element as unknown as HTMLElement, actions);
  const event = (type: string, fields: object) =>
    Object.assign(new Event(type), fields);
  element.dispatchEvent(event("pointerdown", { pointerId: 1 }));
  expect(await input.request()).toBe(true);
  document.dispatchEvent(event("mousemove", { movementX: 10, movementY: -4 }));
  expect(input.consume()).toEqual({ x: 10, y: -4 });
  expect(input.consume()).toEqual({ x: 0, y: 0 });
  document.dispatchEvent(event("mousedown", { button: 0 }));
  expect(actions.isDown("fire")).toBe(true);
  input.release();
  expect(actions.isDown("fire")).toBe(false);
  input.dispose();
  document.dispatchEvent(event("mousemove", { movementX: 99, movementY: 99 }));
  expect(input.consume()).toEqual({ x: 0, y: 0 });
  expect(await input.request()).toBe(false);
});

test("pointer-lock fallback uses pointer events for right-drag aim and left fire, and clears on pause", async () => {
  const { PointerLockInput } = await import("../src/input/pointer-lock.ts");
  const { ActionMap } = await import("../src/input/actions.ts");
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: null,
    defaultView: new EventTarget(),
  });
  const element = Object.assign(new EventTarget(), { ownerDocument: doc });
  const actions = new ActionMap().map({ fire: "Mouse0" });
  const input = new PointerLockInput(
    element as unknown as HTMLElement,
    actions,
  );
  const event = (type: string, fields: object) =>
    Object.assign(new Event(type), {
      pointerId: 1,
      pointerType: "mouse",
      ...fields,
    });
  expect(await input.request()).toBe(false);
  input.setDragFallback(true);
  element.dispatchEvent(
    event("pointerdown", { button: 2, buttons: 2, clientX: 100, clientY: 100 }),
  );
  doc.dispatchEvent(
    event("pointermove", { buttons: 2, clientX: 135, clientY: 80 }),
  );
  expect(input.consume()).toEqual({ x: 35, y: -20 });
  expect(actions.isDown("fire")).toBe(false);
  doc.dispatchEvent(
    event("pointermove", { buttons: 3, clientX: 140, clientY: 80 }),
  );
  expect(actions.isDown("fire")).toBe(true);
  doc.dispatchEvent(
    event("pointermove", { buttons: 2, clientX: 145, clientY: 80 }),
  );
  expect(actions.isDown("fire")).toBe(false);
  element.dispatchEvent(event("pointerdown", { button: 0, buttons: 1 }));
  expect(actions.isDown("fire")).toBe(true);
  doc.dispatchEvent(event("pointerup", { button: 0, buttons: 0 }));
  expect(actions.isDown("fire")).toBe(false);
  element.dispatchEvent(event("pointerdown", { button: 0, buttons: 1 }));
  input.release();
  expect(input.dragFallback).toBe(false);
  expect(actions.isDown("fire")).toBe(false);
  doc.dispatchEvent(event("pointermove", { clientX: 250, clientY: 200 }));
  expect(input.consume()).toEqual({ x: 0, y: 0 });
  input.setDragFallback(true);
  element.dispatchEvent(event("pointerdown", { button: 0, buttons: 1 }));
  element.dispatchEvent(event("lostpointercapture", {}));
  expect(actions.isDown("fire")).toBe(false);
  input.dispose();
  input.setDragFallback(true);
  expect(input.dragFallback).toBe(false);
});

test("native pointer capture waits for OS acknowledgment and clears held input on loss", async () => {
  const { NativePointerLockInput, nativePointerCapture, nativePointerMotion } =
    await import("../src/input/native-pointer-lock.ts");
  const { ActionMap } = await import("../src/input/actions.ts");
  const actions = new ActionMap();
  actions.bind("fire", "Mouse0");
  const requests: boolean[] = [];
  const input = new NativePointerLockInput(
    { setPointerCapture: (v) => requests.push(v) },
    actions,
  );
  const pending = input.request();
  expect(input.locked).toBe(false);
  nativePointerMotion(actions, 9, 9);
  expect(input.consume()).toEqual({ x: 0, y: 0 });
  nativePointerCapture(actions, true);
  expect(await pending).toBe(true);
  nativePointerMotion(actions, 2, -3);
  nativePointerMotion(actions, 4, 1);
  expect(input.consume()).toEqual({ x: 6, y: -2 });
  expect(input.consume()).toEqual({ x: 0, y: 0 });
  actions.keyDown("Mouse0");
  nativePointerCapture(actions, false);
  expect(actions.isDown("fire")).toBe(false);
  expect(input.locked).toBe(false);
  const cancelled = input.request();
  input.dispose();
  expect(await cancelled).toBe(false);
  nativePointerCapture(actions, true);
  expect(input.locked).toBe(false);
  expect(requests.at(-1)).toBe(false);
});

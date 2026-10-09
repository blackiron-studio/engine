import { describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { ActionMap } from "../src/input/actions.ts";
import { Store, localStorageBackend } from "../src/save/store.ts";
import { AnimationPlayer } from "../src/scene/animation.ts";
import { Node, Node2D } from "../src/scene/node.ts";
import { CharacterBody2D, RigidBody2D, StaticBody2D } from "../src/scene/physics.ts";
import { Scene } from "../src/scene/scene.ts";
import { Button, routePointer } from "../src/scene/ui.ts";
import { TouchControls } from "../src/scene/touch.ts";
import { PauseScene, bindShellActions } from "../src/shell/index.ts";

const wasm = await Bun.file(new URL("../src/kernel/physics.wasm", import.meta.url)).arrayBuffer();

test("one Escape press resumes a shell pause without its pause alias reopening the menu", async () => {
  const app = await App.create({ headless: true, config: { fps: false } });
  class Game extends Scene {
    override onAction(name: string, pressed: boolean): void {
      if (name === "pause" && pressed) this.app.scenes.push(new PauseScene(), { overlay: true });
    }
  }
  const game = new Game();
  try {
    bindShellActions(app); app.scenes.change(game);
    const escape = () => { app.input.keyDown("Escape"); app.frame(1 / 60); app.input.keyUp("Escape"); app.frame(1 / 60); };
    escape(); expect(app.scenes.current).toBeInstanceOf(PauseScene);
    escape(); expect(app.scenes.current).toBe(game);
    expect(app.scenes.depth).toBe(1);
  } finally { app.destroy(); }
});

test("a later physical key in the same frame reaches the new scene after an alias transition", async () => {
  const app = await App.create({ headless: true, config: { fps: false } });
  const seen: string[] = [];
  class Next extends Scene { override onAction(name: string, pressed: boolean): void { if (pressed) seen.push(name); } }
  class First extends Scene { override onAction(_name: string, pressed: boolean): void { if (pressed) this.app.scenes.change(new Next()); } }
  try {
    app.input.map({ start: "Enter", alias: "Enter", move: "KeyW" });
    app.scenes.change(new First());
    app.input.keyDown("Enter"); app.input.keyDown("KeyW"); app.frame(1 / 60);
    expect(seen).toEqual(["move"]);
  } finally { app.destroy(); }
});

async function appWithPhysics(scene = new Scene(), gravity: [number, number] = [0, 980]): Promise<App> {
  const app = await App.create({ headless: true, config: { fps: false, seed: 1 } });
  await app.enablePhysics({ wasm, gravity });
  app.scenes.change(scene);
  return app;
}

describe("scene simulation ownership", () => {
  test("a covered scene freezes, cannot collide with an overlay, and resumes intact", async () => {
    const base = new Scene();
    const app = await appWithPhysics(base, [0, 0]);
    try {
      const body = base.world.add(new RigidBody2D({ shape: { circle: 10 } }, 100, 100));
      body.setVelocity(60, 0);
      app.frame(1 / 60);
      const x = body.x;
      const simulation = base.physics;
      const overlay = app.scenes.push(new Scene(), { overlay: true });
      const other = overlay.world.add(new RigidBody2D({ shape: { circle: 10 } }, x, 100));
      let collisions = 0;
      body.onCollide = other.onCollide = () => collisions++;
      for (let i = 0; i < 60; i++) app.frame(1 / 60);
      expect(base.physics).toBe(simulation);
      expect(overlay.physics).not.toBe(simulation);
      expect(app.physics).toBe(overlay.physics);
      expect(body.x).toBe(x);
      expect(other.x).toBeCloseTo(x);
      expect(collisions).toBe(0);
      app.scenes.pop();
      expect(overlay.physics).toBeNull();
      expect(overlay.attachedApp).toBeNull();
      app.frame(1 / 60);
      expect(body.x).toBeGreaterThan(x + 0.9);
    } finally { app.destroy(); }
  });

  test("time scale, hit stop, scene pause, and world pause freeze physics while UI keeps real time", async () => {
    const scene = new Scene();
    const app = await appWithPhysics(scene, [0, 0]);
    try {
      const body = scene.world.add(new RigidBody2D({ shape: { circle: 5 } }));
      body.setVelocity(60, 0);
      let uiTime = 0;
      class UIClock extends Node { override update(dt: number): void { uiTime += dt; } }
      scene.ui.add(new UIClock());
      scene.timeScale = 0;
      for (let i = 0; i < 6; i++) app.frame(1 / 60);
      expect(body.x).toBe(0);
      expect(uiTime).toBeCloseTo(0.1);
      scene.timeScale = 0.5;
      for (let i = 0; i < 60; i++) app.frame(1 / 60);
      expect(body.x).toBeCloseTo(30, 2);
      const x = body.x;
      scene.hitStop(0.1);
      for (let i = 0; i < 6; i++) app.frame(1 / 60);
      expect(body.x).toBeCloseTo(x);
      scene.paused = true;
      app.frame(1 / 60);
      expect(body.x).toBeCloseTo(x);
      scene.paused = false;
      scene.world.paused = true;
      app.frame(1 / 60);
      expect(body.x).toBeCloseTo(x);
      scene.world.paused = false;
      app.frame(1 / 60);
      expect(body.x).toBeGreaterThan(x);
    } finally { app.destroy(); }
  });

  test("enabling physics after a scene attached adopts existing bodies; destroy frees every world once", async () => {
    const app = await App.create({ headless: true, config: { fps: false } });
    const scene = new Scene();
    app.scenes.change(scene);
    class DeferredBody extends RigidBody2D { override ready(): void {} }
    const body = scene.world.add(new DeferredBody({ shape: { circle: 5 } }));
    expect(body.physicsWorld).toBeNull();
    await app.enablePhysics({ wasm });
    expect(body.physicsWorld).toBe(scene.physics);
    const worlds = [scene.physics!, app.scenes.push(new Scene(), { overlay: true }).physics!];
    let freed = 0;
    for (const world of worlds) {
      const destroy = world.backend.destroy.bind(world.backend);
      world.backend.destroy = () => { freed++; destroy(); };
    }
    app.destroy();
    app.destroy();
    for (const world of worlds) world.destroy();
    expect(freed).toBe(2);
  });

  test("concurrent physics initialization shares one world", async () => {
    const app = await App.create({ headless: true, config: { fps: false } });
    try {
      const [a, b] = await Promise.all([app.enablePhysics({ wasm }), app.enablePhysics({ wasm })]);
      expect(a).toBe(b);
      expect(app.scenes.change(new Scene()).physics).toBe(a);
    } finally { app.destroy(); }
  });
});

describe("physics coordinate conversion", () => {
  test("nested rigid bodies preserve local position and rotation across a zero-duration refresh", async () => {
    const scene = new Scene();
    const app = await appWithPhysics(scene, [0, 0]);
    try {
      const parent = scene.world.add(new Node2D(100, 100));
      parent.rotation = Math.PI / 2;
      parent.scale = 2;
      const plain = parent.add(new Node());
      const nested = plain.add(new RigidBody2D({ shape: { circle: 1 } }, 10, 3));
      nested.teleport(10, 3, 0.3);
      scene.physics!.step(0);
      nested.afterStep();
      expect(nested.x).toBeCloseTo(10, 4);
      expect(nested.y).toBeCloseTo(3, 4);
      expect(nested.rotation).toBeCloseTo(0.3, 4);
      expect(scene.physics!.state(nested.body)!.rotation).toBeCloseTo(Math.PI / 2 + 0.3, 4);
      const fixed = plain.add(new StaticBody2D({ shape: { rect: [3, 8] } }, 20, 5));
      parent.rotation = Math.PI / 4;
      fixed.beforeStep();
      expect(scene.physics!.getBody(fixed.body)!.rotation).toBeCloseTo(Math.PI / 4, 4);
      const hero = plain.add(new CharacterBody2D({ shape: { circle: 1 }, snap: 0 }, 50, 50));
      hero.moveAndSlide(1 / 60);
      expect(hero.x).toBeCloseTo(50, 3);
      expect(hero.y).toBeCloseTo(50, 3);
    } finally { app.destroy(); }
  });
});

describe("tree mutation and UI routing", () => {
  test("actions and pointer edges after a scene change reach the active scene", async () => {
    const app = await App.create({ headless: true, config: { fps: false } });
    const seen: string[] = [];
    class Next extends Scene {
      override onAction(name: string): void { seen.push(`next:${name}`); }
      override onPointerDown(): void { seen.push("next:pointer"); }
    }
    class First extends Scene {
      override onAction(name: string): void {
        if (name === "go") this.app.scenes.change(new Next());
        else seen.push(`old:${name}`);
      }
    }
    try {
      app.scenes.change(new First());
      app.input.press("go");
      app.input.press("other");
      app.pointer.handleDown(10,10);
      app.frame(1/60);
      expect(seen).toEqual(["next:other", "next:pointer"]);
    } finally { app.destroy(); }
  });

  test("detaching touch controls releases their held sources while keeping keyboard sources", async () => {
    const app = await App.create({ headless: true, config: { fps: false } });
    try {
      const scene = app.scenes.change(new Scene());
      const controls = scene.ui.add(new TouchControls({ always: true, stick: { left: "left", right: "right", up: "up", down: "down" } }));
      const y = app.height * 0.7;
      app.pointer.handleDown(20,y,0,1,"touch");
      controls.update();
      app.pointer.handleMove(100,y,"touch",1);
      controls.update();
      expect(app.input.isDown("right")).toBe(true);
      app.input.press("right");
      app.scenes.change(new Scene());
      expect(app.input.isDown("right")).toBe(true);
      app.input.release("right");
      expect(app.input.isDown("right")).toBe(false);
    } finally { app.destroy(); }
  });
  test("destroying the current child never skips siblings, and additions wait for the next step", () => {
    const root = new Node();
    const log: string[] = [];
    class Probe extends Node {
      constructor(private readonly tag: string, private readonly run?: () => void) { super(); }
      override update(): void { log.push(this.tag); this.run?.(); }
    }
    const first = root.add(new Probe("first", () => { first.destroy(); root.add(new Probe("new")); }));
    root.add(new Probe("second"));
    root.add(new Probe("third"));
    root.updateTree(1 / 60);
    expect(log).toEqual(["first", "second", "third"]);
    root.updateTree(1 / 60);
    expect(log.slice(3)).toEqual(["second", "third", "new"]);
    expect(() => root.children[0].add(root)).toThrow("descendant");
  });

  test("self-removal during exit is reentrant and each sibling exits once", async () => {
    const app = await App.create({ headless: true, config: { fps: false } });
    const scene = app.scenes.change(new Scene());
    let exits = 0;
    class RemovesOnExit extends Node { override exit(): void { exits++; this.destroy(); } }
    scene.world.add(new RemovesOnExit());
    scene.world.add(new RemovesOnExit());
    app.destroy();
    expect(exits).toBe(2);
  });

  test("a scene change during an update does not update the detached subtree", async () => {
    const app = await App.create({ headless: true, config: { fps: false } });
    let oldUpdates = 0;
    class ChangesScene extends Scene { override update(): void { app.scenes.change(new Scene()); } }
    class OldNode extends Node { override update(): void { oldUpdates++; } }
    try {
      const scene = app.scenes.change(new ChangesScene());
      scene.world.add(new OldNode());
      app.frame(1 / 60);
      expect(oldUpdates).toBe(0);
    } finally { app.destroy(); }
  });

  test("hidden ancestors cannot receive hits and pointer order agrees with zIndex and ySort", async () => {
    const app = await App.create({ headless: true, config: { fps: false } });
    try {
      const scene = app.scenes.change(new Scene());
      const panel = scene.ui.add(new Node2D());
      const hidden = panel.add(new Button("hidden", 0, 0, 100, 40));
      const front = scene.ui.add(new Button("front", 200, 0, 100, 50));
      front.zIndex = 10;
      const back = scene.ui.add(new Button("back", 200, 0, 100, 50));
      app.frame(1 / 60);
      panel.visible = false;
      expect(hidden.hitTest(20, 20)).toBe(false);
      const p = { x: 220, y: 20, down: false, justPressed: false, justReleased: false };
      expect(routePointer(scene.ui, p)).toBe(front);
      front.zIndex = -1;
      expect(routePointer(scene.ui, p)).toBe(back);
      front.zIndex = 0;
      scene.ui.ySort = true;
      front.y = 5;
      app.frame(1 / 60);
      expect(routePointer(scene.ui, p)).toBe(front);
    } finally { app.destroy(); }
  });

  test("120 Hz rendering routes one pointer press but preserves the simulation edge", async () => {
    const app = await App.create({ headless: true, config: { fps: false } });
    let presses = 0, releases = 0, simulatedPresses = 0;
    class FastScene extends Scene {
      override onPointerDown(): void { presses++; }
      override onPointerUp(): void { releases++; }
      override update(): void { if (app.pointer.justPressed) simulatedPresses++; }
    }
    try {
      app.scenes.change(new FastScene());
      app.pointer.handleDown(10, 10);
      app.frame(1 / 120);
      expect(app.pointer.justPressed).toBe(true);
      app.frame(1 / 120);
      expect(presses).toBe(1);
      expect(simulatedPresses).toBe(1);
      app.pointer.handleUp(10, 10);
      app.frame(1 / 120);
      app.frame(1 / 120);
      expect(releases).toBe(1);
    } finally { app.destroy(); }
  });
});

describe("save, animation and rebinding regressions", () => {
  test("quota rejection returns false rather than a false success", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    let writes = 0;
    try {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        setItem() { if (writes++ > 0) throw new Error("QuotaExceededError"); },
        getItem() { return null; }, removeItem() {},
      } });
      const backend = localStorageBackend();
      expect(backend).not.toBeNull();
      const store = new Store({ key: "regression", version: 1, initial: () => ({}), backend: backend! });
      expect(store.save({})).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("blends preserve each object's starting values even when IDs coincide", () => {
    const player = new AnimationPlayer();
    const left = { id: 1, x: 0 }, right = { id: 1, x: 100 };
    player.define("pose", { length: 2, properties: [
      { target: left, property: "x", keys: [[0, 10], [2, 10]] },
      { target: right, property: "x", keys: [[0, 110], [2, 110]] },
    ] }).play("pose", { blend: 1 });
    expect([left.x, right.x]).toEqual([0, 100]);
    player.update(0.5);
    expect([left.x, right.x]).toEqual([5, 105]);
    player.update(0.5);
    expect([left.x, right.x]).toEqual([10, 110]);
  });

  test("rebinding reconciles held keys, de-duplicates codes, and retains direct touch sources", () => {
    const actions = new ActionMap().map({ move: "KeyA" });
    actions.keyDown("KeyA");
    actions.bind("move", "KeyB");
    actions.keyUp("KeyA");
    expect(actions.isDown("move")).toBe(false);
    expect(actions.justReleased("move")).toBe(true);
    actions.keyDown("KeyC");
    actions.bind("move", ["KeyC", "KeyC"]);
    expect(actions.isDown("move")).toBe(true);
    actions.press("move");
    actions.bind("move", "KeyD");
    actions.keyUp("KeyC");
    expect(actions.isDown("move")).toBe(true);
    actions.release("move");
    expect(actions.isDown("move")).toBe(false);
  });
});

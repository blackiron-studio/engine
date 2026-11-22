// Combat: health and armour, traces that stop at walls or the nearest enemy, friendly fire,
// knockback, explosions that fade and hide behind walls, destructible tiles with stages,
// chain reactions and saves, weapons (auto, semi, burst, pellets, bloom, reload), swept
// projectiles, ground picking, twin-stick aim, aim assist and throws that match their preview.

import { describe, expect, test } from "bun:test";
import {
  AimAssist,
  CombatWorld2D,
  type CombatTarget2D,
  DestructibleGrid,
  Health,
  Projectiles2D,
  type ScreenProjector,
  THROW_STEP,
  Thrown2D,
  TwinStickAim,
  Weapon2D,
  type WeaponDef2D,
  gridWalls,
  heightField,
  hitscanShot,
  launchVelocity,
  pickGround,
  predictThrow,
  screenDirToWorld,
} from "../src/combat/index.ts";
import { type SightGrid, TileMapData } from "../src/core/index.ts";
import { Camera2D } from "../src/scene/camera.ts";

const WALL = 1;
const CRATE = 2;
const CRATE_DENTED = 3;
const CRATE_SMASHED = 4;
const BARREL = 5;
const RUBBLE = 6;

function arena(rows: string[], cell = 10) {
  const map = TileMapData.fromAscii(rows, { ".": 0, "#": WALL, c: CRATE, b: BARREL });
  const grid: SightGrid = {
    cols: map.cols,
    rows: map.rows,
    cell,
    opaque: (c, r) => !map.inBounds(c, r) || (map.get(c, r) !== 0 && map.get(c, r) !== RUBBLE),
  };
  const destructibles = new DestructibleGrid(
    map,
    {
      [CRATE]: { hp: 30, stages: [CRATE_DENTED, CRATE_SMASHED], broken: RUBBLE, resist: { bullet: 0.5 } },
      [BARREL]: { hp: 10, broken: 0, explode: { radius: 25, damage: 50, delay: 0.1 } },
    },
    { cell },
  );
  const world = new CombatWorld2D({ walls: gridWalls(grid), destructibles });
  return { map, grid, world, destructibles };
}

function unit(x: number, y: number, team: string, hp = 100, radius = 3): CombatTarget2D {
  return { x, y, team, radius, health: new Health(hp), vx: 0, vy: 0 };
}

describe("Health", () => {
  test("armour soaks first, resistances scale, grace blocks repeats", () => {
    const h = new Health({ max: 100, armour: 20, absorb: 0.5, resist: { fire: 2 }, grace: 0.5 });
    expect(h.take(20)).toBe(10); // half soaked by armour
    expect(h.armour).toBe(10);
    expect(h.take(50)).toBe(0); // invulnerable
    h.update(0.6);
    expect(h.take(10, "fire")).toBe(10); // 20 after resist, 10 soaked
    expect(h.armour).toBe(0);
    h.update(1);
    expect(h.take(500)).toBe(80);
    expect(h.dead).toBe(true);
    expect(h.heal(10)).toBe(0);
    h.reset();
    expect(h.hp).toBe(100);
    expect(h.armour).toBe(20);
  });
});

describe("CombatWorld2D", () => {
  test("traces stop at the nearest of wall or enemy and pass teammates", () => {
    const { world } = arena(["##########", "#........#", "#........#", "##########"]);
    const ally = world.add(unit(30, 15, "blue"));
    const foe = world.add(unit(60, 15, "red"));
    const hit = world.trace(12, 15, 95, 15, { team: "blue" })!;
    expect(hit.target).toBe(foe);
    expect(hit.x).toBeCloseTo(57);
    expect(hit.nx).toBeCloseTo(-1);
    world.remove(foe);
    const wall = world.trace(12, 15, 95, 15, { team: "blue" })!;
    expect(wall.target).toBeNull();
    expect(wall.wall!.col).toBe(9);
    expect(wall.x).toBeCloseTo(90);
    world.friendlyFire = true;
    expect(world.trace(12, 15, 95, 15, { team: "blue" })!.target).toBe(ally);
    expect(world.trace(12, 15, 95, 15, { team: "blue", ignore: ally })!.target).toBeNull();
  });

  test("damage knocks back, reports kills and respects teams", () => {
    const { world } = arena(["....."]);
    const foe = world.add({ ...unit(20, 5, "red", 30), mass: 2 });
    const kills: unknown[] = [];
    world.on("kill", (e) => kills.push(e.target));
    expect(world.damage(foe, 10, { team: "red" })).toBeNull();
    const e = world.damage(foe, 10, { team: "blue", dirX: 3, dirY: 0, knockback: 40 })!;
    expect(e.amount).toBe(10);
    expect(foe.vx).toBe(20);
    world.damage(foe, 50, { team: "blue" });
    expect(kills).toEqual([foe]);
    expect(world.trace(0, 5, 49, 5, { team: "blue" })).toBeNull(); // the dead are not hit
  });

  test("explosions fade with distance and walls shelter what is behind them", () => {
    const { world } = arena(["##########", "#....#...#", "#........#", "##########"]);
    const near = world.add(unit(25, 15, "red"));
    const far = world.add(unit(45, 25, "red"));
    const hidden = world.add(unit(65, 15, "red"));
    world.explode({ x: 15, y: 15, z: 0, radius: 60, damage: 60, team: "blue" });
    expect(near.health.hp).toBeLessThan(far.health.hp);
    expect(far.health.hp).toBeLessThan(100);
    expect(hidden.health.hp).toBe(100);
    expect(CombatWorld2D.falloff({ radius: 10, damage: 1, falloff: 0 }, 9)).toBe(1);
    expect(CombatWorld2D.falloff({ radius: 10, damage: 1 }, 5)).toBeCloseTo(0.5);
    expect(CombatWorld2D.falloff({ radius: 10, damage: 1 }, 11)).toBe(0);
  });

  test("hitscan into a crate dents it through its stages, then breaks it", () => {
    const { world, map, destructibles } = arena(["#######", "#..c..#", "#######"]);
    const changes: number[] = [];
    world.on("tile", (c) => changes.push(c.to));
    const def: WeaponDef2D = { id: "rifle", damage: 12, interval: 0.1, magazine: 30, reloadSeconds: 1, range: 100 };
    const shot = { angle: 0, age: 0, damage: 12, index: 0, pellet: 0, recoil: 0 };
    const r = hitscanShot(world, def, shot, 12, 15, { team: "blue" })!;
    expect(r.tile!.col).toBe(3);
    expect(destructibles.hpAt(3, 1)).toBe(24); // bullets do half
    for (let i = 0; i < 4; i++) hitscanShot(world, def, shot, 12, 15, { team: "blue" });
    expect(changes).toContain(CRATE_DENTED);
    expect(changes).toContain(CRATE_SMASHED);
    expect(map.get(3, 1)).toBe(RUBBLE);
    // Rubble does not block: the next shot reaches the far wall.
    expect(hitscanShot(world, def, shot, 12, 15, { team: "blue" })!.hit.wall!.col).toBe(6);
  });

  test("barrels chain on the world clock and the blast reaches the crate behind", () => {
    const { world, map } = arena(["##########", "#.bb.c...#", "##########"]);
    const booms: number[] = [];
    world.on("explode", (b) => booms.push(Math.round(world.time * 100) / 100));
    world.damageTile(2, 1, 100, "bullet");
    expect(map.get(2, 1)).toBe(0);
    expect(booms).toEqual([]);
    world.update(0.05);
    expect(booms).toEqual([]);
    world.update(0.06);
    expect(booms).toEqual([0.11]);
    expect(map.get(3, 1)).toBe(0); // the second barrel went
    expect(world.scheduled.length).toBe(1);
    world.update(0.1);
    expect(booms.length).toBe(2);
    expect(map.get(5, 1)).not.toBe(CRATE); // damaged by the second blast
  });

  test("nearestEnemy can require a clear view", () => {
    const { world } = arena(["#########", "#...#...#", "#.......#", "#########"]);
    const behind = world.add(unit(65, 15, "red"));
    const open = world.add(unit(75, 28, "red"));
    expect(world.nearestEnemy(15, 15, "blue")).toBe(behind);
    expect(world.nearestEnemy(15, 15, "blue", { visible: true })).toBe(open);
    expect(world.nearestEnemy(15, 15, "blue", { range: 20 })).toBeNull();
  });
});

describe("DestructibleGrid", () => {
  test("saves and restores damage, stages and broken cells", () => {
    const a = arena(["#####", "#cc.#", "#####"]);
    a.destructibles.damage(1, 1, 12);
    a.destructibles.damage(2, 1, 100);
    const saved = JSON.parse(JSON.stringify(a.destructibles.save()));
    const b = arena(["#####", "#cc.#", "#####"]);
    expect(b.destructibles.load(saved)).toBe(true);
    expect(b.map.get(1, 1)).toBe(CRATE_DENTED);
    expect(b.destructibles.hpAt(1, 1)).toBe(18);
    expect(b.map.get(2, 1)).toBe(RUBBLE);
    expect(b.destructibles.takeChanges().length).toBe(2);
    expect(b.destructibles.takeChanges()).toEqual([]);
    expect(arena(["###", "#c#"]).destructibles.load(saved)).toBe(false);
  });

  test("destroy ignores hit points; walls cannot be damaged", () => {
    const { destructibles, map } = arena(["#c#"]);
    expect(destructibles.damage(0, 0, 100)).toBeNull();
    expect(destructibles.destroy(1, 0)!.destroyed).toBe(true);
    expect(map.get(1, 0)).toBe(RUBBLE);
  });
});

describe("Weapon2D", () => {
  const rifle: WeaponDef2D = { id: "rifle", damage: 10, interval: 0.1, magazine: 5, reserve: 7, reloadSeconds: 0.5, range: 100, automatic: true, spread: 0.02, bloom: 0.05, bloomMax: 0.2, bloomRecovery: 0.5 };

  test("automatic fire keeps its rate at any frame rate", () => {
    const count = (dt: number) => {
      const w = new Weapon2D({ ...rifle, magazine: 1000 }, 3);
      let n = 0;
      for (let t = 0; t < 1 - 1e-9; t += dt) n += w.step(dt, { fire: true, angle: 0 }).length;
      return n;
    };
    // A second of fire from t = 0 to t = 1 inclusive: shots at 0, 0.1, ... 1.0.
    expect(count(1 / 60)).toBe(11);
    expect(count(1 / 15)).toBe(11);
    expect(count(0.25)).toBe(11);
    const w = new Weapon2D({ ...rifle, magazine: 100 });
    const shots = w.step(0.35, { fire: true, angle: 0 });
    expect(shots.map((s) => Math.round(s.age * 100) / 100)).toEqual([0.35, 0.25, 0.15, 0.05]);
  });

  test("magazine, auto reload and reserve", () => {
    const w = new Weapon2D(rifle);
    let fired = 0;
    for (let i = 0; i < 60; i++) fired += w.step(0.05, { fire: true, angle: 0 }).length;
    expect(fired).toBe(12);
    expect(w.ammo).toBe(0);
    expect(w.reserve).toBe(0);
    expect(w.reload()).toBe(false);
    expect(w.addAmmo(3)).toBe(3);
    expect(w.reload()).toBe(true);
    expect(w.reloading).toBe(true);
    w.step(0.25, { fire: false, angle: 0 });
    expect(w.reloadProgress).toBeCloseTo(0.5);
    w.step(0.3, { fire: false, angle: 0 });
    expect(w.ammo).toBe(3);
  });

  test("bloom grows with sustained fire and recovers", () => {
    // Recovery runs alongside fire: 10 shots a second at 0.05 each against 0.2 a second back.
    const w = new Weapon2D({ ...rifle, magazine: 100, bloomRecovery: 0.2 });
    for (let i = 0; i < 10; i++) w.step(0.1, { fire: true, angle: 0 });
    expect(w.bloom).toBeCloseTo(0.2);
    w.step(0.5, { fire: false, angle: 0 });
    expect(w.bloom).toBeCloseTo(0.1);
    expect(w.spread).toBeCloseTo(0.12);
  });

  test("semi-automatic needs a pull per shot and remembers an early one", () => {
    const w = new Weapon2D({ ...rifle, automatic: false, interval: 0.2 });
    expect(w.step(0.05, { fire: true, angle: 0 }).length).toBe(1);
    expect(w.step(0.05, { fire: true, angle: 0 }).length).toBe(0);
    w.step(0.05, { fire: false, angle: 0 });
    expect(w.step(0.02, { fire: true, angle: 0 }).length).toBe(0); // still cycling
    expect(w.step(0.02, { fire: false, angle: 0 }).length).toBe(0);
    expect(w.step(0.05, { fire: false, angle: 0 }).length).toBe(1); // the early pull fires
    w.step(0.5, { fire: false, angle: 0 });
    expect(w.step(0.05, { fire: false, angle: 0 }).length).toBe(0); // and is not remembered forever
  });

  test("bursts and pellets", () => {
    const burst = new Weapon2D({ id: "b", damage: 5, interval: 0.5, magazine: 9, reloadSeconds: 1, range: 50, burst: 3, burstInterval: 0.05 });
    expect(burst.step(0.12, { fire: true, angle: 0 }).length).toBe(3);
    expect(burst.ammo).toBe(6);
    expect(burst.step(0.12, { fire: true, angle: 0 }).length).toBe(0);
    const shotgun = new Weapon2D({ id: "s", damage: 6, interval: 0.6, magazine: 2, reloadSeconds: 1, range: 40, pellets: 7, spread: 0.6 }, 9);
    const pellets = shotgun.step(0.016, { fire: true, angle: 1 });
    expect(pellets.length).toBe(7);
    expect(shotgun.ammo).toBe(1);
    for (const p of pellets) expect(Math.abs(p.angle - 1)).toBeLessThanOrEqual(0.3 + 1e-9);
    const sorted = pellets.map((p) => p.angle).sort((a, b) => a - b);
    expect(sorted[6]! - sorted[0]!).toBeGreaterThan(0.35); // a real fan, not a clump
  });

  test("the same seed fires the same spread", () => {
    const a = new Weapon2D({ ...rifle, spread: 0.3 }, "s");
    const b = new Weapon2D({ ...rifle, spread: 0.3 }, "s");
    expect(a.step(0.3, { fire: true, angle: 0 })).toEqual(b.step(0.3, { fire: true, angle: 0 }));
  });

  test("bad definitions are refused", () => {
    expect(() => new Weapon2D({ ...rifle, magazine: 0 })).toThrow();
    expect(() => new Weapon2D({ ...rifle, interval: 0 })).toThrow();
    expect(() => new Weapon2D({ ...rifle, pellets: 1.5 })).toThrow();
  });
});

describe("Projectiles2D", () => {
  test("fast shots sweep instead of tunnelling, and splash on walls", () => {
    const { world } = arena(["############", "#..........#", "############"]);
    const shots = new Projectiles2D(world, 4);
    const foe = world.add(unit(60, 15, "red", 100, 2));
    shots.fire({ x: 15, y: 15, angle: 0, speed: 5000, range: 200, damage: 25, team: "blue", knockback: 10 });
    const hits = shots.update(1 / 60);
    expect(hits.length).toBe(1);
    expect(hits[0]!.damage!.target).toBe(foe);
    expect(foe.health.hp).toBe(75);
    expect(foe.vx).toBeCloseTo(10);
    expect(shots.count).toBe(0);
    world.remove(foe);
    const ally = world.add(unit(95, 15, "blue"));
    shots.fire({ x: 15, y: 15, angle: 0, speed: 600, range: 200, damage: 5, team: "blue", splash: { radius: 30, damage: 40 } });
    let wall = null;
    for (let i = 0; i < 30 && !wall; i++) wall = shots.update(1 / 60)[0] ?? null;
    expect(wall!.hit.wall!.col).toBe(11);
    expect(ally.health.hp).toBe(100); // no friendly fire
  });

  test("range runs out and the pool recycles the oldest", () => {
    const { world } = arena(["...................."]);
    const shots = new Projectiles2D(world, 2);
    const a = shots.fire({ x: 0, y: 5, angle: 0, speed: 100, range: 10, damage: 1 });
    shots.fire({ x: 0, y: 5, angle: 0, speed: 100, range: 50, damage: 1 });
    const c = shots.fire({ x: 0, y: 5, angle: 0, speed: 100, range: 50, damage: 1 });
    expect(c).toBe(a);
    shots.update(0.2);
    expect(shots.count).toBe(2);
    const late = shots.fire({ x: 0, y: 5, angle: 0, speed: 100, range: 50, damage: 1, age: 0.1 });
    expect(late.x).toBeCloseTo(10);
  });

  test("shoot picks hitscan or projectile from the weapon", () => {
    const { world } = arena(["#........#"]);
    const shots = new Projectiles2D(world);
    const shot = { angle: 0, age: 0, damage: 5, index: 0, pellet: 0, recoil: 0 };
    const bullet = shots.shoot({ id: "g", damage: 5, interval: 1, magazine: 1, reloadSeconds: 1, range: 90, speed: 300 }, shot, 15, 5);
    expect(shots.count).toBe(1);
    expect((bullet as { tag: string }).tag).toBe("g");
    const scan = shots.shoot({ id: "h", damage: 5, interval: 1, magazine: 1, reloadSeconds: 1, range: 90 }, shot, 15, 5);
    expect((scan as { hit: { wall: { col: number } } }).hit.wall.col).toBe(9);
  });
});

describe("aim", () => {
  function isoCamera(): Camera2D {
    const cam = new Camera2D(800, 600);
    cam.projection = { kind: "isometric", tile: { w: 64, h: 32 } };
    cam.x = 160;
    cam.y = 160;
    return cam;
  }

  test("pickGround finds the top of a raised block before the floor behind it", () => {
    const cam = isoCamera();
    const cell = 32;
    const heights = (x: number, y: number) => (Math.floor(x / cell) === 5 && Math.floor(y / cell) === 5 ? 48 : 0);
    const [sx, sy] = cam.worldToScreen(5.5 * cell, 5.5 * cell, 48);
    const top = pickGround(cam, sx, sy, heights, { maxZ: 64, step: 4 });
    expect(top.z).toBeCloseTo(48, 1);
    expect(top.x).toBeCloseTo(5.5 * cell, 0);
    expect(top.y).toBeCloseTo(5.5 * cell, 0);
    const [fx, fy] = cam.worldToScreen(2.5 * cell, 2.5 * cell, 0);
    const floor = pickGround(cam, fx, fy, heights, { maxZ: 64, step: 4 });
    expect(floor.z).toBe(0);
    expect(floor.x).toBeCloseTo(2.5 * cell, 1);
  });

  test("screen directions map onto the iso ground", () => {
    const cam = isoCamera();
    const [ux, uy] = screenDirToWorld(cam, 100, 100, 0, -1);
    // Straight up the screen is toward -x and -y equally on an isometric map.
    expect(ux).toBeCloseTo(uy, 5);
    expect(ux).toBeLessThan(0);
    const [wx, wy] = cam.worldToScreen(100 + ux * 10, 100 + uy * 10);
    const [ox, oy] = cam.worldToScreen(100, 100);
    expect(wx - ox).toBeCloseTo(0, 4);
    expect(wy - oy).toBeLessThan(0);
  });

  test("twin-stick follows whichever device moved last", () => {
    const aim = new TwinStickAim();
    const from = { x: 0, y: 0 };
    expect(aim.update({ from, pointer: { x: 10, y: 10 }, pointerGround: { x: 0, y: 5 } })).toBeCloseTo(Math.PI / 2);
    expect(aim.update({ from, stick: { x: 1, y: 0 }, pointer: { x: 10, y: 10 }, pointerGround: { x: 0, y: 5 } })).toBeCloseTo(0);
    expect(aim.device).toBe("stick");
    // Stick released, mouse still: the stick's aim stays.
    expect(aim.update({ from, stick: { x: 0.1, y: 0 }, pointer: { x: 10, y: 10 }, pointerGround: { x: 0, y: 5 } })).toBeCloseTo(0);
    expect(aim.update({ from, pointer: { x: 30, y: 10 }, pointerGround: { x: -5, y: 0 } })).toBeCloseTo(Math.PI);
    expect(aim.device).toBe("pointer");
  });

  test("aim assist bends toward the best target and sticks to it", () => {
    const assist = new AimAssist<{ x: number; y: number }>({ cone: 0.2, strength: 1, range: 200 });
    const a = { x: 100, y: 10 }; // ~0.1 rad off
    const b = { x: 100, y: -25 }; // ~0.25 rad off, outside the cone
    expect(assist.apply(0, 0, 0, [a, b])).toBeCloseTo(Math.atan2(10, 100));
    expect(assist.target).toBe(a);
    // Aim drifts toward b: a stays locked inside the sticky cone.
    assist.apply(0, 0, -0.15, [a, b]);
    expect(assist.target).toBe(a);
    // Hidden targets are skipped.
    assist.reset();
    expect(assist.apply(0, 0, 0, [a], () => false)).toBe(0);
    expect(new AimAssist({ strength: 0.5, cone: 0.3 }).apply(0, 0, 0, [a])).toBeCloseTo(Math.atan2(10, 100) / 2);
  });
});

describe("throws", () => {
  const flat = () => 0;

  test("launchVelocity lands on the target in open ground", () => {
    const v = launchVelocity(0, 0, 0, 200, 100, 0, { speed: 300 });
    const t = new Thrown2D(0, 0, 0, v.vx, v.vy, v.vz);
    const steps = Math.round(v.time / THROW_STEP);
    for (let i = 0; i < steps; i++) t.substep(flat);
    expect(t.x).toBeCloseTo(200, -1);
    expect(t.y).toBeCloseTo(100, -1);
    expect(t.landed).toBe(true);
  });

  test("the preview matches the throw at any frame rate", () => {
    const g: SightGrid = { cols: 20, rows: 20, cell: 20, opaque: (c, r) => c < 0 || r < 0 || c >= 20 || r >= 20 || c === 12, height: (c, r) => (r < 3 ? 30 : 0) };
    const ground = heightField(g);
    const v = launchVelocity(40, 100, 10, 300, 100, 0, { speed: 280 });
    const preview = predictThrow(40, 100, 10, v.vx, v.vy, v.vz, ground);
    for (const dt of [1 / 30, 1 / 60, 1 / 144, 0.1]) {
      const t = new Thrown2D(40, 100, 10, v.vx, v.vy, v.vz);
      for (let i = 0; i < 2000 && !t.resting; i++) t.step(dt, ground);
      expect(t.resting).toBe(true);
      expect(t.x).toBe(preview.end.x);
      expect(t.y).toBe(preview.end.y);
    }
    // It bounced back off the wall at column 12.
    expect(preview.end.x).toBeLessThan(12 * 20);
    expect(preview.bounces).toBeGreaterThan(0);
    expect(preview.landing).not.toBeNull();
  });

  test("bounces lose height, walls flip the speed that hit them, and it rests", () => {
    const wall = (x: number) => (x >= 100 ? Infinity : 0);
    const t = new Thrown2D(50, 0, 0, 200, 0, 300);
    const events: string[] = [];
    for (let i = 0; i < 2000 && !t.resting; i++) for (const e of t.step(1 / 60, wall)) events.push(e.kind);
    expect(events).toContain("wall");
    expect(events).toContain("bounce");
    expect(events[events.length - 1]).toBe("rest");
    expect(t.x).toBeLessThan(100);
  });

  test("a throw clears a low wall but not a tall one", () => {
    const low = (x: number) => (x >= 100 && x < 110 ? 20 : 0);
    const v = launchVelocity(0, 0, 0, 200, 0, 0, { speed: 250 });
    expect(predictThrow(0, 0, 0, v.vx, v.vy, v.vz, low, { stopAtLanding: true }).landing!.x).toBeGreaterThan(110);
    const tall = (x: number) => (x >= 100 && x < 110 ? 400 : 0);
    expect(predictThrow(0, 0, 0, v.vx, v.vy, v.vz, tall, { stopAtLanding: true }).landing!.x).toBeLessThan(100);
  });
});

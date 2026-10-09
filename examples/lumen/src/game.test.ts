import { expect, test } from "bun:test";
import { CORES, OBSTACLES, SALVAGE_DASH, createSalvage, dronePosition, stepSalvage } from "./game.ts";
import { overlapsGroundBox } from "../../../src/three/ground.ts";
test("collect each core once and return to beacon to finish", () => {
  const s = createSalvage();
  for (const [x, z] of CORES) {
    s.x = x;
    s.z = z;
    expect(stepSalvage(s, 0, 0, false, 1 / 60).collected.length).toBe(1);
    expect(stepSalvage(s, 0, 0, false, 1 / 60).collected.length).toBe(0);
  }
  expect(s.won).toBe(false);
  s.x = s.z = 0;
  expect(stepSalvage(s, 0, 0, false, 1 / 60).won).toBe(true);
});
test("diagonal speed normalized, world bounds respected, obstacles block", () => {
  const a = createSalvage(),
    b = createSalvage();
  stepSalvage(a, 1, 0, false, 1 / 60);
  stepSalvage(b, 1, 1, false, 1 / 60);
  expect(Math.hypot(b.x, b.z - 6)).toBeCloseTo(a.x, 5);
  a.x = 11.6;
  stepSalvage(a, 1, 0, false, 0.1);
  expect(a.x).toBe(11.6);
  a.x = -6.5;
  a.z = -3;
  for (let i = 0; i < 60; i++) stepSalvage(a, 1, 0, false, 1 / 60);
  expect(a.x).toBeLessThan(-6.37);
});
test("jump lands and cannot double jump", () => {
  const s = createSalvage();
  stepSalvage(s, 0, 0, true, 1 / 60);
  stepSalvage(s, 0, 0, true, 1 / 60);
  expect(s.jumps).toBe(1);
  for (let i = 0; i < 120; i++) stepSalvage(s, 0, 0, false, 1 / 60);
  expect(s.y).toBe(0);
});

test("a complete route wins through movement and collision without teleporting", () => {
  const s = createSalvage();
  const route = [
    [0, 4],
    [-9, 4],
    [-9, 6],
    [-9, -7],
    [-8, -7],
    [0, -10],
    [7, -8],
    [9, 5],
    [5, 0],
    [0, 0],
  ];
  let target = 0;
  for (let frame = 0; frame < 3600 && !s.won; frame++) {
    const [x, z] = route[target];
    const dx = x - s.x,
      dz = z - s.z,
      distance = Math.hypot(dx, dz);
    if (distance < 0.22 && target < route.length - 1) {
      target++;
      continue;
    }
    stepSalvage(
      s,
      distance > 0.1 ? dx / distance : 0,
      distance > 0.1 ? dz / distance : 0,
      s.y === 0,
      1 / 60,
    );
  }
  expect(s.collected.every(Boolean)).toBe(true);
  expect(s.won).toBe(true);
});

test("optional dash has exact duration across 30/60/120/144 Hz steps", () => {
  const expected = SALVAGE_DASH.speed * SALVAGE_DASH.duration + 5.4 * (0.5 - SALVAGE_DASH.duration);
  for (const hz of [30, 60, 120, 144]) {
    const s = createSalvage();
    let dashes = 0;
    for (let i = 0; i < hz / 2; i++) if (stepSalvage(s, 1, 0, false, 1 / hz, { dash: i === 0 }).dashed) dashes++;
    expect(dashes).toBe(1);
    expect(s.x).toBeCloseTo(expected, 9);
    expect(s.dashRemaining).toBe(0);
    expect(s.dashCooldown).toBeCloseTo(1.2, 9);
    expect(s.time).toBeCloseTo(0.5, 9);
  }
});

test("dash remembers facing, locks direction, obeys cooldown, and preserves damage protection", () => {
  const s = createSalvage();
  stepSalvage(s, 1, 0, false, 1 / 60);
  const x = s.x;
  s.invulnerable = 2;
  expect(stepSalvage(s, 0, 0, false, 1 / 60, { dash: true }).dashed).toBe(true);
  expect(s.x - x).toBeCloseTo(16 / 60, 9);
  expect(s.invulnerable).toBeCloseTo(2 - 1 / 60, 9);
  const z = s.z;
  expect(stepSalvage(s, 0, -1, false, 1 / 60, { dash: true }).dashed).toBe(false);
  expect(s.z).toBe(z);
  for (let i = 0; i < 110; i++) stepSalvage(s, 0, 0, false, 1 / 60);
  expect(s.dashCooldown).toBe(0);
  expect(stepSalvage(s, 0, 0, false, 1 / 60, { dash: true }).dashed).toBe(true);
  expect(s.z).toBeLessThan(z);
});

test("dash stops at cover, rounded corners stay traversable, and embedded starts recover", () => {
  const s = createSalvage();
  s.x = -8; s.z = -3;
  stepSalvage(s, 1, 0, false, 0.25, { dash: true });
  expect(s.x).toBeCloseTo(-6.38, 8);
  expect(overlapsGroundBox(s, 0.38, OBSTACLES[0])).toBe(false);
  s.x = -6.3; s.z = -4.3; // Outside the true circle/box corner, inside its expanded square.
  stepSalvage(s, 0, -1, false, 1 / 60);
  expect(s.x).toBeCloseTo(-6.3, 9);
  expect(s.z).toBeLessThan(-4.3);
  s.x = -5; s.z = -3;
  stepSalvage(s, 0, 0, false, 1 / 60);
  expect(overlapsGroundBox(s, 0.38, OBSTACLES[0])).toBe(false);
});

test("zero/invalid time and victory freeze dash, movement, contacts and gameplay", () => {
  const s = createSalvage();
  stepSalvage(s, 1, 0, true, 1 / 60, { dash: true });
  const frozen = JSON.stringify(s);
  for (const dt of [0, -1, NaN, Infinity]) {
    const events = stepSalvage(s, -1, 1, true, dt, { dash: true });
    expect(events.dashed).toBe(false);
    expect(JSON.stringify(s)).toBe(frozen);
  }
  s.won = true;
  const terminal = JSON.stringify(s);
  for (let i = 0; i < 20; i++) expect(stepSalvage(s, 1, 1, true, 1 / 60, { dash: true }).won).toBe(false);
  expect(JSON.stringify(s)).toBe(terminal);
});

test("damage respawn restores the original route start and cancels residual dash motion", () => {
  const s = createSalvage(), drone = dronePosition(1 / 60, 0);
  s.x = drone.x; s.z = drone.z;
  s.energy = 1; s.invulnerable = 0; s.dashRemaining = 0.1;
  expect(stepSalvage(s, 0, 0, false, 1 / 60).hurt).toBe(true);
  expect([s.x, s.y, s.z, s.energy, s.dashRemaining]).toEqual([0, 0, 6, 3, 0]);
});

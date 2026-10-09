import { describe, expect, test } from "bun:test";
import { moveGroundCircle, overlapsGroundBox, sweepGroundCircle, type GroundBox } from "../src/three/ground.ts";
import { Rng } from "../src/core/rng.ts";

const box: GroundBox = { x: 0, z: 0, w: 2, d: 2 };

describe("continuous ground circle queries", () => {
  test("finds the nearest face and normal regardless of obstacle order", () => {
    const far = { x: 5, z: 0, w: 2, d: 2 };
    for (const boxes of [[far, box], [box, far]]) {
      const hit = sweepGroundCircle({ x: -10, z: 0 }, 0.5, 20, 0, boxes)!;
      expect(hit.box).toBe(box);
      expect(hit.t).toBeCloseTo(0.425, 10);
      expect([hit.x, hit.z, hit.nx, hit.nz]).toEqual([-1.5, 0, -1, 0]);
    }
  });

  test("diagonal corner contact uses a circular arc, not an expanded square", () => {
    const hit = sweepGroundCircle({ x: -2, z: -2 }, 0.5, 2, 2, [box])!;
    expect(hit.x).toBeCloseTo(-1 - 0.5 * Math.SQRT1_2, 10);
    expect(hit.z).toBeCloseTo(hit.x, 10);
    expect(hit.nx).toBeCloseTo(-Math.SQRT1_2, 10);
    expect(hit.nz).toBeCloseTo(-Math.SQRT1_2, 10);
    const clear = { x: 1.4, z: 1.4 };
    expect(overlapsGroundBox(clear, 0.5, box)).toBe(false);
    expect(sweepGroundCircle(clear, 0.5, 0, 1, [box])).toBeNull();
    moveGroundCircle(clear, 0.5, 0, 1, [box]);
    expect(clear).toEqual({ x: 1.4, z: 2.4 });
  });

  test("tangent queries report contact while tangent movement is unobstructed", () => {
    const p = { x: 0, z: 1.5 };
    const hit = sweepGroundCircle(p, 0.5, 2, 0, [box])!;
    expect(hit.t).toBe(0);
    expect(hit.nz).toBeCloseTo(1, 10);
    expect(sweepGroundCircle(p, 0.5, 0, 0, [box])!.t).toBe(0);
    moveGroundCircle(p, 0.5, 2, 0, [box]);
    expect(p).toEqual({ x: 2, z: 1.5 });
  });

  test("a fast dash cannot tunnel through a thin obstacle at a small scale", () => {
    const wall = { x: 0.075, z: 0, w: 0.002, d: 1 };
    const p = { x: 0, z: 0 };
    const hit = sweepGroundCircle(p, 0.01, 100, 0, [wall])!;
    expect(hit.x).toBeCloseTo(0.064, 12);
    const result = moveGroundCircle(p, 0.01, 100, 0, [wall]);
    expect(result.contacts).toHaveLength(1);
    expect(p.x).toBeCloseTo(0.064, 12);
    expect(overlapsGroundBox(p, 0.01, wall)).toBe(false);
  });

  test("point sweeps, stationary overlap, and motion away from contact have explicit behavior", () => {
    expect(sweepGroundCircle({ x: -3, z: 0 }, 0, 6, 0, [box])!.t).toBeCloseTo(1 / 3, 10);
    expect(sweepGroundCircle({ x: 0, z: 0 }, 0.3, 0, 0, [box])!.t).toBe(0);
    expect(sweepGroundCircle({ x: 2, z: 2 }, 0.3, 0, 0, [box])).toBeNull();
    const p = { x: -1.3, z: 0 };
    moveGroundCircle(p, 0.3, -1, 0, [box]);
    expect(p.x).toBeCloseTo(-2.3, 10);
    expect(sweepGroundCircle({ x: -1, z: 0 }, 0, 0, 0, [box])!.t).toBe(0);
  });

  test("distant corner sweeps preserve exact geometry and unit normals", () => {
    const p = { x: -1e8, z: 1.25 };
    const hit = sweepGroundCircle(p, 0.5, 2e8, 0, [box])!;
    expect(hit.x).toBeCloseTo(-1 - Math.sqrt(0.5 ** 2 - 0.25 ** 2), 6);
    expect(Math.hypot(hit.nx, hit.nz)).toBeCloseTo(1, 12);
    const moved = moveGroundCircle(p, 0.5, 2e8, 0, [box]);
    expect(Math.hypot(moved.dx, moved.dz)).toBeLessThanOrEqual(2e8);
    expect(overlapsGroundBox(p, 0.5, box)).toBe(false);
  });

  test("rejects invalid input without mutating the body", () => {
    const p = { x: 0, z: 0 };
    expect(() => moveGroundCircle(p, -1, 1, 0, [])).toThrow();
    expect(() => moveGroundCircle(p, 1, NaN, 0, [])).toThrow();
    expect(() => moveGroundCircle(p, 1, 1, 0, [{ ...box, d: -1 }])).toThrow();
    expect(() => moveGroundCircle(p, 1, 1, 0, [], { maxSlides: 0 })).toThrow();
    expect(p).toEqual({ x: 0, z: 0 });
  });
});

describe("ground sliding and overlap recovery", () => {
  test("slides along walls without losing the unblocked movement component", () => {
    const p = { x: -2, z: 0 };
    moveGroundCircle(p, 0.38, 3, 0.8, [box]);
    expect(p.x).toBeCloseTo(-1.38, 10);
    expect(p.z).toBeCloseTo(0.8, 10);
    expect(overlapsGroundBox(p, 0.38, box)).toBe(false);
  });

  test("two simultaneous walls stop both components and stay collision-free", () => {
    const walls = [{ x: 0, z: 0, w: 1, d: 20 }, { x: 0, z: 0, w: 20, d: 1 }];
    const p = { x: -3, z: -3 };
    const result = moveGroundCircle(p, 0.3, 6, 6, walls);
    expect(p.x).toBeCloseTo(-0.8, 10);
    expect(p.z).toBeCloseTo(-0.8, 10);
    expect(result.contacts).toHaveLength(2);
    expect(result.exhausted).toBe(false);
    for (const wall of walls) expect(overlapsGroundBox(p, 0.3, wall)).toBe(false);
  });

  test("tiny slide residuals preserve existing wall contacts after corner roundoff", () => {
    const boxes = [box, { x: -3.03, z: 0, w: 2, d: 20 }];
    const p = { x: -1.03, z: -3 };
    moveGroundCircle(p, 1, -10, 10, boxes);
    for (const wall of boxes) expect(overlapsGroundBox(p, 1, wall)).toBe(false);
    expect(p.x).toBeCloseTo(-1.03, 8);
    expect(p.z).toBeLessThanOrEqual(-1 - Math.sqrt(1 - 0.03 ** 2) + 1e-9);
  });

  test("bounded movement slides along the allowed centre rectangle", () => {
    const p = { x: 0, z: 0 };
    const result = moveGroundCircle(p, 0.4, 100, 80, [], { bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 } });
    expect(p).toEqual({ x: 2, z: 2 });
    expect(result.contacts).toHaveLength(2);
    expect(result.contacts.every(hit => hit.box === null)).toBe(true);
  });

  test("recovers a spawn inside cover and one penetrating a rounded corner", () => {
    for (const p of [{ x: 0, z: 0 }, { x: 1.1, z: 1.1 }]) {
      const result = moveGroundCircle(p, 0.3, 0, 0, [box]);
      expect(result.recovered).toBe(true);
      expect(result.stuck).toBe(false);
      expect(overlapsGroundBox(p, 0.3, box)).toBe(false);
    }
  });

  test("overlapping boxes do not make recovery oscillate", () => {
    const boxes = [box, { x: 1, z: 0, w: 2, d: 2 }];
    const p = { x: 0.5, z: 0 };
    const result = moveGroundCircle(p, 0.4, 0, 0, boxes);
    expect(result.recovered).toBe(true);
    expect(result.stuck).toBe(false);
    for (const obstacle of boxes) expect(overlapsGroundBox(p, 0.4, obstacle)).toBe(false);
  });

  test("an impossible bounded spawn reports stuck and does not move through cover", () => {
    const p = { x: 0, z: 0 };
    const result = moveGroundCircle(p, 0.3, 10, 0, [{ x: 0, z: 0, w: 100, d: 100 }], { bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 } });
    expect(result.stuck).toBe(true);
    expect(p).toEqual({ x: 0, z: 0 });
  });

  test("a slide budget never applies unchecked remaining movement", () => {
    const p = { x: -2, z: 0 };
    const result = moveGroundCircle(p, 0.38, 3, 0.8, [box], { maxSlides: 1 });
    expect(result.exhausted).toBe(true);
    expect(p.x).toBeCloseTo(-1.38, 10);
    expect(p.z).toBeLessThan(0.8);
    expect(overlapsGroundBox(p, 0.38, box)).toBe(false);
  });

  test("seeded long moves through a dense scene end clear of every obstacle", () => {
    const rng = new Rng(617);
    const boxes = Array.from({ length: 12 }, () => ({ x: rng.range(-8, 8), z: rng.range(-8, 8), w: rng.range(0.01, 3), d: rng.range(0.01, 3) }));
    const p = { x: -12, z: -12 };
    for (let i = 0; i < 250; i++) {
      const result = moveGroundCircle(p, 0.35, rng.range(-20, 20), rng.range(-20, 20), boxes);
      expect(result.stuck).toBe(false);
      for (const box of boxes) expect(overlapsGroundBox(p, 0.35, box)).toBe(false);
    }
  });
});

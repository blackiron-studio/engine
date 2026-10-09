import { test, expect } from "bun:test";
import { ArcadeWorld2D, ArcadeVehicle2D } from "../src/physics/arcade2d.ts";
const room = () =>
  new ArcadeWorld2D({ x: -1000, y: -1000, w: 2000, h: 2000 }, []);
test("arcade vehicles accelerate, steer, reverse and stop independent of renderer", () => {
  const car = new ArcadeVehicle2D(0, 0),
    w = room();
  for (let i = 0; i < 120; i++) car.step(1 / 60, { throttle: 1, steer: 0 }, w);
  expect(car.x).toBeGreaterThan(300);
  expect(car.y).toBe(0);
  expect(car.speed).toBeLessThanOrEqual(340);
  for (let i = 0; i < 30; i++)
    car.step(1 / 60, { throttle: 0, steer: 1, handbrake: true }, w);
  expect(car.angle).toBeGreaterThan(0.3);
  expect(car.speed).toBeLessThan(200);
  car.stop();
  for (let i = 0; i < 60; i++) car.step(1 / 60, { throttle: -1, steer: 0 }, w);
  expect(car.speed).toBeLessThan(0);
  expect(() => car.step(NaN, { throttle: 0, steer: 0 }, w)).toThrow();
});
test("circle movement cannot tunnel through thin walls and slides at corners", () => {
  const w = new ArcadeWorld2D({ x: 0, y: 0, w: 500, h: 500 }, [
      { x: 200, y: 0, w: 2, h: 350 },
    ]),
    p = { x: 100, y: 80 };
  expect(w.move(p, 250, 100, 10)).toBe(true);
  expect(p.x).toBeLessThanOrEqual(190);
  expect(p.y).toBeCloseTo(180);
  expect(w.free(201, 100, 10)).toBe(false);
  expect(w.free(20, 20, 10)).toBe(true);
  const c = new ArcadeVehicle2D(150, 150);
  c.speed = c.vx = 340;
  expect(c.step(0.1, { throttle: 1, steer: 0 }, w)).toBeGreaterThan(100);
  expect(c.x).toBeLessThanOrEqual(177);
});
test("vehicle trajectories stay close across supported fixed step rates", () => {
  const simulate = (fps: number) => {
    const c = new ArcadeVehicle2D(0, 0);
    for (let i = 0; i < fps * 2; i++)
      c.step(1 / fps, { throttle: 1, steer: 0.2 }, room());
    return c;
  };
  const a = simulate(60),
    b = simulate(120);
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(8);
});
test("dynamic circle separation respects stationary actors and static walls", () => {
  const w = room(),
    a = { x: 0, y: 0 },
    b = { x: 12, y: 0 };
  expect(w.separate(a, 10, b, 10, 0)).toBe(true);
  expect(a.x).toBe(0);
  expect(b.x).toBeCloseTo(20);
  expect(w.separate(a, 10, b, 10)).toBe(false);
  const c = { x: 0, y: 0 };
  w.separate(a, 10, c, 10);
  expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeCloseTo(20);
});

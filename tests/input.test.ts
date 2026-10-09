import { describe, expect, test } from "bun:test";
import { ActionMap, Pointer } from "../src/input/index.ts";

describe("ActionMap", () => {
  test("keys map to actions with press and release edges", () => {
    const m = new ActionMap().map({ left: ["KeyA", "ArrowLeft"], right: "KeyD" });
    expect(m.isBound("KeyA")).toBe(true);
    expect(m.isBound("KeyZ")).toBe(false);
    expect(m.keyDown("KeyA")).toBe(true);
    expect(m.isDown("left")).toBe(true);
    expect(m.justPressed("left")).toBe(true);
    m.endFrame();
    expect(m.justPressed("left")).toBe(false);
    expect(m.isDown("left")).toBe(true);
    // A second key for the same action keeps it down when the first is released.
    m.keyDown("ArrowLeft");
    m.keyUp("KeyA");
    expect(m.isDown("left")).toBe(true);
    m.keyUp("ArrowLeft");
    expect(m.isDown("left")).toBe(false);
    expect(m.justReleased("left")).toBe(true);
    expect(m.drain().map((e) => `${e.name}:${e.pressed}`)).toEqual(["left:true", "left:false"]);
    expect(m.drain()).toEqual([]);
  });

  test("axis and vector", () => {
    const m = new ActionMap().map({ l: "KeyA", r: "KeyD", u: "KeyW", d: "KeyS" });
    m.keyDown("KeyD");
    expect(m.axis("l", "r")).toBe(1);
    m.keyDown("KeyS");
    const v = m.vector("l", "r", "u", "d");
    expect(v.x).toBeCloseTo(Math.SQRT1_2);
    expect(v.y).toBeCloseTo(Math.SQRT1_2);
  });

  test("repeated keydown does not re-press; reset releases everything", () => {
    const m = new ActionMap().map({ a: "KeyA" });
    m.keyDown("KeyA");
    m.endFrame();
    m.keyDown("KeyA");
    expect(m.justPressed("a")).toBe(false);
    m.reset();
    expect(m.isDown("a")).toBe(false);
    expect(m.drain().at(-1)).toEqual({ name: "a", pressed: false });
  });
});

describe("Pointer", () => {
  test("down and up within a frame set both edges", () => {
    const p = new Pointer();
    p.handleDown(10, 20, 0, 1, "touch");
    p.handleUp(12, 22, 1);
    const s = p.snapshot();
    expect(s).toEqual({ x: 12, y: 22, down: false, justPressed: true, justReleased: true });
    expect(p.type).toBe("touch");
    p.endFrame();
    expect(p.snapshot().justPressed).toBe(false);
  });

  test("a second pointer id is ignored while one is held", () => {
    const p = new Pointer();
    p.handleDown(0, 0, 0, 1);
    p.handleDown(50, 50, 0, 2);
    expect(p.x).toBe(0);
    p.handleUp(5, 5, 2);
    expect(p.down).toBe(true);
    p.handleUp(5, 5, 1);
    expect(p.down).toBe(false);
  });
});

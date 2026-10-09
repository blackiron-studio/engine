import { describe, expect, test } from "bun:test";
import { Emitter, FixedStep, Rng, Tweens, UndoStack, angleDelta, clamp, grid, hashString, hex, lerp, wrap } from "../src/core/index.ts";

describe("math", () => {
  test("clamp, lerp, wrap", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(wrap(7, 0, 5)).toBe(2);
    expect(wrap(-1, 0, 5)).toBe(4);
  });

  test("angleDelta takes the short way round", () => {
    expect(angleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(angleDelta(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(-0.2);
  });
});

describe("Rng", () => {
  test("same seed, same sequence; state round-trips", () => {
    const a = new Rng("kiln");
    const b = new Rng("kiln");
    const seq = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seq);
    const saved = a.state;
    const x = a.next();
    a.state = saved;
    expect(a.next()).toBe(x);
  });

  test("int is inclusive and in range", () => {
    const r = new Rng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = r.int(2, 4);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(4);
      seen.add(v);
    }
    expect(seen.size).toBe(3);
  });

  test("shuffle keeps every element", () => {
    const r = new Rng(1);
    const arr = r.shuffle([1, 2, 3, 4, 5, 6]);
    expect([...arr].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("forks are deterministic and distinct", () => {
    const r = new Rng(9);
    expect(r.fork("a").next()).toBe(new Rng(9).fork("a").next());
    expect(r.fork("a").next()).not.toBe(r.fork("b").next());
  });

  test("hashString is stable", () => {
    expect(hashString("kiln")).toBe(hashString("kiln"));
    expect(hashString("kiln")).not.toBe(hashString("kilo"));
  });
});

describe("grid", () => {
  const cols = 6;
  const rows = 4;
  // A wall down column 3 with a gap at row 3.
  const cost = (x: number, y: number) => (x === 3 && y !== 3 ? Infinity : 1);

  test("findPath routes through the gap", () => {
    const path = grid.findPath(cols, rows, cost, { x: 0, y: 0 }, { x: 5, y: 0 });
    expect(path).not.toBeNull();
    const p = path as grid.Cell[];
    expect(p[0]).toEqual({ x: 0, y: 0 });
    expect(p[p.length - 1]).toEqual({ x: 5, y: 0 });
    expect(p.some((c) => c.x === 3 && c.y === 3)).toBe(true);
    for (let i = 1; i < p.length; i++) expect(grid.manhattan(p[i - 1].x, p[i - 1].y, p[i].x, p[i].y)).toBe(1);
  });

  test("findPath returns null when blocked", () => {
    const solid = (x: number) => (x === 3 ? Infinity : 1);
    expect(grid.findPath(cols, rows, solid, { x: 0, y: 0 }, { x: 5, y: 0 })).toBeNull();
  });

  test("reachable respects the budget", () => {
    const r = grid.reachable(cols, rows, () => 1, { x: 0, y: 0 }, 2);
    expect(r.get(grid.key(0, 0))).toBe(0);
    expect(r.get(grid.key(2, 0))).toBe(2);
    expect(r.has(grid.key(3, 0))).toBe(false);
    expect(r.get(grid.key(1, 1))).toBe(2);
  });

  test("lineCells is inclusive", () => {
    const l = grid.lineCells(0, 0, 3, 1);
    expect(l[0]).toEqual({ x: 0, y: 0 });
    expect(l[l.length - 1]).toEqual({ x: 3, y: 1 });
  });
});

describe("hex", () => {
  test("distance and neighbours", () => {
    expect(hex.hexDistance({ q: 0, r: 0 }, { q: 2, r: -1 })).toBe(2);
    expect(hex.hexNeighbors({ q: 0, r: 0 })).toHaveLength(6);
    expect(hex.hexRange({ q: 0, r: 0 }, 1)).toHaveLength(7);
  });

  test("pixel round trip", () => {
    const h = { q: 3, r: -2 };
    const p = hex.hexToPixel(h, 10);
    expect(hex.pixelToHex(p.x, p.y, 10)).toEqual(h);
  });
});

describe("Tweens", () => {
  test("interpolates and fires onDone once", () => {
    const tw = new Tweens();
    const o = { x: 0 };
    let done = 0;
    tw.to(o, { x: 10 }, 1, { onDone: () => done++ });
    tw.update(0.5);
    expect(o.x).toBeCloseTo(5);
    tw.update(0.6);
    expect(o.x).toBe(10);
    expect(done).toBe(1);
    expect(tw.size).toBe(0);
  });

  test("delay and after", () => {
    const tw = new Tweens();
    let fired = false;
    tw.after(0.2, () => (fired = true));
    tw.update(0.1);
    expect(fired).toBe(false);
    tw.update(0.15);
    expect(fired).toBe(true);
  });
});

describe("Emitter", () => {
  test("on, once, off", () => {
    const e = new Emitter<{ hit: [number] }>();
    const got: number[] = [];
    const off = e.on("hit", (n) => got.push(n));
    e.once("hit", (n) => got.push(n * 10));
    e.emit("hit", 1);
    e.emit("hit", 2);
    off();
    e.emit("hit", 3);
    expect(got).toEqual([1, 10, 2]);
  });
});

describe("FixedStep", () => {
  test("runs whole steps and returns the remainder alpha", () => {
    const c = new FixedStep(0.1, 1);
    let n = 0;
    const alpha = c.advance(0.25, () => n++);
    expect(n).toBe(2);
    expect(alpha).toBeCloseTo(0.5);
    expect(c.ticks).toBe(2);
  });

  test("clamps huge frames", () => {
    const c = new FixedStep(1 / 60, 0.1, 5);
    let n = 0;
    c.advance(5, () => n++);
    expect(n).toBeLessThanOrEqual(5);
  });
});

describe("UndoStack", () => {
  test("pushes, pops in order, peeks, forgets past its cap, and clears", () => {
    const u = new UndoStack<number>(3);
    expect(u.canUndo).toBe(false);
    u.push(1);
    u.push(2);
    u.push(3);
    u.push(4);
    expect(u.size).toBe(3);
    expect(u.peek()).toBe(4);
    expect(u.pop()).toBe(4);
    expect(u.pop()).toBe(3);
    expect(u.pop()).toBe(2);
    expect(u.pop()).toBeUndefined();
    u.push(9);
    u.clear();
    expect(u.canUndo).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { TileMapData, cellsUnder, groundedAabb, moveAabb } from "../src/core/tilemap.ts";

const LEVEL = TileMapData.fromAscii(
  [
    "........",
    "...=.##.",
    "........",
    "..##....",
    "########",
  ],
  { "#": 1, "=": 2 },
);
const solid = (c: number, r: number) => LEVEL.get(c, r) === 1;
const oneWay = (c: number, r: number) => LEVEL.get(c, r) === 2;
const T = 16;

describe("TileMapData", () => {
  test("parses ascii with a legend and finds cells", () => {
    expect(LEVEL.cols).toBe(8);
    expect(LEVEL.rows).toBe(5);
    expect(LEVEL.get(2, 3)).toBe(1);
    expect(LEVEL.get(3, 1)).toBe(2);
    expect(LEVEL.get(0, 0)).toBe(0);
    expect(LEVEL.get(-1, 0)).toBe(-1);
    expect(LEVEL.find(2)).toEqual([{ x: 3, y: 1 }]);
    const c = LEVEL.clone();
    c.replaceAll(2, 0);
    expect(c.find(2)).toEqual([]);
    expect(LEVEL.find(2)).toHaveLength(1);
  });
});

describe("moveAabb", () => {
  test("falls onto the floor and stops exactly on it", () => {
    const r = moveAabb({ x: 3, y: 10, w: 10, h: 14 }, 0, 100, T, solid);
    expect(r.hitBottom).toBe(true);
    expect(r.y).toBe(4 * T - 14);
    expect(groundedAabb({ x: 3, y: r.y, w: 10, h: 14 }, T, solid)).toBe(true);
  });

  test("walks into a wall and stops flush", () => {
    const r = moveAabb({ x: 0, y: 3 * T + 1, w: 10, h: 14 }, 60, 0, T, solid);
    expect(r.hitRight).toBe(true);
    expect(r.x).toBe(2 * T - 10);
    const l = moveAabb({ x: 70, y: 3 * T + 1, w: 10, h: 14 }, -60, 0, T, solid);
    expect(l.hitLeft).toBe(true);
    expect(l.x).toBe(4 * T);
  });

  test("does not tunnel through thin walls at high speed", () => {
    const r = moveAabb({ x: 0, y: 3 * T + 1, w: 10, h: 14 }, 400, 0, T, solid);
    expect(r.x).toBe(2 * T - 10);
  });

  test("one-way platforms block from above only", () => {
    const fromAbove = moveAabb({ x: 3 * T + 3, y: 0, w: 10, h: 14 }, 0, 40, T, solid, oneWay);
    expect(fromAbove.hitBottom).toBe(true);
    expect(fromAbove.y).toBe(T - 14);
    const fromBelow = moveAabb({ x: 3 * T + 3, y: 2 * T + 4, w: 10, h: 14 }, 0, -30, T, solid, oneWay);
    expect(fromBelow.hitTop).toBe(false);
    expect(fromBelow.y).toBe(2 * T + 4 - 30);
  });

  test("hits the ceiling", () => {
    // Standing on the floor under the blocks at row 1, jumping up.
    const under = moveAabb({ x: 5 * T + 3, y: 4 * T - 14, w: 10, h: 14 }, 0, -100, T, solid);
    expect(under.hitTop).toBe(true);
    expect(under.y).toBe(2 * T);
    // Nothing above column 0, so the same jump is free.
    const free = moveAabb({ x: 3, y: 4 * T - 14, w: 10, h: 14 }, 0, -40, T, solid);
    expect(free.hitTop).toBe(false);
    expect(free.y).toBe(4 * T - 14 - 40);
  });

  test("cellsUnder lists overlapped cells", () => {
    expect(cellsUnder({ x: 14, y: 14, w: 4, h: 4 }, T)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
  });
});

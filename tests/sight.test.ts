// Line of sight: grid rays stop at walls and pass over low ones, canSee respects range,
// cones and corners, shadowcasting is symmetric and lights the walls that bound a room,
// and fog of war reports only what changed and saves what was explored.

import { describe, expect, test } from "bun:test";
import { FogOfWar, Rng, type SightGrid, TileMapData, canSee, castGridRay, inSightCone, visibilityField } from "../src/core/index.ts";

function gridFrom(rows: string[], cell = 1, heights?: Record<string, number>): SightGrid {
  const map = TileMapData.fromAscii(rows, { "#": 1, ".": 0, h: 2 });
  return {
    cols: map.cols,
    rows: map.rows,
    cell,
    opaque: (c, r) => !map.inBounds(c, r) || map.get(c, r) === 1,
    height: heights ? (c, r) => (map.inBounds(c, r) && map.get(c, r) === 2 ? heights.h! : 0) : undefined,
  };
}

describe("castGridRay", () => {
  const room = gridFrom([
    "#######",
    "#.....#",
    "#..#..#",
    "#.....#",
    "#######",
  ]);

  test("stops at the first wall with the face it came through", () => {
    const hit = castGridRay(room, 1.5, 2.5, 5.5, 2.5)!;
    expect(hit.col).toBe(3);
    expect(hit.row).toBe(2);
    expect(hit.x).toBeCloseTo(3);
    expect(hit.nx).toBe(-1);
    expect(hit.ny).toBe(0);
    expect(hit.t).toBeCloseTo(1.5 / 4);
  });

  test("an open line returns null, and the end cell can be left out", () => {
    expect(castGridRay(room, 1.5, 1.5, 5.5, 1.5)).toBeNull();
    expect(castGridRay(room, 1.5, 2.5, 3.5, 2.5)).not.toBeNull();
    expect(castGridRay(room, 1.5, 2.5, 3.5, 2.5, { includeEnd: false })).toBeNull();
  });

  test("world units scale by the cell size", () => {
    const big = gridFrom(["#####", "#.#.#", "#####"], 32);
    const hit = castGridRay(big, 48, 48, 112, 48)!;
    expect(hit.col).toBe(2);
    expect(hit.x).toBeCloseTo(64);
  });

  test("diagonal corners: two walls close the gap, one wall does not", () => {
    const closed = gridFrom(["....", ".#..", "..#.", "...."]);
    expect(castGridRay(closed, 1, 3, 3, 1, { includeEnd: false })).not.toBeNull();
    const open = gridFrom(["....", ".#..", "....", "...."]);
    expect(castGridRay(open, 1, 3, 3, 1, { includeEnd: false })).toBeNull();
  });

  test("with heights a ray passes over a low wall and stops at a tall one", () => {
    const yard = gridFrom(["......", "..h...", "......"], 1, { h: 1 });
    expect(castGridRay(yard, 0.5, 1.5, 5.5, 1.5, { z0: 1.5, z1: 1.5 })).toBeNull();
    expect(castGridRay(yard, 0.5, 1.5, 5.5, 1.5, { z0: 0.5, z1: 0.5 })!.col).toBe(2);
    // Lobbing from high to low clears it only while still above the wall.
    expect(castGridRay(yard, 0.5, 1.5, 5.5, 1.5, { z0: 3, z1: 0 })).toBeNull();
    expect(castGridRay(yard, 0.5, 1.5, 5.5, 1.5, { z0: 1.2, z1: 0 })!.col).toBe(2);
  });
});

describe("canSee", () => {
  const room = gridFrom([
    "##########",
    "#........#",
    "#...#....#",
    "#........#",
    "##########",
  ]);

  test("walls hide, open floor shows, and it is symmetric", () => {
    expect(canSee(room, 1.5, 2.5, 8.5, 2.5)).toBe(false);
    expect(canSee(room, 8.5, 2.5, 1.5, 2.5)).toBe(false);
    expect(canSee(room, 1.5, 1.5, 8.5, 1.5)).toBe(true);
    expect(canSee(room, 1.5, 2.5, 4.5, 2.5)).toBe(true); // the wall itself is seen
  });

  test("range and sight cones", () => {
    expect(canSee(room, 1.5, 1.5, 8.5, 1.5, { range: 5 })).toBe(false);
    expect(canSee(room, 1.5, 1.5, 5.5, 1.5, { range: 5 })).toBe(true);
    expect(canSee(room, 1.5, 1.5, 5.5, 1.5, { facing: Math.PI, fov: Math.PI / 2 })).toBe(false);
    expect(canSee(room, 1.5, 1.5, 5.5, 1.5, { facing: 0.3, fov: Math.PI / 2 })).toBe(true);
    expect(inSightCone(0, 0, 0, Math.PI / 2, 10, 5, 5.1)).toBe(false);
    expect(inSightCone(0, 0, 0, Math.PI / 2, 10, 5, 4.9)).toBe(true);
    expect(inSightCone(0, 0, 0, Math.PI * 2, 10, -5, 0)).toBe(true);
  });

  test("heights: a crouched viewer is hidden by a low wall a standing one sees over", () => {
    const yard = gridFrom(["........", "...h....", "........"], 1, { h: 1 });
    expect(canSee(yard, 0.5, 1.5, 7.5, 1.5, { eye: 0.6 })).toBe(false);
    expect(canSee(yard, 0.5, 1.5, 7.5, 1.5, { eye: 1.6 })).toBe(true);
    // Standing on the wall sees everything around it.
    expect(canSee(yard, 3.5, 1.5, 7.5, 1.5, { eye: 0.6 })).toBe(true);
  });
});

describe("visibilityField", () => {
  test("lights the room and its walls, and a pillar casts a shadow", () => {
    const g = gridFrom([
      "#########",
      "#.......#",
      "#.......#",
      "#...#...#",
      "#.......#",
      "#########",
    ]);
    const f = visibilityField(g, 1.5, 3.5, 20);
    const at = (c: number, r: number) => f[r * g.cols + c];
    expect(at(1, 3)).toBe(1);
    expect(at(0, 3)).toBe(1); // bounding wall
    expect(at(4, 3)).toBe(1); // the pillar itself
    expect(at(6, 3)).toBe(0); // straight behind it
    expect(at(7, 1)).toBe(1);
    expect(at(8, 0)).toBe(1); // far corner wall
  });

  test("radius and cone limit what is seen", () => {
    const g = gridFrom(["...........", "...........", "..........."]);
    const near = visibilityField(g, 0.5, 1.5, 3);
    expect(near[1 * g.cols + 3]).toBe(1);
    expect(near[1 * g.cols + 4]).toBe(0);
    const cone = visibilityField(g, 5.5, 1.5, 10, { facing: 0, fov: Math.PI / 2 });
    expect(cone[1 * g.cols + 8]).toBe(1);
    expect(cone[1 * g.cols + 2]).toBe(0);
    expect(cone[1 * g.cols + 5]).toBe(1);
  });

  test("symmetric on random maps: A sees B exactly when B sees A", () => {
    const rng = new Rng(7);
    for (let trial = 0; trial < 6; trial++) {
      const cols = 16;
      const rows = 12;
      const walls = new Uint8Array(cols * rows);
      for (let i = 0; i < walls.length; i++) walls[i] = rng.next() < 0.22 ? 1 : 0;
      const g: SightGrid = { cols, rows, opaque: (c, r) => c < 0 || r < 0 || c >= cols || r >= rows || walls[r * cols + c] === 1 };
      const floors: [number, number][] = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!walls[r * cols + c]) floors.push([c, r]);
      const fields = new Map<number, Uint8Array>();
      for (const [c, r] of floors) fields.set(r * cols + c, visibilityField(g, c + 0.5, r + 0.5, 100));
      for (const [ac, ar] of floors) {
        for (const [bc, br] of floors) {
          const ab = fields.get(ar * cols + ac)![br * cols + bc];
          const ba = fields.get(br * cols + bc)![ar * cols + ac];
          expect(ab).toBe(ba);
        }
      }
    }
  });

  test("cells taller than the eye block; lower ones do not", () => {
    const g = gridFrom(["........", "...h....", "........"], 1, { h: 2 });
    const low = visibilityField(g, 0.5, 1.5, 20, { eyeZ: 1 });
    expect(low[1 * g.cols + 3]).toBe(1);
    expect(low[1 * g.cols + 6]).toBe(0);
    const high = visibilityField(g, 0.5, 1.5, 20, { eyeZ: 3 });
    expect(high[1 * g.cols + 6]).toBe(1);
  });
});

describe("FogOfWar", () => {
  test("reports only flipped cells, remembers explored ones and saves them", () => {
    const g = gridFrom([
      "##########",
      "#....#...#",
      "#....#...#",
      "##########",
    ]);
    const fog = new FogOfWar(g);
    const first = fog.update([{ x: 1.5, y: 1.5, radius: 10 }]);
    expect(first.length).toBeGreaterThan(0);
    expect(fog.isVisible(2, 2)).toBe(true);
    expect(fog.isVisible(7, 1)).toBe(false);
    expect(fog.update([{ x: 1.5, y: 1.5, radius: 10 }])).toEqual([]);

    const moved = fog.update([{ x: 7.5, y: 1.5, radius: 10 }]);
    expect(moved).toContain(1 * g.cols + 7);
    expect(fog.isVisible(2, 2)).toBe(false);
    expect(fog.isExplored(2, 2)).toBe(true);
    expect(fog.sees(7.5, 2.5)).toBe(true);

    const saved = fog.saveExplored();
    const again = new FogOfWar(g);
    expect(again.loadExplored(saved)).toBe(true);
    for (let i = 0; i < fog.explored.length; i++) expect(again.explored[i]).toBe(fog.explored[i]);
    expect(new FogOfWar(gridFrom(["...", "..."])).loadExplored(saved)).toBe(false);
  });
});

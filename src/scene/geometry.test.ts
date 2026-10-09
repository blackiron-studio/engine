import { expect, test } from "bun:test";
import { Graphics2D, triangulatePolygon, type Point2D } from "./geometry.ts";
import type { DrawContext } from "./draw.ts";
const area = (v: number[]) => {
  let a = 0;
  for (let i = 0; i < v.length; i += 6)
    a +=
      Math.abs(
        (v[i + 2] - v[i]) * (v[i + 5] - v[i + 1]) -
          (v[i + 3] - v[i + 1]) * (v[i + 4] - v[i]),
      ) / 2;
  return a;
};
test("concave polygon preserves area in both windings", () => {
  const p: Point2D[] = [
    [0, 0],
    [4, 0],
    [4, 1],
    [1, 1],
    [1, 4],
    [0, 4],
  ];
  expect(area(triangulatePolygon(p))).toBe(7);
  expect(area(triangulatePolygon([...p].reverse()))).toBe(7);
});
test("closing points and collinear vertices do not corrupt triangles", () => {
  expect(
    area(
      triangulatePolygon([
        [0, 0],
        [2, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ]),
    ),
  ).toBe(16);
});
test("degenerate input is empty and nonfinite input is rejected", () => {
  expect(
    triangulatePolygon([
      [0, 0],
      [1, 0],
      [2, 0],
    ]),
  ).toEqual([]);
  expect(() =>
    triangulatePolygon([
      [0, 0],
      [NaN, 1],
      [1, 0],
    ]),
  ).toThrow();
});
test("retained shape count resets and invalid radius is rejected", () => {
  const g = new Graphics2D().rect(0, 0, 10, 10, 0xffffff);
  expect(g.triangleCount).toBe(2);
  g.clearGraphics();
  expect(g.triangleCount).toBe(0);
  expect(() => g.ellipse(0, 0, -1, 1, 0)).toThrow();
});

test("polygons retain their area far from the origin and at small scales", () => {
  const square: Point2D[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  expect(
    area(triangulatePolygon(square.map(([x, y]) => [x + 1e9, y + 1e9]))),
  ).toBe(1);
  expect(
    area(triangulatePolygon(square.map(([x, y]) => [x * 1e-5, y * 1e-5]))),
  ).toBeCloseTo(1e-10, 18);
  const concave: Point2D[] = [
    [0, 0],
    [3, 0],
    [3, 1],
    [1, 1],
    [1, 3],
    [0, 3],
  ];
  expect(
    area(triangulatePolygon(concave.map(([x, y]) => [x + 1e9, y + 1e9]))),
  ).toBe(5);
});

test("concave outlines with multiple collinear runs produce no degenerate triangles", () => {
  const outline: Point2D[] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [3, 1],
    [2, 1],
    [1, 1],
    [1, 2],
    [1, 3],
    [0, 3],
    [0, 2],
    [0, 1],
  ];
  for (const p of [outline, [...outline].reverse()]) {
    const result = triangulatePolygon(p);
    expect(area(result)).toBe(5);
    for (let i = 0; i < result.length; i += 6)
      expect(area(result.slice(i, i + 6))).toBeGreaterThan(0);
  }
});

test("rounded rectangles stay inside their bounds for either size direction", () => {
  const capture = (g: Graphics2D): number[] => {
    const result: number[] = [];
    g.render({
      cull: false,
      atlas: { whiteU: 0, whiteV: 0 },
      mesh(vertices: ArrayLike<number>, count: number) {
        for (let i = 0; i < count; i++)
          result.push(vertices[i * 4], vertices[i * 4 + 1]);
      },
    } as unknown as DrawContext);
    return result;
  };
  const normal = capture(new Graphics2D().roundedRect(0, 0, 10, 10, 2, 0));
  const reversed = capture(
    new Graphics2D().roundedRect(10, 10, -10, -10, 2, 0),
  );
  expect(reversed).toEqual(normal);
  expect(Math.min(...normal)).toBe(0);
  expect(Math.max(...normal)).toBe(10);
  expect(Math.abs(area(normal) - (100 - (4 - Math.PI) * 4))).toBeLessThan(0.15);
  expect(new Graphics2D().roundedRect(0, 0, 10, 10, 0, 0).triangleCount).toBe(
    2,
  );
  expect(() => new Graphics2D().roundedRect(0, 0, 10, 10, NaN, 0)).toThrow();
});

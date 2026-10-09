import { expect, test } from "bun:test";
import {
  Geometry3D,
  Material3D,
  Mesh3D,
  Scene3D,
  Vec3,
} from "../src/three/index.ts";
import { FakeRenderer } from "../src/render/fake.ts";

test("new material options preserve legacy defaults and unlit compatibility", () => {
  const material = new Material3D();
  expect(String(material.shading)).toBe("standard");
  expect(material.toneMapped).toBe(true);
  expect(material.unlit).toBe(false);
  expect(new Material3D({ unlit: true }).shading).toBe("unlit");
  expect(new Material3D({ unlit: true, shading: "lambert" }).shading).toBe(
    "lambert",
  );
  expect(new Material3D({ shading: "lambert", unlit: true }).shading).toBe(
    "lambert",
  );
  material.shading = "lambert";
  material.unlit = false;
  expect(String(material.shading)).toBe("lambert");
  material.unlit = true;
  expect(String(material.shading)).toBe("unlit");
  material.unlit = false;
  expect(String(material.shading)).toBe("standard");
});

test("tint is per mesh and recorded without mutating shared material or previous frames", () => {
  const geometry = Geometry3D.box(),
    material = new Material3D({ color: 0xcccccc }),
    scene = new Scene3D();
  const a = scene.world3D.add(new Mesh3D(geometry, material)),
    b = scene.world3D.add(new Mesh3D(geometry, material));
  expect(a.tint).toBe(0xffffff);
  a.tint = 0x123456;
  b.tint = 0xabcdef;
  expect(a.material).toBe(b.material);
  expect(material.color).toBe(0xcccccc);
  const renderer = new FakeRenderer(960, 540);
  renderer.begin(0);
  renderer.render3D(scene.collectFrame3D());
  a.tint = 0;
  const frame = renderer.ops.find((op) => op.op === "world3d");
  if (frame?.op !== "world3d") throw new Error("Missing mesh recording");
  expect(frame.meshes.map((mesh) => mesh.tint)).toEqual([0x123456, 0xabcdef]);
});

for (const inner of [0, 0.4, 0.999])
  test(`flat ring with inner radius ${inner} has bounded, consistent, upward-facing triangles`, () => {
    const segments = 32,
      ring = Geometry3D.ring(1, inner, segments),
      p = ring.positions,
      n = ring.normals,
      indices = ring.indices;
    expect(indices.length / 3).toBe(segments * (inner === 0 ? 1 : 2));
    let area = 0;
    const edges = new Map<string, number>();
    for (let i = 0; i < indices.length; i += 3) {
      const [ia, ib, ic] = [indices[i], indices[i + 1], indices[i + 2]];
      const a = new Vec3(p[ia * 3], p[ia * 3 + 1], p[ia * 3 + 2]),
        b = new Vec3(p[ib * 3], p[ib * 3 + 1], p[ib * 3 + 2]),
        c = new Vec3(p[ic * 3], p[ic * 3 + 1], p[ic * 3 + 2]);
      const normal = b.sub(a).cross(c.sub(a));
      expect(normal.y).toBeGreaterThan(0);
      area += normal.length / 2;
      for (const [u, v] of [
        [ia, ib],
        [ib, ic],
        [ic, ia],
      ]) {
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    const expectedArea =
      ((segments * Math.sin((2 * Math.PI) / segments)) / 2) *
      (1 - inner * inner);
    expect(area).toBeCloseTo(expectedArea, 5);
    expect(
      [...edges.values()].every((count) => count === 1 || count === 2),
    ).toBe(true);
    expect([...edges.values()].filter((count) => count === 1).length).toBe(
      segments * (inner === 0 ? 1 : 2),
    );
    for (let i = 0; i < p.length; i += 3) {
      expect(p[i + 1]).toBe(0);
      expect(Array.from(n.slice(i, i + 3))).toEqual([0, 1, 0]);
      const radius = Math.hypot(p[i], p[i + 2]);
      expect(radius).toBeLessThanOrEqual(1 + 1e-6);
      expect(radius).toBeGreaterThanOrEqual(inner - 1e-6);
    }
  });

test("ring validates dimensions and segments before allocating buffers", () => {
  expect(Geometry3D.ring(0.25).radius).toBeCloseTo(0.25);
  for (const args of [
    [0, 0],
    [1, -0.1],
    [1, 1],
    [1, 2],
    [1, NaN],
    [Infinity, 0.5],
    [1, 0.5, 2],
    [1, 0.5, 3.5],
    [1, 0.5, 513],
  ])
    expect(() => Geometry3D.ring(args[0], args[1], args[2])).toThrow();
});

// Procedural 3D content: surfaces tile, normals face outward and up, the sky stays on the camera.

import { describe, expect, test } from "bun:test";
import { Camera3D } from "../src/three/camera.ts";
import { blobGeometry, SkyDome3D, skyTexture, surface, terrainGeometry, type SurfaceKind } from "../src/three/procedural.ts";

describe("procedural 3D", () => {
  test("every surface bakes three square maps whose opposite edges match", () => {
    const kinds: SurfaceKind[] = ["tiles", "concrete", "metal", "grass", "dirt", "rock", "sand", "planks", "bricks", "cobbles", "hex", "plaster"];
    for (const kind of kinds) {
      const s = surface(kind, { size: 64, seed: 2 });
      for (const t of [s.map, s.normalMap, s.metallicRoughnessMap]) {
        expect([t.width, t.height]).toEqual([64, 64]);
        expect(t.wrap).toBe("repeat");
      }
      // Seamless: the left and right columns differ about as much as neighbouring columns.
      const d = s.map.data;
      const col = (x: number) => Array.from({ length: 64 }, (_, y) => d[(y * 64 + x) * 4] + d[(y * 64 + x) * 4 + 1]);
      const diff = (a: number[], b: number[]) => a.reduce((acc, v, i) => acc + Math.abs(v - b[i]), 0) / a.length;
      expect(diff(col(0), col(63))).toBeLessThan(diff(col(10), col(20)) + 40);
    }
  });

  test("blobs have outward normals and terrain faces up", () => {
    const g = blobGeometry({ radius: 1, seed: 4, detail: 2 });
    let outward = 0;
    for (let i = 0; i < g.positions.length; i += 3) outward += g.positions[i] * g.normals[i] + g.positions[i + 1] * g.normals[i + 1] + g.positions[i + 2] * g.normals[i + 2] > 0 ? 1 : -1;
    expect(outward).toBeGreaterThan(g.positions.length / 3 * 0.9);
    const t = terrainGeometry({ width: 10, depth: 10, segments: 8, height: () => 0 });
    expect(t.normals[1]).toBeCloseTo(1, 5);
  });

  test("the sky dome follows the camera and skips fog and shadows", () => {
    const cam = new Camera3D();
    cam.position.set(5, 3, -2);
    const sky = new SkyDome3D(cam, skyTexture({ resolution: 64 }));
    sky.prepareRender3D();
    expect([sky.position.x, sky.position.y, sky.position.z]).toEqual([5, 3, -2]);
    expect(sky.scale.x).toBeCloseTo(cam.far * 0.9, 5);
    expect(sky.material.fog).toBe(false);
    expect(sky.castShadow).toBe(false);
  });
});

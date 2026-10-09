// Skinned meshes: a sprite cut into triangles, vertices weighted to bones by distance, deformed
// when a bone turns, and drawn as a mesh; following a rig copies its bone motion.

import { beforeAll, describe, expect, test } from "bun:test";
import { defineSprite, resetSpriteRegistry } from "../src/art/index.ts";
import { Rig2D, Scene, Skin2D } from "../src/scene/index.ts";
import { createTestApp, lastFrame, stepFrames } from "../src/testkit/index.ts";

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("arm", { w: 8, h: 32, origin: [0.5, 0] }, (p) => p.rect(0, 0, 8, 32, "#c96"));
  for (const n of ["head", "torso", "limb"]) defineSprite(`p.${n}`, { w: 8, h: 12 }, (p) => p.rect(0, 0, 8, 12, "#fff"));
});

describe("Skin2D", () => {
  test("vertices near a bone follow it; the mesh reaches the renderer as triangles", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const skin = scene.world.add(
      new Skin2D({ sprite: "arm", cols: 1, rows: 4, influences: 2, bones: [{ name: "upper", x0: 0, y0: 0, x1: 0, y1: 16 }, { name: "lower", x0: 0, y0: 16, x1: 0, y1: 32 }] }, 100, 100),
    );
    stepFrames(app);
    const mesh = lastFrame(app).find((o) => o.op === "mesh") as { count: number } | undefined;
    expect(mesh).toBeDefined();
    // 1x4 cells: 4 quads, 8 triangles, 24 vertices.
    expect(mesh!.count).toBe(24);
    // Rest: nothing moves.
    expect(skin.deform(0, 32)).toEqual([0, 32]);
    // Bend the lower bone a quarter turn about its start: the tip swings sideways (clockwise
    // with y down, so a point below the pivot goes left).
    skin.setBone("lower", { rot: Math.PI / 2 });
    const [tx, ty] = skin.deform(0, 32);
    expect(tx).toBeLessThan(-8);
    expect(ty).toBeLessThan(32);
    // The shoulder end stays put, being all upper bone.
    const [sx, sy] = skin.deform(0, 0);
    expect(Math.abs(sx)).toBeLessThan(1);
    expect(Math.abs(sy)).toBeLessThan(1);
    // Weights favour the nearer bone and sum to one.
    const w = skin.weightsAt(0, 30);
    expect(w.bones[0]).toBe(1);
    expect(w.weights[0]).toBeGreaterThan(w.weights[1]);
    expect(w.weights[0] + w.weights[1]).toBeCloseTo(1, 6);
  });

  test("following a rig copies its bone rotations relative to rest", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const rig = scene.world.add(new Rig2D({ template: "humanoid", parts: { head: "p.head", torso: "p.torso", "arm.near": "p.limb" } }));
    const skin = scene.world.add(new Skin2D({ sprite: "arm", cols: 1, rows: 2, bones: [{ name: "arm.near", x0: 0, y0: 0, x1: 0, y1: 32 }] }));
    skin.follow(rig);
    rig.play("swing", true);
    stepFrames(app, 8);
    const armRot = rig.bones.get("arm.near")!.rotation;
    expect(armRot).not.toBe(0);
    const [tx] = skin.deform(0, 32);
    // The tip has swung the way the rig's arm did: a negative turn sends a hanging tip to +x.
    expect(Math.sign(tx)).toBe(-Math.sign(Math.sin(armRot)));
    expect(Math.abs(tx)).toBeGreaterThan(1);
  });
});

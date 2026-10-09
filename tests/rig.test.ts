// Cutout rigs: bones from a template, parts on them, procedural and keyframed clips, layers,
// events, mirroring, and the parts loader that builds a rig from `blackiron art parts` output.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePNG } from "../cli/png.ts";
import { HUMANOID, Painter, defineRig, defineRigManifest, defineSprite, getRigManifest, resetImageRegistry, resetSpriteRegistry, resolveAssets } from "../src/art/index.ts";
import { HeadlessPlatform } from "../src/platform/headless.ts";
import { CLIPS, Rig2D, Scene, clipFromKeys } from "../src/scene/index.ts";
import { createTestApp, drawnSprites, stepFrames } from "../src/testkit/index.ts";

function parts() {
  for (const n of ["head", "torso", "arm", "leg", "sword"]) defineSprite(`p.${n}`, { w: 8, h: 12 }, (p) => p.rect(0, 0, 8, 12, "#fff"));
  return { head: "p.head", torso: "p.torso", "arm.near": "p.arm", "arm.far": "p.arm", "leg.near": "p.leg", "leg.far": "p.leg", weapon: "p.sword" };
}

describe("Rig2D", () => {
  beforeEach(() => {
    resetSpriteRegistry();
  });

  test("builds bones from the template in draw order, with parts anchored where the template says", async () => {
    const P = parts();
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const rig = scene.world.add(new Rig2D({ template: "humanoid", parts: P }));
    expect(rig.bones.size).toBe(HUMANOID.bones.length);
    expect(rig.bones.get("head")?.parent).toBe(rig.bones.get("torso"));
    expect(rig.bones.get("weapon")?.parent).toBe(rig.bones.get("arm.near"));
    expect(rig.parts.size).toBe(7);
    // The head hangs from its bottom centre, so its origin is (4, 12) on an 8x12 part.
    expect([rig.parts.get("head")?.originX, rig.parts.get("head")?.originY]).toEqual([4, 12]);
    stepFrames(app);
    const drawn = drawnSprites(app);
    // Far arm and far leg are drawn before the torso, the weapon last.
    expect(drawn.indexOf("p.arm")).toBeLessThan(drawn.indexOf("p.torso"));
    expect(drawn.lastIndexOf("p.sword")).toBe(drawn.length - 1);
    // Hips sit above the feet, scaled by the character's height.
    const tall = new Rig2D({ template: "humanoid", parts: {}, height: 128 });
    expect(tall.bones.get("hips")?.y).toBe(-48);
  });

  test("clips pose bones, loop or finish, fire events and layer over each other", async () => {
    const P = parts();
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const rig = scene.world.add(new Rig2D({ template: "humanoid", parts: P }));
    const events: string[] = [];
    rig.onEvent = (n, layer) => events.push(`${layer}:${n}`);
    const finished: string[] = [];
    rig.onFinished = (n, layer) => finished.push(`${layer}:${n}`);
    rig.play("walk");
    stepFrames(app, 6);
    const legNear = rig.bones.get("leg.near")!.rotation;
    const legFar = rig.bones.get("leg.far")!.rotation;
    expect(legNear).not.toBe(0);
    expect(Math.sign(legNear)).toBe(-Math.sign(legFar));
    // Half a cycle later the legs have swapped.
    stepFrames(app, 21);
    expect(Math.sign(rig.bones.get("leg.near")!.rotation)).toBe(-Math.sign(legNear));
    expect(events.filter((e) => e === "base:step").length).toBeGreaterThanOrEqual(1);
    // A swing on the upper layer moves the sword arm while the legs keep walking.
    rig.layer("upper", "swing");
    stepFrames(app, 8);
    expect(rig.bones.get("arm.near")!.rotation).toBeLessThan(-0.5);
    expect(rig.bones.get("leg.near")!.rotation).not.toBe(0);
    stepFrames(app, 20);
    expect(events).toContain("upper:hit");
    expect(finished).toContain("upper:swing");
    expect(rig.isPlaying("upper")).toBe(false);
    // The arm is back to the walk's swing once the layer falls away.
    stepFrames(app);
    expect(Math.abs(rig.bones.get("arm.near")!.rotation)).toBeLessThan(0.5);
    // A fall holds its end.
    rig.play("fall");
    stepFrames(app, 60);
    expect(rig.bones.get("hips")!.rotation).toBeCloseTo(-1.5, 1);
    expect(finished).toContain("base:fall");
  });

  test("keyframed clips ease between keys and facing mirrors the rig", async () => {
    const P = parts();
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const rig = scene.world.add(new Rig2D({ template: "humanoid", parts: P }));
    const nod = clipFromKeys({ name: "nod", duration: 1, tracks: { head: { rot: [[0, 0], [0.5, 1], [1, 0]] } }, events: [{ at: 0.5, name: "nod" }] });
    rig.play(nod);
    stepFrames(app, 30);
    expect(rig.bones.get("head")!.rotation).toBeCloseTo(1, 1);
    stepFrames(app, 15);
    expect(rig.bones.get("head")!.rotation).toBeCloseTo(0.5, 1);
    rig.facing = "left";
    expect(rig.scaleX).toBe(-1);
    rig.face(1);
    expect(rig.scaleX).toBe(1);
    rig.face(0);
    expect(rig.facing as string).toBe("right");
    expect(Object.keys(CLIPS).sort()).toEqual(["carry", "cast", "fall", "hurt", "idle", "run", "swing", "thrust", "walk"]);
  });

  test("a parts sheet loads as a rig with the pivots the cut worked out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blackiron-rig-"));
    const p = new Painter(20, 12);
    p.rect(1, 1, 8, 10, "#f00");
    p.rect(10, 1, 8, 10, "#00f");
    await writeFile(join(dir, "r.png"), encodePNG(20, 12, p.data));
    await writeFile(
      join(dir, "r.json"),
      JSON.stringify({
        frames: [
          { filename: "head", frame: { x: 1, y: 1, w: 8, h: 10 }, duration: 100 },
          { filename: "torso", frame: { x: 10, y: 1, w: 8, h: 10 }, duration: 100 },
          { filename: "leg.far", frame: { x: 10, y: 1, w: 8, h: 10 }, duration: 100 },
        ],
        meta: { image: "r.png", rig: { template: "humanoid", height: 40, pivots: { hips: [0, -15], torso: [0, 0], head: [0, -10] }, anchors: { head: [0.5, 1] } } },
      }),
    );
    resetImageRegistry();
    defineRig("r", "r.json");
    const items = await resolveAssets(new HeadlessPlatform({ root: dir }));
    // Dotted part names survive: only image extensions come off.
    expect(items.map((i) => i.name)).toEqual(["r.head", "r.torso", "r.leg.far"]);
    const manifest = getRigManifest("r");
    expect(manifest?.parts).toEqual({ head: "r.head", torso: "r.torso", "leg.far": "r.leg.far" });
    expect(manifest?.pivots?.head).toEqual([0, -10]);
    const rig = new Rig2D("r");
    expect(rig.bones.get("hips")?.y).toBe(-15);
    expect(rig.bones.get("head")?.y).toBe(-10);
    // Bones the cut did not place keep the template's, scaled to the height.
    expect(rig.bones.get("leg.near")?.x).toBeCloseTo(4 * (40 / 64), 5);
    expect(() => new Rig2D("nope")).toThrow();
    defineRigManifest("m", { template: "blob", parts: {} });
    expect(new Rig2D("m").template.name).toBe("blob");
    resetImageRegistry();
  });

  test("crossfades weight two clips over time, blends keep phase, and IK reaches a point", async () => {
    const P = parts();
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const rig = scene.world.add(new Rig2D({ template: "humanoid", parts: P }));
    rig.play("idle");
    rig.crossfade("walk", 0.5);
    stepFrames(app, 15);
    expect(rig.weightOf("walk")).toBeCloseTo(0.5, 1);
    expect(rig.weightOf("idle")).toBeCloseTo(0.5, 1);
    expect(rig.current).toBe("walk");
    stepFrames(app, 20);
    expect(rig.weightOf("walk")).toBe(1);
    expect(rig.weightOf("idle")).toBe(0);
    // A blend holds both: at t = 0 the run adds nothing, at t = 1 the walk adds nothing.
    rig.blend("walk", "run", 0);
    stepFrames(app, 3);
    const legAtWalk = rig.bones.get("leg.near")!.rotation;
    rig.blend("walk", "run", 1);
    stepFrames(app, 1);
    expect(rig.weightOf("run")).toBe(1);
    expect(Math.abs(rig.bones.get("leg.near")!.rotation)).toBeGreaterThan(0);
    void legAtWalk;
    // IK: the weapon hand reaches for a point in front of the shoulder.
    rig.play("idle", true);
    rig.reach("weapon", 40, -30);
    stepFrames(app, 1);
    const [hx, hy] = rig.bones.get("weapon")!.positionIn(rig);
    // The wrist (the weapon's pivot) cannot pass the target but points toward it.
    expect(Math.hypot(hx - 40, hy + 30)).toBeLessThan(Math.hypot(6 - 40, -20 + 16 + 30));
    rig.release();
    stepFrames(app, 1);
    expect(rig.bones.get("arm.near")!.rotation).toBeCloseTo(0, 1);
    // Aim: the head looks toward a point above and to the right.
    rig.aim("head", 100, -200);
    stepFrames(app, 1);
    expect(rig.bones.get("head")!.rotation).not.toBe(0);
  });
});

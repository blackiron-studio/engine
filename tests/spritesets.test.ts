// Sprite sets: one animation name, frames picked by facing, mirrored sides, frame events,
// held poses and hitboxes; and the manifest loader that builds them from `blackiron art import`.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePNG } from "../cli/png.ts";
import { Painter, defineAnimationSet, defineHitbox, defineSprite, defineSpriteSet, facingFrom, framesFor, getAnimation, getAnimationSet, resetImageRegistry, resetSpriteRegistry, resolveAssets } from "../src/art/index.ts";
import { HeadlessPlatform } from "../src/platform/headless.ts";
import { AnimatedSprite, Scene } from "../src/scene/index.ts";
import { createTestApp, stepFrames } from "../src/testkit/index.ts";

function walkSet() {
  for (const n of ["d0", "d1", "u0", "r0", "r1", "h0"]) defineSprite(n, { w: 4, h: 6 }, (p) => p.rect(0, 0, 4, 6, "#fff"));
  return defineAnimationSet({
    name: "k.walk",
    fps: 10,
    loop: true,
    mirror: true,
    frames: ["d0", "d1"],
    facings: { down: ["d0", "d1"], up: ["u0"], right: ["r0", "r1"] },
    events: new Map([["d1", "step"], ["r1", "step"]]),
    hold: 0,
  });
}

describe("Sprite sets", () => {
  beforeEach(() => {
    resetSpriteRegistry();
  });

  test("facings resolve, a missing left mirrors the right, and plain animations exist too", () => {
    const set = walkSet();
    expect(framesFor(set, "down")).toEqual({ frames: ["d0", "d1"], flip: false });
    expect(framesFor(set, "left")).toEqual({ frames: ["r0", "r1"], flip: true });
    expect(framesFor(set, "up")).toEqual({ frames: ["u0"], flip: false });
    expect(getAnimation("k.walk.right")?.frames).toEqual(["r0", "r1"]);
    expect(getAnimation("k.walk")?.frames).toEqual(["d0", "d1"]);
    expect(facingFrom(1, 0.2)).toBe("right");
    expect(facingFrom(-0.1, -1)).toBe("up");
    expect(facingFrom(0, 0, "left")).toBe("left");
  });

  test("an AnimatedSprite follows its facing, flips for the mirrored side and fires frame events", async () => {
    walkSet();
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const s = scene.world.add(new AnimatedSprite("k.walk"));
    const events: string[] = [];
    s.onEvent = (name, frame) => events.push(`${name}@${frame}`);
    expect(s.sprite).toBe("d0");
    s.facing = "left";
    expect(s.sprite).toBe("r0");
    expect(s.flipX).toBe(true);
    expect(s.mirrored).toBe(true);
    s.face(1, 0);
    expect(s.flipX).toBe(false);
    expect(s.facing as string).toBe("right");
    stepFrames(app, 7);
    expect(s.sprite).toBe("r1");
    expect(events).toEqual(["step@1"]);
    s.face(0, 1);
    expect(s.sprite).toBe("d1");
    // Playing the same set again keeps going; a different one restarts.
    s.play("k.walk");
    expect(s.frame).toBe(1);
    void app;
  });

  test("a held single frame finishes after its hold, and hitboxes come out in local space", async () => {
    defineSprite("hurt0", { w: 10, h: 20 }, (p) => p.rect(0, 0, 10, 20, "#f00"));
    defineAnimationSet({ name: "k.hurt", fps: 8, loop: false, mirror: false, frames: ["hurt0"], facings: {}, events: new Map(), hold: 0.25 });
    defineHitbox("hurt0", { x: 2, y: 4, w: 6, h: 10 });
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const s = scene.world.add(new AnimatedSprite("k.hurt"));
    let finished = "";
    s.onFinished = (n) => (finished = n);
    stepFrames(app, 10);
    expect(finished).toBe("");
    stepFrames(app, 6);
    expect(finished).toBe("k.hurt");
    // The painted sprite's origin is its centre (5, 10): the box shifts by that.
    expect(s.hitbox()).toEqual({ x: -3, y: -6, w: 6, h: 10 });
    s.flipX = true;
    expect(s.hitbox()).toEqual({ x: -3, y: -6, w: 6, h: 10 });
    defineHitbox("hurt0", { x: 0, y: 4, w: 4, h: 10 });
    expect(s.hitbox()?.x).toBe(1);
    void app;
  });

  test("the loader reads a manifest with facings, mirror, events, hold and hitboxes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blackiron-set-"));
    const p = new Painter(16, 4);
    for (let i = 0; i < 4; i++) p.rect(i * 4, 0, 4, 4, ["#f00", "#0f0", "#00f", "#ff0"][i]);
    await writeFile(join(dir, "k.png"), encodePNG(16, 4, p.data));
    await writeFile(
      join(dir, "k.json"),
      JSON.stringify({
        frames: [0, 1, 2, 3].map((i) => ({ filename: String(i), frame: { x: i * 4, y: 0, w: 4, h: 4 }, duration: 100 })),
        meta: {
          image: "k.png",
          pitch: 4,
          anchor: [0.5, 1],
          animations: {
            walk: { fps: 6, facings: { down: [0, 1], right: [2, 3] }, mirror: true, events: { "1": "step" } },
            hurt: { frames: [3], hold: 0.5 },
          },
          hitboxes: { "3": { x: 1, y: 1, w: 2, h: 2 } },
        },
      }),
    );
    resetImageRegistry();
    defineSpriteSet("k", "k.json");
    const items = await resolveAssets(new HeadlessPlatform({ root: dir }));
    expect(items.map((i) => i.name)).toEqual(["k.0", "k.1", "k.2", "k.3"]);
    expect(items[0].origin).toEqual([0.5, 1]);
    const walk = getAnimationSet("k.walk");
    expect(walk?.fps).toBe(6);
    expect(walk?.loop).toBe(true);
    expect(framesFor(walk!, "left")).toEqual({ frames: ["k.2", "k.3"], flip: true });
    expect(walk?.events.get("k.1")).toBe("step");
    const hurt = getAnimationSet("k.hurt");
    expect(hurt?.loop).toBe(false);
    expect(hurt?.hold).toBe(0.5);
    expect(getAnimation("k.walk.right")?.frames).toEqual(["k.2", "k.3"]);
    resetImageRegistry();
  });
});

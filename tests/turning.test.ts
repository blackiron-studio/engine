// Turning: a Heading turns at a limited rate the same at any frame rate; direction sets pick a
// view with a dead zone, and mirror only across the screen's vertical; directional animations
// fall back along their chain; sprites blend between views and find named points after
// mirroring, on flat and isometric layers.

import { beforeAll, describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { defineDirectionalAnimation, defineDirections, definePoints, defineSprite, getAnimationSet, pickDirection, resetSpriteRegistry, screenAngleOf, viewFrames } from "../src/art/index.ts";
import { Heading } from "../src/core/index.ts";
import type { FakeOp, FakeRenderer } from "../src/render/fake.ts";
import { AnimatedSprite, Camera2D, Scene, groundDeltaOf } from "../src/scene/index.ts";

const ISO = [1, -1, 0, 0, 0.5, 0.5, -1, 0, 1, 1, 0, 0] as [number, number, number, number, number, number, number, number, number, number, number, number];
const DEG = Math.PI / 180;

beforeAll(() => {
  resetSpriteRegistry();
  const paint = (name: string) => defineSprite(name, { w: 8, h: 8, origin: [0.5, 1] }, (p) => p.rect(0, 0, 8, 8, "#fff"));
  for (const v of ["side", "front", "back"]) paint(`fig.${v}.idle`);
  paint("fig.side.fire");
  paint("fig.front.fire");
  paint("fig.side.kick");
  // Three painted views, mirrored to six: the layout Iron Rebellion paints.
  defineDirections("fig", { views: { side: 0, front: 0.7, back: -0.7 }, mirror: true });
  defineDirectionalAnimation("fig.idle", { directions: "fig", frames: (v) => [`fig.${v}.idle`] });
  defineDirectionalAnimation("fig.fire", { directions: "fig", frames: (v) => (v === "back" ? null : [`fig.${v}.fire`]), fallback: "fig.idle" });
  defineDirectionalAnimation("fig.kick", { directions: "fig", frames: { side: ["fig.side.kick"] }, fallback: "fig.fire", hold: 0.1 });
  definePoints("fig.side.fire", { muzzle: [12, -5] });
  definePoints("fig.front.fire", { muzzle: [9, -4] });
  definePoints("fig.front.idle", { muzzle: [7, -6] });
  definePoints("fig.side.idle", { muzzle: [11, -6] });
  definePoints("fig.back.idle", { muzzle: [6, -8] });
});

async function appWith(scene: Scene): Promise<App> {
  const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 640, height: 360 }, fps: false } });
  app.scenes.change(scene);
  return app;
}

function isoScene(): Scene {
  const scene = new Scene();
  scene.camera.projection = { kind: "isometric", tile: { w: 64, h: 32 } };
  return scene;
}

const figOps = (app: App): Extract<FakeOp, { op: "sprite" }>[] =>
  (app.renderer as FakeRenderer).ops.filter((o): o is Extract<FakeOp, { op: "sprite" }> => o.op === "sprite" && o.name.startsWith("fig."));

const label = (s: AnimatedSprite): string => `${s.direction?.view}${s.direction?.flip ? "~" : ""}`;

describe("Heading", () => {
  test("a half turn takes halfTurn seconds and lands the same at any frame rate", () => {
    const at = (dt: number, t: number) => {
      const h = new Heading({ angle: 0, halfTurn: 0.2 });
      h.target = Math.PI * 0.999;
      let left = t;
      while (left > 1e-12) {
        const step = Math.min(dt, left);
        h.update(step);
        left -= step;
      }
      return h.angle;
    };
    const quarter = Math.PI / 2;
    for (const dt of [1 / 7, 1 / 30, 1 / 60, 1 / 144]) {
      expect(at(dt, 0.1)).toBeCloseTo(quarter, 9);
      expect(at(dt, 0.2)).toBeCloseTo(Math.PI * 0.999, 9);
    }
    const h = new Heading({ halfTurn: 0.2 });
    expect(h.timeToFace(Math.PI / 2)).toBeCloseTo(0.1, 9);
  });

  test("halfTurn 0 snaps; a zero vector keeps the target; snap jumps", () => {
    const h = new Heading({ halfTurn: 0 });
    h.towards(0, -1);
    h.update(1 / 60);
    expect(h.angle).toBeCloseTo(-Math.PI / 2, 9);
    h.towards(0, 0);
    expect(h.target).toBeCloseTo(-Math.PI / 2, 9);
    const g = new Heading({ halfTurn: 1 });
    g.snap(2);
    expect(g.angle).toBe(2);
    expect(g.turning).toBe(false);
  });

  test("catch-up turns fast while far behind, then normally; timeToFace matches", () => {
    const make = () => new Heading({ angle: 0, halfTurn: 0.4, catchUp: 0.5, catchUpHalfTurn: 0.05 });
    const target = 3;
    const expected = make().timeToFace(target);
    expect(expected).toBeCloseTo((3 - 0.5) / (Math.PI / 0.05) + 0.5 / (Math.PI / 0.4), 9);
    for (const dt of [1 / 30, 1 / 120]) {
      const h = make();
      h.target = target;
      let t = 0;
      while (h.turning && t < 2) {
        h.update(dt);
        t += dt;
      }
      expect(t).toBeGreaterThanOrEqual(expected - 1e-9);
      expect(t).toBeLessThan(expected + dt + 1e-9);
    }
    // Midway the two speeds give the same angle at any step size.
    const a = make();
    const b = make();
    a.target = b.target = target;
    for (let i = 0; i < 12; i++) a.update(1 / 240);
    b.update(1 / 20);
    expect(a.angle).toBeCloseTo(b.angle, 9);
  });

  test("a target straight behind keeps the way the body was already turning", () => {
    const h = new Heading({ angle: 0, halfTurn: 0.3 });
    h.target = -0.4;
    h.update(1 / 60);
    const now = h.angle;
    h.target = now + Math.PI;
    expect(Math.sign(h.offset)).toBe(-1);
    h.update(1 / 60);
    expect(h.angle).toBeLessThan(now);
  });
});

describe("direction sets", () => {
  test("mirrored views flip only across the screen's vertical", () => {
    const set = defineDirections("probe", { views: { side: 0, front: 0.7, back: -0.7 }, mirror: true });
    expect(set.directions.length).toBe(6);
    let cur = -1;
    let flip: boolean | null = null;
    for (let i = 0; i <= 3600; i++) {
      const a = -Math.PI + (i / 3600) * 2 * Math.PI;
      cur = pickDirection(set, a, cur);
      const d = set.directions[cur];
      if (flip !== null && d.flip !== flip) expect(Math.abs(Math.cos(a))).toBeLessThan(Math.sin(set.deadZone) + 0.01);
      flip = d.flip;
    }
  });

  test("the same views as Iron Rebellion's hand-written picker away from boundaries", () => {
    const set = defineDirections("probe", { views: { side: 0, front: 0.7, back: -0.7 }, mirror: true });
    const viewOf = (angle: number) => {
      const sx = Math.cos(angle) - Math.sin(angle);
      const sy = (Math.cos(angle) + Math.sin(angle)) / 2;
      const tilt = Math.atan2(sy, Math.abs(sx));
      return { view: tilt > 0.35 ? "front" : tilt < -0.35 ? "back" : "side", flip: sx < 0, tilt, sx };
    };
    for (let i = 0; i < 360; i++) {
      const world = i * DEG;
      const ref = viewOf(world);
      if (Math.abs(Math.abs(ref.tilt) - 0.35) < 0.02 || Math.abs(ref.sx) < 0.02) continue;
      const d = set.directions[pickDirection(set, screenAngleOf(world, ISO))];
      expect(`${d.view}${d.flip}`).toBe(`${ref.view}${ref.flip}`);
    }
  });

  test("aiming right on a boundary never flickers; the view changes past the dead zone", () => {
    const set = defineDirections("probe", { views: { side: 0, front: 0.7 }, deadZone: 4 * DEG });
    const edge = 0.35;
    let cur = pickDirection(set, edge - 0.1);
    const side = cur;
    for (let i = 0; i < 50; i++) cur = pickDirection(set, edge + (i % 2 ? 1 : -1) * 1e-4, cur);
    expect(cur).toBe(side);
    cur = pickDirection(set, edge + 3 * DEG, cur);
    expect(cur).toBe(side);
    cur = pickDirection(set, edge + 5 * DEG, cur);
    expect(set.directions[cur].view).toBe("front");
    cur = pickDirection(set, edge - 3 * DEG, cur);
    expect(set.directions[cur].view).toBe("front");
    cur = pickDirection(set, edge - 5 * DEG, cur);
    expect(cur).toBe(side);
  });

  test("missing frames fall back along the chain", () => {
    const kick = getAnimationSet("fig.kick")!;
    expect(viewFrames(kick, "side").frames).toEqual(["fig.side.kick"]);
    expect(viewFrames(kick, "front").frames).toEqual(["fig.front.fire"]);
    expect(viewFrames(kick, "back").frames).toEqual(["fig.back.idle"]);
    expect(viewFrames(kick, "back").source.name).toBe("fig.idle");
  });
});

describe("directional sprites", () => {
  test("the view follows the heading through the isometric projection, and flat layers as given", async () => {
    const scene = isoScene();
    const s = scene.world.add(new AnimatedSprite("fig.idle", 100, 100));
    const ui = scene.ui.add(new AnimatedSprite("fig.idle", 10, 10));
    const app = await appWith(scene);
    const look = (sprite: AnimatedSprite, angle: number) => {
      sprite.heading = angle;
      sprite.refreshView();
      return { label: label(sprite), name: sprite.sprite, mirrored: sprite.flipX };
    };
    // +x runs right and down the screen: the front three-quarter view.
    expect(look(s, 0)).toEqual({ label: "front", name: "fig.front.idle", mirrored: false });
    expect(look(s, Math.PI / 2)).toEqual({ label: "front~", name: "fig.front.idle", mirrored: true });
    expect(look(s, -Math.PI / 2)).toEqual({ label: "back", name: "fig.back.idle", mirrored: false });
    expect(look(s, -Math.PI / 4)).toEqual({ label: "side", name: "fig.side.idle", mirrored: false });
    // The UI layer is flat: +x is straight right.
    expect(look(ui, 0).label).toBe("side");
    app.destroy();
  });

  test("a turn passes through the side view and blends at each change", async () => {
    const scene = isoScene();
    const s = scene.world.add(new AnimatedSprite("fig.idle", 100, 100));
    s.turn = new Heading({ angle: -Math.PI / 2, halfTurn: 0.3 });
    const app = await appWith(scene);
    app.frame(1 / 60);
    expect(label(s)).toBe("back");
    s.turn.target = Math.PI / 2 - 0.2;
    const seen: string[] = [];
    let sinceChange = 99;
    for (let i = 0; i < 60; i++) {
      app.frame(1 / 60);
      sinceChange++;
      if (seen[seen.length - 1] !== label(s)) {
        seen.push(label(s));
        sinceChange = 0;
        if (seen.length > 1) expect(s.blending).toBe(true);
      }
      const drawn = figOps(app);
      if (s.blending) {
        // About 60 ms after the latest change: four frames at 60 fps.
        expect(sinceChange).toBeLessThan(4);
        // New view first at full strength, then the old one fading over it.
        expect(drawn.length).toBe(2);
        expect(drawn[0].name).toBe(s.sprite);
        expect(drawn[0].alpha).toBe(1);
        expect(drawn[1].alpha).toBeGreaterThan(0);
        expect(drawn[1].alpha).toBeLessThanOrEqual(1);
      } else expect(drawn.length).toBe(1);
    }
    expect(seen[0]).toBe("back");
    expect(seen).toContain(seen.includes("side") ? "side" : "side~");
    expect(seen[seen.length - 1]).toBe("front~");
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(s.blending).toBe(false);
    app.destroy();
  });

  test("a heading jittering on a boundary keeps one view and never blends", async () => {
    const scene = isoScene();
    const s = scene.world.add(new AnimatedSprite("fig.idle", 100, 100));
    const app = await appWith(scene);
    // World −π/4 + a little: the side/back boundary on screen sits at −0.35.
    const edge = Math.atan2(-0.35, 1);
    const world = (screen: number) => {
      // Invert the iso screen angle for a unit ground direction.
      for (let i = 0; i < 4000; i++) {
        const a = -Math.PI + (i / 4000) * 2 * Math.PI;
        if (Math.abs(screenAngleOf(a, ISO) - screen) < 1e-3) return a;
      }
      throw new Error("no angle");
    };
    const base = world(edge);
    s.heading = base;
    app.frame(1 / 60);
    const first = label(s);
    for (let i = 0; i < 40; i++) {
      s.heading = base + (i % 2 ? 1 : -1) * 0.004;
      app.frame(1 / 60);
      expect(label(s)).toBe(first);
      expect(s.blending).toBe(false);
    }
    app.destroy();
  });

  test("mirrored views put the muzzle on the mirrored side, and its world point draws there", async () => {
    const scene = isoScene();
    const s = scene.world.add(new AnimatedSprite("fig.fire", 100, 60));
    s.z = 10;
    const app = await appWith(scene);
    s.heading = 0;
    expect(s.point("muzzle")).toEqual([9, -4]);
    expect(label(s)).toBe("front");
    s.heading = Math.PI / 2;
    expect(s.point("muzzle")).toEqual([-9, -4]);
    expect(label(s)).toBe("front~");
    // Back has no fire frame: the idle painting and its own point stand in.
    s.heading = -Math.PI / 2;
    s.refreshView();
    expect(s.sprite).toBe("fig.back.idle");
    expect(s.point("muzzle")).toEqual([6, -8]);
    for (const forward of [0, 6]) {
      s.heading = Math.PI / 2;
      const w = s.pointInWorld("muzzle", forward)!;
      const cam = scene.camera;
      const [ax, ay] = cam.worldToScreen(s.x, s.y, s.z);
      const [bx, by] = cam.worldToScreen(w[0], w[1], w[2]);
      expect((bx - ax) / cam.zoom).toBeCloseTo(-9, 6);
      expect((by - ay) / cam.zoom).toBeCloseTo(-4, 6);
      // Forward moves it toward the camera: a higher depth key (x + y here).
      expect(w[0] + w[1] - (s.x + s.y)).toBeCloseTo(forward * Math.SQRT2, 6);
    }
    s.play("fig.kick");
    s.heading = -Math.PI / 4;
    s.refreshView();
    expect(s.sprite).toBe("fig.side.kick");
    expect(s.point("muzzle")).toBeNull();
    app.destroy();
  });

  test("groundDelta inverts tilt and top-down projections too", () => {
    for (const projection of [{ kind: "tilt" as const, angle: 0.6 }, { kind: "tilt" as const, angle: 0 }, { kind: "isometric" as const, tile: { w: 64, h: 32 } }]) {
      const cam = new Camera2D(640, 360);
      cam.projection = projection;
      const [dx, dy, dz] = cam.groundDelta(7, -5, 3);
      const [ax, ay] = cam.worldToScreen(50, 50, 0);
      const [bx, by] = cam.worldToScreen(50 + dx, 50 + dy, dz);
      expect(bx - ax).toBeCloseTo(7, 6);
      expect(by - ay).toBeCloseTo(-5, 6);
    }
    expect(groundDeltaOf(null, 3, 4, 9)).toEqual([3, 4, 0]);
  });
});

// AnimationPlayer keyframes, triggers, blending and the state machine.

import { describe, expect, test } from "bun:test";
import { AnimationPlayer, StateMachine } from "../src/scene/animation.ts";

describe("AnimationPlayer", () => {
  test("property tracks interpolate, sprite tracks step, triggers fire once", () => {
    const target = { x: 0, alpha: 1, sprite: "idle.0", velocity: { x: 0 } };
    const calls: string[] = [];
    const p = new AnimationPlayer();
    p.playSound = (n) => calls.push(`sfx:${n}`);
    p.define("hop", {
      properties: [
        { target, property: "x", keys: [[0, 0], [1, 100, "linear"]] },
        { target, property: "velocity.x", keys: [[0, 0], [0.5, 10]] },
      ],
      sprites: [{ target, keys: [[0, "hop.0"], [0.5, "hop.1"]] }],
      calls: { keys: [[0.25, () => calls.push("quarter")]] },
      sounds: { keys: [[0.5, "thud"]] },
    });
    p.play("hop");
    expect(target.x).toBe(0);
    expect(target.sprite).toBe("hop.0");
    p.update(0.5);
    expect(target.x).toBeCloseTo(50);
    expect(target.velocity.x).toBeCloseTo(10);
    expect(target.sprite).toBe("hop.1");
    expect(calls).toEqual(["quarter", "sfx:thud"]);
    p.update(0.5);
    expect(target.x).toBeCloseTo(100);
    expect(p.playing).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test("looping clips wrap, queued clips follow, onFinished reports", () => {
    const target = { y: 0 };
    const p = new AnimationPlayer();
    const finished: string[] = [];
    p.onFinished = (n) => finished.push(n);
    p.define("bob", { loop: true, properties: [{ target, property: "y", keys: [[0, 0], [1, 10]] }] });
    p.define("drop", { properties: [{ target, property: "y", keys: [[0, 0], [0.5, 50]] }] });
    p.play("bob");
    p.update(1.25);
    expect(target.y).toBeCloseTo(2.5);
    expect(p.playing).toBe("bob");
    p.play("drop").queue("bob");
    p.update(0.25);
    expect(target.y).toBeCloseTo(25);
    p.update(0.25);
    // "drop" finished and the queued "bob" started from its first key.
    expect(finished).toEqual(["drop"]);
    expect(p.playing).toBe("bob");
    expect(target.y).toBeCloseTo(0);
  });

  test("blending eases from the current value into the new clip", () => {
    const target = { x: 100 };
    const p = new AnimationPlayer();
    p.define("reset", { properties: [{ target, property: "x", keys: [[0, 0], [1, 0]] }] });
    p.play("reset", { blend: 1 });
    expect(target.x).toBeCloseTo(100);
    p.update(0.5);
    expect(target.x).toBeCloseTo(50);
    p.update(0.5);
    expect(target.x).toBeCloseTo(0);
  });
});

describe("StateMachine", () => {
  test("transitions follow conditions and drive the player", () => {
    const target = { x: 0 };
    const p = new AnimationPlayer();
    p.define("idle", { loop: true, properties: [{ target, property: "x", keys: [[0, 0], [1, 0]] }] });
    p.define("run", { loop: true, properties: [{ target, property: "x", keys: [[0, 0], [1, 10]] }] });
    let speed = 0;
    const m = new StateMachine(p);
    const log: string[] = [];
    m.add("idle", { clip: "idle", enter: () => log.push("enter idle") });
    m.add("run", { clip: "run", exit: () => log.push("exit run") });
    m.transition("idle", "run", () => speed > 0);
    m.transition("run", "idle", () => speed === 0);
    m.set("idle");
    m.update(0.1);
    expect(p.playing).toBe("idle");
    speed = 5;
    m.update(0.1);
    expect(m.state).toBe("run");
    expect(p.playing).toBe("run");
    speed = 0;
    m.update(0.1);
    expect(m.state).toBe("idle");
    expect(log).toEqual(["enter idle", "exit run", "enter idle"]);
  });
});

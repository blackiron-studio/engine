import { describe, expect, test } from "bun:test";
import { LEVEL, RULES, T, TILE, coinKey, createGame, tick } from "../src/game.ts";

const STILL = { x: 0, jump: false, jumpHeld: false };
const step = (s: ReturnType<typeof createGame>, input = STILL, n = 1) => {
  for (let i = 0; i < n; i++) tick(s, input, 1 / 60);
};

// A flat floor with a coin at head height two tiles to the right of the start.
const FLAT = ["........", "..P.....", ".....o..", "########", "########"];
// A spike set into the floor next to the start.
const SPIKY = ["........", "..P.....", "........", "###^####", "########"];

describe("platformer rules", () => {
  test("parses the level: start, coins and clean tiles", () => {
    const s = createGame(FLAT);
    expect(s.spawn).toEqual({ x: 2 * TILE + 3, y: 1 * TILE + 2 });
    expect(s.coinsTotal).toBe(1);
    expect(s.map.find(T.START)).toEqual([]);
    expect(s.map.find(T.COIN)).toEqual([]);
    expect(createGame(LEVEL).coinsTotal).toBeGreaterThan(10);
  });

  test("gravity lands the player exactly on the ground", () => {
    const s = createGame(FLAT);
    step(s, STILL, 120);
    expect(s.player.onGround).toBe(true);
    expect(s.player.y + s.player.h).toBe(3 * TILE);
  });

  test("jumping rises and a short press cuts the jump", () => {
    const s = createGame(FLAT);
    step(s, STILL, 120);
    const y0 = s.player.y;
    const ev = tick(s, { x: 0, jump: true, jumpHeld: true }, 1 / 60);
    expect(ev.some((e) => e.type === "jump")).toBe(true);
    expect(s.player.vy).toBeLessThan(0);
    step(s, { x: 0, jump: false, jumpHeld: true }, 10);
    expect(s.player.y).toBeLessThan(y0);
    const held = s.player.vy;
    tick(s, { x: 0, jump: false, jumpHeld: false }, 1 / 60);
    expect(s.player.vy).toBeGreaterThan(held);
    expect(s.player.vy).toBeGreaterThanOrEqual(-RULES.jumpCut);
  });

  test("coyote time allows a jump just after leaving a ledge", () => {
    const s = createGame(FLAT);
    step(s, STILL, 120);
    s.player.onGround = false;
    s.player.coyote = RULES.coyote;
    const ev = tick(s, { x: 0, jump: true, jumpHeld: true }, 1 / 60);
    expect(ev.some((e) => e.type === "jump")).toBe(true);
  });

  test("walking over a coin collects it", () => {
    const s = createGame(FLAT);
    step(s, STILL, 120);
    const events: string[] = [];
    for (let i = 0; i < 90; i++) for (const e of tick(s, { x: 1, jump: false, jumpHeld: false }, 1 / 60)) events.push(e.type);
    expect(events).toContain("coin");
    expect(s.coinsGot).toBe(1);
    expect(s.coins.has(coinKey(5, 2, s.map.cols))).toBe(false);
  });

  test("spikes kill and respawn at the start", () => {
    const s = createGame(SPIKY);
    step(s, STILL, 120);
    s.player.x = 3 * TILE + 3;
    s.player.y = 3 * TILE + 2;
    const ev = tick(s, STILL, 1 / 60);
    expect(ev.some((e) => e.type === "die")).toBe(true);
    expect(s.deaths).toBe(1);
    expect(s.player.dead).toBeGreaterThan(0);
    step(s, STILL, 60);
    expect(s.player.dead).toBe(0);
    expect(s.player.x).toBe(s.spawn.x);
  });

  test("falling out of the world also kills", () => {
    const s = createGame(["P.", "..", ".."]);
    step(s, STILL, 240);
    expect(s.deaths).toBeGreaterThanOrEqual(1);
  });

  test("touching the flag wins and freezes the game", () => {
    const s = createGame(["P.F", "###"]);
    step(s, { x: 1, jump: false, jumpHeld: false }, 120);
    expect(s.won).toBe(true);
    const x = s.player.x;
    step(s, { x: 1, jump: false, jumpHeld: false }, 10);
    expect(s.player.x).toBe(x);
  });
});

import { describe, expect, test } from "bun:test";
import { RULES, WORLD_H, WORLD_W, createGame, targetWispCount, tick } from "../src/game.ts";

describe("Wisp Hollow rules", () => {
  test("zero-time and invalid steps never collect, damage, or separate overlapping actors", () => {
    const s = createGame("freeze");
    s.embers[0].x = s.player.x;
    s.embers[0].y = s.player.y - 12;
    s.wisps[0].x = s.player.x;
    s.wisps[0].y = s.player.y - 16;
    for (const dt of [0, -1, NaN, Infinity]) expect(tick(s, { x: 1, y: 0 }, dt)).toEqual([]);
    expect(s.score).toBe(0);
    expect(s.player.lives).toBe(RULES.lives);
    expect(s.time).toBe(0);
    expect(s.embers).toHaveLength(RULES.emberCount);
  });
  test("a seed produces the same world twice", () => {
    const a = createGame("seed-1");
    const b = createGame("seed-1");
    expect(a.tiles).toEqual(b.tiles);
    expect(a.obstacles).toEqual(b.obstacles);
    expect(a.embers).toEqual(b.embers);
  });

  test("different seeds differ", () => {
    const a = createGame("seed-1");
    const b = createGame("seed-2");
    expect(a.obstacles).not.toEqual(b.obstacles);
  });

  test("starts with the configured embers, wisps and lives", () => {
    const s = createGame(1);
    expect(s.embers.length).toBe(RULES.emberCount);
    expect(s.wisps.length).toBe(RULES.wispStart);
    expect(s.player.lives).toBe(RULES.lives);
  });

  test("moving right advances the player and faces right", () => {
    const s = createGame(1);
    const x0 = s.player.x;
    for (let i = 0; i < 30; i++) tick(s, { x: 1, y: 0 }, 1 / 60);
    expect(s.player.x).toBeGreaterThan(x0 + 40);
    expect(s.player.facing).toBe(1);
    expect(s.player.moving).toBe(true);
  });

  test("the player stays inside the world", () => {
    const s = createGame(1);
    for (let i = 0; i < 2000; i++) tick(s, { x: -1, y: -1 }, 1 / 60);
    expect(s.player.x).toBeGreaterThanOrEqual(8);
    expect(s.player.y).toBeGreaterThanOrEqual(12);
    for (let i = 0; i < 4000; i++) tick(s, { x: 1, y: 1 }, 1 / 60);
    expect(s.player.x).toBeLessThanOrEqual(WORLD_W - 8);
    expect(s.player.y).toBeLessThanOrEqual(WORLD_H - 4);
  });

  test("walking onto an ember collects it, scores, and respawns another", () => {
    const s = createGame(1);
    s.wisps.length = 0;
    const e = s.embers[0];
    s.player.x = e.x;
    s.player.y = e.y + 6;
    const events = tick(s, { x: 0, y: 0 }, 1 / 60);
    expect(events.some((ev) => ev.type === "collect")).toBe(true);
    expect(s.score).toBe(1);
    expect(s.embers.length).toBe(RULES.emberCount);
    expect(s.embers.find((x) => x.id === e.id)).toBeUndefined();
    expect(events.some((ev) => ev.type === "emberSpawn")).toBe(true);
  });

  test("a wisp touching the player costs a life and grants invulnerability", () => {
    const s = createGame(1);
    const w = s.wisps[0];
    w.x = s.player.x;
    w.y = s.player.y - 8;
    const events = tick(s, { x: 0, y: 0 }, 1 / 60);
    expect(events.some((ev) => ev.type === "hurt")).toBe(true);
    expect(s.player.lives).toBe(RULES.lives - 1);
    expect(s.player.hurt).toBeGreaterThan(0);
    // The striking wisp is replaced.
    expect(s.wisps.find((x) => x.id === w.id)).toBeUndefined();
    expect(s.wisps.length).toBe(RULES.wispStart);
    // Immediately touching again does nothing while invulnerable.
    const w2 = s.wisps[0];
    w2.x = s.player.x;
    w2.y = s.player.y - 8;
    const again = tick(s, { x: 0, y: 0 }, 1 / 60);
    expect(again.some((ev) => ev.type === "hurt")).toBe(false);
  });

  test("losing every life ends the game and freezes it", () => {
    const s = createGame(1);
    for (let life: number = RULES.lives; life > 0; life--) {
      s.player.hurt = 0;
      const w = s.wisps[0];
      w.x = s.player.x;
      w.y = s.player.y - 8;
      const events = tick(s, { x: 0, y: 0 }, 1 / 60);
      if (life === 1) expect(events.some((ev) => ev.type === "over")).toBe(true);
    }
    expect(s.over).toBe(true);
    const x = s.player.x;
    tick(s, { x: 1, y: 0 }, 1 / 60);
    expect(s.player.x).toBe(x);
  });

  test("more embers summon more wisps, up to the cap", () => {
    expect(targetWispCount(0)).toBe(RULES.wispStart);
    expect(targetWispCount(RULES.wispEvery)).toBe(RULES.wispStart + 1);
    expect(targetWispCount(10_000)).toBe(RULES.wispMax);
    const s = createGame(1);
    s.score = RULES.wispEvery * 2;
    tick(s, { x: 0, y: 0 }, 1 / 60);
    expect(s.wisps.length).toBe(RULES.wispStart + 2);
  });

  test("wisps drift toward the player", () => {
    const s = createGame(1);
    const w = s.wisps[0];
    const d0 = Math.hypot(w.x - s.player.x, w.y - s.player.y);
    for (let i = 0; i < 120; i++) tick(s, { x: 0, y: 0 }, 1 / 60);
    const w1 = s.wisps.find((x) => x.id === w.id);
    expect(w1).toBeDefined();
    expect(Math.hypot((w1 as typeof w).x - s.player.x, (w1 as typeof w).y - s.player.y)).toBeLessThan(d0);
  });
});

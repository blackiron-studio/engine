import { describe, expect, test } from "bun:test";
import { RULES, createGame, targetSlimes, tick } from "../src/game.ts";

describe("topdown rules", () => {
  test("worlds are deterministic per seed", () => {
    expect(createGame("a").obstacles).toEqual(createGame("a").obstacles);
    expect(createGame("a").obstacles).not.toEqual(createGame("b").obstacles);
  });

  test("moving right advances and faces right", () => {
    const s = createGame(1);
    const x0 = s.player.x;
    for (let i = 0; i < 30; i++) tick(s, { x: 1, y: 0 }, 1 / 60);
    expect(s.player.x).toBeGreaterThan(x0 + 30);
    expect(s.player.facing).toBe(1);
  });

  test("picking a gem scores and respawns one", () => {
    const s = createGame(1);
    s.slimes.length = 0;
    const g = s.gems[0];
    s.player.x = g.x;
    s.player.y = g.y + 5;
    const events = tick(s, { x: 0, y: 0 }, 1 / 60);
    expect(events.some((e) => e.type === "pick")).toBe(true);
    expect(s.score).toBe(1);
    expect(s.gems).toHaveLength(RULES.gems);
  });

  test("a slime costs a life and eventually ends the game", () => {
    const s = createGame(1);
    for (let life = RULES.lives; life > 0; life--) {
      s.player.hurt = 0;
      s.slimes[0].x = s.player.x;
      s.slimes[0].y = s.player.y - 5;
      const events = tick(s, { x: 0, y: 0 }, 1 / 60);
      expect(events.some((e) => e.type === "hurt")).toBe(true);
    }
    expect(s.over).toBe(true);
  });

  test("slime count grows with score up to the cap", () => {
    expect(targetSlimes(0)).toBe(RULES.slimeStart);
    expect(targetSlimes(RULES.slimeEvery * 100)).toBe(RULES.slimeMax);
  });
});

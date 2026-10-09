import { describe, expect, test } from "bun:test";
import { grid } from "@blackiron-studio/engine/core";
import { TERRAIN, TYPES, attack, createGame, endTurn, enemyStep, moveUnit, reachable, targets, team, unitById } from "../src/game.ts";

describe("tactics rules", () => {
  test("starts with four units a side on the player's turn", () => {
    const s = createGame(1);
    expect(team(s, 0)).toHaveLength(4);
    expect(team(s, 1)).toHaveLength(4);
    expect(s.phase).toBe("player");
  });

  test("movement respects terrain cost, water and other units", () => {
    const s = createGame(1);
    const soldier = team(s, 0)[0];
    const r = reachable(s, soldier);
    expect(r.has(grid.key(soldier.col, soldier.row))).toBe(true);
    for (const k of r.keys()) {
      const { x, y } = grid.unkey(k);
      expect(s.map.get(x, y)).not.toBe(TERRAIN.WATER);
      expect(s.map.get(x, y)).not.toBe(TERRAIN.ROCK);
    }
    // Forest costs two, so a straight run through it reaches less far.
    const forest = grid.key(1, 1);
    expect(r.has(forest)).toBe(true);
    const ally = team(s, 0)[1];
    expect(r.has(grid.key(ally.col, ally.row))).toBe(false);
  });

  test("moveUnit walks a path and only once per turn", () => {
    const s = createGame(1);
    const u = team(s, 0)[0];
    const path = moveUnit(s, u.id, u.col + 2, u.row);
    expect(path).not.toBeNull();
    expect(path?.[0]).toEqual({ x: 1, y: 2 });
    expect(u.col).toBe(3);
    expect(moveUnit(s, u.id, 4, 2)).toBeNull();
    expect(moveUnit(s, u.id, 11, 7)).toBeNull();
  });

  test("attacks need range, deal damage, respect forest cover and kill", () => {
    const s = createGame(1);
    const a = team(s, 0)[0];
    const t = team(s, 1)[0];
    expect(attack(s, a.id, t.id)).toBeNull();
    t.col = a.col + 1;
    t.row = a.row;
    const r = attack(s, a.id, t.id);
    expect(r?.damage).toBe(TYPES.soldier.atk);
    expect(t.hp).toBe(TYPES.brute.hp - TYPES.soldier.atk);
    expect(a.acted).toBe(true);
    expect(attack(s, a.id, t.id)).toBeNull();
    // Cover.
    const b = team(s, 0)[1];
    const e = team(s, 1)[1];
    e.col = b.col + 1;
    e.row = b.row;
    s.map.set(e.col, e.row, TERRAIN.FOREST);
    expect(attack(s, b.id, e.id)?.damage).toBe(TYPES.soldier.atk - 1);
    // Kill.
    e.hp = 1;
    endTurn(s);
    endTurn(s);
    const k = attack(s, b.id, e.id);
    expect(k?.killed).toBe(true);
    expect(unitById(s, e.id)).toBeUndefined();
  });

  test("archers hit at range two and three but not adjacent", () => {
    const s = createGame(1);
    const archer = team(s, 0)[2];
    const enemy = team(s, 1)[0];
    enemy.col = archer.col + 1;
    enemy.row = archer.row;
    expect(targets(s, archer)).toHaveLength(0);
    enemy.col = archer.col + 3;
    expect(targets(s, archer).map((u) => u.id)).toEqual([enemy.id]);
  });

  test("the enemy phase closes in and attacks, then hands the turn back", () => {
    const s = createGame(1);
    endTurn(s);
    expect(s.phase).toBe("enemy");
    const before = team(s, 1).map((u) => grid.manhattan(u.col, u.row, 1, 3));
    const actions = [];
    for (let i = 0; i < 4; i++) actions.push(enemyStep(s));
    expect(actions.every((a) => a !== null)).toBe(true);
    const after = team(s, 1).map((u) => grid.manhattan(u.col, u.row, 1, 3));
    expect(after.reduce((a, b) => a + b, 0)).toBeLessThan(before.reduce((a, b) => a + b, 0));
    expect(enemyStep(s)).toBeNull();
    expect(s.phase).toBe("player");
    expect(s.round).toBe(2);
    expect(team(s, 1).every((u) => !u.acted)).toBe(true);
  });

  test("an enemy in range attacks the weakest target", () => {
    const s = createGame(1);
    const brute = team(s, 1)[0];
    const p1 = team(s, 0)[0];
    const p2 = team(s, 0)[1];
    p1.col = brute.col - 1;
    p1.row = brute.row;
    p2.col = brute.col + 1;
    p2.row = brute.row;
    p2.hp = 2;
    endTurn(s);
    const a = enemyStep(s);
    expect(a?.attack?.targetId).toBe(p2.id);
    expect(a?.attack?.killed).toBe(true);
  });

  test("wiping out a team ends the game", () => {
    const s = createGame(1);
    for (const e of team(s, 1)) e.hp = 1;
    const a = team(s, 0)[0];
    for (const e of [...team(s, 1)]) {
      e.col = a.col + 1;
      e.row = a.row;
      a.acted = false;
      attack(s, a.id, e.id);
    }
    expect(s.winner).toBe(0);
    expect(s.phase).toBe("over");
    expect(enemyStep(s)).toBeNull();
  });
});

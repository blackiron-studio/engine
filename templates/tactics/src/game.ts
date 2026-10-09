// Rules for the tactics starter: a grid, two teams, movement by flood fill, attacks by
// range, an enemy phase. Pure state, deterministic, tested without a browser.

import { Rng, TileMapData, grid } from "@kiln/engine/core";

export const GRID = { cols: 20, rows: 12, tile: 32 } as const;

export const TERRAIN = { GRASS: 0, FOREST: 1, WATER: 2, ROCK: 3 } as const;
export const TERRAIN_SPRITE = ["grass", "forest", "water", "rock"] as const;

export const MAP = [
  "....................",
  ".T......~~..........",
  ".T......~~.....R....",
  "....R...........T...",
  "......R........~~..T",
  "..~~...........~~..T",
  "..~~..T.............",
  ".......T....R.......",
  "............T.......",
  "....T........~~~....",
  "..............~~....",
  "....................",
];
export const LEGEND: Record<string, number> = { T: TERRAIN.FOREST, "~": TERRAIN.WATER, R: TERRAIN.ROCK };

export type Kind = "soldier" | "archer" | "brute";

export interface UnitType {
  name: string;
  hp: number;
  atk: number;
  move: number;
  rangeMin: number;
  rangeMax: number;
}

export const TYPES: Record<Kind, UnitType> = {
  soldier: { name: "SOLDIER", hp: 8, atk: 3, move: 4, rangeMin: 1, rangeMax: 1 },
  archer: { name: "ARCHER", hp: 5, atk: 3, move: 3, rangeMin: 2, rangeMax: 3 },
  brute: { name: "BRUTE", hp: 11, atk: 4, move: 3, rangeMin: 1, rangeMax: 1 },
};

export type Team = 0 | 1;

export interface Unit {
  id: number;
  kind: Kind;
  team: Team;
  col: number;
  row: number;
  hp: number;
  moved: boolean;
  acted: boolean;
}

export type Phase = "player" | "enemy" | "over";

export interface GameState {
  map: TileMapData;
  units: Unit[];
  phase: Phase;
  round: number;
  winner: Team | null;
  selected: number | null;
  rng: Rng;
}

export interface AttackResult {
  attackerId: number;
  targetId: number;
  damage: number;
  killed: boolean;
}

export interface EnemyAction {
  unitId: number;
  path: grid.Cell[];
  attack: AttackResult | null;
}

export function createGame(seed: string | number = "skirmish"): GameState {
  const map = TileMapData.fromAscii(MAP, LEGEND, TERRAIN.GRASS);
  let id = 1;
  const mk = (kind: Kind, team: Team, col: number, row: number): Unit => ({ id: id++, kind, team, col, row, hp: TYPES[kind].hp, moved: false, acted: false });
  return {
    map,
    units: [
      mk("soldier", 0, 1, 2),
      mk("soldier", 0, 1, 5),
      mk("archer", 0, 0, 3),
      mk("archer", 0, 2, 8),
      mk("brute", 1, 17, 5),
      mk("soldier", 1, 17, 3),
      mk("archer", 1, 18, 6),
      mk("soldier", 1, 16, 9),
    ],
    phase: "player",
    round: 1,
    winner: null,
    selected: null,
    rng: new Rng(seed),
  };
}

export const terrainCost = (t: number): number => (t === TERRAIN.GRASS ? 1 : t === TERRAIN.FOREST ? 2 : Infinity);
export const unitAt = (s: GameState, col: number, row: number): Unit | undefined => s.units.find((u) => u.col === col && u.row === row);
export const unitById = (s: GameState, id: number): Unit | undefined => s.units.find((u) => u.id === id);
export const team = (s: GameState, t: Team): Unit[] => s.units.filter((u) => u.team === t);

function costFor(s: GameState, unit: Unit): grid.CostFn {
  return (x, y) => {
    const c = terrainCost(s.map.get(x, y));
    if (!isFinite(c)) return Infinity;
    const other = unitAt(s, x, y);
    if (other && other.team !== unit.team) return Infinity;
    return c;
  };
}

/** Cells the unit can end its move on, keyed with `grid.key`, with the cost to get there. */
export function reachable(s: GameState, unit: Unit): Map<number, number> {
  if (unit.moved) return new Map([[grid.key(unit.col, unit.row), 0]]);
  const all = grid.reachable(GRID.cols, GRID.rows, costFor(s, unit), { x: unit.col, y: unit.row }, TYPES[unit.kind].move);
  for (const k of [...all.keys()]) {
    const { x, y } = grid.unkey(k);
    const other = unitAt(s, x, y);
    if (other && other !== unit) all.delete(k);
  }
  return all;
}

export const inRange = (u: Unit, col: number, row: number): boolean => {
  const d = grid.manhattan(u.col, u.row, col, row);
  const t = TYPES[u.kind];
  return d >= t.rangeMin && d <= t.rangeMax;
};

/** Enemy units the unit could attack from where it stands. */
export function targets(s: GameState, unit: Unit): Unit[] {
  if (unit.acted) return [];
  return s.units.filter((o) => o.team !== unit.team && inRange(unit, o.col, o.row));
}

export function select(s: GameState, id: number | null): void {
  s.selected = id;
}

/** Move a unit to a reachable cell. Returns the path walked, or null if not allowed. */
export function moveUnit(s: GameState, id: number, col: number, row: number): grid.Cell[] | null {
  const u = unitById(s, id);
  if (!u || u.moved || s.phase === "over") return null;
  if (!reachable(s, u).has(grid.key(col, row))) return null;
  const path = grid.findPath(GRID.cols, GRID.rows, costFor(s, u), { x: u.col, y: u.row }, { x: col, y: row });
  if (!path) return null;
  u.col = col;
  u.row = row;
  u.moved = true;
  return path;
}

export function attack(s: GameState, attackerId: number, targetId: number): AttackResult | null {
  const a = unitById(s, attackerId);
  const t = unitById(s, targetId);
  if (!a || !t || a.acted || a.team === t.team || !inRange(a, t.col, t.row) || s.phase === "over") return null;
  const cover = s.map.get(t.col, t.row) === TERRAIN.FOREST ? 1 : 0;
  const damage = Math.max(1, TYPES[a.kind].atk - cover);
  t.hp -= damage;
  const killed = t.hp <= 0;
  if (killed) s.units.splice(s.units.indexOf(t), 1);
  a.acted = true;
  a.moved = true;
  checkWinner(s);
  return { attackerId, targetId, damage, killed };
}

/** Spend a unit's action without attacking. */
export function wait(s: GameState, id: number): void {
  const u = unitById(s, id);
  if (u) {
    u.acted = true;
    u.moved = true;
  }
}

export function checkWinner(s: GameState): Team | null {
  if (team(s, 1).length === 0) s.winner = 0;
  else if (team(s, 0).length === 0) s.winner = 1;
  if (s.winner !== null) s.phase = "over";
  return s.winner;
}

export const allActed = (s: GameState, t: Team): boolean => team(s, t).every((u) => u.acted);

export function endTurn(s: GameState): void {
  if (s.phase === "over") return;
  for (const u of s.units) {
    u.moved = false;
    u.acted = false;
  }
  s.selected = null;
  if (s.phase === "player") s.phase = "enemy";
  else {
    s.phase = "player";
    s.round++;
  }
}

/**
 * Take one enemy unit's turn: attack if a target is in range, otherwise move toward the
 * nearest player unit (preferring cells that put it in range) and attack if possible.
 * Returns null and hands the turn back once every enemy has acted.
 */
export function enemyStep(s: GameState): EnemyAction | null {
  if (s.phase !== "enemy") return null;
  const u = team(s, 1).find((x) => !x.acted);
  if (!u) {
    endTurn(s);
    return null;
  }
  const players = team(s, 0);
  if (players.length === 0) {
    checkWinner(s);
    return null;
  }
  const nearest = players.reduce((best, p) => (grid.manhattan(u.col, u.row, p.col, p.row) < grid.manhattan(u.col, u.row, best.col, best.row) ? p : best));
  let path: grid.Cell[] = [];
  const immediate = targets(s, u);
  if (immediate.length === 0) {
    let bestKey = grid.key(u.col, u.row);
    let bestScore = Infinity;
    for (const [k, cost] of reachable(s, u)) {
      const { x, y } = grid.unkey(k);
      const d = grid.manhattan(x, y, nearest.col, nearest.row);
      const t = TYPES[u.kind];
      const canHit = d >= t.rangeMin && d <= t.rangeMax;
      const score = (canHit ? -100 : 0) + Math.abs(d - t.rangeMin) * 10 + cost + s.rng.range(0, 0.5);
      if (score < bestScore) {
        bestScore = score;
        bestKey = k;
      }
    }
    const dest = grid.unkey(bestKey);
    if (dest.x !== u.col || dest.y !== u.row) path = moveUnit(s, u.id, dest.x, dest.y) ?? [];
  }
  const after = targets(s, u);
  let result: AttackResult | null = null;
  if (after.length > 0) {
    const weakest = after.reduce((a, b) => (b.hp < a.hp ? b : a));
    result = attack(s, u.id, weakest.id);
  } else wait(s, u.id);
  return { unitId: u.id, path, attack: result };
}

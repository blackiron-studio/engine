// Rules for the platformer starter: level parsing, player physics, pickups and hazards.
// Pure state plus a tick function, so it runs in `bun test` without a browser.

import { TileMapData, approach, cellsUnder, clamp, groundedAabb, moveAabb } from "@kiln/engine/core";

export const TILE = 32;

export const T = { EMPTY: 0, SOLID: 1, PLATFORM: 2, COIN: 3, SPIKE: 4, FLAG: 5, START: 6 } as const;
export const LEGEND: Record<string, number> = { "#": T.SOLID, "=": T.PLATFORM, o: T.COIN, "^": T.SPIKE, F: T.FLAG, P: T.START };

/** The level. `#` solid, `=` one-way platform, `o` coin, `^` spike, `P` start, `F` flag. */
export const LEVEL = [
  "................................................................................",
  "................................................................................",
  "...........o.o..............o.o.........................o.o.....................",
  "..........#####............#####.......................#####....................",
  "......o..............o........................o...........................o.....",
  "....####........o..=====..........o.###..........o.o....====..........o...####..",
  "...............###..........o.o..####...........######.........o.o.......^^.###.",
  ".P.....o..===.........o.....####.........o.................o..######...######..F",
  "####..####.......o...####...........^^..######.........o............^^.........#",
  "####..####..o.^^.......#.....o.....####.........o.....####.....o..o.......######",
  "####^^#######====....o.#....###.......................^^^.....######............",
  "####..........o......==#.......^^^..........o.o.....######..........o...........",
  "####.....o.o.........o.#.....######........#####....................####........",
  "####...######.o.....####...........o.o.................o..o...^^^...............",
  "####..............o..........^^^..#####.........o.....######...######...........",
  "####...#...o..o.....^^^.....######......o..o.........................o.o........",
  "####...#..#####....######..........####..######.....o.......^^^^....######......",
  "########^^^^^^^^^^^^^^^^^^^^^^^#########^^^^^^^^^^^^#####^^^^^^^^^^^^^^^^^^^^^^^#",
  "################################################################################",
  "################################################################################",
  "################################################################################",
  "################################################################################",
];

export const RULES = {
  speed: 184,
  accel: 1800,
  gravity: 1960,
  maxFall: 660,
  jump: 536,
  /** Upward speed the jump is cut to when the button is released early. */
  jumpCut: 200,
  coyote: 0.1,
  buffer: 0.12,
  respawn: 0.7,
} as const;

export interface PlayerState {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  onGround: boolean;
  facing: 1 | -1;
  coyote: number;
  buffer: number;
  jumping: boolean;
  /** Seconds until respawn while dead; 0 when alive. */
  dead: number;
}

export interface GameInput {
  x: number;
  /** Jump pressed this step. */
  jump: boolean;
  jumpHeld: boolean;
}

export type GameEvent =
  | { type: "jump"; x: number; y: number }
  | { type: "land"; x: number; y: number }
  | { type: "coin"; x: number; y: number; got: number; total: number }
  | { type: "die"; x: number; y: number }
  | { type: "respawn" }
  | { type: "win"; time: number; deaths: number };

export interface GameState {
  map: TileMapData;
  coins: Set<number>;
  coinsTotal: number;
  coinsGot: number;
  player: PlayerState;
  spawn: { x: number; y: number };
  deaths: number;
  time: number;
  won: boolean;
}

export const coinKey = (col: number, row: number, cols: number): number => row * cols + col;

export function createGame(rows: string[] = LEVEL): GameState {
  const map = TileMapData.fromAscii(rows, LEGEND, T.EMPTY);
  const start = map.find(T.START)[0] ?? { x: 1, y: 1 };
  map.replaceAll(T.START, T.EMPTY);
  const coins = new Set<number>();
  for (const c of map.find(T.COIN)) coins.add(coinKey(c.x, c.y, map.cols));
  map.replaceAll(T.COIN, T.EMPTY);
  const spawn = { x: start.x * TILE + 3, y: start.y * TILE + 2 };
  return {
    map,
    coins,
    coinsTotal: coins.size,
    coinsGot: 0,
    player: { x: spawn.x, y: spawn.y, w: 20, h: 28, vx: 0, vy: 0, onGround: false, facing: 1, coyote: 0, buffer: 0, jumping: false, dead: 0 },
    spawn,
    deaths: 0,
    time: 0,
    won: false,
  };
}

export const isSolid = (map: TileMapData) => (c: number, r: number) => map.get(c, r) === T.SOLID;
export const isPlatform = (map: TileMapData) => (c: number, r: number) => map.get(c, r) === T.PLATFORM;

export function respawn(s: GameState): void {
  const p = s.player;
  p.x = s.spawn.x;
  p.y = s.spawn.y;
  p.vx = 0;
  p.vy = 0;
  p.dead = 0;
  p.jumping = false;
  p.onGround = false;
}

function die(s: GameState, events: GameEvent[]): void {
  const p = s.player;
  p.dead = RULES.respawn;
  s.deaths++;
  events.push({ type: "die", x: p.x + p.w / 2, y: p.y + p.h / 2 });
}

export function tick(s: GameState, input: GameInput, dt: number): GameEvent[] {
  const events: GameEvent[] = [];
  if (s.won) return events;
  s.time += dt;
  const p = s.player;
  if (p.dead > 0) {
    p.dead -= dt;
    if (p.dead <= 0) {
      respawn(s);
      events.push({ type: "respawn" });
    }
    return events;
  }

  const ix = clamp(input.x, -1, 1);
  p.vx = approach(p.vx, ix * RULES.speed, RULES.accel * dt);
  if (ix < -0.05) p.facing = -1;
  else if (ix > 0.05) p.facing = 1;

  p.coyote = p.onGround ? RULES.coyote : Math.max(0, p.coyote - dt);
  p.buffer = input.jump ? RULES.buffer : Math.max(0, p.buffer - dt);
  if (p.buffer > 0 && p.coyote > 0) {
    p.vy = -RULES.jump;
    p.buffer = 0;
    p.coyote = 0;
    p.onGround = false;
    p.jumping = true;
    events.push({ type: "jump", x: p.x + p.w / 2, y: p.y + p.h });
  }
  if (p.jumping && !input.jumpHeld && p.vy < -RULES.jumpCut) p.vy = -RULES.jumpCut;
  if (p.vy >= 0) p.jumping = false;
  p.vy = Math.min(RULES.maxFall, p.vy + RULES.gravity * dt);

  const solid = isSolid(s.map);
  const platform = isPlatform(s.map);
  const r = moveAabb(p, p.vx * dt, p.vy * dt, TILE, solid, platform);
  p.x = r.x;
  p.y = r.y;
  if (r.hitLeft || r.hitRight) p.vx = 0;
  if (r.hitTop) p.vy = 0;
  const wasGround = p.onGround;
  if (r.hitBottom) p.vy = 0;
  p.onGround = r.hitBottom || (p.vy >= 0 && groundedAabb(p, TILE, solid, platform));
  if (p.onGround && !wasGround) events.push({ type: "land", x: p.x + p.w / 2, y: p.y + p.h });

  // Pickups and hazards use a slightly smaller box so grazing a spike is forgiven.
  for (const c of cellsUnder({ x: p.x + 4, y: p.y + 4, w: p.w - 8, h: p.h - 8 }, TILE)) {
    const k = coinKey(c.x, c.y, s.map.cols);
    if (s.coins.has(k)) {
      s.coins.delete(k);
      s.coinsGot++;
      events.push({ type: "coin", x: c.x * TILE + TILE / 2, y: c.y * TILE + TILE / 2, got: s.coinsGot, total: s.coinsTotal });
    }
    const t = s.map.get(c.x, c.y);
    if (t === T.SPIKE) {
      die(s, events);
      return events;
    }
    if (t === T.FLAG) {
      s.won = true;
      events.push({ type: "win", time: s.time, deaths: s.deaths });
      return events;
    }
  }
  if (p.y > s.map.rows * TILE + 64) die(s, events);
  return events;
}

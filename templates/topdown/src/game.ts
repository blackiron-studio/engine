// Rules for the top-down starter. Pure state plus a tick function with a seeded rng, so
// everything here runs in `bun test` without a browser.

import { Rng, clamp } from "@kiln/engine/core";

export const WORLD = { cols: 60, rows: 34, tile: 32 } as const;
export const WORLD_W = WORLD.cols * WORLD.tile;
export const WORLD_H = WORLD.rows * WORLD.tile;

export const RULES = {
  speed: 180,
  lives: 3,
  hurtTime: 1.2,
  gems: 6,
  pickRadius: 18,
  slimeStart: 2,
  slimeEvery: 5,
  slimeMax: 7,
  slimeSpeed: 54,
  slimeSpeedPerGem: 1.8,
  hitRadius: 14,
  knockback: 240,
} as const;

/** Tile ids: 0-2 grass, 3 dark grass (autotiled), 4 flowers. */
export const GRASS_IDS = [0, 1, 2] as const;
export const DARK_ID = 3;
export const FLOWERS_ID = 4;

export interface Obstacle {
  x: number;
  y: number;
  r: number;
  sprite: string;
}

export interface Gem {
  id: number;
  x: number;
  y: number;
}

export interface Slime {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
}

export interface Player {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  moving: boolean;
  hurt: number;
  lives: number;
}

export type GameEvent =
  | { type: "pick"; x: number; y: number; score: number }
  | { type: "hurt"; x: number; y: number; lives: number }
  | { type: "gemSpawn"; id: number }
  | { type: "slimeSpawn"; id: number }
  | { type: "over"; score: number };

export interface GameState {
  tiles: Uint8Array;
  obstacles: Obstacle[];
  player: Player;
  gems: Gem[];
  slimes: Slime[];
  score: number;
  time: number;
  nextId: number;
  over: boolean;
  rng: Rng;
}

export function createGame(seed: string | number = "meadow"): GameState {
  const rng = new Rng(seed);
  const tiles = new Uint8Array(WORLD.cols * WORLD.rows);
  for (let i = 0; i < tiles.length; i++) tiles[i] = rng.int(0, 2);
  for (let n = 0; n < 18; n++) {
    const cx = rng.int(0, WORLD.cols - 1);
    const cy = rng.int(0, WORLD.rows - 1);
    const r = rng.int(2, 4);
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= WORLD.cols || y >= WORLD.rows) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) tiles[y * WORLD.cols + x] = DARK_ID;
    }
  }
  for (let n = 0; n < 70; n++) tiles[rng.int(0, WORLD.rows - 1) * WORLD.cols + rng.int(0, WORLD.cols - 1)] = FLOWERS_ID;

  const obstacles: Obstacle[] = [];
  const place = (sprite: string, r: number, count: number) => {
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const x = rng.range(32, WORLD_W - 32);
        const y = rng.range(32, WORLD_H - 8);
        if (Math.hypot(x - WORLD_W / 2, y - WORLD_H / 2) < 100) continue;
        if (obstacles.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + r + 12)) continue;
        obstacles.push({ x, y, r, sprite });
        break;
      }
    }
  };
  place("bush", 15, 34);
  place("rock", 11, 26);

  const s: GameState = {
    tiles,
    obstacles,
    player: { x: WORLD_W / 2, y: WORLD_H / 2, vx: 0, vy: 0, facing: 1, moving: false, hurt: 0, lives: RULES.lives },
    gems: [],
    slimes: [],
    score: 0,
    time: 0,
    nextId: 1,
    over: false,
    rng: rng.fork("play"),
  };
  for (let i = 0; i < RULES.gems; i++) spawnGem(s);
  for (let i = 0; i < RULES.slimeStart; i++) spawnSlime(s);
  return s;
}

function freeSpot(s: GameState, minFromPlayer: number): [number, number] {
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = s.rng.range(32, WORLD_W - 32);
    const y = s.rng.range(32, WORLD_H - 32);
    if (Math.hypot(x - s.player.x, y - s.player.y) < minFromPlayer) continue;
    if (s.obstacles.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + 16)) continue;
    return [x, y];
  }
  return [s.rng.range(32, WORLD_W - 32), s.rng.range(32, WORLD_H - 32)];
}

function spawnGem(s: GameState): Gem {
  const [x, y] = freeSpot(s, 100);
  const g = { id: s.nextId++, x, y };
  s.gems.push(g);
  return g;
}

function spawnSlime(s: GameState): Slime {
  const [x, y] = freeSpot(s, 260);
  const w = { id: s.nextId++, x, y, vx: 0, vy: 0, phase: s.rng.range(0, Math.PI * 2) };
  s.slimes.push(w);
  return w;
}

export const targetSlimes = (score: number): number => Math.min(RULES.slimeMax, RULES.slimeStart + Math.floor(score / RULES.slimeEvery));

export function tick(s: GameState, input: { x: number; y: number }, dt: number): GameEvent[] {
  const events: GameEvent[] = [];
  if (s.over) return events;
  s.time += dt;
  const p = s.player;

  let ix = clamp(input.x, -1, 1);
  let iy = clamp(input.y, -1, 1);
  const il = Math.hypot(ix, iy);
  if (il > 1) {
    ix /= il;
    iy /= il;
  }
  const knocked = p.hurt > RULES.hurtTime - 0.25;
  p.moving = il > 0.05 && !knocked;
  if (!knocked) {
    p.vx = ix * RULES.speed;
    p.vy = iy * RULES.speed;
  } else {
    p.vx *= 1 - 6 * dt;
    p.vy *= 1 - 6 * dt;
  }
  if (ix < -0.05) p.facing = -1;
  else if (ix > 0.05) p.facing = 1;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  for (const o of s.obstacles) {
    const dx = p.x - o.x;
    const dy = (p.y - o.y) * 1.5;
    const d = Math.hypot(dx, dy);
    const min = o.r + 8;
    if (d < min && d > 0) {
      p.x += (dx / d) * (min - d);
      p.y += ((dy / 1.5) / d) * (min - d);
    }
  }
  p.x = clamp(p.x, 12, WORLD_W - 12);
  p.y = clamp(p.y, 16, WORLD_H - 4);
  if (p.hurt > 0) p.hurt = Math.max(0, p.hurt - dt);

  for (let i = s.gems.length - 1; i >= 0; i--) {
    const g = s.gems[i];
    if (Math.hypot(g.x - p.x, g.y - (p.y - 10)) < RULES.pickRadius) {
      s.gems.splice(i, 1);
      s.score++;
      events.push({ type: "pick", x: g.x, y: g.y, score: s.score });
    }
  }
  while (s.gems.length < RULES.gems) events.push({ type: "gemSpawn", id: spawnGem(s).id });
  while (s.slimes.length < targetSlimes(s.score)) events.push({ type: "slimeSpawn", id: spawnSlime(s).id });

  const speed = RULES.slimeSpeed + s.score * RULES.slimeSpeedPerGem;
  for (const w of s.slimes) {
    const dx = p.x - w.x;
    const dy = p.y - 10 - w.y;
    const d = Math.hypot(dx, dy) || 1;
    const wobble = Math.sin(s.time * 2 + w.phase) * 0.5;
    const tx = dx / d - (dy / d) * wobble;
    const ty = dy / d + (dx / d) * wobble;
    w.vx += (tx * speed - w.vx) * Math.min(1, 2.5 * dt);
    w.vy += (ty * speed - w.vy) * Math.min(1, 2.5 * dt);
    w.x += w.vx * dt;
    w.y += w.vy * dt;
    if (p.hurt <= 0 && Math.hypot(w.x - p.x, w.y - (p.y - 10)) < RULES.hitRadius + 8) {
      p.lives--;
      p.hurt = RULES.hurtTime;
      p.vx = ((p.x - w.x) / d) * RULES.knockback;
      p.vy = ((p.y - 10 - w.y) / d) * RULES.knockback;
      events.push({ type: "hurt", x: w.x, y: w.y, lives: p.lives });
      if (p.lives <= 0) {
        s.over = true;
        events.push({ type: "over", score: s.score });
      }
      break;
    }
  }
  return events;
}

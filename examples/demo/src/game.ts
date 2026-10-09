// Wisp Hollow rules. Pure and deterministic: no DOM, no engine nodes, just state and a
// seeded rng, so the whole game can be tested headlessly and would port unchanged.

import { Rng, clamp } from "@blackiron-studio/engine/core";

export const WORLD = { cols: 80, rows: 45, tile: 32 } as const;
export const WORLD_W = WORLD.cols * WORLD.tile;
export const WORLD_H = WORLD.rows * WORLD.tile;

export const RULES = {
  playerSpeed: 210,
  playerRadius: 10,
  lives: 3,
  invulnerable: 1.3,
  emberCount: 6,
  emberRadius: 18,
  wispStart: 2,
  wispMax: 8,
  wispEvery: 7,
  wispSpeed: 68,
  wispSpeedPerEmber: 1.4,
  wispRadius: 14,
  knockback: 300,
} as const;

/** Ground tile ids. 0-3 grass, 4 dark grass (autotiled), 6-7 flowers, 8 path (autotiled). */
export const GROUND = ["grass.0", "grass.1", "grass.2", "grass.3", "", "", "flowers.0", "flowers.1"] as const;
export const DARK_ID = 4;
export const PATH_ID = 8;

export interface Obstacle {
  x: number;
  y: number;
  r: number;
  sprite: string;
}

export interface Ember {
  id: number;
  x: number;
  y: number;
  /** Bob phase. */
  phase: number;
}

export interface Wisp {
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
  /** Seconds of invulnerability remaining. */
  hurt: number;
  lives: number;
}

export type GameEvent =
  | { type: "collect"; x: number; y: number; score: number }
  | { type: "hurt"; x: number; y: number; lives: number }
  | { type: "wispSpawn"; x: number; y: number; id: number }
  | { type: "emberSpawn"; x: number; y: number; id: number }
  | { type: "wispGone"; id: number }
  | { type: "over"; score: number };

export interface GameState {
  seed: string;
  tiles: Uint8Array;
  obstacles: Obstacle[];
  player: Player;
  embers: Ember[];
  wisps: Wisp[];
  score: number;
  time: number;
  nextId: number;
  over: boolean;
  rng: Rng;
}

export interface GameInput {
  /** Movement direction, each in [-1, 1]. */
  x: number;
  y: number;
}

function buildTiles(rng: Rng): Uint8Array {
  const { cols, rows } = WORLD;
  const t = new Uint8Array(cols * rows);
  for (let i = 0; i < t.length; i++) t[i] = rng.int(0, 3);
  // Dark patches.
  for (let n = 0; n < 26; n++) {
    const cx = rng.int(0, cols - 1);
    const cy = rng.int(0, rows - 1);
    const r = rng.int(2, 5);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 * 1.6 <= r * r * rng.range(0.6, 1)) t[y * cols + x] = DARK_ID;
      }
    }
  }
  // Flowers.
  for (let n = 0; n < 140; n++) t[rng.int(0, rows - 1) * cols + rng.int(0, cols - 1)] = 6 + rng.int(0, 1);
  // A winding path across the middle, two tiles wide in places.
  let py = Math.floor(rows / 2);
  for (let x = 0; x < cols; x++) {
    py = clamp(py + rng.int(-1, 1), 4, rows - 5);
    t[py * cols + x] = PATH_ID;
    if (rng.chance(0.5)) t[(py + 1) * cols + x] = PATH_ID;
  }
  return t;
}

function buildObstacles(rng: Rng, tiles: Uint8Array): Obstacle[] {
  const out: Obstacle[] = [];
  const tryPlace = (sprite: string, r: number, count: number) => {
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const x = rng.range(48, WORLD_W - 48);
        const y = rng.range(48, WORLD_H - 16);
        const col = Math.floor(x / WORLD.tile);
        const row = Math.floor(y / WORLD.tile);
        if (tiles[row * WORLD.cols + col] === PATH_ID) continue;
        if (Math.hypot(x - WORLD_W / 2, y - WORLD_H / 2) < 140) continue;
        if (out.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + r + 12)) continue;
        out.push({ x, y, r, sprite });
        break;
      }
    }
  };
  tryPlace("tree.0", 18, 34);
  tryPlace("tree.1", 18, 30);
  tryPlace("bush.0", 16, 22);
  tryPlace("bush.1", 16, 18);
  tryPlace("rock.0", 10, 16);
  tryPlace("rock.1", 11, 12);
  tryPlace("rock.2", 12, 10);
  tryPlace("mushroom", 0, 24);
  return out;
}

export function createGame(seed: string | number = "hollow"): GameState {
  const rng = new Rng(seed);
  const tiles = buildTiles(rng.fork("tiles"));
  const obstacles = buildObstacles(rng.fork("obstacles"), tiles);
  const s: GameState = {
    seed: String(seed),
    tiles,
    obstacles,
    player: { x: WORLD_W / 2, y: WORLD_H / 2, vx: 0, vy: 0, facing: 1, moving: false, hurt: 0, lives: RULES.lives },
    embers: [],
    wisps: [],
    score: 0,
    time: 0,
    nextId: 1,
    over: false,
    rng: rng.fork("play"),
  };
  for (let i = 0; i < RULES.emberCount; i++) spawnEmber(s);
  for (let i = 0; i < RULES.wispStart; i++) spawnWisp(s);
  return s;
}

function freeSpot(s: GameState, minFromPlayer: number, margin = 40): [number, number] {
  for (let attempt = 0; attempt < 40; attempt++) {
    const x = s.rng.range(margin, WORLD_W - margin);
    const y = s.rng.range(margin, WORLD_H - margin);
    if (Math.hypot(x - s.player.x, y - s.player.y) < minFromPlayer) continue;
    if (s.obstacles.some((o) => o.r > 0 && Math.hypot(o.x - x, o.y - y) < o.r + 16)) continue;
    return [x, y];
  }
  return [s.rng.range(margin, WORLD_W - margin), s.rng.range(margin, WORLD_H - margin)];
}

function spawnEmber(s: GameState): Ember {
  const [x, y] = freeSpot(s, 140);
  const e: Ember = { id: s.nextId++, x, y, phase: s.rng.range(0, Math.PI * 2) };
  s.embers.push(e);
  return e;
}

function spawnWisp(s: GameState): Wisp {
  // Wisps rise from the edges, away from the player.
  const side = s.rng.int(0, 3);
  let x = 0;
  let y = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    x = side === 0 ? 24 : side === 1 ? WORLD_W - 24 : s.rng.range(24, WORLD_W - 24);
    y = side === 2 ? 24 : side === 3 ? WORLD_H - 24 : s.rng.range(24, WORLD_H - 24);
    if (Math.hypot(x - s.player.x, y - s.player.y) > 320) break;
  }
  const w: Wisp = { id: s.nextId++, x, y, vx: 0, vy: 0, phase: s.rng.range(0, Math.PI * 2) };
  s.wisps.push(w);
  return w;
}

export function wispSpeed(s: GameState): number {
  return RULES.wispSpeed + s.score * RULES.wispSpeedPerEmber;
}

export function targetWispCount(score: number): number {
  return Math.min(RULES.wispMax, RULES.wispStart + Math.floor(score / RULES.wispEvery));
}

/** Advance the game by `dt` seconds. Returns what happened, for the presentation layer. */
export function tick(s: GameState, input: GameInput, dt: number): GameEvent[] {
  const events: GameEvent[] = [];
  if (s.over || !Number.isFinite(dt) || dt <= 0) return events;
  s.time += dt;
  const p = s.player;

  // Movement with obstacle push-out and world bounds.
  let ix = clamp(input.x, -1, 1);
  let iy = clamp(input.y, -1, 1);
  const il = Math.hypot(ix, iy);
  if (il > 1) {
    ix /= il;
    iy /= il;
  }
  p.moving = il > 0.05 && p.hurt < RULES.invulnerable - 0.25;
  const knock = p.hurt > RULES.invulnerable - 0.25;
  if (!knock) {
    p.vx = ix * RULES.playerSpeed;
    p.vy = iy * RULES.playerSpeed;
  } else {
    p.vx *= 1 - 6 * dt;
    p.vy *= 1 - 6 * dt;
  }
  if (ix < -0.05) p.facing = -1;
  else if (ix > 0.05) p.facing = 1;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  for (const o of s.obstacles) {
    if (o.r <= 0) continue;
    const dx = p.x - o.x;
    const dy = (p.y - o.y) * 1.6;
    const d = Math.hypot(dx, dy);
    const min = o.r + RULES.playerRadius;
    if (d < min && d > 0) {
      p.x += (dx / d) * (min - d);
      p.y += ((dy / 1.6) / d) * (min - d);
    }
  }
  p.x = clamp(p.x, 16, WORLD_W - 16);
  p.y = clamp(p.y, 24, WORLD_H - 8);
  if (p.hurt > 0) p.hurt = Math.max(0, p.hurt - dt);

  // Embers.
  for (let i = s.embers.length - 1; i >= 0; i--) {
    const e = s.embers[i];
    if (Math.hypot(e.x - p.x, e.y - (p.y - 12)) < RULES.emberRadius + RULES.playerRadius) {
      s.embers.splice(i, 1);
      s.score++;
      events.push({ type: "collect", x: e.x, y: e.y, score: s.score });
    }
  }
  while (s.embers.length < RULES.emberCount) {
    const e = spawnEmber(s);
    events.push({ type: "emberSpawn", x: e.x, y: e.y, id: e.id });
  }

  // Wisps chase with a wobble.
  const speed = wispSpeed(s);
  while (s.wisps.length < targetWispCount(s.score)) {
    const w = spawnWisp(s);
    events.push({ type: "wispSpawn", x: w.x, y: w.y, id: w.id });
  }
  for (const w of s.wisps) {
    const dx = p.x - w.x;
    const dy = p.y - 16 - w.y;
    const d = Math.hypot(dx, dy) || 1;
    const wobble = Math.sin(s.time * 2.3 + w.phase) * 0.6;
    const tx = dx / d - (dy / d) * wobble;
    const ty = dy / d + (dx / d) * wobble;
    w.vx += (tx * speed - w.vx) * Math.min(1, 3 * dt);
    w.vy += (ty * speed - w.vy) * Math.min(1, 3 * dt);
    w.x += w.vx * dt;
    w.y += w.vy * dt;
    // Wisps keep a little distance from each other.
    for (const o of s.wisps) {
      if (o === w) continue;
      const ox = w.x - o.x;
      const oy = w.y - o.y;
      const od = Math.hypot(ox, oy);
      if (od < 28 && od > 0) {
        w.x += (ox / od) * (28 - od) * 0.5;
        w.y += (oy / od) * (28 - od) * 0.5;
      }
    }
    if (p.hurt <= 0 && Math.hypot(w.x - p.x, w.y - (p.y - 16)) < RULES.wispRadius + RULES.playerRadius) {
      p.lives--;
      p.hurt = RULES.invulnerable;
      const kx = (p.x - w.x) / d;
      const ky = (p.y - 16 - w.y) / d;
      p.vx = kx * RULES.knockback;
      p.vy = ky * RULES.knockback;
      events.push({ type: "hurt", x: w.x, y: w.y, lives: p.lives });
      // The wisp that struck dissipates and another rises elsewhere.
      events.push({ type: "wispGone", id: w.id });
      s.wisps.splice(s.wisps.indexOf(w), 1);
      const nw = spawnWisp(s);
      events.push({ type: "wispSpawn", x: nw.x, y: nw.y, id: nw.id });
      if (p.lives <= 0) {
        s.over = true;
        events.push({ type: "over", score: s.score });
      }
      break;
    }
  }
  return events;
}

// 2D (and 2.5D) combat: targets with health and teams, traces that stop at walls or the
// nearest target, hits with knockback, explosions that fade with distance and hide behind
// walls, destructible tiles and chain reactions on a deterministic clock. Walls come from a
// sight grid (tile maps, iso maps) or a physics world; the world holds no art or sound —
// games listen to its events.

import { Emitter } from "../core/events.ts";
import { castGridRay, type SightGrid } from "../core/sight.ts";
import type { DestructibleGrid, ExplosionSpec2D, TileChange2D } from "./destructible.ts";
import type { Health } from "./health.ts";

export type Team = string | number;

export interface CombatTarget2D {
  x: number;
  y: number;
  radius: number;
  team: Team;
  health: Health;
  /** Bottom and height, world units, for shots that carry a height; any height when omitted. */
  z?: number;
  height?: number;
  /** Knockback is added to these when present. */
  vx?: number;
  vy?: number;
  /** Knockback is divided by this; 1 by default. */
  mass?: number;
}

export interface WallHit2D {
  x: number;
  y: number;
  /** Fraction of the segment travelled, 0..1. */
  t: number;
  nx: number;
  ny: number;
  /** The grid cell hit, for grid walls. */
  col?: number;
  row?: number;
  /** The collider hit, for physics walls. */
  collider?: number;
}

/** First wall along a segment, or null; heights at either end are optional. */
export type RayBlocker2D = (x0: number, y0: number, x1: number, y1: number, z0?: number, z1?: number) => WallHit2D | null;

/** Walls from a sight grid: opaque cells, and cells taller than the shot. */
export function gridWalls(grid: SightGrid): RayBlocker2D {
  return (x0, y0, x1, y1, z0, z1) => castGridRay(grid, x0, y0, x1, y1, { z0, z1 });
}

interface Raycaster {
  raycast(x: number, y: number, dx: number, dy: number, maxDistance?: number, mask?: number, solid?: boolean): { x: number; y: number; nx: number; ny: number; distance: number; collider: number } | null;
}

/** Walls from a physics world's colliders under `mask`. */
export function physicsWalls(world: Raycaster, mask?: number): RayBlocker2D {
  return (x0, y0, x1, y1) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len === 0) return null;
    const hit = world.raycast(x0, y0, (x1 - x0) / len, (y1 - y0) / len, len, mask, true);
    return hit ? { x: hit.x, y: hit.y, t: hit.distance / len, nx: hit.nx, ny: hit.ny, collider: hit.collider } : null;
  };
}

export interface TraceOptions {
  /** The shooter's team: teammates are passed through unless friendly fire is on. */
  team?: Team;
  /** Shot height at the start and end. */
  z0?: number;
  z1?: number;
  /** Never hit these (the shooter). */
  ignore?: CombatTarget2D | ((t: CombatTarget2D) => boolean);
  /** Thickness of the shot: a projectile's radius. */
  radius?: number;
  /** Only walls; targets are passed through. */
  wallsOnly?: boolean;
}

export interface TraceHit2D {
  x: number;
  y: number;
  t: number;
  distance: number;
  nx: number;
  ny: number;
  target: CombatTarget2D | null;
  wall: WallHit2D | null;
}

export interface DamageInfo2D {
  kind?: string;
  source?: unknown;
  team?: Team;
  /** Where it landed. */
  x?: number;
  y?: number;
  /** Direction it travelled, for knockback and hit sparks. */
  dirX?: number;
  dirY?: number;
  knockback?: number;
}

export interface DamageEvent2D {
  target: CombatTarget2D;
  /** Hit points lost. */
  amount: number;
  /** Damage before armour and resistances. */
  raw: number;
  kind: string;
  source: unknown;
  team: Team | undefined;
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  knockback: number;
  killed: boolean;
}

export interface Explosion2D extends ExplosionSpec2D {
  x: number;
  y: number;
  z: number;
  team?: Team;
  source?: unknown;
}

export interface HitPayload2D {
  damage: number;
  kind?: string;
  knockback?: number;
  team?: Team;
  source?: unknown;
  /** Blows up where it lands. */
  splash?: ExplosionSpec2D;
}

export interface ImpactResult2D {
  hit: TraceHit2D;
  damage: DamageEvent2D | null;
  tile: TileChange2D | null;
}

export type CombatEvents2D = {
  damage: [DamageEvent2D];
  kill: [DamageEvent2D];
  explode: [Explosion2D];
  tile: [TileChange2D];
  impact: [ImpactResult2D];
};

export interface CombatWorldOptions {
  walls?: RayBlocker2D | null;
  friendlyFire?: boolean;
  destructibles?: DestructibleGrid | null;
}

function segmentCircle(x0: number, y0: number, dx: number, dy: number, cx: number, cy: number, r: number): number {
  const fx = x0 - cx;
  const fy = y0 - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a === 0) return -1;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

export class CombatWorld2D {
  readonly targets = new Set<CombatTarget2D>();
  readonly events = new Emitter<CombatEvents2D>();
  walls: RayBlocker2D | null;
  friendlyFire: boolean;
  destructibles: DestructibleGrid | null;
  /** Seconds of world time; chain explosions are scheduled on it. */
  time = 0;
  private pending: { at: number; seq: number; blast: Explosion2D }[] = [];
  private seq = 0;

  constructor(opts: CombatWorldOptions = {}) {
    this.walls = opts.walls ?? null;
    this.friendlyFire = opts.friendlyFire ?? false;
    this.destructibles = opts.destructibles ?? null;
  }

  on<K extends keyof CombatEvents2D>(name: K, fn: (...args: CombatEvents2D[K]) => void): () => void {
    return this.events.on(name, fn);
  }

  add<T extends CombatTarget2D>(target: T): T {
    this.targets.add(target);
    return target;
  }

  remove(target: CombatTarget2D): void {
    this.targets.delete(target);
  }

  /** Whether `team` may hurt `target`. */
  hostile(team: Team | undefined, target: CombatTarget2D): boolean {
    return this.friendlyFire || team === undefined || team !== target.team;
  }

  /** The nearest wall or target along a segment. */
  trace(x0: number, y0: number, x1: number, y1: number, opts: TraceOptions = {}): TraceHit2D | null {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const wall = this.walls ? this.walls(x0, y0, x1, y1, opts.z0, opts.z1) : null;
    let best = wall ? wall.t : Infinity;
    let target: CombatTarget2D | null = null;
    if (!opts.wallsOnly) {
      const ignore = opts.ignore;
      const pad = opts.radius ?? 0;
      for (const t of this.targets) {
        if (t.health.dead || !this.hostile(opts.team, t)) continue;
        if (ignore && (typeof ignore === "function" ? ignore(t) : ignore === t)) continue;
        const at = segmentCircle(x0, y0, dx, dy, t.x, t.y, t.radius + pad);
        if (at < 0 || at >= best) continue;
        if (opts.z0 !== undefined && t.height !== undefined) {
          const z = opts.z0 + ((opts.z1 ?? opts.z0) - opts.z0) * at;
          const bottom = t.z ?? 0;
          if (z < bottom - pad || z > bottom + t.height + pad) continue;
        }
        best = at;
        target = t;
      }
    }
    if (best === Infinity) return null;
    const x = x0 + dx * best;
    const y = y0 + dy * best;
    let nx = 0;
    let ny = 0;
    if (target) {
      const ox = x - target.x;
      const oy = y - target.y;
      const ol = Math.hypot(ox, oy);
      if (ol > 0) {
        nx = ox / ol;
        ny = oy / ol;
      } else if (len > 0) {
        nx = -dx / len;
        ny = -dy / len;
      }
    } else if (wall) {
      nx = wall.nx;
      ny = wall.ny;
    }
    return { x, y, t: best, distance: len * best, nx, ny, target, wall: target ? null : wall };
  }

  /** A trace along an angle. */
  hitscan(x: number, y: number, angle: number, range: number, opts: TraceOptions = {}): TraceHit2D | null {
    return this.trace(x, y, x + Math.cos(angle) * range, y + Math.sin(angle) * range, opts);
  }

  /** Whether nothing walls off the segment (targets are ignored). */
  clear(x0: number, y0: number, x1: number, y1: number, z0?: number, z1?: number): boolean {
    return !this.walls || this.walls(x0, y0, x1, y1, z0, z1) === null;
  }

  /** Hurt a target. Null when its team protects it or it is already dead. */
  damage(target: CombatTarget2D, amount: number, info: DamageInfo2D = {}): DamageEvent2D | null {
    if (target.health.dead || !this.hostile(info.team, target)) return null;
    const lost = target.health.take(amount, info.kind);
    let dirX = info.dirX ?? 0;
    let dirY = info.dirY ?? 0;
    const dl = Math.hypot(dirX, dirY);
    if (dl > 0) {
      dirX /= dl;
      dirY /= dl;
    }
    const kb = (info.knockback ?? 0) / (target.mass ?? 1);
    if (kb !== 0) {
      if (target.vx !== undefined) target.vx += dirX * kb;
      if (target.vy !== undefined) target.vy += dirY * kb;
    }
    const event: DamageEvent2D = {
      target,
      amount: lost,
      raw: amount,
      kind: info.kind ?? "hit",
      source: info.source,
      team: info.team,
      x: info.x ?? target.x,
      y: info.y ?? target.y,
      dirX,
      dirY,
      knockback: kb,
      killed: target.health.dead,
    };
    this.events.emit("damage", event);
    if (event.killed) this.events.emit("kill", event);
    return event;
  }

  /** Damage a destructible cell; a destroyed explosive cell schedules its blast. */
  damageTile(col: number, row: number, amount: number, kind?: string, source?: unknown, team?: Team): TileChange2D | null {
    const grid = this.destructibles;
    if (!grid) return null;
    const change = grid.damage(col, row, amount, kind, source);
    if (!change) return null;
    this.events.emit("tile", change);
    if (change.destroyed && change.def.explode) {
      const cs = grid.cell;
      this.schedule({ ...change.def.explode, x: (col + 0.5) * cs, y: (row + 0.5) * cs, z: 0, team, source: change }, change.def.explode.delay ?? 0.12);
    }
    return change;
  }

  /** Apply a hit found by a trace: hurt the target or the wall cell, and splash. */
  impact(hit: TraceHit2D, payload: HitPayload2D, dirX = 0, dirY = 0, z = 0): ImpactResult2D {
    let damage: DamageEvent2D | null = null;
    let tile: TileChange2D | null = null;
    if (hit.target) {
      damage = this.damage(hit.target, payload.damage, {
        kind: payload.kind,
        source: payload.source,
        team: payload.team,
        x: hit.x,
        y: hit.y,
        dirX,
        dirY,
        knockback: payload.knockback,
      });
    } else if (hit.wall) {
      let col = hit.wall.col;
      let row = hit.wall.row;
      if ((col === undefined || row === undefined) && this.destructibles) {
        // A physics wall: the cell just past the surface.
        const cs = this.destructibles.cell;
        col = Math.floor((hit.x - hit.nx * 0.01 * cs) / cs);
        row = Math.floor((hit.y - hit.ny * 0.01 * cs) / cs);
      }
      if (col !== undefined && row !== undefined) tile = this.damageTile(col, row, payload.damage, payload.kind, payload.source, payload.team);
    }
    if (payload.splash) {
      // Step back off the wall so the blast starts in the open.
      const back = hit.wall ? 0.01 * (this.destructibles?.cell ?? 1) : 0;
      this.explode({ ...payload.splash, x: hit.x + hit.nx * back, y: hit.y + hit.ny * back, z, team: payload.team, source: payload.source });
    }
    const result = { hit, damage, tile };
    this.events.emit("impact", result);
    return result;
  }

  /** Damage scale at `distance` from a blast's centre. */
  static falloff(spec: ExplosionSpec2D, distance: number): number {
    if (distance > spec.radius) return 0;
    const f = spec.falloff ?? 1;
    return f === 0 ? 1 : Math.pow(Math.max(0, 1 - distance / spec.radius), f);
  }

  /** Blow up now: targets and destructible cells within reach, walls sheltering what is behind. */
  explode(blast: Explosion2D): DamageEvent2D[] {
    this.events.emit("explode", blast);
    const kind = blast.kind ?? "explosive";
    const blocked = blast.blockedByWalls ?? true;
    const z = blast.z ?? 0;
    const hits: DamageEvent2D[] = [];
    for (const t of [...this.targets]) {
      if (t.health.dead) continue;
      const dx = t.x - blast.x;
      const dy = t.y - blast.y;
      const d = Math.hypot(dx, dy);
      const scale = CombatWorld2D.falloff(blast, Math.max(0, d - t.radius));
      if (scale <= 0) continue;
      if (blocked && this.walls && d > 0) {
        const tz = (t.z ?? 0) + (t.height ?? 0) / 2;
        if (this.walls(blast.x, blast.y, t.x, t.y, z, tz)) continue;
      }
      const e = this.damage(t, blast.damage * scale, {
        kind,
        source: blast.source,
        team: blast.team,
        x: t.x,
        y: t.y,
        dirX: d > 0 ? dx : 0,
        dirY: d > 0 ? dy : 0,
        knockback: (blast.knockback ?? 0) * scale,
      });
      if (e) hits.push(e);
    }
    const grid = this.destructibles;
    if (grid) {
      const cs = grid.cell;
      const c0 = Math.floor((blast.x - blast.radius) / cs);
      const c1 = Math.floor((blast.x + blast.radius) / cs);
      const r0 = Math.floor((blast.y - blast.radius) / cs);
      const r1 = Math.floor((blast.y + blast.radius) / cs);
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          if (!grid.isDestructible(col, row)) continue;
          // Distance to the nearest point of the cell, so the face next to the blast is reached.
          const nx = Math.max(col * cs, Math.min(blast.x, (col + 1) * cs));
          const ny = Math.max(row * cs, Math.min(blast.y, (row + 1) * cs));
          const scale = CombatWorld2D.falloff(blast, Math.hypot(nx - blast.x, ny - blast.y));
          if (scale <= 0) continue;
          if (blocked && this.walls) {
            const cx = (col + 0.5) * cs;
            const cy = (row + 0.5) * cs;
            const wall = this.walls(blast.x, blast.y, cx, cy, z, z);
            if (wall && !this.isCell(wall, col, row, cs)) continue;
          }
          this.damageTile(col, row, blast.damage * scale, kind, blast.source, blast.team);
        }
      }
    }
    return hits;
  }

  private isCell(wall: WallHit2D, col: number, row: number, cs: number): boolean {
    if (wall.col !== undefined && wall.row !== undefined) return wall.col === col && wall.row === row;
    const px = wall.x - wall.nx * 0.01 * cs;
    const py = wall.y - wall.ny * 0.01 * cs;
    return Math.floor(px / cs) === col && Math.floor(py / cs) === row;
  }

  /** Blow up after `delay` seconds of world time. */
  schedule(blast: Explosion2D, delay: number): void {
    this.pending.push({ at: this.time + Math.max(0, delay), seq: this.seq++, blast });
  }

  /** Blasts still waiting to go off. */
  get scheduled(): readonly Explosion2D[] {
    return this.pending.map((p) => p.blast);
  }

  /** Advance the world clock: due chain explosions go off in order, and health grace ticks down. */
  update(dt: number): void {
    this.time += dt;
    for (const t of this.targets) t.health.update(dt);
    for (let guard = 0; guard < 10000; guard++) {
      let next = -1;
      for (let i = 0; i < this.pending.length; i++) {
        const p = this.pending[i]!;
        if (p.at > this.time + 1e-9) continue;
        if (next < 0 || p.at < this.pending[next]!.at || (p.at === this.pending[next]!.at && p.seq < this.pending[next]!.seq)) next = i;
      }
      if (next < 0) break;
      const [p] = this.pending.splice(next, 1);
      this.explode(p!.blast);
    }
  }

  /** Targets whose circles touch a circle. */
  query(x: number, y: number, radius: number, filter?: (t: CombatTarget2D) => boolean): CombatTarget2D[] {
    const out: CombatTarget2D[] = [];
    for (const t of this.targets) {
      if (t.health.dead || (filter && !filter(t))) continue;
      const r = radius + t.radius;
      if ((t.x - x) ** 2 + (t.y - y) ** 2 <= r * r) out.push(t);
    }
    return out;
  }

  /** The closest living target hostile to `team` within range, optionally only ones in clear view. */
  nearestEnemy(x: number, y: number, team: Team, opts: { range?: number; visible?: boolean; z?: number; filter?: (t: CombatTarget2D) => boolean } = {}): CombatTarget2D | null {
    let best: CombatTarget2D | null = null;
    let bestD = (opts.range ?? Infinity) ** 2;
    for (const t of this.targets) {
      if (t.health.dead || t.team === team || (opts.filter && !opts.filter(t))) continue;
      const d = (t.x - x) ** 2 + (t.y - y) ** 2;
      if (d > bestD) continue;
      if (opts.visible && !this.clear(x, y, t.x, t.y, opts.z, (t.z ?? 0) + (t.height ?? 0) / 2)) continue;
      best = t;
      bestD = d;
    }
    return best;
  }
}

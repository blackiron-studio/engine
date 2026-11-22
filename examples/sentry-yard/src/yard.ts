// The yard as a simulation, with no rendering: the map and its heights, destructible bricks,
// crates and barrels, sentry turrets that sweep, spot, track and fire, the operative with a
// rifle, a shotgun and grenades, fog of war, and saves. The play scene draws it and feeds it
// input; tests drive it directly.

import {
  CombatWorld2D,
  type CombatTarget2D,
  DestructibleGrid,
  type DestructibleSave,
  Health,
  Projectiles2D,
  type ProjectileImpact2D,
  type ImpactResult2D,
  Thrown2D,
  Weapon2D,
  type WeaponDef2D,
  gridWalls,
  heightField,
  hitscanShot,
  launchVelocity,
  predictThrow,
  slopeTo,
  type HeightField,
  type ThrowPrediction,
} from "@blackiron-studio/engine/combat";
import { FogOfWar, type SightGrid, TileMapData, angleDelta, canSee, visibilityField } from "@blackiron-studio/engine/core";
import { CELL, TILE } from "./units.ts";

export const SLAB = 1;
export const LINE = 2;
export const OIL = 3;
export const GRATE = 4;
export const WALL = 5;
export const BRICK = 6;
export const BRICK_CRACKED = 7;
export const CRATE = 8;
export const CRATE_SPLIT = 9;
export const RUBBLE = 10;
export const BARREL = 11;
export const PAD = 12;

export const LAYOUT = [
  "########################",
  "#....=.....#.......__..#",
  "#.T_......o#..ccc..T_..#",
  "#.__..cc...#...........#",
  "#.........BBBB..o..S...#",
  "#..c.............:.....#",
  "#..c....%.....cc.:.....#",
  "#BBBB.........cc.:..BBB#",
  "#.......S.o............#",
  "#:::::::::::....=......#",
  "#......cc.......=...o..#",
  "#......cc...BBBBBB.....#",
  "#...........B....B.....#",
  "#..o....%...B.S..B..cc.#",
  "#...........B....B..cc.#",
  "#####.......BB.BBB.....#",
  "#...#..................#",
  "#...#...cc...o.....T_..#",
  "#...BBB.cc.........__..#",
  "#......................#",
  "#.P.......=....cc......#",
  "#.........=....cc..o...#",
  "#......................#",
  "########################",
];

export const LEGEND: Record<string, number> = { ".": SLAB, ":": LINE, "%": OIL, "=": GRATE, "#": WALL, B: BRICK, c: CRATE, o: BARREL, S: SLAB, T: PAD, _: PAD, P: SLAB };

/** Levels each tile stands up from the ground. */
export function levelsOf(tile: number): number {
  return tile === WALL || tile === BRICK || tile === BRICK_CRACKED ? 2 : tile === CRATE || tile === CRATE_SPLIT || tile === PAD ? 1 : 0;
}

export const TILE_RISE = TILE.rise;
export const PLAYER_TEAM = "operative";
export const SENTRY_TEAM = "sentry";
/** Eye and chest heights above the ground under a unit. */
export const EYE = 20;
export const CHEST = 12;
const SENTRY_EYE = 18;
const SENTRY_RANGE = 300;
const SENTRY_FOV = 1.7;
const SENTRY_TURN = 2.4;
const SENTRY_SWEEP = 0.9;
const PLAYER_SPEED = 125;
const PLAYER_RADIUS = 9;
export const VIEW_RADIUS = 330;
export const GRENADE_FUSE = 1.5;
export const GRENADE_RANGE = 260;
export const GRENADE_BLAST = { radius: 96, damage: 95, knockback: 260, kind: "explosive" };

export const RIFLE: WeaponDef2D = { id: "rifle", damage: 14, interval: 0.11, magazine: 30, reloadSeconds: 1.3, range: 380, automatic: true, spread: 0.025, bloom: 0.035, bloomMax: 0.24, bloomRecovery: 0.8, recoil: 0.6, kind: "bullet" };
export const SHOTGUN: WeaponDef2D = { id: "shotgun", damage: 10, interval: 0.8, magazine: 6, reloadSeconds: 1.7, range: 210, pellets: 8, spread: 0.55, knockback: 40, recoil: 2.6, kind: "bullet" };
export const BOLT: WeaponDef2D = { id: "bolt", damage: 7, interval: 0.75, magazine: 1000, reloadSeconds: 0, range: 340, speed: 380, radius: 3, spread: 0.06, kind: "energy" };

export interface Sentry extends CombatTarget2D {
  id: number;
  col: number;
  row: number;
  /** Ground height under it. */
  z: number;
  /** Rest facing and the current one, radians. */
  base: number;
  facing: number;
  phase: number;
  state: "sweep" | "alert" | "dead";
  /** Seconds since it last saw the operative while alert. */
  lost: number;
  lastX: number;
  lastY: number;
  gun: Weapon2D;
  /** Seconds of hit flash left. */
  flash: number;
}

export interface Operative extends CombatTarget2D {
  z: number;
  vx: number;
  vy: number;
  /** Aim, radians on the ground. */
  aim: number;
  flash: number;
}

export type Fx =
  | { kind: "shot"; weapon: string; x0: number; y0: number; x1: number; y1: number; z: number; hit: "wall" | "brick" | "crate" | "barrel" | "sentry" | "operative" | "none" }
  | { kind: "bolt"; x: number; y: number; z: number }
  | { kind: "blast"; x: number; y: number; z: number; radius: number }
  | { kind: "tile"; col: number; row: number; from: number; to: number; destroyed: boolean }
  | { kind: "hurt"; target: "operative" | "sentry"; x: number; y: number; z: number; amount: number; killed: boolean }
  | { kind: "throw" }
  | { kind: "bounce"; x: number; y: number; z: number }
  | { kind: "spotted"; id: number }
  | { kind: "reload"; weapon: string }
  | { kind: "empty" };

export interface Grenade {
  t: Thrown2D;
  fuse: number;
}

export interface YardSave {
  v: 1;
  tiles: DestructibleSave;
  dead: number[];
  player: { x: number; y: number; hp: number; armour: number };
  grenades: number;
  ammo: number[];
  explored: string;
}

export interface Controls {
  /** Ground direction to walk, any length up to 1. */
  moveX: number;
  moveY: number;
  aim: number;
  /** Height (absolute) of what is under the aim point and its distance, to shoot up or down to it. */
  aimZ?: number;
  aimDist?: number;
  fire: boolean;
  weapon?: number;
  reload?: boolean;
}

export class Yard {
  readonly map: TileMapData;
  readonly cols: number;
  readonly rows: number;
  readonly grid: SightGrid;
  readonly ground: HeightField;
  readonly world: CombatWorld2D;
  readonly tiles: DestructibleGrid;
  readonly bolts: Projectiles2D;
  readonly fog: FogOfWar;
  readonly sentries: Sentry[] = [];
  readonly player: Operative;
  readonly weapons: Weapon2D[];
  readonly grenadesInFlight: Grenade[] = [];
  readonly fx: Fx[] = [];
  weapon = 0;
  grenades = 5;
  time = 0;
  /** Cells whose fog changed since the scene last looked. */
  fogChanged: number[] = [];
  private fogCell = -1;
  private fogDirty = true;

  constructor(save: YardSave | null = null) {
    this.map = TileMapData.fromAscii(LAYOUT, LEGEND);
    this.cols = this.map.cols;
    this.rows = this.map.rows;
    const map = this.map;
    this.grid = {
      cols: this.cols,
      rows: this.rows,
      cell: CELL,
      opaque: (c, r) => !map.inBounds(c, r) || map.get(c, r) === BARREL,
      height: (c, r) => (map.inBounds(c, r) ? levelsOf(map.get(c, r)) * TILE.rise : 0),
    };
    this.ground = heightField(this.grid);
    this.tiles = new DestructibleGrid(
      map,
      {
        [BRICK]: { hp: 140, stages: [BRICK_CRACKED], broken: RUBBLE, resist: { bullet: 0.35, energy: 0.2, explosive: 1.6 } },
        [CRATE]: { hp: 45, stages: [CRATE_SPLIT], broken: RUBBLE, resist: { bullet: 0.8, energy: 0.6, explosive: 2 } },
        [BARREL]: { hp: 18, broken: OIL, explode: { radius: 92, damage: 80, knockback: 240, delay: 0.14 } },
      },
      { cell: CELL },
    );
    this.world = new CombatWorld2D({ walls: gridWalls(this.grid), destructibles: this.tiles });
    this.bolts = new Projectiles2D(this.world, 96);
    this.fog = new FogOfWar(this.grid);

    let start: [number, number] = [2, 20];
    let id = 0;
    const centre = [(this.cols / 2) * CELL, (this.rows / 2) * CELL];
    LAYOUT.forEach((line, r) => {
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === "P") start = [c, r];
        if (ch !== "S" && ch !== "T") continue;
        const x = (c + 0.5) * CELL;
        const y = (r + 0.5) * CELL;
        const base = Math.atan2(centre[1] - y, centre[0] - x);
        const s: Sentry = {
          id: id++,
          col: c,
          row: r,
          x,
          y,
          z: levelsOf(map.get(c, r)) * TILE.rise,
          height: 30,
          radius: 11,
          team: SENTRY_TEAM,
          health: new Health({ max: 70, armour: 20, absorb: 0.5, resist: { explosive: 1.4 } }),
          base,
          facing: base,
          phase: id * 1.7,
          state: "sweep",
          lost: 0,
          lastX: x,
          lastY: y,
          gun: new Weapon2D({ ...BOLT, automatic: true }, 100 + id),
          flash: 0,
        };
        this.sentries.push(this.world.add(s));
      }
    });
    this.player = this.world.add<Operative>({
      x: (start[0] + 0.5) * CELL,
      y: (start[1] + 0.5) * CELL,
      z: 0,
      radius: PLAYER_RADIUS,
      height: 26,
      team: PLAYER_TEAM,
      health: new Health({ max: 100, armour: 40, absorb: 0.6, grace: 0.05 }),
      vx: 0,
      vy: 0,
      mass: 1.4,
      aim: -Math.PI / 4,
      flash: 0,
    });
    this.weapons = [new Weapon2D(RIFLE, 1), new Weapon2D(SHOTGUN, 2)];

    this.world.on("tile", (c) => {
      this.fogDirty = true;
      this.fx.push({ kind: "tile", col: c.col, row: c.row, from: c.from, to: c.to, destroyed: c.destroyed });
    });
    this.world.on("explode", (b) => this.fx.push({ kind: "blast", x: b.x, y: b.y, z: b.z, radius: b.radius }));
    this.world.on("damage", (e) => {
      const who = e.target === this.player ? "operative" : "sentry";
      const t = e.target as Sentry | Operative;
      t.flash = 0.12;
      if (who === "sentry") this.alert(t as Sentry, this.player.x, this.player.y);
      this.fx.push({ kind: "hurt", target: who, x: t.x, y: t.y, z: t.z + 24, amount: e.amount, killed: e.killed });
      if (e.killed && who === "sentry") this.wreck(t as Sentry);
    });

    if (save) this.load(save);
    this.updateFog();
  }

  get alive(): boolean {
    return this.player.health.alive;
  }

  get remaining(): number {
    return this.sentries.filter((s) => s.state !== "dead").length;
  }

  get cleared(): boolean {
    return this.remaining === 0;
  }

  get gun(): Weapon2D {
    return this.weapons[this.weapon];
  }

  /** Ground height at a position, ignoring walls (for drawing). */
  heightAt(x: number, y: number): number {
    const c = Math.floor(x / CELL);
    const r = Math.floor(y / CELL);
    return this.map.inBounds(c, r) ? levelsOf(this.map.get(c, r)) * TILE.rise : 0;
  }

  /** The predicted arc of a grenade thrown at a ground point now. */
  previewThrow(tx: number, ty: number, maxTime = GRENADE_FUSE): ThrowPrediction {
    const v = this.throwVelocity(tx, ty);
    return predictThrow(this.player.x, this.player.y, this.player.z + 18, v.vx, v.vy, v.vz, this.ground, { maxTime });
  }

  private throwVelocity(tx: number, ty: number) {
    const p = this.player;
    let dx = tx - p.x;
    let dy = ty - p.y;
    const d = Math.hypot(dx, dy);
    if (d > GRENADE_RANGE) {
      dx *= GRENADE_RANGE / d;
      dy *= GRENADE_RANGE / d;
    }
    return launchVelocity(p.x, p.y, p.z + 18, p.x + dx, p.y + dy, this.ground(p.x + dx, p.y + dy) === Infinity ? 0 : this.ground(p.x + dx, p.y + dy), { speed: 300 });
  }

  throwGrenade(tx: number, ty: number): boolean {
    if (this.grenades <= 0 || !this.alive) return false;
    this.grenades--;
    const v = this.throwVelocity(tx, ty);
    this.grenadesInFlight.push({ t: new Thrown2D(this.player.x, this.player.y, this.player.z + 18, v.vx, v.vy, v.vz), fuse: GRENADE_FUSE });
    this.fx.push({ kind: "throw" });
    return true;
  }

  private alert(s: Sentry, x: number, y: number): void {
    if (s.state === "dead") return;
    if (s.state === "sweep") this.fx.push({ kind: "spotted", id: s.id });
    s.state = "alert";
    s.lost = 0;
    s.lastX = x;
    s.lastY = y;
  }

  private wreck(s: Sentry): void {
    s.state = "dead";
    // A dying turret pops: it can set off the barrels next to it.
    this.world.schedule({ x: s.x, y: s.y, z: s.z, radius: 56, damage: 30, knockback: 120, kind: "explosive", team: SENTRY_TEAM }, 0.18);
  }

  /** Whether the operative can stand at (x, y). */
  open(x: number, y: number): boolean {
    const p = this.player;
    for (const dx of [-p.radius * 0.7, p.radius * 0.7]) {
      for (const dy of [-p.radius * 0.7, p.radius * 0.7]) {
        if (this.ground(x + dx, y + dy) > p.z + 2) return false;
      }
    }
    for (const s of this.sentries) if (s.state !== "dead" && s.z <= p.z + 2 && Math.hypot(s.x - x, s.y - y) < s.radius + p.radius) return false;
    return true;
  }

  private move(dx: number, dy: number): void {
    const p = this.player;
    if (dx && this.open(p.x + dx, p.y)) p.x += dx;
    if (dy && this.open(p.x, p.y + dy)) p.y += dy;
  }

  step(dt: number, input: Controls): void {
    this.time += dt;
    const p = this.player;
    p.flash = Math.max(0, p.flash - dt);
    if (this.alive) {
      const len = Math.hypot(input.moveX, input.moveY);
      const k = len > 1 ? 1 / len : 1;
      this.move(input.moveX * k * PLAYER_SPEED * dt, input.moveY * k * PLAYER_SPEED * dt);
      p.aim = input.aim;
      if (input.weapon !== undefined && input.weapon !== this.weapon && this.weapons[input.weapon]) {
        this.weapon = input.weapon;
        this.weapons[this.weapon].step(0, { fire: false, angle: p.aim });
      }
      if (input.reload && this.gun.reload()) this.fx.push({ kind: "reload", weapon: this.gun.def.id });
      const wasReloading = this.gun.reloading;
      const shots = this.gun.step(dt, { fire: input.fire, angle: p.aim });
      if (!wasReloading && this.gun.reloading) this.fx.push({ kind: "reload", weapon: this.gun.def.id });
      const mx = p.x + Math.cos(p.aim) * 10;
      const my = p.y + Math.sin(p.aim) * 10;
      const z0 = p.z + CHEST;
      const slope = input.aimZ !== undefined && input.aimDist ? Math.max(-0.4, Math.min(0.4, slopeTo(z0, input.aimZ, input.aimDist))) : 0;
      for (const shot of shots) this.shot(this.gun.def, shot.angle, shot.damage, mx, my, z0, slope, p);
    }
    // Knockback slides, blocked by walls.
    if (p.vx || p.vy) {
      this.move(p.vx * dt, p.vy * dt);
      const keep = Math.exp(-8 * dt);
      p.vx *= keep;
      p.vy *= keep;
      if (Math.hypot(p.vx, p.vy) < 1) p.vx = p.vy = 0;
    }
    for (const s of this.sentries) this.updateSentry(s, dt);
    for (const hit of this.bolts.update(dt)) this.boltHit(hit);
    for (const b of this.bolts) this.fx.push({ kind: "bolt", x: b.x, y: b.y, z: b.z });
    for (let i = this.grenadesInFlight.length - 1; i >= 0; i--) {
      const g = this.grenadesInFlight[i];
      for (const e of g.t.step(dt, this.ground)) if (e.kind !== "rest") this.fx.push({ kind: "bounce", x: e.x, y: e.y, z: e.z });
      g.fuse -= dt;
      if (g.fuse <= 0) {
        this.grenadesInFlight.splice(i, 1);
        this.world.explode({ ...GRENADE_BLAST, x: g.t.x, y: g.t.y, z: g.t.z, team: PLAYER_TEAM, source: "grenade" });
      }
    }
    this.world.update(dt);
    this.updateFog();
  }

  private shot(def: WeaponDef2D, angle: number, damage: number, x: number, y: number, z: number, slope: number, source: CombatTarget2D): void {
    const result = hitscanShot(this.world, def, { angle, age: 0, damage, index: 0, pellet: 0, recoil: 0 }, x, y, { team: PLAYER_TEAM, source, z, slope });
    const x1 = result ? result.hit.x : x + Math.cos(angle) * def.range;
    const y1 = result ? result.hit.y : y + Math.sin(angle) * def.range;
    this.fx.push({ kind: "shot", weapon: def.id, x0: x, y0: y, x1, y1, z, hit: this.surface(result) });
  }

  private boltHit(hit: ProjectileImpact2D): void {
    this.fx.push({ kind: "shot", weapon: "bolt", x0: hit.projectile.px, y0: hit.projectile.py, x1: hit.hit.x, y1: hit.hit.y, z: hit.projectile.z, hit: this.surface(hit) });
  }

  private surface(r: ImpactResult2D | null): Extract<Fx, { kind: "shot" }>["hit"] {
    if (!r) return "none";
    if (r.hit.target) return r.hit.target === this.player ? "operative" : "sentry";
    const t = r.tile?.from ?? (r.hit.wall?.col !== undefined ? this.map.get(r.hit.wall.col, r.hit.wall.row!) : WALL);
    return t === BRICK || t === BRICK_CRACKED ? "brick" : t === CRATE || t === CRATE_SPLIT ? "crate" : t === BARREL ? "barrel" : "wall";
  }

  private updateSentry(s: Sentry, dt: number): void {
    s.flash = Math.max(0, s.flash - dt);
    if (s.state === "dead") return;
    const p = this.player;
    const fov = s.state === "alert" ? SENTRY_FOV * 1.5 : SENTRY_FOV;
    const sees = this.alive && canSee(this.grid, s.x, s.y, p.x, p.y, { range: SENTRY_RANGE, eye: SENTRY_EYE, targetHeight: CHEST + 6, facing: s.facing, fov });
    if (sees) this.alert(s, p.x, p.y);
    let fire = false;
    if (s.state === "alert") {
      if (!sees) s.lost += dt;
      const want = Math.atan2(s.lastY - s.y, s.lastX - s.x);
      const d = angleDelta(s.facing, want);
      s.facing += Math.sign(d) * Math.min(Math.abs(d), SENTRY_TURN * dt);
      fire = sees && Math.abs(d) < 0.16;
      if (s.lost > 2.2) {
        s.state = "sweep";
        s.base = s.facing;
        s.phase = 0;
      }
    } else {
      s.phase += dt * 0.7;
      s.facing = s.base + Math.sin(s.phase) * SENTRY_SWEEP;
    }
    const shots = s.gun.step(dt, { fire, angle: s.facing });
    for (const shot of shots) {
      const mx = s.x + Math.cos(shot.angle) * 14;
      const my = s.y + Math.sin(shot.angle) * 14;
      const z = s.z + SENTRY_EYE - 4;
      const slope = slopeTo(z, p.z + CHEST, Math.hypot(s.lastX - mx, s.lastY - my));
      this.bolts.shoot(s.gun.def, shot, mx, my, { team: SENTRY_TEAM, source: s, z, slope });
    }
  }

  private updateFog(): void {
    const p = this.player;
    const cell = Math.floor(p.y / CELL) * this.cols + Math.floor(p.x / CELL);
    if (cell === this.fogCell && !this.fogDirty) return;
    this.fogCell = cell;
    this.fogDirty = false;
    const changed = this.fog.update([{ x: p.x, y: p.y, radius: VIEW_RADIUS, eye: EYE }]);
    if (changed.length) this.fogChanged.push(...changed);
  }

  /** Cells a sentry watches right now: its cone, cut by walls. */
  sentryView(s: Sentry, out?: Uint8Array): Uint8Array {
    return visibilityFieldFor(this.grid, s, out);
  }

  save(): YardSave {
    const p = this.player;
    return {
      v: 1,
      tiles: this.tiles.save(),
      dead: this.sentries.filter((s) => s.state === "dead").map((s) => s.id),
      player: { x: p.x, y: p.y, hp: p.health.hp, armour: p.health.armour },
      grenades: this.grenades,
      ammo: this.weapons.map((w) => w.ammo),
      explored: this.fog.saveExplored(),
    };
  }

  private load(save: YardSave): void {
    if (save.v !== 1) return;
    this.tiles.load(save.tiles);
    for (const id of save.dead) {
      const s = this.sentries.find((q) => q.id === id);
      if (!s) continue;
      s.state = "dead";
      s.health.hp = 0;
    }
    const p = this.player;
    if (Number.isFinite(save.player.x) && Number.isFinite(save.player.y)) {
      p.x = save.player.x;
      p.y = save.player.y;
    }
    p.health.hp = Math.max(1, Math.min(p.health.max, save.player.hp));
    p.health.armour = Math.max(0, save.player.armour);
    this.grenades = Math.max(0, Math.floor(save.grenades));
    save.ammo.forEach((a, i) => {
      if (this.weapons[i]) this.weapons[i].ammo = Math.max(0, Math.min(this.weapons[i].def.magazine, Math.floor(a)));
    });
    this.fog.loadExplored(save.explored);
    this.fogDirty = true;
  }
}

function visibilityFieldFor(grid: SightGrid, s: Sentry, out?: Uint8Array): Uint8Array {
  return visibilityField(grid, s.x, s.y, SENTRY_RANGE, { eyeZ: s.z + SENTRY_EYE, facing: s.facing, fov: s.state === "alert" ? SENTRY_FOV * 1.5 : SENTRY_FOV, out });
}

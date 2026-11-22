// Destructible tiles over any tile store (TileMap, IsoTileMap, TileMapData): per-cell hit
// points, damage stages that swap the tile, a broken tile when destroyed, resistances and
// explosions for chain reactions. Changing a tile goes through the map's own `set`, so tile
// maps re-autotile and rebuild on their next frame; colliders and paths built from the map
// are the game's to rebuild from `on("change")`. The changed cells save and load.

import { Emitter } from "../core/events.ts";

export interface TileStore2D {
  readonly cols: number;
  readonly rows: number;
  get(col: number, row: number): number;
  set(col: number, row: number, tile: number): void;
}

export interface ExplosionSpec2D {
  radius: number;
  damage: number;
  /** How damage fades to the edge: 0 flat, 1 linear (default), 2 steeper. */
  falloff?: number;
  /** Knockback at the centre, fading like damage. */
  knockback?: number;
  /** Damage kind; "explosive" by default. */
  kind?: string;
  /** Walls shelter what is behind them; true by default. */
  blockedByWalls?: boolean;
  /** Seconds before it goes off when set off by another blast; 0.12 by default. */
  delay?: number;
}

export interface DestructibleTile {
  hp: number;
  /** Tiles shown as damage builds up, lightest first; picked by the share of hit points lost. */
  stages?: number[];
  /** Tile left when destroyed; 0 by default. It may have its own entry, to break again. */
  broken?: number;
  /** Damage multipliers by kind: `{ bullet: 0.25, explosive: 3 }`. */
  resist?: Record<string, number>;
  /** Blows up when destroyed. */
  explode?: ExplosionSpec2D;
}

export interface TileChange2D {
  col: number;
  row: number;
  from: number;
  to: number;
  /** Hit points left; 0 when destroyed. */
  hp: number;
  destroyed: boolean;
  /** The entry the damage was measured against. */
  def: DestructibleTile;
  kind?: string;
  source?: unknown;
}

export interface DestructibleSave {
  v: 1;
  cols: number;
  rows: number;
  /** [index, tile, hp (-1 untouched), original tile (-1 none)] for every cell that changed. */
  cells: [number, number, number, number][];
}

export class DestructibleGrid {
  readonly cell: number;
  readonly events = new Emitter<{ change: [TileChange2D] }>();
  private readonly hp: Float32Array;
  private readonly origin: Int32Array;
  private readonly touched = new Set<number>();
  private readonly changed = new Set<number>();

  constructor(
    readonly map: TileStore2D,
    readonly defs: Record<number, DestructibleTile>,
    opts: { cell?: number } = {},
  ) {
    this.cell = opts.cell ?? 1;
    const n = map.cols * map.rows;
    this.hp = new Float32Array(n).fill(Number.NaN);
    this.origin = new Int32Array(n).fill(-1);
    for (const [id, def] of Object.entries(defs)) {
      if (!(def.hp > 0)) throw new RangeError(`Destructible tile ${id} needs positive hp`);
    }
  }

  on(name: "change", fn: (change: TileChange2D) => void): () => void {
    return this.events.on(name, fn);
  }

  private index(col: number, row: number): number {
    return col >= 0 && row >= 0 && col < this.map.cols && row < this.map.rows ? row * this.map.cols + col : -1;
  }

  /** The entry a cell's damage is measured against, if it can be damaged. */
  defAt(col: number, row: number): DestructibleTile | undefined {
    const i = this.index(col, row);
    if (i < 0) return undefined;
    const o = this.origin[i]!;
    return this.defs[o >= 0 ? o : this.map.get(col, row)];
  }

  isDestructible(col: number, row: number): boolean {
    return this.defAt(col, row) !== undefined;
  }

  /** Hit points left in a cell; 0 for cells that cannot be damaged. */
  hpAt(col: number, row: number): number {
    const def = this.defAt(col, row);
    if (!def) return 0;
    const h = this.hp[this.index(col, row)]!;
    return Number.isNaN(h) ? def.hp : h;
  }

  /** Cell under a world position. */
  cellAt(x: number, y: number): [number, number] {
    return [Math.floor(x / this.cell), Math.floor(y / this.cell)];
  }

  /** Damage a cell; returns what changed, or null when the cell cannot be damaged. */
  damage(col: number, row: number, amount: number, kind?: string, source?: unknown): TileChange2D | null {
    const i = this.index(col, row);
    const def = this.defAt(col, row);
    if (i < 0 || !def || !(amount > 0)) return null;
    const from = this.map.get(col, row);
    if (this.origin[i]! < 0) {
      this.origin[i] = from;
      this.hp[i] = def.hp;
    }
    this.touched.add(i);
    const mult = kind !== undefined ? (def.resist?.[kind] ?? 1) : 1;
    const hp = Math.max(0, this.hp[i]! - amount * mult);
    this.hp[i] = hp;
    let to: number;
    const destroyed = hp <= 0;
    if (destroyed) {
      to = def.broken ?? 0;
      // The broken tile starts fresh: its own entry, if any, measures the next hits.
      this.origin[i] = -1;
      this.hp[i] = Number.NaN;
    } else {
      to = this.stageTile(def, this.origin[i]!, hp);
    }
    if (to !== from) {
      this.map.set(col, row, to);
      this.changed.add(i);
    }
    const change: TileChange2D = { col, row, from, to, hp, destroyed, def, kind, source };
    this.events.emit("change", change);
    return change;
  }

  /** Destroy a cell outright, whatever its hit points. */
  destroy(col: number, row: number, kind?: string, source?: unknown): TileChange2D | null {
    const hp = this.hpAt(col, row);
    const def = this.defAt(col, row);
    if (!def) return null;
    const mult = kind !== undefined ? (def.resist?.[kind] ?? 1) : 1;
    return this.damage(col, row, mult > 0 ? hp / mult + 1 : Infinity, mult > 0 ? kind : undefined, source);
  }

  private stageTile(def: DestructibleTile, origin: number, hp: number): number {
    const stages = def.stages;
    if (!stages?.length) return origin;
    const lost = 1 - hp / def.hp;
    const k = Math.min(stages.length - 1, Math.floor(lost * (stages.length + 1)) - 1);
    return k < 0 ? origin : stages[k]!;
  }

  /** Cells whose tile changed since the last call, as [col, row] pairs. */
  takeChanges(): [number, number][] {
    const out: [number, number][] = [];
    for (const i of this.changed) out.push([i % this.map.cols, Math.floor(i / this.map.cols)]);
    this.changed.clear();
    return out;
  }

  /** Every damaged or destroyed cell, for a save. */
  save(): DestructibleSave {
    const cells: DestructibleSave["cells"] = [];
    for (const i of [...this.touched].sort((a, b) => a - b)) {
      const col = i % this.map.cols;
      const row = Math.floor(i / this.map.cols);
      const h = this.hp[i]!;
      cells.push([i, this.map.get(col, row), Number.isNaN(h) ? -1 : Math.round(h * 1000) / 1000, this.origin[i]!]);
    }
    return { v: 1, cols: this.map.cols, rows: this.map.rows, cells };
  }

  /** Apply a save over the map as built; returns false for a save of a different-sized map. */
  load(save: DestructibleSave): boolean {
    if (save?.v !== 1 || save.cols !== this.map.cols || save.rows !== this.map.rows) return false;
    for (const [i, tile, hp, origin] of save.cells) {
      if (!(i >= 0 && i < this.hp.length)) continue;
      const col = i % this.map.cols;
      const row = Math.floor(i / this.map.cols);
      if (this.map.get(col, row) !== tile) {
        this.map.set(col, row, tile);
        this.changed.add(i);
      }
      this.hp[i] = hp < 0 ? Number.NaN : hp;
      this.origin[i] = origin;
      this.touched.add(i);
    }
    return true;
  }
}

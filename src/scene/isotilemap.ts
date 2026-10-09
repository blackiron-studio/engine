// An isometric tile map with elevation: floors at their height, cliff faces down to lower
// neighbours, per-cell tint for fog of war, and `heightAt` for things standing on it. The
// map is a world-space batch the kernel projects and depth-sorts with everything else.
// Ground units: a cell is `cell` units wide (half the tile's pixel width by default), so an
// isometric camera with the same tile size lands cells on whole pixels.

import type { Region } from "../art/atlas.ts";
import { TileMapData } from "../core/tilemap.ts";
import { BATCH3_STRIDE, type Kernel } from "../kernel/protocol.ts";
import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";

export interface IsoTile {
  /** The floor diamond. */
  top: string;
  /** Cliff faces below it; the map's `faces` when missing. */
  left?: string;
  right?: string;
}

export interface IsoTileMapOptions {
  data: TileMapData | number[][];
  /** Height of each cell in levels; a grid, a function, or flat. */
  elevation?: number[][] | ((col: number, row: number) => number);
  /** Tile pixel size and the pixels one level rises. */
  tile: { w: number; h: number; rise: number };
  tiles: Record<number, string | IsoTile>;
  /** Cliff faces for tiles that name none. */
  faces?: { left: string; right: string };
  /** World units per cell; half the tile width by default. */
  cell?: number;
}

interface Instance {
  region: Region;
  gx: number;
  gy: number;
  gz: number;
  bias: number;
  col: number;
  row: number;
}

export class IsoTileMap extends Node2D {
  readonly data: TileMapData;
  readonly tile: { w: number; h: number; rise: number };
  readonly tiles: Record<number, string | IsoTile>;
  readonly faces: { left: string; right: string } | null;
  /** World units per cell. */
  readonly cell: number;
  private readonly elevation: Uint8Array;
  private readonly tintOf: Uint32Array;
  private readonly alphaOf: Float32Array;
  private kernel: Kernel | null = null;
  private batch = -1;
  private instances: Instance[] = [];
  private cellStart = new Int32Array(0);
  private cellCount = new Uint8Array(0);
  private dirty = true;
  private tintsDirty = false;

  constructor(opts: IsoTileMapOptions) {
    super();
    if (opts.data instanceof TileMapData) this.data = opts.data;
    else {
      const rows = opts.data;
      this.data = new TileMapData(Math.max(...rows.map((r) => r.length)), rows.length);
      rows.forEach((row, r) => row.forEach((v, c) => this.data.set(c, r, v)));
    }
    this.tile = opts.tile;
    this.tiles = opts.tiles;
    this.faces = opts.faces ?? null;
    this.cell = opts.cell ?? opts.tile.w / 2;
    const n = this.cols * this.rows;
    this.elevation = new Uint8Array(n);
    this.tintOf = new Uint32Array(n).fill(0xffffff);
    this.alphaOf = new Float32Array(n).fill(1);
    const e = opts.elevation;
    if (e) {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) this.elevation[r * this.cols + c] = Math.max(0, Math.round(typeof e === "function" ? e(c, r) : (e[r]?.[c] ?? 0)));
      }
    }
  }

  get cols(): number {
    return this.data.cols;
  }

  get rows(): number {
    return this.data.rows;
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }

  get(col: number, row: number): number {
    return this.inBounds(col, row) ? this.data.get(col, row) : 0;
  }

  set(col: number, row: number, id: number): void {
    if (!this.inBounds(col, row)) return;
    this.data.set(col, row, id);
    this.dirty = true;
  }

  /** Levels above the ground; cells outside the map count as zero. */
  elevationAt(col: number, row: number): number {
    return this.inBounds(col, row) ? this.elevation[row * this.cols + col] : 0;
  }

  setElevation(col: number, row: number, levels: number): void {
    if (!this.inBounds(col, row)) return;
    this.elevation[row * this.cols + col] = Math.max(0, Math.round(levels));
    this.dirty = true;
  }

  /** Cell under a ground position in the map's own space. */
  cellAt(x: number, y: number): { col: number; row: number } {
    return { col: Math.floor(x / this.cell), row: Math.floor(y / this.cell) };
  }

  /** Ground centre of a cell. */
  cellCenter(col: number, row: number): [number, number] {
    return [(col + 0.5) * this.cell, (row + 0.5) * this.cell];
  }

  /** Height of the ground at a position, in world units. */
  heightAt(x: number, y: number): number {
    const { col, row } = this.cellAt(x, y);
    return this.elevationAt(col, row) * this.tile.rise;
  }

  /** Whether a cell holds a tile at all. */
  walkable(col: number, row: number): boolean {
    return this.get(col, row) !== 0;
  }

  /** Tint and alpha of a cell's tiles: fog of war, highlights, the see-through egg. */
  setTint(col: number, row: number, tint: number, alpha = 1): void {
    if (!this.inBounds(col, row)) return;
    const i = row * this.cols + col;
    if (this.tintOf[i] === (tint & 0xffffff) && this.alphaOf[i] === alpha) return;
    this.tintOf[i] = tint & 0xffffff;
    this.alphaOf[i] = alpha;
    this.tintsDirty = true;
  }

  tintAt(col: number, row: number): number {
    return this.inBounds(col, row) ? this.tintOf[row * this.cols + col] : 0xffffff;
  }

  /** Call after editing `data` directly. */
  invalidate(): void {
    this.dirty = true;
  }

  private entry(id: number): IsoTile | null {
    const e = this.tiles[id];
    if (!e) return null;
    return typeof e === "string" ? { top: e } : e;
  }

  /** Every floor and cliff-face instance, in ground units, with per-cell depth biases. */
  private build(ctx: DrawContext): void {
    const out: Instance[] = [];
    const { rise } = this.tile;
    const half = this.cell / 2;
    this.cellStart = new Int32Array(this.cols * this.rows).fill(-1);
    this.cellCount = new Uint8Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const id = this.data.get(c, r);
        const t = this.entry(id);
        if (!t) continue;
        const i = r * this.cols + c;
        const e = this.elevation[i];
        const [gx, gy] = this.cellCenter(c, r);
        this.cellStart[i] = out.length;
        // The floor sits under anything standing on the cell: half a cell behind its centre.
        out.push({ region: ctx.region(t.top), gx, gy, gz: e * rise, bias: -half, col: c, row: r });
        const left = t.left ?? this.faces?.left;
        const right = t.right ?? this.faces?.right;
        // Faces the viewer sees: towards +x (right) and +y (left), down to the lower neighbour. A
        // face's top edge is the floor edge of its level, so it anchors at that level's centre.
        if (right) {
          const down = e - this.elevationAt(c + 1, r);
          for (let k = 0; k < down; k++) out.push({ region: ctx.region(right), gx, gy, gz: (e - k) * rise, bias: -half + 0.5, col: c, row: r });
        }
        if (left) {
          const down = e - this.elevationAt(c, r + 1);
          for (let k = 0; k < down; k++) out.push({ region: ctx.region(left), gx, gy, gz: (e - k) * rise, bias: -half + 0.5, col: c, row: r });
        }
        this.cellCount[i] = out.length - this.cellStart[i];
      }
    }
    this.instances = out;
  }

  private writeInstance(d: Float32Array, n: number, inst: Instance): void {
    const o = n * BATCH3_STRIDE;
    const r = inst.region;
    const i = inst.row * this.cols + inst.col;
    d[o] = inst.gx;
    d[o + 1] = inst.gy;
    d[o + 2] = inst.gz;
    d[o + 3] = r.w;
    d[o + 4] = r.h;
    d[o + 5] = r.ox;
    d[o + 6] = r.oy;
    d[o + 7] = r.u0;
    d[o + 8] = r.v0;
    d[o + 9] = r.u1;
    d[o + 10] = r.v1;
    d[o + 11] = this.tintOf[i];
    d[o + 12] = this.alphaOf[i];
    d[o + 13] = inst.bias;
  }

  private release(): void {
    if (this.kernel && this.batch >= 0) this.kernel.destroyBatch3(this.batch);
    this.kernel = null;
    this.batch = -1;
  }

  override exit(): void {
    this.release();
  }

  override render(ctx: DrawContext): void {
    const k = ctx.kernel;
    if (k && ctx.renderer.drawBatch3) {
      if (this.dirty || this.kernel !== k || this.batch < 0) {
        this.release();
        this.build(ctx);
        this.kernel = k;
        this.batch = k.createBatch3(Math.max(1, this.instances.length));
        const d = k.batch3Data(this.batch);
        for (let n = 0; n < this.instances.length; n++) this.writeInstance(d, n, this.instances[n]);
        k.setBatch3Count(this.batch, this.instances.length);
        this.dirty = false;
        this.tintsDirty = false;
      } else if (this.tintsDirty) {
        const d = k.batch3Data(this.batch);
        for (let n = 0; n < this.instances.length; n++) {
          const inst = this.instances[n];
          const i = inst.row * this.cols + inst.col;
          d[n * BATCH3_STRIDE + 11] = this.tintOf[i];
          d[n * BATCH3_STRIDE + 12] = this.alphaOf[i];
        }
        k.setBatch3Count(this.batch, this.instances.length);
        this.tintsDirty = false;
      }
      ctx.batch3(this.batch);
      return;
    }
    // No kernel renderer: draw the instances one by one, projected by the context.
    if (this.dirty) {
      this.build(ctx);
      this.dirty = false;
    }
    for (const inst of this.instances) {
      const i = inst.row * this.cols + inst.col;
      ctx.sprite3(inst.region, inst.gx, inst.gy, inst.gz, { tint: this.tintOf[i], alpha: this.alphaOf[i] });
    }
  }

  /** Instances the last build produced, for tests. */
  get instanceCount(): number {
    return this.instances.length;
  }
}

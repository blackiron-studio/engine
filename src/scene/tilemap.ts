// TileMap: a grid of tile ids drawn from a tile set, with autotiling, animated tiles and
// collision built in. With a kernel, the map is a retained batch: tiles are written once
// and re-culled natively every frame; without one it draws the visible tiles itself.

import type { Cell } from "../core/grid.ts";
import { type Aabb, type MoveResult, type PathOptions, TileMapData, autotileMask, autotileMask8, blobIndex, cellsUnder, findPath, groundedAabb, mergeRects, moveAabb } from "../core/tilemap.ts";
import { autotileMode } from "../art/sprites.ts";
import type { PhysicsWorld } from "../physics/world.ts";
import { BATCH_STRIDE, type Kernel } from "../kernel/protocol.ts";
import type { DrawContext } from "./draw.ts";
import { LightLayer, type Occluding, pointIn } from "./light.ts";
import { Node2D } from "./node.ts";

export type TileEntry =
  | string
  | { autotile: string }
  | { frames: string[]; fps: number }
  | null;

export interface TileMapOptions {
  /** Tile ids as a TileMapData, rows of numbers, or ASCII rows with a legend. */
  data: TileMapData | number[][] | string[];
  legend?: Record<string, number>;
  tileSize: number;
  /** Sprite for each tile id: a name, an autotile set, or animation frames. */
  tiles: Record<number, TileEntry>;
  solid?: number[];
  oneWay?: number[];
  /** Extra tiles drawn beyond the view, for oversized tile art. */
  overscan?: number;
  /** Solid tiles block shadowed lights. */
  occlude?: boolean;
}

interface AnimCell {
  c: number;
  r: number;
  frames: string[];
  fps: number;
}

export class TileMap extends Node2D implements Occluding {
  readonly data: TileMapData;
  readonly tileSize: number;
  readonly tiles: Record<number, TileEntry>;
  readonly solidIds: Set<number>;
  readonly oneWayIds: Set<number>;
  overscan: number;
  /** Whether solid tiles cast shadows; set from the options or later, before the layer's first frame. */
  occlude: boolean;
  private t = 0;
  private kernel: Kernel | null = null;
  private staticBatch = -1;
  private animBatch = -1;
  private animCap = 0;
  private dirty = true;
  private readonly animCells: AnimCell[] = [];
  private animRates: number[] = [];
  private animKey = "";

  constructor(opts: TileMapOptions) {
    super();
    if (opts.data instanceof TileMapData) this.data = opts.data;
    else if (typeof opts.data[0] === "string") this.data = TileMapData.fromAscii(opts.data as string[], opts.legend ?? {});
    else {
      const rows = opts.data as number[][];
      this.data = new TileMapData(Math.max(...rows.map((r) => r.length)), rows.length);
      rows.forEach((row, r) => row.forEach((v, c) => this.data.set(c, r, v)));
    }
    this.tileSize = opts.tileSize;
    this.tiles = opts.tiles;
    this.solidIds = new Set(opts.solid ?? []);
    this.oneWayIds = new Set(opts.oneWay ?? []);
    this.overscan = opts.overscan ?? 1;
    this.occlude = opts.occlude ?? false;
  }

  override ready(): void {
    if (this.occlude) this.scene?.world.findAll(LightLayer)[0]?.addOccluder(this);
  }

  /**
   * Edges of solid tiles that face open cells, merged along runs, in `layer`'s space. Only the
   * cells under `bounds` (in the layer's space) are walked.
   */
  appendOccluders(layer: LightLayer, out: number[], bounds: { x: number; y: number; w: number; h: number } | null): void {
    if (!this.occlude || !this.visible) return;
    const ts = this.tileSize;
    let c0 = 0;
    let r0 = 0;
    let c1 = this.cols - 1;
    let r1 = this.rows - 1;
    if (bounds) {
      // The bounds' corners in map space give the cell range to walk.
      const corners = [pointIn(layer, this, bounds.x, bounds.y), pointIn(layer, this, bounds.x + bounds.w, bounds.y), pointIn(layer, this, bounds.x, bounds.y + bounds.h), pointIn(layer, this, bounds.x + bounds.w, bounds.y + bounds.h)];
      c0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0])) / ts) - 1);
      c1 = Math.min(this.cols - 1, Math.ceil(Math.max(...corners.map((c) => c[0])) / ts) + 1);
      r0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1])) / ts) - 1);
      r1 = Math.min(this.rows - 1, Math.ceil(Math.max(...corners.map((c) => c[1])) / ts) + 1);
    }
    const solid = (c: number, r: number) => c >= 0 && r >= 0 && c < this.cols && r < this.rows && this.isSolid(c, r);
    const push = (x0: number, y0: number, x1: number, y1: number) => {
      const a = pointIn(this, layer, x0, y0);
      const b = pointIn(this, layer, x1, y1);
      out.push(a[0], a[1], b[0], b[1]);
    };
    // Horizontal edges: runs along a row where the cell is solid and the neighbour above (or below) is not.
    for (let r = r0; r <= r1; r++) {
      for (const dir of [-1, 1]) {
        let start = -1;
        for (let c = c0; c <= c1 + 1; c++) {
          const edge = c <= c1 && solid(c, r) && !solid(c, r + dir);
          if (edge && start < 0) start = c;
          if (!edge && start >= 0) {
            const y = dir < 0 ? r * ts : (r + 1) * ts;
            push(start * ts, y, c * ts, y);
            start = -1;
          }
        }
      }
    }
    // Vertical edges: runs along a column where the neighbour left (or right) is open.
    for (let c = c0; c <= c1; c++) {
      for (const dir of [-1, 1]) {
        let start = -1;
        for (let r = r0; r <= r1 + 1; r++) {
          const edge = r <= r1 && solid(c, r) && !solid(c + dir, r);
          if (edge && start < 0) start = r;
          if (!edge && start >= 0) {
            const x = dir < 0 ? c * ts : (c + 1) * ts;
            push(x, start * ts, x, r * ts);
            start = -1;
          }
        }
      }
    }
  }

  get cols(): number {
    return this.data.cols;
  }

  get rows(): number {
    return this.data.rows;
  }

  get pixelWidth(): number {
    return this.cols * this.tileSize;
  }

  get pixelHeight(): number {
    return this.rows * this.tileSize;
  }

  get(col: number, row: number): number {
    return this.data.get(col, row);
  }

  set(col: number, row: number, id: number): void {
    this.data.set(col, row, id);
    this.dirty = true;
  }

  /** Call after editing `data` directly so the retained batch is rebuilt. */
  invalidate(): void {
    this.dirty = true;
  }

  isSolid = (col: number, row: number): boolean => this.solidIds.has(this.data.get(col, row));
  isOneWay = (col: number, row: number): boolean => this.oneWayIds.has(this.data.get(col, row));

  /** Cell under a world position in this map's local space. */
  cellAt(x: number, y: number): Cell {
    return { x: Math.floor(x / this.tileSize), y: Math.floor(y / this.tileSize) };
  }

  /** Move a box through the map, stopping at solid and one-way tiles. */
  moveBody(box: Aabb, dx: number, dy: number): MoveResult {
    return moveAabb(box, dx, dy, this.tileSize, this.isSolid, this.isOneWay);
  }

  grounded(box: Aabb): boolean {
    return groundedAabb(box, this.tileSize, this.isSolid, this.isOneWay);
  }

  cellsUnder(box: Aabb): Cell[] {
    return cellsUnder(box, this.tileSize);
  }

  /** The tile of an autotile set for a cell: by edge mask, or by blob index for blob sets. */
  autotileName(set: string, col: number, row: number, id = this.data.get(col, row)): string {
    return autotileMode(set) === "blob" ? `${set}.${blobIndex(autotileMask8(this.data, col, row, id))}` : `${set}.${autotileMask(this.data, col, row, id)}`;
  }

  /** A* between cells through non-solid tiles (or `passable`), from the start (exclusive) to the goal. */
  pathfind(from: Cell, to: Cell, opts: PathOptions & { passable?: (col: number, row: number) => boolean } = {}): Cell[] | null {
    const passable = opts.passable ?? ((c: number, r: number) => !this.isSolid(c, r));
    return findPath(this.cols, this.rows, passable, from, to, opts);
  }

  /** Cell centres of a path in this map's local space, for steering. */
  pathPoints(path: Cell[]): [number, number][] {
    return path.map((c) => [(c.x + 0.5) * this.tileSize, (c.y + 0.5) * this.tileSize]);
  }

  /**
   * Solid tiles as one static body of merged box colliders in `world`, one-way tiles as thin
   * platforms; for maps whose actors are physics bodies. Rebuild after editing tiles.
   */
  attachPhysics(world: PhysicsWorld, opts: { layers?: number; mask?: number; friction?: number } = {}): { body: number; colliders: number[] } {
    const layer = this.scene?.world;
    const [ox, oy] = layer ? this.positionIn(layer) : [this.x, this.y];
    const body = world.createBody({ kind: "static", x: ox, y: oy });
    const ts = this.tileSize;
    const colliders: number[] = [];
    for (const r of mergeRects(this.cols, this.rows, (c, row) => this.isSolid(c, row))) {
      colliders.push(world.createCollider(body, { shape: { rect: [r.w * ts, r.h * ts] }, x: (r.x + r.w / 2) * ts, y: (r.y + r.h / 2) * ts, layers: opts.layers, mask: opts.mask, friction: opts.friction }));
    }
    for (const r of mergeRects(this.cols, this.rows, (c, row) => this.isOneWay(c, row) && !this.isSolid(c, row))) {
      colliders.push(world.createCollider(body, { shape: { rect: [r.w * ts, 2] }, x: (r.x + r.w / 2) * ts, y: r.y * ts + 1, layers: opts.layers, mask: opts.mask, friction: opts.friction, oneWay: true }));
    }
    return { body, colliders };
  }

  /** Sprite name for a cell, resolving autotiles and animation frames. */
  spriteAt(col: number, row: number): string | null {
    const id = this.data.get(col, row);
    const entry = this.tiles[id];
    if (!entry) return null;
    if (typeof entry === "string") return entry;
    if ("autotile" in entry) return this.autotileName(entry.autotile, col, row, id);
    const frame = Math.floor(this.t * entry.fps) % entry.frames.length;
    return entry.frames[frame];
  }

  override update(dt: number): void {
    this.t += dt;
  }

  override exit(): void {
    this.releaseBatches();
  }

  private releaseBatches(): void {
    if (this.kernel) {
      if (this.staticBatch >= 0) this.kernel.destroyBatch(this.staticBatch);
      if (this.animBatch >= 0) this.kernel.destroyBatch(this.animBatch);
    }
    this.kernel = null;
    this.staticBatch = -1;
    this.animBatch = -1;
    this.animCap = 0;
    this.dirty = true;
  }

  override render(ctx: DrawContext): void {
    const k = ctx.kernel;
    if (k) {
      this.renderBatched(ctx, k);
      return;
    }
    const v = ctx.view;
    const [ox, oy] = this.positionIn(this.scene?.world ?? this);
    const T = this.tileSize;
    const c0 = Math.max(0, Math.floor((v.x - ox) / T) - this.overscan);
    const c1 = Math.min(this.cols - 1, Math.ceil((v.x + v.w - ox) / T) + this.overscan);
    const r0 = Math.max(0, Math.floor((v.y - oy) / T) - this.overscan);
    const r1 = Math.min(this.rows - 1, Math.ceil((v.y + v.h - oy) / T) + this.overscan);
    const prevCull = ctx.cull;
    ctx.cull = false;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const name = this.spriteAt(c, r);
        if (name) ctx.sprite(name, c * T, r * T, { ox: 0, oy: 0 });
      }
    }
    ctx.cull = prevCull;
  }

  private renderBatched(ctx: DrawContext, k: Kernel): void {
    if (this.kernel !== k) {
      this.releaseBatches();
      this.kernel = k;
      this.staticBatch = k.createBatch(this.cols * this.rows);
    }
    if (this.dirty) this.rebuild(ctx, k);
    else if (this.animCells.length > 0 && this.frameKey() !== this.animKey) this.rebuildAnimated(ctx, k);
    const v = ctx.view;
    const [ox, oy] = this.positionIn(this.scene?.world ?? this);
    const pad = this.overscan * this.tileSize;
    const cull = { x: v.x - ox - pad, y: v.y - oy - pad, w: v.w + pad * 2, h: v.h + pad * 2 };
    ctx.batch(this.staticBatch, cull);
    if (this.animBatch >= 0) ctx.batch(this.animBatch, cull);
  }

  /** Write every static tile into the batch once; animated cells are kept aside. */
  private rebuild(ctx: DrawContext, k: Kernel): void {
    const data = k.batchData(this.staticBatch);
    const T = this.tileSize;
    let n = 0;
    this.animCells.length = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const id = this.data.get(c, r);
        const entry = this.tiles[id];
        if (!entry) continue;
        if (typeof entry === "object" && "frames" in entry) {
          this.animCells.push({ c, r, frames: entry.frames, fps: entry.fps });
          continue;
        }
        const name = typeof entry === "string" ? entry : this.autotileName(entry.autotile, c, r, id);
        const reg = ctx.region(name);
        const o = n * BATCH_STRIDE;
        data[o] = c * T;
        data[o + 1] = r * T;
        data[o + 2] = reg.w;
        data[o + 3] = reg.h;
        data[o + 4] = reg.u0;
        data[o + 5] = reg.v0;
        data[o + 6] = reg.u1;
        data[o + 7] = reg.v1;
        n++;
      }
    }
    k.setBatchCount(this.staticBatch, n);
    this.animRates = [...new Set(this.animCells.map((a) => a.fps))];
    if (this.animCells.length > 0) {
      if (this.animBatch < 0 || this.animCap < this.animCells.length) {
        if (this.animBatch >= 0) k.destroyBatch(this.animBatch);
        this.animCap = this.animCells.length;
        this.animBatch = k.createBatch(this.animCap);
      }
      this.rebuildAnimated(ctx, k);
    } else if (this.animBatch >= 0) {
      k.destroyBatch(this.animBatch);
      this.animBatch = -1;
      this.animCap = 0;
    }
    this.dirty = false;
  }

  private frameKey(): string {
    let key = "";
    for (const fps of this.animRates) key += `${Math.floor(this.t * fps)},`;
    return key;
  }

  private rebuildAnimated(ctx: DrawContext, k: Kernel): void {
    const data = k.batchData(this.animBatch);
    const T = this.tileSize;
    let n = 0;
    for (const a of this.animCells) {
      const frame = Math.floor(this.t * a.fps) % a.frames.length;
      const reg = ctx.region(a.frames[frame]);
      const o = n * BATCH_STRIDE;
      data[o] = a.c * T;
      data[o + 1] = a.r * T;
      data[o + 2] = reg.w;
      data[o + 3] = reg.h;
      data[o + 4] = reg.u0;
      data[o + 5] = reg.v0;
      data[o + 6] = reg.u1;
      data[o + 7] = reg.v1;
      n++;
    }
    k.setBatchCount(this.animBatch, n);
    this.animKey = this.frameKey();
  }
}

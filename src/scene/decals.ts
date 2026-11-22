// Decals: marks that stay on a surface for a while, then fade. Bullet holes, scorch, blood,
// footprints, tyre marks. Paint the art as seen straight on (a round hole is a circle); the
// node lays it flat on the ground or on a wall face through the camera's projection, so it
// squashes the way the surface does. A fixed ring of slots holds them; the oldest goes first.
// In projected layers a mark sorts with the tile it lies on, just above it, so actors standing
// there still draw over it. `IsoTileMap.surfaceAt` turns a hit into a surface to mark.

import { Rng } from "../core/rng.ts";
import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";
import { depthOf, placeAt, projectDir, restorePlace } from "./place.ts";

export interface DecalOptions {
  sprite: string;
  /** Seconds at full strength. Infinity keeps it until the ring needs the slot. */
  stay?: number;
  /** Seconds it then takes to fade away. */
  fade?: number;
  alpha?: number;
  tint?: number;
  additive?: boolean;
  /** Rotation on the surface, in radians; `randomRot` picks one. */
  rot?: number;
  randomRot?: boolean;
  /** Size; a [min, max] pair picks one at random. */
  scale?: number | [number, number];
  /**
   * The surface's outward normal: [0, 0, 1] (the ground, the default) or a wall face such as
   * [1, 0, 0]. Wall marks stand upright on the face.
   */
  normal?: [number, number, number];
  /** Added to the depth key, for the rare mark that must sort differently. */
  depthBias?: number;
}

export interface DecalsOptions {
  /** Marks kept at once; the oldest is replaced past it. */
  capacity?: number;
  /** World units per tile, to sort marks with the tile they lie on (32 by default). */
  cell?: number;
  /** Seed for random rotations and sizes. */
  seed?: number;
}

interface Decal {
  live: boolean;
  x: number;
  y: number;
  z: number;
  sprite: string;
  stay: number;
  fade: number;
  age: number;
  alpha: number;
  tint: number;
  additive: boolean;
  rot: number;
  scale: number;
  nx: number;
  ny: number;
  nz: number;
  bias: number;
}

export class Decals extends Node2D {
  readonly capacity: number;
  readonly cell: number;
  private readonly ring: Decal[] = [];
  private next = 0;
  private readonly rng: Rng;

  constructor(opts: DecalsOptions = {}) {
    super();
    this.capacity = Math.max(1, opts.capacity ?? 128);
    this.cell = opts.cell ?? 32;
    this.rng = new Rng(opts.seed ?? 1);
  }

  /** Marks alive now. */
  get count(): number {
    let n = 0;
    for (const d of this.ring) if (d.live) n++;
    return n;
  }

  /** Leave a mark at (x, y, z) in this node's ground space; returns its slot. */
  mark(x: number, y: number, z: number, o: DecalOptions): number {
    const slot = this.next;
    this.next = (this.next + 1) % this.capacity;
    const [nx, ny, nz] = normalised(o.normal ?? [0, 0, 1]);
    const sc = o.scale ?? 1;
    const d: Decal = {
      live: true,
      x,
      y,
      z,
      sprite: o.sprite,
      stay: o.stay ?? 10,
      fade: Math.max(0, o.fade ?? 2),
      age: 0,
      alpha: o.alpha ?? 1,
      tint: o.tint ?? 0xffffff,
      additive: o.additive ?? false,
      rot: o.randomRot ? this.rng.range(0, Math.PI * 2) : (o.rot ?? 0),
      scale: Array.isArray(sc) ? this.rng.range(sc[0], sc[1]) : sc,
      nx,
      ny,
      nz,
      bias: o.depthBias ?? 0,
    };
    this.ring[slot] = d;
    return slot;
  }

  freeAll(): void {
    for (const d of this.ring) d.live = false;
    this.next = 0;
  }

  /** Remove the marks a test picks, given each mark's position and surface normal; returns how many. */
  freeWhere(test: (x: number, y: number, z: number, normal: [number, number, number]) => boolean): number {
    let n = 0;
    for (const d of this.ring) {
      if (!d.live || !test(d.x, d.y, d.z, [d.nx, d.ny, d.nz])) continue;
      d.live = false;
      n++;
    }
    return n;
  }

  /** Remove the marks on one cell: its top and its own faces, not a neighbour's face on the shared edge. */
  freeCell(col: number, row: number): number {
    return this.freeWhere((x, y, _z, [nx, ny]) => this.cellOf(x, nx) === col && this.cellOf(y, ny) === row);
  }

  /** The cell a mark belongs to along one axis: the one behind the face it lies on. */
  private cellOf(v: number, n: number): number {
    return Math.floor((v - n * 0.25) / this.cell);
  }

  override update(dt: number): void {
    for (const d of this.ring) {
      if (!d.live) continue;
      d.age += dt;
      if (d.age >= d.stay + d.fade) d.live = false;
    }
  }

  override render(ctx: DrawContext): void {
    const bias = ctx.depthBias;
    let placed = false;
    const half = this.cell / 2;
    const basis: [number, number, number, number] = [1, 0, 0, 1];
    for (const d of this.ring) {
      if (!d.live) continue;
      const k = d.age <= d.stay ? 1 : d.fade > 0 ? 1 - (d.age - d.stay) / d.fade : 0;
      if (k <= 0) continue;
      const cos = Math.cos(d.rot) * d.scale;
      const sin = Math.sin(d.rot) * d.scale;
      let extra = d.bias;
      const wall = Math.abs(d.nz) < 0.5;
      if (wall) {
        // Upright on the face: x along the face (reading left to right on screen), y down.
        let tx = -d.ny;
        let ty = d.nx;
        if (projectDir(ctx, tx, ty, 0)[0] < 0 || (projectDir(ctx, tx, ty, 0)[0] === 0 && ty < 0)) {
          tx = -tx;
          ty = -ty;
        }
        const [ax, ay] = projectDir(ctx, tx, ty, 0);
        const [bx, by] = projectDir(ctx, 0, 0, -1);
        basis[0] = ax * cos + bx * sin;
        basis[1] = ay * cos + by * sin;
        basis[2] = -ax * sin + bx * cos;
        basis[3] = -ay * sin + by * cos;
      } else {
        const [ax, ay] = projectDir(ctx, 1, 0, 0);
        const [bx, by] = projectDir(ctx, 0, 1, 0);
        basis[0] = ax * cos + bx * sin;
        basis[1] = ay * cos + by * sin;
        basis[2] = -ax * sin + bx * cos;
        basis[3] = -ay * sin + by * cos;
      }
      if (ctx.projection) {
        // Sort with the tile the mark lies on, like IsoTileMap: floors at half a cell behind the
        // cell's centre, faces just in front of that; the mark just in front of either.
        const col = this.cellOf(d.x, d.nx);
        const row = this.cellOf(d.y, d.ny);
        const cx = (col + 0.5) * this.cell + this.ground[4];
        const cy = (row + 0.5) * this.cell + this.ground[5];
        const gz = this.worldZ + d.z;
        const anchor = depthOf(ctx, cx, cy, gz) - half + (wall ? 0.75 : 0.25);
        extra += anchor - depthOf(ctx, d.x + this.ground[4], d.y + this.ground[5], gz);
      }
      placeAt(ctx, this, bias, d.x, d.y, d.z, extra, basis);
      placed = true;
      ctx.sprite(d.sprite, 0, 0, { alpha: d.alpha * k, tint: d.tint, additive: d.additive, smooth: true });
    }
    if (placed) restorePlace(ctx, this, bias);
  }
}

function normalised(n: readonly number[]): [number, number, number] {
  const len = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0) || 1;
  return [(n[0] ?? 0) / len, (n[1] ?? 0) / len, (n[2] ?? 1) / len];
}

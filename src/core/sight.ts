// Line of sight on grids: a ray walk that stops at the first blocking cell (with optional
// cell heights, so a low wall is seen and shot over), `canSee` between two points, symmetric
// shadowcasting for the set of cells a viewer sees, sight cones, and fog of war that reports
// only the cells whose visibility changed. Positions and heights are in world units; the
// grid says how many world units one cell spans.

import { angleDelta } from "./math.ts";

export interface SightGrid {
  cols: number;
  rows: number;
  /** World units per cell; 1 by default. */
  cell?: number;
  /** Cells that block sight at any height. Called for cells outside the map too. */
  opaque(col: number, row: number): boolean;
  /** Height of a cell's top in world units. With it, a ray passes over cells lower than itself. */
  height?(col: number, row: number): number;
}

export interface GridRayHit {
  col: number;
  row: number;
  /** Where the ray entered the blocking cell, in world units. */
  x: number;
  y: number;
  /** Fraction of the segment travelled before the hit, 0..1. */
  t: number;
  /** Face of the cell the ray came through: (-1, 0) is the cell's left side. Zero for the start cell. */
  nx: number;
  ny: number;
}

export interface GridRayOptions {
  /** Ray height at the start and end, world units; a level ray at 0 when omitted. */
  z0?: number;
  z1?: number;
  /** Test the cell the ray starts in; false by default (a viewer is not blocked by its own cell). */
  includeStart?: boolean;
  /** Test the cell the ray ends in; true by default. `canSee` leaves it out so walls themselves are seen. */
  includeEnd?: boolean;
}

const EPS = 1e-9;

function blocks(grid: SightGrid, col: number, row: number, zMin: number): boolean {
  if (grid.opaque(col, row)) return true;
  return grid.height !== undefined && grid.height(col, row) > zMin + EPS;
}

/**
 * Walk the cells a segment crosses (Amanatides-Woo) and return the first that blocks it, or
 * null. A ray through the exact corner between two blocking cells is blocked; through a
 * corner beside one open cell it squeezes past.
 */
export function castGridRay(grid: SightGrid, x0: number, y0: number, x1: number, y1: number, opts: GridRayOptions = {}): GridRayHit | null {
  const cs = grid.cell ?? 1;
  const z0 = opts.z0 ?? 0;
  const z1 = opts.z1 ?? z0;
  const includeStart = opts.includeStart ?? false;
  const includeEnd = opts.includeEnd ?? true;
  const gx0 = x0 / cs;
  const gy0 = y0 / cs;
  const dx = x1 / cs - gx0;
  const dy = y1 / cs - gy0;
  let col = Math.floor(gx0);
  let row = Math.floor(gy0);
  const endCol = Math.floor(x1 / cs);
  const endRow = Math.floor(y1 / cs);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
  let tMaxX = stepX > 0 ? (col + 1 - gx0) / dx : stepX < 0 ? (gx0 - col) / -dx : Infinity;
  let tMaxY = stepY > 0 ? (row + 1 - gy0) / dy : stepY < 0 ? (gy0 - row) / -dy : Infinity;
  let tEnter = 0;
  let nx = 0;
  let ny = 0;
  const zAt = (t: number): number => z0 + (z1 - z0) * Math.min(1, Math.max(0, t));
  const hit = (c: number, r: number, t: number, hx: number, hy: number): GridRayHit => ({
    col: c,
    row: r,
    t,
    x: x0 + (x1 - x0) * t,
    y: y0 + (y1 - y0) * t,
    nx: hx,
    ny: hy,
  });
  const steps = Math.abs(endCol - col) + Math.abs(endRow - row) + 2;
  for (let i = 0; i <= steps; i++) {
    const atEnd = col === endCol && row === endRow;
    const tExit = Math.min(tMaxX, tMaxY, 1);
    const test = (i > 0 || includeStart) && (!atEnd || includeEnd);
    if (test && blocks(grid, col, row, Math.min(zAt(tEnter), zAt(tExit)))) return hit(col, row, tEnter, nx, ny);
    if (atEnd || tExit >= 1) return null;
    if (Math.abs(tMaxX - tMaxY) < EPS) {
      // Through a corner: the two cells beside it both blocking closes the gap.
      const t = tMaxX;
      const z = zAt(t);
      const sideX = blocks(grid, col + stepX, row, z);
      const sideY = blocks(grid, col, row + stepY, z);
      if (sideX && sideY) return hit(col + stepX, row, t, -stepX, 0);
      col += stepX;
      row += stepY;
      tEnter = t;
      nx = -stepX;
      ny = -stepY;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    } else if (tMaxX < tMaxY) {
      col += stepX;
      tEnter = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
    } else {
      row += stepY;
      tEnter = tMaxY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
    }
  }
  return null;
}

export interface SightOptions {
  /** Farther than this (world units) is never seen. */
  range?: number;
  /** Eye height above the ground under the viewer, when the grid has heights. 0 by default. */
  eye?: number;
  /** Height above its ground that the viewer aims at; the eye height by default. */
  targetHeight?: number;
  /** Facing (radians) and full field of view (radians) of a sight cone; a full circle when omitted. */
  facing?: number;
  fov?: number;
}

/** Height of the ground under a world position (0 without heights). */
export function groundHeight(grid: SightGrid, x: number, y: number): number {
  const cs = grid.cell ?? 1;
  return grid.height ? grid.height(Math.floor(x / cs), Math.floor(y / cs)) : 0;
}

/** Whether (tx, ty) lies within range and inside a cone facing `facing` with a full angle of `fov`. */
export function inSightCone(x: number, y: number, facing: number, fov: number, range: number, tx: number, ty: number): boolean {
  const dx = tx - x;
  const dy = ty - y;
  const d2 = dx * dx + dy * dy;
  if (d2 > range * range) return false;
  if (d2 < EPS || fov >= Math.PI * 2) return true;
  return Math.abs(angleDelta(facing, Math.atan2(dy, dx))) <= fov / 2 + EPS;
}

/** Whether a viewer at (x, y) sees the point (tx, ty): within range and cone, with nothing blocking between. */
export function canSee(grid: SightGrid, x: number, y: number, tx: number, ty: number, opts: SightOptions = {}): boolean {
  if (opts.range !== undefined || opts.fov !== undefined) {
    if (!inSightCone(x, y, opts.facing ?? 0, opts.fov ?? Math.PI * 2, opts.range ?? Infinity, tx, ty)) return false;
  }
  const eye = opts.eye ?? 0;
  const z0 = groundHeight(grid, x, y) + eye;
  const z1 = groundHeight(grid, tx, ty) + (opts.targetHeight ?? eye);
  return castGridRay(grid, x, y, tx, ty, { z0, z1, includeEnd: false }) === null;
}

export interface FieldOptions {
  /** Absolute eye height. Cells taller than it block; the ground under the viewer plus `eye` by default. */
  eyeZ?: number;
  eye?: number;
  facing?: number;
  fov?: number;
  /** Reuse this buffer (cols * rows); it is cleared first. */
  out?: Uint8Array;
}

const floorDiv = (a: number, b: number): number => Math.floor(a / b);
const ceilDiv = (a: number, b: number): number => Math.ceil(a / b);

/**
 * Cells a viewer at (x, y) sees within `radius` world units, as 1s in a cols * rows buffer
 * (row-major). Symmetric shadowcasting from the viewer's cell: if A sees B, B sees A; walls
 * that bound the view are themselves visible. With heights, a cell blocks when it is taller
 * than the eye; seeing over a low wall onto a taller one beyond is `canSee`'s job.
 */
export function visibilityField(grid: SightGrid, x: number, y: number, radius: number, opts: FieldOptions = {}): Uint8Array {
  const { cols, rows } = grid;
  const out = opts.out ?? new Uint8Array(cols * rows);
  out.fill(0);
  const cs = grid.cell ?? 1;
  const oc = Math.floor(x / cs);
  const or = Math.floor(y / cs);
  const eyeZ = opts.eyeZ ?? groundHeight(grid, x, y) + (opts.eye ?? 0);
  const R = radius / cs;
  const R2 = R * R;
  const fov = opts.fov ?? Math.PI * 2;
  const facing = opts.facing ?? 0;
  const cone = fov < Math.PI * 2;
  const inside = (c: number, r: number): boolean => c >= 0 && r >= 0 && c < cols && r < rows;
  const wall = (c: number, r: number): boolean => !inside(c, r) || blocks(grid, c, r, eyeZ);
  const reveal = (c: number, r: number): void => {
    if (!inside(c, r)) return;
    const dc = c - oc;
    const dr = r - or;
    if (dc * dc + dr * dr > R2) return;
    if (cone && (dc !== 0 || dr !== 0) && Math.abs(angleDelta(facing, Math.atan2(dr, dc))) > fov / 2 + EPS) return;
    out[r * cols + c] = 1;
  };
  if (inside(oc, or)) out[or * cols + oc] = 1;
  const maxDepth = Math.ceil(R);
  // Rows of a quadrant as [depth, startNum, startDen, endNum, endDen]; slopes stay exact fractions.
  const stack: number[][] = [];
  for (let q = 0; q < 4; q++) {
    const cellOf = (depth: number, col: number): [number, number] =>
      q === 0 ? [oc + col, or - depth] : q === 1 ? [oc + depth, or + col] : q === 2 ? [oc + col, or + depth] : [oc - depth, or + col];
    stack.push([1, -1, 1, 1, 1]);
    while (stack.length) {
      const [depth, sn0, sd0, en, ed] = stack.pop()!;
      if (depth > maxDepth) continue;
      let sn = sn0;
      let sd = sd0;
      const minCol = floorDiv(2 * depth * sn + sd, 2 * sd);
      const maxCol = ceilDiv(2 * depth * en - ed, 2 * ed);
      let prev = 0; // 0 none, 1 wall, 2 floor
      for (let col = minCol; col <= maxCol; col++) {
        const [c, r] = cellOf(depth, col);
        const isWall = wall(c, r);
        const symmetric = col * sd >= depth * sn && col * ed <= depth * en;
        if (isWall || symmetric) reveal(c, r);
        if (prev === 1 && !isWall) {
          sn = 2 * col - 1;
          sd = 2 * depth;
        }
        if (prev === 2 && isWall) stack.push([depth + 1, sn, sd, 2 * col - 1, 2 * depth]);
        prev = isWall ? 1 : 2;
      }
      if (prev === 2) stack.push([depth + 1, sn, sd, en, ed]);
    }
  }
  return out;
}

export interface Viewer {
  x: number;
  y: number;
  /** World units. */
  radius: number;
  eye?: number;
  facing?: number;
  fov?: number;
}

/**
 * Fog of war over a grid: what any viewer sees now, and what has ever been seen. `update`
 * returns the cells whose visibility changed, so a renderer retints only those.
 */
export class FogOfWar {
  readonly visible: Uint8Array;
  readonly explored: Uint8Array;
  private readonly next: Uint8Array;
  private readonly scratch: Uint8Array;

  constructor(readonly grid: SightGrid) {
    const n = grid.cols * grid.rows;
    this.visible = new Uint8Array(n);
    this.explored = new Uint8Array(n);
    this.next = new Uint8Array(n);
    this.scratch = new Uint8Array(n);
  }

  /** Recompute from these viewers; returns the indices (row * cols + col) whose visibility flipped. */
  update(viewers: Iterable<Viewer>): number[] {
    this.next.fill(0);
    for (const v of viewers) {
      visibilityField(this.grid, v.x, v.y, v.radius, { eye: v.eye, facing: v.facing, fov: v.fov, out: this.scratch });
      for (let i = 0; i < this.scratch.length; i++) if (this.scratch[i]) this.next[i] = 1;
    }
    const changed: number[] = [];
    for (let i = 0; i < this.next.length; i++) {
      if (this.next[i] !== this.visible[i]) {
        this.visible[i] = this.next[i];
        changed.push(i);
      }
      if (this.next[i]) this.explored[i] = 1;
    }
    return changed;
  }

  isVisible(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.grid.cols && row < this.grid.rows && this.visible[row * this.grid.cols + col] === 1;
  }

  isExplored(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.grid.cols && row < this.grid.rows && this.explored[row * this.grid.cols + col] === 1;
  }

  /** Whether a world position is in a currently visible cell. */
  sees(x: number, y: number): boolean {
    const cs = this.grid.cell ?? 1;
    return this.isVisible(Math.floor(x / cs), Math.floor(y / cs));
  }

  /** The explored cells as a compact run-length string for a save. */
  saveExplored(): string {
    const runs: string[] = [];
    let bit = 0;
    let run = 0;
    for (let i = 0; i < this.explored.length; i++) {
      if (this.explored[i] === bit) run++;
      else {
        runs.push(run.toString(36));
        bit ^= 1;
        run = 1;
      }
    }
    runs.push(run.toString(36));
    return runs.join(".");
  }

  /** Restore explored cells from `saveExplored`; a save from a different-sized map is ignored. */
  loadExplored(saved: string): boolean {
    const runs = saved.split(".").map((r) => parseInt(r, 36));
    if (runs.some((r) => !Number.isFinite(r) || r < 0)) return false;
    if (runs.reduce((a, b) => a + b, 0) !== this.explored.length) return false;
    let i = 0;
    let bit = 0;
    for (const r of runs) {
      this.explored.fill(bit, i, i + r);
      i += r;
      bit ^= 1;
    }
    return true;
  }
}

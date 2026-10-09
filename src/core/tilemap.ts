// Tile-grid helpers for platformers and top-down games: ASCII level parsing and
// axis-separated AABB movement against solid and one-way tiles.

import type { Cell } from "./grid.ts";

export class TileMapData {
  readonly data: Uint8Array;

  constructor(
    readonly cols: number,
    readonly rows: number,
    data?: Uint8Array,
  ) {
    this.data = data ?? new Uint8Array(cols * rows);
  }

  /** Parse rows of characters through a legend; unknown characters get `fallback`. */
  static fromAscii(rows: string[], legend: Record<string, number>, fallback = 0): TileMapData {
    const cols = Math.max(...rows.map((r) => r.length));
    const map = new TileMapData(cols, rows.length);
    rows.forEach((row, r) => {
      for (let c = 0; c < cols; c++) map.data[r * cols + c] = legend[row[c] ?? ""] ?? fallback;
    });
    return map;
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }

  /** Tile value, or -1 outside the map. */
  get(col: number, row: number): number {
    return this.inBounds(col, row) ? this.data[row * this.cols + col] : -1;
  }

  set(col: number, row: number, value: number): void {
    if (this.inBounds(col, row)) this.data[row * this.cols + col] = value;
  }

  /** Every cell holding `value`. */
  find(value: number): Cell[] {
    const out: Cell[] = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (this.data[r * this.cols + c] === value) out.push({ x: c, y: r });
    return out;
  }

  /** Replace every `value` with `replacement`. */
  replaceAll(value: number, replacement: number): void {
    for (let i = 0; i < this.data.length; i++) if (this.data[i] === value) this.data[i] = replacement;
  }

  clone(): TileMapData {
    return new TileMapData(this.cols, this.rows, new Uint8Array(this.data));
  }
}

/** Axis-aligned box with its top-left corner at (x, y). */
export interface Aabb {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MoveResult {
  x: number;
  y: number;
  hitLeft: boolean;
  hitRight: boolean;
  hitTop: boolean;
  hitBottom: boolean;
}

const EPS = 1e-4;

/**
 * Move a box by (dx, dy) through a tile grid, stopping at solid tiles. Movement is
 * resolved one axis at a time and in sub-steps of half a tile, so fast bodies cannot
 * tunnel. One-way tiles only block a downward move that started above them.
 */
export function moveAabb(
  box: Aabb,
  dx: number,
  dy: number,
  tileSize: number,
  solidAt: (col: number, row: number) => boolean,
  oneWayAt?: (col: number, row: number) => boolean,
): MoveResult {
  const res: MoveResult = { x: box.x, y: box.y, hitLeft: false, hitRight: false, hitTop: false, hitBottom: false };
  const w = box.w;
  const h = box.h;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (tileSize / 2)));
  const sx = dx / steps;
  const sy = dy / steps;
  let x = box.x;
  let y = box.y;
  for (let i = 0; i < steps; i++) {
    if (sx !== 0 && !(res.hitLeft || res.hitRight)) {
      x += sx;
      const r0 = Math.floor(y / tileSize);
      const r1 = Math.floor((y + h - EPS) / tileSize);
      if (sx > 0) {
        const c = Math.floor((x + w - EPS) / tileSize);
        for (let r = r0; r <= r1; r++) {
          if (solidAt(c, r)) {
            x = c * tileSize - w;
            res.hitRight = true;
            break;
          }
        }
      } else {
        const c = Math.floor(x / tileSize);
        for (let r = r0; r <= r1; r++) {
          if (solidAt(c, r)) {
            x = (c + 1) * tileSize;
            res.hitLeft = true;
            break;
          }
        }
      }
    }
    if (sy !== 0 && !(res.hitTop || res.hitBottom)) {
      const prevBottom = y + h;
      y += sy;
      const c0 = Math.floor(x / tileSize);
      const c1 = Math.floor((x + w - EPS) / tileSize);
      if (sy > 0) {
        const r = Math.floor((y + h - EPS) / tileSize);
        const top = r * tileSize;
        for (let c = c0; c <= c1; c++) {
          if (solidAt(c, r) || (oneWayAt?.(c, r) && prevBottom <= top + EPS)) {
            y = top - h;
            res.hitBottom = true;
            break;
          }
        }
      } else {
        const r = Math.floor(y / tileSize);
        for (let c = c0; c <= c1; c++) {
          if (solidAt(c, r)) {
            y = (r + 1) * tileSize;
            res.hitTop = true;
            break;
          }
        }
      }
    }
  }
  res.x = x;
  res.y = y;
  return res;
}

/** Whether a box rests on a solid or one-way tile directly beneath it. */
export function groundedAabb(box: Aabb, tileSize: number, solidAt: (col: number, row: number) => boolean, oneWayAt?: (col: number, row: number) => boolean): boolean {
  const r = Math.floor((box.y + box.h + EPS) / tileSize);
  const c0 = Math.floor(box.x / tileSize);
  const c1 = Math.floor((box.x + box.w - EPS) / tileSize);
  const bottom = box.y + box.h;
  for (let c = c0; c <= c1; c++) {
    if (solidAt(c, r)) return true;
    if (oneWayAt?.(c, r) && Math.abs(bottom - r * tileSize) < 0.01) return true;
  }
  return false;
}

/**
 * Four-bit autotile mask for a cell: which of its north (1), east (2), south (4) and west
 * (8) neighbours hold the same id. Cells outside the map count as matching, so edges
 * look continuous.
 */
export function autotileMask(map: { get(col: number, row: number): number }, col: number, row: number, id = map.get(col, row)): number {
  const same = (c: number, r: number) => {
    const v = map.get(c, r);
    return v === id || v === -1;
  };
  return (same(col, row - 1) ? 1 : 0) | (same(col + 1, row) ? 2 : 0) | (same(col, row + 1) ? 4 : 0) | (same(col - 1, row) ? 8 : 0);
}

/**
 * Eight-bit autotile mask: north 1, north-east 2, east 4, south-east 8, south 16, south-west
 * 32, west 64, north-west 128. A corner only counts when both edges beside it match, which is
 * what makes 47 distinct tiles cover every case (the "blob" tileset).
 */
export function autotileMask8(map: { get(col: number, row: number): number }, col: number, row: number, id = map.get(col, row)): number {
  const same = (c: number, r: number) => {
    const v = map.get(c, r);
    return v === id || v === -1;
  };
  const n = same(col, row - 1);
  const e = same(col + 1, row);
  const so = same(col, row + 1);
  const w = same(col - 1, row);
  let m = (n ? 1 : 0) | (e ? 4 : 0) | (so ? 16 : 0) | (w ? 64 : 0);
  if (n && e && same(col + 1, row - 1)) m |= 2;
  if (so && e && same(col + 1, row + 1)) m |= 8;
  if (so && w && same(col - 1, row + 1)) m |= 32;
  if (n && w && same(col - 1, row - 1)) m |= 128;
  return m;
}

/** Drop corners whose edges are not both present, so any eight-bit mask maps to a blob tile. */
export function canonicalMask8(m: number): number {
  const n = m & 1;
  const e = m & 4;
  const so = m & 16;
  const w = m & 64;
  let out = n | e | so | w;
  if (n && e && m & 2) out |= 2;
  if (so && e && m & 8) out |= 8;
  if (so && w && m & 32) out |= 32;
  if (n && w && m & 128) out |= 128;
  return out;
}

/** The 47 masks a blob tileset holds, in tile order: ascending by mask value. */
export const BLOB_MASKS: readonly number[] = (() => {
  const out: number[] = [];
  for (let m = 0; m < 256; m++) if (canonicalMask8(m) === m) out.push(m);
  return out;
})();

const BLOB_INDEX: Int16Array = (() => {
  const idx = new Int16Array(256);
  for (let m = 0; m < 256; m++) idx[m] = BLOB_MASKS.indexOf(canonicalMask8(m));
  return idx;
})();

/** Which of the 47 blob tiles draws a cell with this eight-bit mask. */
export const blobIndex = (mask8: number): number => BLOB_INDEX[mask8 & 255];

export interface PathOptions {
  /** Allow diagonal steps, never cutting a corner past a blocked cell. */
  diagonal?: boolean;
  /** Stop after this many expansions and return null; 20000 by default. */
  maxNodes?: number;
}

/**
 * A* over a grid from `from` to `to` through cells `passable` allows; returns the cells from
 * the start (exclusive) to the goal (inclusive), or null when there is no way.
 */
export function findPath(cols: number, rows: number, passable: (col: number, row: number) => boolean, from: Cell, to: Cell, opts: PathOptions = {}): Cell[] | null {
  if (from.x === to.x && from.y === to.y) return [];
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows;
  if (!inside(to.x, to.y) || !passable(to.x, to.y)) return null;
  const diagonal = opts.diagonal ?? false;
  const maxNodes = opts.maxNodes ?? 20000;
  const key = (c: number, r: number) => r * cols + c;
  const g = new Map<number, number>();
  const came = new Map<number, number>();
  const closed = new Set<number>();
  // Binary heap of [f, key].
  const heap: [number, number][] = [];
  const push = (f: number, k: number) => {
    heap.push([f, k]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop() as [number, number];
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const h = (c: number, r: number) => {
    const dx = Math.abs(c - to.x);
    const dy = Math.abs(r - to.y);
    return diagonal ? 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy) : 10 * (dx + dy);
  };
  const start = key(from.x, from.y);
  g.set(start, 0);
  push(h(from.x, from.y), start);
  const goal = key(to.x, to.y);
  let expanded = 0;
  const steps: [number, number, number][] = [[1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10]];
  if (diagonal) steps.push([1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14]);
  while (heap.length) {
    const [, k] = pop();
    if (closed.has(k)) continue;
    if (k === goal) break;
    closed.add(k);
    if (++expanded > maxNodes) return null;
    const c = k % cols;
    const r = (k - c) / cols;
    const gk = g.get(k) as number;
    for (const [dc, dr, cost] of steps) {
      const nc = c + dc;
      const nr = r + dr;
      if (!inside(nc, nr) || !passable(nc, nr)) continue;
      // No slipping between two blocked cells on a diagonal.
      if (dc !== 0 && dr !== 0 && (!passable(c + dc, r) || !passable(c, r + dr))) continue;
      const nk = key(nc, nr);
      if (closed.has(nk)) continue;
      const ng = gk + cost;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        came.set(nk, k);
        push(ng + h(nc, nr), nk);
      }
    }
  }
  if (!came.has(goal)) return null;
  const path: Cell[] = [];
  for (let k = goal; k !== start; k = came.get(k) as number) {
    const c = k % cols;
    path.push({ x: c, y: (k - c) / cols });
  }
  return path.reverse();
}

/** Solid cells as merged rectangles (in cells): rows of runs, joined with the row above when they line up. */
export function mergeRects(cols: number, rows: number, solid: (col: number, row: number) => boolean): { x: number; y: number; w: number; h: number }[] {
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  let prev: { x: number; y: number; w: number; h: number }[] = [];
  for (let r = 0; r < rows; r++) {
    const runs: { x: number; y: number; w: number; h: number }[] = [];
    let start = -1;
    for (let c = 0; c <= cols; c++) {
      const on = c < cols && solid(c, r);
      if (on && start < 0) start = c;
      if (!on && start >= 0) {
        const above = prev.find((p) => p.x === start && p.w === c - start);
        if (above) {
          above.h += 1;
          runs.push(above);
        } else {
          const rect = { x: start, y: r, w: c - start, h: 1 };
          rects.push(rect);
          runs.push(rect);
        }
        start = -1;
      }
    }
    prev = runs;
  }
  return rects;
}

/** Cells a box overlaps, for pickups and hazards. */
export function cellsUnder(box: Aabb, tileSize: number): Cell[] {
  const out: Cell[] = [];
  const c0 = Math.floor(box.x / tileSize);
  const c1 = Math.floor((box.x + box.w - EPS) / tileSize);
  const r0 = Math.floor(box.y / tileSize);
  const r1 = Math.floor((box.y + box.h - EPS) / tileSize);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push({ x: c, y: r });
  return out;
}

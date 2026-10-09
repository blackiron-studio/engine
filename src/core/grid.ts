// Square-grid helpers: neighbours, A* pathfinding and movement-budget flood fill.
// Cells are addressed as (x, y) integers; `key` packs them for Map/Set use.

export interface Cell {
  x: number;
  y: number;
}

export const key = (x: number, y: number): number => ((y & 0xffff) << 16) | (x & 0xffff);
export const unkey = (k: number): Cell => ({ x: k & 0xffff, y: (k >>> 16) & 0xffff });

export const manhattan = (ax: number, ay: number, bx: number, by: number): number => Math.abs(ax - bx) + Math.abs(ay - by);
export const chebyshev = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

const N4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const N8: ReadonlyArray<readonly [number, number]> = [
  ...N4,
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export function neighbors(x: number, y: number, cols: number, rows: number, diagonal = false): Cell[] {
  const out: Cell[] = [];
  for (const [dx, dy] of diagonal ? N8 : N4) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) out.push({ x: nx, y: ny });
  }
  return out;
}

/** Per-cell entry cost. Return `Infinity` for impassable cells. */
export type CostFn = (x: number, y: number) => number;

class MinHeap {
  private keys: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(k: number, p: number): void {
    this.keys.push(k);
    this.prio.push(p);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.keys[0];
    const lastK = this.keys.pop() as number;
    const lastP = this.prio.pop() as number;
    if (this.keys.length > 0) {
      this.keys[0] = lastK;
      this.prio[0] = lastP;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.prio[l] < this.prio[m]) m = l;
        if (r < this.keys.length && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const p = this.prio[a];
    this.prio[a] = this.prio[b];
    this.prio[b] = p;
  }
}

export interface PathOptions {
  diagonal?: boolean;
  /** Cost multiplier for diagonal steps; defaults to sqrt(2). */
  diagonalCost?: number;
  /** Stop expanding after this many nodes; returns null when exceeded. */
  maxNodes?: number;
}

/**
 * A* from `from` to `to`. Returns the list of cells including both ends, or null when
 * unreachable. The start cell's own cost is ignored; the goal's cost applies.
 */
export function findPath(
  cols: number,
  rows: number,
  cost: CostFn,
  from: Cell,
  to: Cell,
  opts: PathOptions = {},
): Cell[] | null {
  if (from.x === to.x && from.y === to.y) return [{ x: from.x, y: from.y }];
  if (cost(to.x, to.y) === Infinity) return null;
  const diagonal = opts.diagonal ?? false;
  const dCost = opts.diagonalCost ?? Math.SQRT2;
  const maxNodes = opts.maxNodes ?? cols * rows * 4;
  const heuristic = diagonal
    ? (x: number, y: number) => chebyshev(x, y, to.x, to.y)
    : (x: number, y: number) => manhattan(x, y, to.x, to.y);

  const g = new Map<number, number>();
  const came = new Map<number, number>();
  const open = new MinHeap();
  const startK = key(from.x, from.y);
  const goalK = key(to.x, to.y);
  g.set(startK, 0);
  open.push(startK, heuristic(from.x, from.y));
  let expanded = 0;

  while (open.size > 0) {
    const cur = open.pop();
    if (cur === goalK) {
      const path: Cell[] = [];
      let k: number | undefined = cur;
      while (k !== undefined) {
        path.push(unkey(k));
        k = came.get(k);
      }
      return path.reverse();
    }
    if (++expanded > maxNodes) return null;
    const { x, y } = unkey(cur);
    const gCur = g.get(cur) as number;
    for (const [dx, dy] of diagonal ? N8 : N4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const c = cost(nx, ny);
      if (c === Infinity) continue;
      const step = dx !== 0 && dy !== 0 ? c * dCost : c;
      const nk = key(nx, ny);
      const ng = gCur + step;
      const prev = g.get(nk);
      if (prev !== undefined && prev <= ng) continue;
      g.set(nk, ng);
      came.set(nk, cur);
      open.push(nk, ng + heuristic(nx, ny));
    }
  }
  return null;
}

/**
 * Dijkstra flood fill limited by a movement budget. Returns a map from packed cell key
 * to the cheapest cost of reaching it (the origin costs 0).
 */
export function reachable(cols: number, rows: number, cost: CostFn, from: Cell, budget: number, diagonal = false): Map<number, number> {
  const best = new Map<number, number>();
  const open = new MinHeap();
  const startK = key(from.x, from.y);
  best.set(startK, 0);
  open.push(startK, 0);
  while (open.size > 0) {
    const cur = open.pop();
    const gCur = best.get(cur) as number;
    const { x, y } = unkey(cur);
    for (const [dx, dy] of diagonal ? N8 : N4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const c = cost(nx, ny);
      if (c === Infinity) continue;
      const ng = gCur + (dx !== 0 && dy !== 0 ? c * Math.SQRT2 : c);
      if (ng > budget) continue;
      const nk = key(nx, ny);
      const prev = best.get(nk);
      if (prev !== undefined && prev <= ng) continue;
      best.set(nk, ng);
      open.push(nk, ng);
    }
  }
  return best;
}

/** Bresenham line between two cells, inclusive. */
export function lineCells(x0: number, y0: number, x1: number, y1: number): Cell[] {
  const out: Cell[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

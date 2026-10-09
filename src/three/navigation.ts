import { Vec3 } from "./math.ts";
/** Sampled 2.5D navigation surface for walkers. null blocks a cell; height changes obey maxStep.
 * Bake with agent-radius clearance in sampleHeight. Overlapping floors require separate grids.
 */
export class NavigationGrid3D {
  private readonly heights: Float32Array;
  constructor(
    readonly width: number,
    readonly depth: number,
    readonly cellSize: number,
    readonly originX: number,
    readonly originZ: number,
    sampleHeight: (x: number, z: number) => number | null,
    readonly maxStep = 0.4,
  ) {
    if (
      ![width, depth, cellSize, originX, originZ, maxStep].every(
        Number.isFinite,
      ) ||
      !Number.isInteger(width) ||
      !Number.isInteger(depth) ||
      width < 1 ||
      depth < 1 ||
      width * depth > 1e6 ||
      cellSize <= 0 ||
      maxStep < 0
    )
      throw new RangeError("Invalid navigation grid");
    this.heights = new Float32Array(width * depth);
    for (let z = 0; z < depth; z++)
      for (let x = 0; x < width; x++) {
        const h = sampleHeight(
          originX + (x + 0.5) * cellSize,
          originZ + (z + 0.5) * cellSize,
        );
        if (h !== null && !Number.isFinite(h))
          throw new RangeError("Invalid navigation height");
        this.heights[z * width + x] = h ?? NaN;
      }
  }
  private cell(p: Readonly<Vec3>): number {
    const x = Math.floor((p.x - this.originX) / this.cellSize),
      z = Math.floor((p.z - this.originZ) / this.cellSize);
    return x < 0 || z < 0 || x >= this.width || z >= this.depth
      ? -1
      : z * this.width + x;
  }
  point(i: number): Vec3 {
    return new Vec3(
      this.originX + ((i % this.width) + 0.5) * this.cellSize,
      this.heights[i],
      this.originZ + (Math.floor(i / this.width) + 0.5) * this.cellSize,
    );
  }
  findPath(
    from: Readonly<Vec3>,
    to: Readonly<Vec3>,
    maxVisited = 4096,
  ): Vec3[] {
    const start = this.cell(from),
      end = this.cell(to);
    if (
      start < 0 ||
      end < 0 ||
      !Number.isFinite(this.heights[start]) ||
      !Number.isFinite(this.heights[end])
    )
      return [];
    const distance = (i: number) =>
      Math.abs((i % this.width) - (end % this.width)) +
      Math.abs(Math.floor(i / this.width) - Math.floor(end / this.width));
    const open = [start],
      cost = new Map([[start, 0]]),
      parent = new Map<number, number>(),
      closed = new Set<number>();
    while (open.length && closed.size < maxVisited) {
      open.sort(
        (a, b) => cost.get(b)! + distance(b) - cost.get(a)! - distance(a),
      );
      const at = open.pop()!;
      if (at === end) {
        const path = [at];
        while (parent.has(path[0])) path.unshift(parent.get(path[0])!);
        return path.map((i) => this.point(i));
      }
      if (closed.has(at)) continue;
      closed.add(at);
      const x = at % this.width,
        z = Math.floor(at / this.width);
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx,
          nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= this.width || nz >= this.depth) continue;
        const next = nz * this.width + nx;
        if (
          !Number.isFinite(this.heights[next]) ||
          Math.abs(this.heights[next] - this.heights[at]) > this.maxStep ||
          closed.has(next)
        )
          continue;
        const c = cost.get(at)! + 1;
        if (c < (cost.get(next) ?? Infinity)) {
          cost.set(next, c);
          parent.set(next, at);
          open.push(next);
        }
      }
    }
    return [];
  }
}

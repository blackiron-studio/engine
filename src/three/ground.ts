/** Planar X/Z collision for walkers, dashes and projectiles. No renderer or physics backend is required. */
export interface GroundPoint { x: number; z: number }
export interface GroundBox extends GroundPoint { w: number; d: number }
/** Allowed centre positions, already inset for the actor's radius where required. */
export interface GroundBounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface GroundHit extends GroundPoint {
  /** Fraction of the requested displacement, in [0, 1]. x/z is the circle centre at impact. */
  t: number;
  /** Surface normal pointing from the obstacle toward the circle. */
  nx: number;
  nz: number;
  /** Null / -1 denotes the movement bounds rather than an obstacle. */
  box: Readonly<GroundBox> | null;
  index: number;
}
export interface GroundMoveOptions {
  bounds?: Readonly<GroundBounds>;
  /** Maximum contact projections per move. Remaining motion is discarded safely at this limit. Default 8. */
  maxSlides?: number;
}
export interface GroundMoveResult extends GroundPoint {
  /** Actual movement, including any initial overlap recovery. */
  dx: number;
  dz: number;
  contacts: GroundHit[];
  recovered: boolean;
  /** No free recovery candidate exists inside the supplied bounds. The body is left in place. */
  stuck: boolean;
  /** The iteration limit discarded some displacement. No unchecked movement is applied. */
  exhausted: boolean;
}

const EPS = 1e-9;
const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

function validate(x: number, z: number, radius: number, dx: number, dz: number, boxes: readonly Readonly<GroundBox>[]): void {
  if (![x, z, radius, dx, dz].every(Number.isFinite) || radius < 0) {
    throw new Error("Ground positions/displacement must be finite and radius nonnegative");
  }
  for (const box of boxes) {
    if (![box.x, box.z, box.w, box.d].every(Number.isFinite) || box.w < 0 || box.d < 0) {
      throw new Error("Ground boxes require finite positions and nonnegative dimensions");
    }
  }
}

/** Strict penetration, excluding contact. The corner test uses the actual circle, not its bounding square. */
function penetration(x: number, z: number, radius: number, b: Readonly<GroundBox>): { nx: number; nz: number; depth: number } | null {
  const left = b.x - b.w / 2, right = b.x + b.w / 2;
  const bottom = b.z - b.d / 2, top = b.z + b.d / 2;
  const qx = clamp(x, left, right), qz = clamp(z, bottom, top);
  const vx = x - qx, vz = z - qz, distance = Math.hypot(vx, vz);
  if (distance > 0) {
    return distance < radius - EPS ? { nx: vx / distance, nz: vz / distance, depth: radius - distance } : null;
  }
  const distances = [x - left + radius, right - x + radius, z - bottom + radius, top - z + radius];
  let axis = 0;
  for (let i = 1; i < 4; i++) if (distances[i] < distances[axis]) axis = i;
  if (distances[axis] <= EPS) return null;
  return { nx: axis === 0 ? -1 : axis === 1 ? 1 : 0, nz: axis === 2 ? -1 : axis === 3 ? 1 : 0, depth: distances[axis] };
}

/** Whether a circle penetrates a box. Mere touching is allowed. */
export function overlapsGroundBox(body: Readonly<GroundPoint>, radius: number, box: Readonly<GroundBox>): boolean {
  validate(body.x, body.z, radius, 0, 0, [box]);
  return penetration(body.x, body.z, radius, box) !== null;
}

function sweep(
  x: number, z: number, radius: number, dx: number, dz: number,
  boxes: readonly Readonly<GroundBox>[], blockingOnly: boolean,
): GroundHit | null {
  let nearest: GroundHit | null = null;
  const consider = (t: number, nx: number, nz: number, box: Readonly<GroundBox>, index: number): void => {
    if (t < -EPS || t > 1 + EPS || !Number.isFinite(t)) return;
    if (blockingOnly && dx * nx + dz * nz >= -EPS) return;
    t = clamp(t, 0, 1);
    if (!nearest || t < nearest.t) nearest = { t, x: x + dx * t, z: z + dz * t, nx, nz, box, index };
  };
  const lengthSquared = dx * dx + dz * dz;
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    const overlap = penetration(x, z, radius, box);
    if (overlap) { consider(0, overlap.nx, overlap.nz, box, index); continue; }
    const left = box.x - box.w / 2, right = box.x + box.w / 2;
    const bottom = box.z - box.d / 2, top = box.z + box.d / 2;
    // Classify initial contact in world units, before dividing by displacement.
    // A tiny inward slide remainder can turn harmless positional roundoff into a
    // large negative entry fraction, which must not make an existing wall vanish.
    const contactX = x - clamp(x, left, right), contactZ = z - clamp(z, bottom, top);
    const contactDistance = Math.hypot(contactX, contactZ);
    if (contactDistance > 0 && contactDistance <= radius + EPS) {
      consider(0, contactX / contactDistance, contactZ / contactDistance, box, index);
      continue;
    }
    if (radius === 0 && contactDistance === 0) {
      const distances = [x - left, right - x, z - bottom, top - z];
      let axis = 0;
      for (let i = 1; i < 4; i++) if (distances[i] < distances[axis]) axis = i;
      consider(0, axis === 0 ? -1 : axis === 1 ? 1 : 0, axis === 2 ? -1 : axis === 3 ? 1 : 0, box, index);
      continue;
    }
    if (lengthSquared === 0) continue;
    // The Minkowski sum has four straight faces, each ending at the original box corners.
    if (dx !== 0) {
      const t = ((dx > 0 ? left - radius : right + radius) - x) / dx;
      const hitZ = z + dz * t;
      if (hitZ >= bottom - EPS && hitZ <= top + EPS) consider(t, dx > 0 ? -1 : 1, 0, box, index);
    }
    if (dz !== 0) {
      const t = ((dz > 0 ? bottom - radius : top + radius) - z) / dz;
      const hitX = x + dx * t;
      if (hitX >= left - EPS && hitX <= right + EPS) consider(t, 0, dz > 0 ? -1 : 1, box, index);
    }
    if (radius === 0) continue;
    // Four exact quarter-circle arcs complete the rounded corners. An expanded AABB
    // would incorrectly block diagonal space outside these arcs.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const cx = sx < 0 ? left : right, cz = sz < 0 ? bottom : top;
      const fx = x - cx, fz = z - cz;
      const projection = fx * dx + fz * dz;
      const constant = fx * fx + fz * fz - radius * radius;
      // The cross-product form avoids subtracting two enormous, almost equal
      // squared projections when sweeping from far away past a small corner.
      const cross = fx * dz - fz * dx;
      const discriminant = lengthSquared * radius * radius - cross * cross;
      if (discriminant < 0) continue;
      // Stable quadratic roots avoid cancellation when the start is far from a small corner.
      const root = Math.sqrt(discriminant);
      const q = -projection - (projection >= 0 ? root : -root);
      const t = q === 0 ? 0 : Math.min(q / lengthSquared, constant / q);
      if (t < -EPS || t > 1 + EPS) continue;
      const vx = x + dx * t - cx, vz = z + dz * t - cz;
      if (vx * sx < -EPS || vz * sz < -EPS) continue;
      const normalLength = Math.hypot(vx, vz);
      if (normalLength > 0) consider(t, vx / normalLength, vz / normalLength, box, index);
    }
  }
  return nearest;
}

/**
 * Earliest circle/box hit along a displacement, including exact rounded corners.
 * Starting penetration or contact (within 1e-9 world units) returns t=0, even for stationary queries.
 * No hit returns null; results are independent of obstacle order
 * except ties at the same contact time. This query does not mutate its inputs.
 */
export function sweepGroundCircle(
  body: Readonly<GroundPoint>, radius: number, dx: number, dz: number,
  boxes: readonly Readonly<GroundBox>[],
): GroundHit | null {
  validate(body.x, body.z, radius, dx, dz, boxes);
  return sweep(body.x, body.z, radius, dx, dz, boxes, false);
}

function clampToBounds(p: GroundPoint, bounds?: Readonly<GroundBounds>): void {
  if (!bounds) return;
  p.x = clamp(p.x, bounds.minX, bounds.maxX);
  p.z = clamp(p.z, bounds.minZ, bounds.maxZ);
}

/** Recovery is only needed for spawn/teleport/edit overlap, not normal swept movement. */
function recover(body: GroundPoint, radius: number, boxes: readonly Readonly<GroundBox>[], bounds?: Readonly<GroundBounds>): boolean {
  const free = (x: number, z: number): boolean => !boxes.some(box => penetration(x, z, radius, box));
  clampToBounds(body, bounds);
  if (free(body.x, body.z)) return true;
  const originX = body.x, originZ = body.z;
  let bestX = originX, bestZ = originZ, bestDistance = Infinity;
  const candidate = (x: number, z: number): void => {
    if (bounds) { x = clamp(x, bounds.minX, bounds.maxX); z = clamp(z, bounds.minZ, bounds.maxZ); }
    const distance = Math.hypot(x - originX, z - originZ);
    if (distance < bestDistance && free(x, z)) { bestDistance = distance; bestX = x; bestZ = z; }
  };
  const margin = radius + EPS * 4;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const box of boxes) {
    const left = box.x - box.w / 2, right = box.x + box.w / 2;
    const bottom = box.z - box.d / 2, top = box.z + box.d / 2;
    minX = Math.min(minX, left - margin); maxX = Math.max(maxX, right + margin);
    minZ = Math.min(minZ, bottom - margin); maxZ = Math.max(maxZ, top + margin);
    candidate(left - margin, clamp(originZ, bottom, top));
    candidate(right + margin, clamp(originZ, bottom, top));
    candidate(clamp(originX, left, right), bottom - margin);
    candidate(clamp(originX, left, right), top + margin);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx < 0 ? left : right, z = sz < 0 ? bottom : top;
      const vx = Math.max(0, (originX - x) * sx), vz = Math.max(0, (originZ - z) * sz);
      const distance = Math.hypot(vx, vz);
      if (distance > 0) candidate(x + sx * vx / distance * margin, z + sz * vz / distance * margin);
      candidate(x + sx * margin, z + sz * margin);
    }
  }
  // Overlapping cover can hide every individual nearest surface. The union's outer
  // extents provide deterministic fallback exits rather than oscillating between boxes.
  candidate(minX, originZ); candidate(maxX, originZ);
  candidate(originX, minZ); candidate(originX, maxZ);
  if (!Number.isFinite(bestDistance)) return false;
  body.x = bestX; body.z = bestZ;
  return true;
}

/**
 * Move a circular ground footprint continuously and project unused displacement along walls.
 * Mutates x/z only; height, gravity, facing and gameplay timers belong to the caller.
 * Initial overlap is recovered against all cover, and an unrecoverable bounded spawn reports stuck.
 * No fixed movement substep size is used, so thin obstacles remain solid during long dashes.
 */
export function moveGroundCircle(
  body: GroundPoint, radius: number, dx: number, dz: number,
  boxes: readonly Readonly<GroundBox>[], options: GroundMoveOptions = {},
): GroundMoveResult {
  validate(body.x, body.z, radius, dx, dz, boxes);
  const bounds = options.bounds, limit = options.maxSlides ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("maxSlides must be an integer from 1 to 64");
  if (bounds && (![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(Number.isFinite) || bounds.minX > bounds.maxX || bounds.minZ > bounds.maxZ)) {
    throw new Error("Ground centre bounds must be finite and ordered");
  }
  const originX = body.x, originZ = body.z, contacts: GroundHit[] = [];
  const result = (recovered: boolean, stuck: boolean, exhausted: boolean): GroundMoveResult => ({ x: body.x, z: body.z, dx: body.x - originX, dz: body.z - originZ, contacts, recovered, stuck, exhausted });
  if (!recover(body, radius, boxes, bounds)) {
    body.x = originX; body.z = originZ;
    return result(false, true, false);
  }
  const recovered = body.x !== originX || body.z !== originZ;
  let remainingX = dx, remainingZ = dz;
  for (let iteration = 0; iteration < limit; iteration++) {
    if (Math.hypot(remainingX, remainingZ) < EPS) return result(recovered, false, false);
    let hit = sweep(body.x, body.z, radius, remainingX, remainingZ, boxes, true);
    const boundHit = (t: number, nx: number, nz: number): void => {
      if (t >= 0 && t <= 1 && (!hit || t < hit.t)) hit = { t, x: body.x + remainingX * t, z: body.z + remainingZ * t, nx, nz, box: null, index: -1 };
    };
    if (bounds) {
      if (remainingX > 0) boundHit((bounds.maxX - body.x) / remainingX, -1, 0);
      else if (remainingX < 0) boundHit((bounds.minX - body.x) / remainingX, 1, 0);
      if (remainingZ > 0) boundHit((bounds.maxZ - body.z) / remainingZ, 0, -1);
      else if (remainingZ < 0) boundHit((bounds.minZ - body.z) / remainingZ, 0, 1);
    }
    if (!hit) { body.x += remainingX; body.z += remainingZ; return result(recovered, false, false); }
    body.x = hit.x; body.z = hit.z;
    contacts.push(hit);
    remainingX *= 1 - hit.t;
    remainingZ *= 1 - hit.t;
    const inward = remainingX * hit.nx + remainingZ * hit.nz;
    if (inward < 0) { remainingX -= inward * hit.nx; remainingZ -= inward * hit.nz; }
  }
  return result(recovered, false, Math.hypot(remainingX, remainingZ) >= EPS);
}
